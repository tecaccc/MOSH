/**
 * 通知设置（zustand）：设置页「通知」分区数据源 + 提醒轮询读取通道开关。
 *
 * 持久化在后端 settings 键 `notify_settings`（经多设备同步端到端加密同步）；
 * 授权码不回显（`email.has_password` 探针，表单留空保存 = 保留原值）。
 *
 * reminder.ts 到点时调 `channelsOf()` 取当前开关：系统通知仍走前端插件
 * （tauri-plugin-notification），邮件走后端 `notify_send_email`（SMTP 直发）。
 * 仅在 Tauri 环境生效（vite dev 浏览器直开时静默跳过，channels 回退默认）。
 */

import { create } from "zustand";
import {
  getNotifySettings,
  saveNotifySettings,
  type NotifySettingsSaveInput,
} from "../lib/ipc";
import type { NotifySettingsInfo } from "../lib/types";

const inTauri = "__TAURI_INTERNALS__" in window;

interface NotifyState {
  /** 回显配置（null = 未加载/非 Tauri 环境）。 */
  config: NotifySettingsInfo | null;
  /** 操作进行中（保存/开关按钮禁用态）。 */
  busy: boolean;
  /** 挂载时拉取（幂等；reminder 轮询每 tick 也刷一次，保证开关即时生效）。 */
  load: () => Promise<void>;
  /** 整体保存（系统/邮件开关 + 邮件表单）。 */
  save: (input: NotifySettingsSaveInput) => Promise<void>;
  /** 快捷开关：只改系统或邮件通道（不动另一侧与表单）。 */
  setChannel: (patch: { system?: boolean; emailEnabled?: boolean }) => Promise<void>;
}

export const useNotifyStore = create<NotifyState>((set, get) => ({
  config: null,
  busy: false,

  load: async () => {
    if (!inTauri) return;
    try {
      set({ config: await getNotifySettings() });
    } catch {
      /* 读取失败保留旧值；提醒发放走 channelsOf 兑底 */
    }
  },

  save: async (input) => {
    set({ busy: true });
    try {
      set({ config: await saveNotifySettings(input) });
    } finally {
      set({ busy: false });
    }
  },

  setChannel: async ({ system, emailEnabled }) => {
    const cur = get().config;
    const input: NotifySettingsSaveInput = {
      system: system ?? cur?.system ?? true,
      email_enabled: emailEnabled ?? cur?.email_enabled ?? false,
      email: cur?.email
        ? {
            host: cur.email.host,
            port: cur.email.port,
            encryption: cur.email.encryption,
            username: cur.email.username,
            // 授权码不回显：空串 = 保留已存值。
            password: "",
            from: cur.email.from,
            to: cur.email.to,
          }
        : null,
    };
    await get().save(input);
  },
}));

/** 提醒发放时读通道开关（未加载/非 Tauri 回退默认：系统开、邮件关）。 */
export function channelsOf(): { system: boolean; email: boolean } {
  const c = useNotifyStore.getState().config;
  return {
    system: c?.system ?? true,
    email: !!(c?.email_enabled && c.email?.host),
  };
}
