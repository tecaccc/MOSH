/**
 * 农历（中国阴历 / 干支）展示工具，供首页月历与「今日」视图复用。
 *
 * 依赖 `lunar-typescript`（6tail，纯 JS、离线、含精确农历/干支算法）。
 * 入参统一为 date-only `YYYY-MM-DD`；输出为中文展示串。
 *
 * 设计稿（docs/pencil-new.pen · Aot2d / z0EdN）约定：
 *  - 月历副标题：`丙午年 · 七月`
 *  - 每日农历：`初一` / `十九` / `二十` / `廿一`（getDayInChinese）
 *  - 页脚完整：`农历丙午年 七月初一`
 */

import { Solar } from "lunar-typescript";

/** date-only `YYYY-MM-DD` → [y, m, d] 数字。非法 → null。 */
function parse(dateStr: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 单日农历对象（解析失败回退到今日）。 */
function lunarOf(dateStr: string) {
  const p = parse(dateStr);
  if (!p) return Solar.fromDate(new Date()).getLunar();
  return Solar.fromYmd(p[0], p[1], p[2]).getLunar();
}

/** 农历日（"初一" / "十九" / "廿一"）。 */
export function lunarDay(dateStr: string): string {
  return lunarOf(dateStr).getDayInChinese();
}

/** 月历副标题：`丙午年 · 七月`（干支年 + 农历月）。 */
export function lunarYearMonth(dateStr: string): string {
  const l = lunarOf(dateStr);
  return `${l.getYearInGanZhi()}年 · ${l.getMonthInChinese()}月`;
}

/** 页脚完整：`农历丙午年 七月初一`。 */
export function lunarFull(dateStr: string): string {
  const l = lunarOf(dateStr);
  return `农历${l.getYearInGanZhi()}年 ${l.getMonthInChinese()}月${l.getDayInChinese()}`;
}
