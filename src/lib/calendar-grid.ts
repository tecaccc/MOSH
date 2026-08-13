/**
 * 纯日历网格日期运算（无 Svelte；store 与各视图共用）。
 *
 * 一切以 date-only `YYYY-MM-DD` 为锚点；周首日为**周一**（用户确认）。
 * 日期算术一律用**本地** `Date(y, m-1, d)` 构造，避免 UTC date-only 解析的时区漂移。
 */

import type { Record as RecordT } from "./types";
import { toDateOnly } from "./datetime";

/** 周一首的星期标签。 */
export function weekdayLabelsMonFirst(): string[] {
  return ["一", "二", "三", "四", "五", "六", "日"];
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parse(s: string): Ymd {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function fmt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今日的 date-only。 */
export function todayOnly(): string {
  return fmt(new Date());
}

/** date-only 加/减 N 天。 */
export function addDays(dateOnly: string, n: number): string {
  const { y, m, d } = parse(dateOnly);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return fmt(dt);
}

/** date-only 加/减 N 月（日份超界则钳到月末）。 */
export function addMonths(dateOnly: string, n: number): string {
  const { y, m, d } = parse(dateOnly);
  const dt = new Date(y, m - 1, d);
  dt.setMonth(dt.getMonth() + n);
  return fmt(dt);
}

/** date-only 所在月首日。 */
export function monthStart(dateOnly: string): string {
  const { y, m } = parse(dateOnly);
  return fmt(new Date(y, m - 1, 1));
}

/** date-only 所在周的周一。 */
export function mondayOfWeek(dateOnly: string): string {
  const { y, m, d } = parse(dateOnly);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7; // 周一=0 … 周日=6
  return addDays(dateOnly, -dow);
}

/** 月视图 6×7 网格首格：月首所在周的周一。 */
export function monthGridStart(dateOnly: string): string {
  return mondayOfWeek(monthStart(dateOnly));
}

/** 两个 date-only 是否同月（按 `YYYY-MM` 比较）。 */
export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** 同日。 */
export function isSameDay(a: string, b: string): boolean {
  return a === b;
}

/** 月份标签，如 `2026年8月`。 */
export function monthLabel(dateOnly: string): string {
  const { y, m } = parse(dateOnly);
  return `${y}年${m}月`;
}

/** 取日号（1–31）。 */
export function dayOfMonth(dateOnly: string): number {
  return parse(dateOnly).d;
}

/**
 * 事件是否落在某日（date-only）。
 * 全天事件：[start_at, end_at] 含端点逐日比较；定时事件：取两端本地日期，落在区间即算。
 * 两者统一：用 `toDateOnly` 归一后做闭区间比较（全天 end_at 含当天）。
 */
export function eventOnDay(event: RecordT, dateOnly: string): boolean {
  if (!event.start_at || !event.end_at) return false;
  const s = toDateOnly(event.start_at);
  const e = toDateOnly(event.end_at);
  return s <= dateOnly && e >= dateOnly;
}

/**
 * 某日的事件（全天置顶，再按 start_at 升序）。供月格/议程复用。
 */
export function orderedForDay(events: RecordT[], dateOnly: string): RecordT[] {
  return events
    .filter((e) => eventOnDay(e, dateOnly))
    .sort((a, b) => {
      const aAll = a.data.all_day === true ? 0 : 1;
      const bAll = b.data.all_day === true ? 0 : 1;
      if (aAll !== bAll) return aAll - bAll;
      return (a.start_at ?? "").localeCompare(b.start_at ?? "");
    });
}

/**
 * 定时事件在某日时间轴上的渲染块（分钟自当地 0:00 起）。
 * 跨日事件被**截断到当日 [0,1440]**（见 design 风险项），`clipped` 标记是否被截断。
 * 全天事件返回 null（由全天带渲染）。无重叠返回 null。
 */
export function timedBlockOnDay(
  event: RecordT,
  dateOnly: string,
): { startMin: number; endMin: number; clipped: boolean } | null {
  if (event.data.all_day === true || !event.start_at || !event.end_at) return null;
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const { y, m, d } = parse(dateOnly);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  if (end.getTime() <= dayStart || start.getTime() >= dayEnd) return null;

  const s = Math.max(start.getTime(), dayStart);
  const e = Math.min(end.getTime(), dayEnd);
  return {
    startMin: (s - dayStart) / 60000,
    endMin: (e - dayStart) / 60000,
    clipped: start.getTime() < dayStart || end.getTime() > dayEnd,
  };
}

/** 时间轴上某日的一个定时事件块（含通道布局结果）。 */
export interface TimedBlock {
  event: RecordT;
  startMin: number;
  endMin: number;
  clipped: boolean;
  lane: number;
  laneCount: number;
}

/**
 * 某日定时事件的通道布局：把相互重叠的事件归为同簇，簇内按贪婪分道，
 * 使重叠事件并排显示（而非互相遮挡）。`lane/laneCount` 供 CSS 算 left/width。
 */
export function layoutTimedDay(events: RecordT[], dateOnly: string): TimedBlock[] {
  const raw = events
    .map((e) => {
      const b = timedBlockOnDay(e, dateOnly);
      return b ? { event: e, ...b } : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const out: TimedBlock[] = [];
  let i = 0;
  while (i < raw.length) {
    // 收集一个重叠簇：后续 startMin < 簇内最大 endMin 者都属同簇。
    const cluster = [raw[i]];
    let clusterEnd = raw[i].endMin;
    let j = i + 1;
    while (j < raw.length && raw[j].startMin < clusterEnd) {
      cluster.push(raw[j]);
      clusterEnd = Math.max(clusterEnd, raw[j].endMin);
      j++;
    }
    // 簇内贪婪分道。
    const lanes: number[] = [];
    for (const b of cluster) {
      let lane = -1;
      for (let k = 0; k < lanes.length; k++) {
        if (lanes[k] <= b.startMin) {
          lanes[k] = b.endMin;
          lane = k;
          break;
        }
      }
      if (lane === -1) {
        lanes.push(b.endMin);
        lane = lanes.length - 1;
      }
      out.push({
        event: b.event,
        startMin: b.startMin,
        endMin: b.endMin,
        clipped: b.clipped,
        lane,
        laneCount: 0,
      });
    }
    const laneCount = lanes.length;
    for (let k = out.length - cluster.length; k < out.length; k++) {
      out[k].laneCount = laneCount;
    }
    i = j;
  }
  return out;
}
