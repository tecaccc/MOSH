/**
 * 日历 reactive 状态（Svelte 5 runes 模块级 `$state`）。
 *
 * 严格遵守 `frontend/state-management` spec 的**函数导出**模式：
 * 被重新赋值的 `$state`（_mode / _cursor / _editingId）保持模块私有，
 * 外部只通过导出函数（mode / cursor / events / editingEvent / …）读取，
 * 以维持响应式。只做 mutate 不重赋值的 `_events` 用私有 const。
 *
 * 区间加载（见 design §3/§7）：按 mode+cursor 算窗口 from=首日(含)/to=末日+1(排他)，
 * 调 `listEvents`；视图随后用 `eventOnDay` 在内存事件上按日切分。
 */

import {
  createEvent as ipcCreateEvent,
  deleteRecord as ipcDeleteRecord,
  updateRecord as ipcUpdateRecord,
  listEvents as ipcListEvents,
} from "./ipc";
import { addDays, addMonths, mondayOfWeek, monthGridStart, monthStart, todayOnly } from "./calendar-grid";
import type { EventInput, Record as RecordT, RecordPatch } from "./types";

/** 日历视图模式。 */
export type CalMode = "month" | "week" | "day" | "agenda";

const _events = $state<RecordT[]>([]);
let _mode = $state<CalMode>("month");
let _cursor = $state<string>(todayOnly());
let _editingId = $state<string | null | undefined>(undefined);

/** 当前窗口内加载到内存的事件（响应式）。 */
export function events(): RecordT[] {
  return _events;
}

/** 当前模式（响应式）。 */
export function mode(): CalMode {
  return _mode;
}

/** 当前聚焦日期 date-only（响应式）。 */
export function cursor(): string {
  return _cursor;
}

/** 当前编辑的事件：null=新建、undefined=编辑器关闭、RecordT=编辑中（响应式）。 */
export function editingEvent(): RecordT | null | undefined {
  if (_editingId === undefined) return undefined;
  if (_editingId === null) return null;
  return _events.find((e) => e.id === _editingId);
}

/** 按 mode+cursor 计算区间窗口 [from, to)：from 含、to 排他（date-only）。 */
function window(): { from: string; to: string } {
  switch (_mode) {
    case "month":
      return { from: monthGridStart(_cursor), to: addDays(monthGridStart(_cursor), 42) };
    case "week":
      return { from: mondayOfWeek(_cursor), to: addDays(mondayOfWeek(_cursor), 7) };
    case "day":
      return { from: _cursor, to: addDays(_cursor, 1) };
    case "agenda":
      // 议程：以 cursor 为起点的 30 天窗口（翻页按 30 天步进）。
      return { from: _cursor, to: addDays(_cursor, 30) };
  }
}

/**
 * 按 mode+cursor 重新加载区间事件。组件在响应式上下文里追踪 mode()/cursor()
 * 后调用本函数以在翻页/切模式时刷新。
 */
export async function loadRange(): Promise<void> {
  const { from, to } = window();
  const list = await ipcListEvents(from, to);
  _events.splice(0, _events.length, ...list);
}

/** 切换模式（不主动 reload；由组件 effect 在 mode 变化时统一 reload）。 */
export function setMode(m: CalMode): void {
  _mode = m;
}

/**
 * 翻页：按当前模式的单位移动 cursor。
 * month→±1 月、week→±1 周、day→±1 天、agenda→±30 天。
 */
export function moveCursor(delta: number): void {
  switch (_mode) {
    case "month":
      _cursor = addMonths(_cursor, delta);
      break;
    case "week":
      _cursor = addDays(_cursor, 7 * delta);
      break;
    case "day":
      _cursor = addDays(_cursor, delta);
      break;
    case "agenda":
      _cursor = addDays(_cursor, 30 * delta);
      break;
  }
}

/** 聚焦回今天。 */
export function goToday(): void {
  _cursor = todayOnly();
}

/** 设置聚焦日（点格钻取等）。 */
export function setCursor(dateOnly: string): void {
  _cursor = dateOnly;
}

/** 钻取到某日（聚焦 + 切到 day 模式）。 */
export function openDay(dateOnly: string): void {
  _cursor = dateOnly;
  _mode = "day";
}

/** 打开新建事件表单；可选 prefill 该日（同时聚焦，供编辑器取默认起止）。 */
export function startCreateEvent(dateOnly?: string): void {
  if (dateOnly) _cursor = dateOnly;
  _editingId = null;
}

/** 打开指定事件的编辑器。 */
export function startEditEvent(id: string): void {
  _editingId = id;
}

/** 关闭事件编辑器。 */
export function closeEditor(): void {
  _editingId = undefined;
}

/** 创建事件后刷新区间。 */
export async function createEvent(input: EventInput): Promise<RecordT> {
  const rec = await ipcCreateEvent(input);
  await loadRange();
  _editingId = rec.id;
  return rec;
}

/** 部分更新事件后刷新区间。 */
export async function updateEvent(id: string, patch: RecordPatch): Promise<RecordT> {
  const rec = await ipcUpdateRecord(id, patch);
  await loadRange();
  return rec;
}

/** 取消事件（status=cancelled）后刷新。 */
export async function cancelEvent(id: string): Promise<RecordT> {
  return updateEvent(id, { status: "cancelled" });
}

/** 软删事件后刷新（并关掉对应编辑器）。 */
export async function deleteEvent(id: string): Promise<void> {
  await ipcDeleteRecord(id);
  if (_editingId === id) _editingId = undefined;
  await loadRange();
}
