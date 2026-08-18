/**
 * 全局 Toast 通知（zustand）：操作反馈类通知（保存成功/失败、测试连接结果、
 * 后台同步失败等）统一经此弹出，由 App 顶部 toast-layer 向下弹出堆叠展示
 * （见 ToastHost）。状态展示类信息（如天气面板预览）仍走各自面板内联呈现。
 *
 * 用法：`toast.success("已保存")` / `toast.error("失败：…")` /
 * `toast.info("标题", { detail: 长文本, ttl: 0 })`。
 * - 错误默认 9s、成功 3.5s、信息 6s 自动消失（卡片无手动关闭，勿用 ttl=0 常驻）；
 * - 文案末尾的句号（。/ .）会被统一去掉，保持无标点结尾；
 * - 同文案重复推送只重置计时（连点/循环失败不刷屏）；
 * - 最多堆叠 4 条，超出丢弃最旧的。
 */

import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

/** 可选操作按钮（如同步失败的「重试」）。 */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  /** 次要说明行（小字、可滚动、保留换行）。 */
  detail?: string;
  /** 可选操作按钮。 */
  action?: ToastAction;
  /** 自动消失毫秒数；0 = 常驻。 */
  ttl?: number;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  detail?: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
  /** 推送一条通知；同文案已在展示时仅重置计时。返回 toast id（供后续收起）。 */
  push: (kind: ToastKind, text: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const MAX_STACK = 4;
const DEFAULT_TTL: Record<ToastKind, number> = {
  success: 3500,
  error: 9000,
  info: 6000,
};

let seq = 1;
const timers = new Map<number, number>();

/** 去掉文案末尾的句号（中/英），通知文案统一无标点结尾。 */
function trimPeriod(s: string): string {
  return s.replace(/[.。]+\s*$/, "");
}

/** （重）设定自动消失计时。 */
function arm(id: number, ttl: number) {
  const prev = timers.get(id);
  if (prev !== undefined) window.clearTimeout(prev);
  if (ttl <= 0) return;
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      useToastStore.getState().dismiss(id);
    }, ttl),
  );
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text, opts) => {
    const ttl = opts?.ttl ?? DEFAULT_TTL[kind];
    const trimmed = trimPeriod(text);
    const existing = get().toasts.find((t) => t.kind === kind && t.text === trimmed);
    if (existing) {
      arm(existing.id, ttl);
      return existing.id;
    }
    const id = seq++;
    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          id,
          kind,
          text: trimmed,
          detail: opts?.detail?.replace(/[.。]+\s*$/, ""),
          action: opts?.action,
        },
      ].slice(-MAX_STACK),
    }));
    arm(id, ttl);
    return id;
  },
  dismiss: (id) => {
    const prev = timers.get(id);
    if (prev !== undefined) {
      window.clearTimeout(prev);
      timers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** 命令式便捷入口（事件回调/store action 中使用，无需 hook）。 */
export const toast = {
  success: (text: string, opts?: ToastOptions) =>
    useToastStore.getState().push("success", text, opts),
  error: (text: string, opts?: ToastOptions) =>
    useToastStore.getState().push("error", text, opts),
  info: (text: string, opts?: ToastOptions) =>
    useToastStore.getState().push("info", text, opts),
};
