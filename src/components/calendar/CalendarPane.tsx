import { useEffect, useRef } from "react";
import { useCalendarStore, type CalMode } from "../../state/calendar";
import { useAppStore } from "../../state/store";
import { addDays, mondayOfWeek, monthLabel, parseDateOnly } from "../../lib/calendar-grid";
import { formatDate } from "../../lib/datetime";
import { useToday } from "../../lib/use-today";
import AgendaView from "./AgendaView";
import DayView from "./DayView";
import MonthView from "./MonthView";
import WeekView from "./WeekView";
import styles from "./CalendarPane.module.css";

/** 日历面板：工具栏（模式切换/翻页/今天/新建）+ 当前模式视图。 */

const modes: { key: CalMode; label: string }[] = [
  { key: "month", label: "月" },
  { key: "week", label: "周" },
  { key: "day", label: "日" },
  { key: "agenda", label: "议程" },
];

export default function CalendarPane() {
  const mode = useCalendarStore((s) => s.mode);
  const cursor = useCalendarStore((s) => s.cursor);
  const moveCursor = useCalendarStore((s) => s.moveCursor);
  const goToday = useCalendarStore((s) => s.goToday);
  const setMode = useCalendarStore((s) => s.setMode);
  const startCreateEvent = useCalendarStore((s) => s.startCreateEvent);
  const loadRange = useCalendarStore((s) => s.loadRange);
  // AI 工具等外部变更后自增，触发重载当前区间。
  const dataVersion = useAppStore((s) => s.dataVersion);

  // 响应式「今天」：跨午夜后跟随（光标仍停在旧今天/启动日时自动跳到新今天）。
  const today = useToday();
  const prevToday = useRef(today);
  useEffect(() => {
    const prev = prevToday.current;
    prevToday.current = today;
    const { cursor, initDay } = useCalendarStore.getState();
    // 用户已翻页离开（光标既非旧今天也非启动日）则不打扰；否则定位到新今天。
    if (cursor !== today && (cursor === prev || cursor === initDay)) goToday();
  }, [today, goToday]);

  // 首挂载 + mode/cursor 变化 + 外部数据变更时刷新区间。
  useEffect(() => {
    void loadRange();
  }, [mode, cursor, loadRange, dataVersion]);

  const title = (() => {
    switch (mode) {
      case "month":
        return monthLabel(cursor);
      case "week": {
        const s = mondayOfWeek(cursor);
        return `${formatDate(s)} – ${formatDate(addDays(s, 6))}`;
      }
      case "day": {
        // date-only 需本地构造取星期（字符串直解按 UTC，负时区会错位到前一天）。
        const dow = ["日", "一", "二", "三", "四", "五", "六"][parseDateOnly(cursor).getDay()];
        return `${formatDate(cursor)} 周${dow}`;
      }
      case "agenda":
        return `议程 · ${formatDate(cursor)} 起`;
    }
  })();

  return (
    <div className={styles.pane}>
      <header className={styles.toolbar}>
        <div className={styles.nav}>
          <button type="button" className={styles.btn} onClick={() => moveCursor(-1)} aria-label="上一页">‹</button>
          <button type="button" className={styles.today} onClick={goToday}>今天</button>
          <button type="button" className={styles.btn} onClick={() => moveCursor(1)} aria-label="下一页">›</button>
        </div>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.right}>
          <div className={styles.modes} role="tablist">
            {modes.map((m) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                className={`${styles.mode}${mode === m.key ? ` ${styles.active}` : ""}`}
                aria-selected={mode === m.key}
                onClick={() => setMode(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.new} onClick={() => startCreateEvent()}>+ 新建事件</button>
        </div>
      </header>

      <div className={styles.view}>
        {mode === "month" ? (
          <MonthView />
        ) : mode === "week" ? (
          <WeekView />
        ) : mode === "day" ? (
          <DayView />
        ) : (
          <AgendaView />
        )}
      </div>
    </div>
  );
}
