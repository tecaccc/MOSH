import { useEffect } from "react";
import { useCalendarStore, type CalMode } from "../../state/calendar";
import { useAppStore } from "../../state/store";
import { addDays, mondayOfWeek, monthLabel } from "../../lib/calendar-grid";
import { formatDate } from "../../lib/datetime";
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
        const dow = ["日", "一", "二", "三", "四", "五", "六"][new Date(cursor).getDay()];
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
