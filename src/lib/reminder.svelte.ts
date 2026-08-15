/**
 * 事件提醒（任务 TODO：支持事件周期提醒）。
 *
 * 在 App 根挂载后每 60s 轮询一次未来 15 天的事件，把设置了 `reminder_minutes`
 * 且提醒时刻已到（事件尚未开始）的事件推入 `dueReminders()`，由 ReminderToast
 * 组件以顶部弹出式通知展示。周期事件先 `expandRecurring` 展开再判定。
 *
 * 已触发/已关闭的提醒用 `_fired` 去重（进程内记忆，不落库）。
 */

import { listEvents } from "./ipc";
import { addDays, expandRecurring, reminderMinutesOf, todayOnly } from "./calendar-grid";
import type { Record as RecordT } from "./types";

let _due = $state<RecordT[]>([]);
const _fired = new Set<string>();
let _started = false;

function keyOf(e: RecordT): string {
  return `${e.id}::${e.start_at ?? ""}`;
}

/** 当前到点待展示的提醒（响应式）。 */
export function dueReminders(): RecordT[] {
  return _due;
}

/** 关闭某条提醒（从列表移除并标记已触发）。 */
export function dismissReminder(e: RecordT): void {
  _fired.add(keyOf(e));
  _due = _due.filter((x) => keyOf(x) !== keyOf(e));
}

/** 轮询一次：加载未来 15 天事件，展开周期，挑出提醒已到点者。 */
export async function pollReminders(): Promise<void> {
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
    // 提醒时刻已到且事件尚未开始 → 触发一次。
    if (now >= at && now < start && !_fired.has(key)) {
      _fired.add(key);
      fresh.push(ev);
    }
  }
  if (fresh.length > 0) _due = [..._due, ...fresh];
}

/** 启动提醒轮询（幂等）。 */
export function startReminders(): void {
  if (_started) return;
  _started = true;
  void pollReminders();
  setInterval(() => void pollReminders(), 60_000);
}
