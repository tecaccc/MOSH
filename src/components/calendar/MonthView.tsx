import { useMemo } from "react";
import { useCalendarStore } from "../../state/calendar";
import {
  addDays,
  dayOfMonth,
  isSameDay,
  isSameMonth,
  monthGridStart,
  orderedForDay,
  todayOnly,
  weekdayLabelsMonFirst,
} from "../../lib/calendar-grid";
import { formatTime } from "../../lib/datetime";
import type { Record as RecordT } from "../../lib/types";
import styles from "./MonthView.module.css";

/** 月视图：6×7 网格（周一首）。点格空白 → 当日新建；点事件 → 编辑。 */

const labels = weekdayLabelsMonFirst();
const today = todayOnly();

export default function MonthView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const renderEvents = useCalendarStore((s) => s.renderEvents);
  const startCreateEvent = useCalendarStore((s) => s.startCreateEvent);
  const startEditEvent = useCalendarStore((s) => s.startEditEvent);

  const days = useMemo(() => {
    const start = monthGridStart(cursor);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [cursor]);

  const dayEvents = (day: string): RecordT[] => orderedForDay(renderEvents, day);

  return (
    <div className={styles.month}>
      <div className={styles.weekdays}>
        {labels.map((label) => (
          <div key={label} className={styles.weekday}>{label}</div>
        ))}
      </div>

      <div className={styles.grid}>
        {days.map((day) => (
          <div
            key={day}
            className={`${styles.cell}${!isSameMonth(day, cursor) ? ` ${styles.out}` : ""}${isSameDay(day, today) ? ` ${styles.today}` : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => startCreateEvent(day)}
            onKeyDown={(e) => e.key === "Enter" && startCreateEvent(day)}
          >
            <div className={styles.daynum}>{dayOfMonth(day)}</div>
            <div className={styles.evts}>
              {dayEvents(day).map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  className={`${styles.chip}${ev.data.all_day === true ? ` ${styles.allday}` : ""}${ev.status === "cancelled" ? ` ${styles.cancelled}` : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditEvent(ev.id);
                  }}
                  title={`${ev.title}${typeof ev.data.location === "string" && ev.data.location ? " · " + (ev.data.location as string) : ""}`}
                >
                  {ev.data.all_day === true ? (
                    <span className={styles["chip-title"]}>{ev.title}</span>
                  ) : (
                    <>
                      <span className={styles["chip-time"]}>{formatTime(ev.start_at)}</span>
                      <span className={styles["chip-title"]}>{ev.title}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
