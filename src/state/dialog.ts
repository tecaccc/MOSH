/**
 * 全局对话框（zustand）：以 Promise 形式替代浏览器原生 confirm/prompt。
 *
 * 用法（任意组件/事件回调内）：
 *   const ok = await useDialogStore.getState().confirm({
 *     title: "删除会话", message: "…", danger: true, confirmText: "删除",
 *   });
 *   const text = await useDialogStore.getState().prompt({
 *     title: "添加子任务", placeholder: "子任务标题", confirmText: "添加",
 *   });
 *
 * 同一时间只挂一个对话框（后到覆盖并以前一个 resolve(null/false) 收尾——
 * 理论上不会发生：DialogHost 挂遮罩，UI 不会再触发第二个）。
 */

import { create } from "zustand";

/** confirm 对话框选项。 */
export interface ConfirmOptions {
  title: string;
  /** 正文（支持 \n 换行）。 */
  message?: string;
  /** 危险操作（删除类）：图标与确认按钮转红色。 */
  danger?: boolean;
  /** 确认按钮文案，缺省「确定」。 */
  confirmText?: string;
  /** 取消按钮文案，缺省「取消」。 */
  cancelText?: string;
}

/** prompt 对话框选项（在 confirm 之上加输入框）。 */
export interface PromptOptions extends ConfirmOptions {
  /** 输入框占位提示。 */
  placeholder?: string;
  /** 初始值。 */
  initialValue?: string;
}

/** 内部请求（resolve 回调存在 store 外部闭包不可序列化，一并放状态）。 */
interface DialogRequest {
  kind: "confirm" | "prompt";
  options: ConfirmOptions | PromptOptions;
  resolve: (value: boolean | string | null) => void;
}

interface DialogState {
  request: DialogRequest | null;
  /** 弹确认框；resolve(true/false)。 */
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** 弹输入框；resolve(文本/null=取消)。 */
  prompt(opts: PromptOptions): Promise<string | null>;
  /** DialogHost 内部：完成当前请求。 */
  settle(value: boolean | string | null): void;
}

export const useDialogStore = create<DialogState>()((set, get) => ({
  request: null,

  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({
        request: {
          kind: "confirm",
          options: opts,
          resolve: resolve as (value: boolean | string | null) => void,
        },
      });
    }),

  prompt: (opts) =>
    new Promise<string | null>((resolve) => {
      set({
        request: {
          kind: "prompt",
          options: opts,
          resolve: resolve as (value: boolean | string | null) => void,
        },
      });
    }),

  settle: (value) => {
    const req = get().request;
    if (req) req.resolve(value);
    set({ request: null });
  },
}));
