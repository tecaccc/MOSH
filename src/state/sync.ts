/**
 * 多设备同步（zustand）：状态点 + 设置页数据源。
 *
 * 生命周期：init（先订阅 `sync://status` 再读配置/状态，同步落地变更后刷新数据视图）→
 * saveConfig / importKey / setEnabled（写配置）→ syncNow（手动同步，设置页与
 * 标题栏按钮共用）。仅在 Tauri 环境生效（vite dev 浏览器直开时静默跳过）。
 *
 * 操作反馈统一走全局 toast（state/toast）：手动同步失败与后台（启动拉/
 * 防抖推）失败同源——都由 `sync://status`（phase=error）事件弹 toast
 * （含「重试」），恢复 syncing/idle 时收起，不重复报。
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
import { toast, useToastStore } from "./toast";
import type { SyncConfigInfo, SyncConfigInput, SyncUi } from "../lib/types";
import { useProfileStore } from "./profile";
import { useAppStore } from "./store";

const inTauri = "__TAURI_INTERNALS__" in window;

/** 当前后台失败 toast 的 id（恢复 syncing/idle 时收起）。 */
let syncErrToastId: number | null = null;

interface SyncState {
  /** 配置回显（null = 未加载/非 Tauri 环境）。 */
  config: SyncConfigInfo | null;
  /** 运行状态（事件驱动）。 */
  ui: SyncUi;
  /** 首次配置时生成的一次性密钥（卡片展示后清除）。 */
  generatedKey: string | null;
  /** 操作进行中（按钮禁用态）。 */
  busy: boolean;
  init: () => Promise<void>;
  saveConfig: (input: SyncConfigInput) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  importKey: (key: string) => Promise<void>;
  exportKey: () => Promise<string>;
  syncNow: () => Promise<void>;
  clearGeneratedKey: () => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  config: null,
  ui: { phase: "idle", last_success_at: null, error: null, applied: 0 },
  generatedKey: null,
  busy: false,

  init: async () => {
    if (!inTauri || get().config) return;
    // 后端事件驱动状态更新（启动拉/防抖推的进度对前端可见）；
    // 失败转全局 toast（含「重试」），恢复 syncing/idle 时收起错误卡。
    // 同步合并落地变更时刷新对应视图——否则启动拉/他机变更只进库不进 UI，
    // 需重启才能看到；纯推送（无落地变更）不触发，避免防抖推频繁重载。
    let sawEvent = false;
    void listen<SyncUi>("sync://status", (event) => {
      sawEvent = true;
      const ui = event.payload;
      if (ui.phase === "error" && ui.error) {
        const { push, dismiss } = useToastStore.getState();
        if (syncErrToastId !== null) dismiss(syncErrToastId);
        syncErrToastId = push("error", `同步失败：${ui.error}`, {
          action: { label: "重试", run: () => void get().syncNow() },
        });
      } else if (syncErrToastId !== null) {
        useToastStore.getState().dismiss(syncErrToastId);
        syncErrToastId = null;
      }
      set({ ui });
      if (ui.phase === "idle") {
        // 有落地变更时刷新对应视图——个人资料存在 settings（随 dump 同步），
        // 他机改名/换头像后本机首页/侧栏问候即时生效，不再需重启。
        if (ui.applied > 0) {
          void useAppStore.getState().refreshData();
          void useProfileStore.getState().load().catch(() => {});
        }
      }
    });
    try {
      const [config, ui] = await Promise.all([syncGetConfig(), syncGetStatus()]);
      set({ config, ui });
      // 启动拉完成于监听注册前的漏事件场景：初始状态里已有落地变更则补刷；
      // 事件已到过则不重复（sawEvent 路径已刷新）。
      if (!sawEvent && ui.phase === "idle") {
        if (ui.applied > 0) {
          void useAppStore.getState().refreshData();
          void useProfileStore.getState().load().catch(() => {});
        }
      }
    } catch (e) {
      toast.error(`同步初始化失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },

  saveConfig: async (input) => {
    set({ busy: true });
    try {
      const config = await syncConfigure(input);
      set({ config, generatedKey: config.generated_key ?? null });
      if (config.generated_key) {
        toast.success("配置已保存，并生成了新的加密密钥（见下方卡片，请立即抄录）");
      } else if (config.needs_key_import) {
        toast.info(
          "远端已有同步数据：为避免密钥不一致，未生成新密钥。请在下方「加密密钥」导入原设备的密钥后再启用同步。",
          { ttl: 10000 },
        );
      } else {
        toast.success("同步配置已保存。");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  setEnabled: async (enabled) => {
    set({ busy: true });
    try {
      await syncSetEnabled(enabled);
      const config = await syncGetConfig();
      set({ config });
      toast.success(enabled ? "同步已启用。" : "同步已停用（配置与数据保留）。");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      set({ busy: false });
    }
  },

  importKey: async (key) => {
    set({ busy: true });
    try {
      await syncImportKey(key);
      const config = await syncGetConfig();
      set({ config });
      toast.success("密钥已导入，现在可以启用同步了。");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  exportKey: async () => syncExportKey(),

  // 手动同步失败不在此报 toast：后端 sync_now 与后台失败一样会推
  // `sync://status`（phase=error）事件，由 init 里的监听统一弹出。
  // 入口不唯一（设置页/标题栏按钮/失败 toast 重试），进行中直接忽略防并发。
  syncNow: async () => {
    const { busy, ui } = get();
    if (busy || ui.phase === "syncing") return;
    set({ busy: true });
    try {
      const outcome = await syncNow();
      toast.success(
        `同步完成：合并 ${outcome.remote_dumps} 份远端备份，应用 ${outcome.stats.records_applied} 条记录变更。`,
      );
      const config = await syncGetConfig();
      set({ config });
    } catch {
      /* 失败 toast 由 sync://status 事件统一弹出 */
    } finally {
      set({ busy: false });
    }
  },

  clearGeneratedKey: () => set({ generatedKey: null }),
}));
