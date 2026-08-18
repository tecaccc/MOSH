/**
 * 多设备同步（zustand）：状态点 + 设置页数据源。
 *
 * 生命周期：init（读配置 + 状态 + 订阅 `sync://status` 事件）→
 * saveConfig / importKey / setEnabled（写配置）→ syncNow（手动同步）。
 * 仅在 Tauri 环境生效（vite dev 浏览器直开时静默跳过）。
 */

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  syncConfigure,
  syncExportKey,
  syncGetConfig,
  syncGetStatus,
  syncImportKey,
  syncNow,
  syncSetEnabled,
} from "../lib/ipc";
import type { SyncConfigInfo, SyncConfigInput, SyncUi } from "../lib/types";

const inTauri = "__TAURI_INTERNALS__" in window;

interface SyncState {
  /** 配置回显（null = 未加载/非 Tauri 环境）。 */
  config: SyncConfigInfo | null;
  /** 运行状态（事件驱动）。 */
  ui: SyncUi;
  /** 首次配置时生成的一次性密钥（弹窗展示后清除）。 */
  generatedKey: string | null;
  /** 表单/操作反馈。 */
  busy: boolean;
  message: string | null;
  error: string | null;
  init: () => Promise<void>;
  saveConfig: (input: SyncConfigInput) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  importKey: (key: string) => Promise<void>;
  exportKey: () => Promise<string>;
  syncNow: () => Promise<void>;
  clearGeneratedKey: () => void;
  clearFeedback: () => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  config: null,
  ui: { phase: "idle", last_success_at: null, error: null },
  generatedKey: null,
  busy: false,
  message: null,
  error: null,

  init: async () => {
    if (!inTauri || get().config) return;
    try {
      const [config, ui] = await Promise.all([syncGetConfig(), syncGetStatus()]);
      set({ config, ui });
    } catch (e) {
      set({ error: String(e) });
    }
    // 后端事件驱动状态更新（启动拉/防抖推的进度对前端可见）。
    void listen<SyncUi>("sync://status", (event) => {
      set({ ui: event.payload });
    });
  },

  saveConfig: async (input) => {
    set({ busy: true, error: null, message: null });
    try {
      const config = await syncConfigure(input);
      set({ config, generatedKey: config.generated_key ?? null });
      if (config.generated_key) {
        set({
          message:
            "配置已保存，并生成了新的加密密钥——请立即抄录（仅此一次显示，可稍后在「导出密钥」重新获取）。",
        });
      } else {
        set({ message: "配置已保存。" });
      }
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  setEnabled: async (enabled) => {
    set({ busy: true, error: null, message: null });
    try {
      await syncSetEnabled(enabled);
      const config = await syncGetConfig();
      set({ config, message: enabled ? "同步已启用。" : "同步已停用（配置与数据保留）。" });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  importKey: async (key) => {
    set({ busy: true, error: null, message: null });
    try {
      await syncImportKey(key);
      const config = await syncGetConfig();
      set({ config, message: "密钥已导入。" });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  exportKey: async () => syncExportKey(),

  syncNow: async () => {
    set({ busy: true, error: null, message: null });
    try {
      const outcome = await syncNow();
      set({
        message: `同步完成：合并 ${outcome.remote_dumps} 份远端备份，应用 ${outcome.stats.records_applied} 条记录变更。`,
      });
      const config = await syncGetConfig();
      set({ config });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  clearGeneratedKey: () => set({ generatedKey: null }),
  clearFeedback: () => set({ message: null, error: null }),
}));
