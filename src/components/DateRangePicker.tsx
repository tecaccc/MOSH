import { useMemo, useState } from "react";
import styles from "./DateRangePicker.module.css";

/**
 * 日历区间筛选（待办事项页日期过滤用）：触发按钮 + 弹层月历。
 *
 * 交互（常见日历区间范式）：
 * - 无区间或已有完整区间时点击 → 设为起点；
 * - 已有起点时再点 → 设为终点（早于起点的点击重设起点；点同一天 = 单日区间）；
 * - 终点选定后弹层自动收起；单边（仅起点/仅终点）为开区间，可手动收起生效。
 * 区间值为 date-only `YYYY-MM-DD`（字符串字典序即日期序）；单边 null = 该侧不限。
 */

/** 日期区间（date-only；单边 null = 开区间）。 */
export interface DateRange {
  from: string | null;
  to: string | null;
}

export const EMPTY_RANGE: DateRange = { from: null, to: null };

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

const pad = (n: number): string => String(n).padStart(2, "0");
const keyOf = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateFromKey = (k: string): Date => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** 单日键 → 展示串（如 “8月13日”；带年标记时如 “2025年12月30日”）。 */
function pretty(k: string, withYear: boolean): string {
  const [, mo, da] = k.split("-");
  const md = `${parseInt(mo, 10)}月${parseInt(da, 10)}日`;
  return withYear ? `${k.slice(0, 4)}年${md}` : md;
}

/** 区间 → 触发钮/标题文案（跨年时两端都带年份）。 */
export function rangeLabel(r: DateRange): string {
  if (r.from && r.to) {
    const crossYear = r.from.slice(0, 4) !== r.to.slice(0, 4);
    return `${pretty(r.from, crossYear)} – ${pretty(r.to, crossYear)}`;
  }
  if (r.from) return `${pretty(r.from, false)} 起`;
  if (r.to) return `至 ${pretty(r.to, false)}`;
  return "日历筛选";
}

/** 渲染网格：从当月首日所在的周一起其 6 周（42 格，含前后月补位）。 */
function gridOf(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

interface Props {
  range: DateRange;
  onChange: (range: DateRange) => void;
}

export default function DateRangePicker({ range, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => new Date());

  const cells = useMemo(() => gridOf(cursor), [cursor]);
  const todayKey = keyOf(new Date());
  const active = range.from !== null || range.to !== null;

  const openPicker = () => {
    // 游标定位到已有起点的月份（无则当月），便于续选/调整。
    setCursor(range.from ? dateFromKey(range.from) : new Date());
    setOpen(true);
  };

  const onPick = (key: string) => {
    if (!range.from || (range.from && range.to)) {
      onChange({ from: key, to: null }); // 起点选定
      return;
    }
    if (key === range.from) {
      onChange({ from: key, to: key }); // 同一天 = 单日区间
      setOpen(false);
      return;
    }
    if (key > range.from) {
      onChange({ from: range.from, to: key }); // 完整区间 → 收起
      setOpen(false);
      return;
    }
    onChange({ from: key, to: null }); // 早于起点：重设起点
  };

  const navMonth = (delta: number) => {
    const d = new Date(cursor);
    d.setMonth(d.getMonth() + delta);
    setCursor(d);
  };

  const title = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;

  return (
    <div className={styles.range}>
      <button
        type="button"
        className={`${styles["range-btn"]}${active ? ` ${styles.on}` : ""}`}
        onClick={() => (open ? setOpen(false) : openPicker())}
        title="按日历选择日期区间筛选"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M8 3v4M16 3v4M3 10h18" />
        </svg>
        {active ? rangeLabel(range) : "日历筛选"}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className={styles["cal-mask"]}
            aria-label="关闭日历"
            onClick={() => setOpen(false)}
          />
          <div className={styles.cal} role="dialog" aria-label="日期区间选择">
            <div className={styles["cal-head"]}>
              <button type="button" className={styles["cal-nav"]} onClick={() => navMonth(-1)} aria-label="上一月">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <span className={styles["cal-title"]}>{title}</span>
              <button type="button" className={styles["cal-nav"]} onClick={() => navMonth(1)} aria-label="下一月">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>

            <div className={styles["cal-week"]}>
              {WEEKDAYS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>

            <div className={styles["cal-grid"]}>
              {cells.map((d) => {
                const key = keyOf(d);
                const inMonth = sameMonth(d, cursor);
                const isToday = key === todayKey;
                const isSel = key === range.from || key === range.to;
                const inRange =
                  range.from !== null &&
                  range.to !== null &&
                  key > range.from &&
                  key < range.to;
                return (
                  <button
                    key={key}
                    type="button"
                    className={[
                      styles["cal-cell"],
                      inMonth ? "" : ` ${styles.muted}`,
                      isToday ? ` ${styles.today}` : "",
                      inRange ? ` ${styles.inrange}` : "",
                      isSel ? ` ${styles.sel}` : "",
                    ].join("").trim()}
                    onClick={() => onPick(key)}
                    aria-label={`${key}`}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>

            <div className={styles["cal-foot"]}>
              <span className={styles["cal-hint"]}>
                {range.from && !range.to
                  ? "已选起点，再点一天作为终点（可先关闭=仅起点起筛）"
                  : "点击两天选择区间（同一天=单日）"}
              </span>
              <div className={styles["cal-foot-btns"]}>
                <button type="button" className={styles["cal-today"]} onClick={() => setCursor(new Date())}>
                  回到本月
                </button>
                {active ? (
                  <button type="button" className={styles["cal-clear"]} onClick={() => onChange(EMPTY_RANGE)}>
                    清除区间
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
