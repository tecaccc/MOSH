/**
 * 日历状态（zustand；原 calendar.svelte.ts 迁移）。
 *
 * 区间加载策略不变：按 mode+cursor 算窗口 [from,to)（from 含、to 排他），
 * 调 listEvents；视图用 eventOnDay 在内存渲染事件上按日切分。
 * 组件在 mode/cursor 变化时 useEffect 调 loadRange()。
 */

import { create } from "zustand";
import {
  addDays,
  addMonths,
  expandRecurring,
  mondayOfWeek,
  monthGridStart,
  occurrenceParentId,
  todayOnly,
} from "../lib/calendar-grid";
import {
  createEvent as ipcCreateEvent,
  deleteRecord as ipcDeleteRecord,
  listEvents as ipcListEvents,
  updateRecord as ipcUpdateRecord,
} from "../lib/ipc";
import type { EventInput, RecordData, RecordPatch } from "../lib/types";

/** 日历视图模式。 */
export type CalMode = "month" | "week" | "day" | "agenda";

interface CalendarState {
  /** 当前窗口内加载到内存的原始事件（编辑/查找用）。 */
  events: RecordData[];
  /** 展开周期后的渲染事件（occurrence id 带 `::` 后缀）。 */
  renderEvents: RecordData[];
  mode: CalMode;
  /** 当前聚焦日期 date-only。 */
  cursor: string;
  /**
  * 应用启动时的「今天」（date-only）。托盘常驻跨午夜后，CalendarPane 据此判断
  * 光标是否仍停在启动日（即未被用户翻页）→ 自动跟随到新「今天」。
  */
  initDay: string;
  /** null=新建、undefined=编辑器关闭、id=编辑中。 */
  editingId: string | null | undefined;

  loadRange(): Promise<void>;
  loadEvents(from: string, to: string): Promise<void>;
  setMode(m: CalMode): void;
  moveCursor(delta: number): void;
  goToday(): void;
  setCursor(dateOnly: string): void;
  openDay(dateOnly: string): void;
  startCreateEvent(dateOnly?: string): void;
  startEditEvent(id: string): void;
  closeEditor(): void;
  createEvent(input: EventInput): Promise<RecordData>;
  updateEvent(id: string, patch: RecordPatch): Promise<RecordData>;
  cancelEvent(id: string): Promise<RecordData>;
  deleteEvent(id: string): Promise<void>;
}

/** 按 mode+cursor 计算区间窗口 [from, to)（date-only）。 */
function windowOf(mode: CalMode, cursor: string): { from: string; to: string } {
  switch (mode) {
    case "month":
      return { from: monthGridStart(cursor), to: addDays(monthGridStart(cursor), 42) };
    case "week":
      return { from: mondayOfWeek(cursor), to: addDays(mondayOfWeek(cursor), 7) };
    case "day":
      return { from: cursor, to: addDays(cursor, 1) };
    case "agenda":
      // 议程：以 cursor 为起点的 30 天窗口（翻页按 30 天步进）。
      return { from: cursor, to: addDays(cursor, 30) };
  }
}

export const useCalendarStore = create<CalendarState>()((set, get) => ({
  events: [],
  renderEvents: [],
  mode: "month",
  cursor: todayOnly(),
  initDay: todayOnly(),
  editingId: undefined,

  loadRange: async () => {
    const { mode, cursor } = get();
    const { from, to } = windowOf(mode, cursor);
    const list = await ipcListEvents(from, to);
    set({ events: list, renderEvents: expandRecurring(list, from, to) });
  },

  /** 显式加载指定区间（首页等非日历视图复用；不受 mode/cursor 影响）。 */
  loadEvents: async (from, to) => {
    const list = await ipcListEvents(from, to);
    set({ events: list, renderEvents: expandRecurring(list, from, to) });
  },

  setMode: (m) => set({ mode: m }),

  moveCursor: (delta) =>
    set((s) => {
      switch (s.mode) {
        case "month":
          return { cursor: addMonths(s.cursor, delta) };
        case "week":
          return { cursor: addDays(s.cursor, 7 * delta) };
        case "day":
          return { cursor: addDays(s.cursor, delta) };
        case "agenda":
          return { cursor: addDays(s.cursor, 30 * delta) };
      }
    }),

  goToday: () => set({ cursor: todayOnly() }),
  setCursor: (dateOnly) => set({ cursor: dateOnly }),
  openDay: (dateOnly) => set({ cursor: dateOnly, mode: "day" }),

  startCreateEvent: (dateOnly) =>
    set((s) => ({ ...(dateOnly ? { cursor: dateOnly } : {}), editingId: null })),
  startEditEvent: (id) => set({ editingId: occurrenceParentId(id) }),
  closeEditor: () => set({ editingId: undefined }),

  createEvent: async (input) => {
    const rec = await ipcCreateEvent(input);
    await get().loadRange();
    set({ editingId: rec.id });
    return rec;
  },

  updateEvent: async (id, patch) => {
    const rec = await ipcUpdateRecord(id, patch);
    await get().loadRange();
    return rec;
  },

  cancelEvent: async (id) => {
    return get().updateEvent(id, { status: "cancelled" });
  },

  deleteEvent: async (id) => {
    await ipcDeleteRecord(id);
    set((s) => (s.editingId === id ? { editingId: undefined } : s));
    await get().loadRange();
  },
}));

/** 当前编辑的事件：null=新建、undefined=关闭、RecordData=编辑中（派生）。 */
export function editingEventOf(
  events: RecordData[],
  editingId: string | null | undefined,
): RecordData | null | undefined {
  if (editingId === undefined) return undefined;
  if (editingId === null) return null;
  return events.find((e) => e.id === editingId);
}
