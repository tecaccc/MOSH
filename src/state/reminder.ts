/**
 * 事件提醒（zustand；原 reminder.svelte.ts 迁移）。
 *
 * 每 60s 轮询未来 15 天事件，展开周期后把提醒时刻已到（事件尚未开始）
 * 的事件推入 due 列表，由 ReminderToast 顶部弹出展示。
 * 已触发/已关闭的提醒用模块级 _fired 去重（进程内记忆，不落库）。
 */

import { create } from "zustand";
import { addDays, expandRecurring, reminderMinutesOf, todayOnly } from "../lib/calendar-grid";
import { listEvents } from "../lib/ipc";
import type { Record as RecordT } from "../lib/types";

interface ReminderState {
  due: RecordT[];
  dismissReminder(e: RecordT): void;
  pollReminders(): Promise<void>;
}

const _fired = new Set<string>();
let _started = false;

function keyOf(e: RecordT): string {
  return `${e.id}::${e.start_at ?? ""}`;
}

export const useReminderStore = create<ReminderState>()((set) => ({
  due: [],

  dismissReminder: (e) => {
    _fired.add(keyOf(e));
    set((s) => ({ due: s.due.filter((x) => keyOf(x) !== keyOf(e)) }));
  },

  pollReminders: async () => {
    const from = todayOnly();
    const to = addDays(from, 15);
    let list: RecordT[];
    try {
      list = await listEvents(from, to);
    } catch {
      return; // 非 Tauri 环境忽略
    }
    const expanded = expandRecurring(list, from, to);
    const now = Date.now();
    const fresh: RecordT[] = [];
    for (const ev of expanded) {
      if (ev.status !== "active" || !ev.start_at) continue;
      const minutes = reminderMinutesOf(ev);
      if (minutes <= 0) continue;
      const start = new Date(ev.start_at).getTime();
      if (Number.isNaN(start)) continue;
      const at = start - minutes * 60_000;
      const key = keyOf(ev);
      if (now >= at && now < start && !_fired.has(key)) {
        _fired.add(key);
        fresh.push(ev);
      }
    }
    if (fresh.length > 0) set((s) => ({ due: [...s.due, ...fresh] }));
  },
}));

/** 启动提醒轮询（幂等）。App 根挂载后调用一次。 */
export function startReminders(): void {
  if (_started) return;
  _started = true;
  void useReminderStore.getState().pollReminders();
  setInterval(() => void useReminderStore.getState().pollReminders(), 60_000);
}
