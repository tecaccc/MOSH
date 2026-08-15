import { useMemo } from "react";
import { useCalendarStore } from "../../state/calendar";
import {
  addDays,
  eventOnDay,
  isSameDay,
  todayOnly,
  weekdayLabelsMonFirst,
} from "../../lib/calendar-grid";
import { formatDate, formatTime } from "../../lib/datetime";
import type { Record as RecordT } from "../../lib/types";
import styles from "./AgendaView.module.css";

/**
 * 议程视图：窗口（cursor 起 30 天）内事件按日分组列表。
 * 全天事件归其 start 日（多日全天只显示一次，附 `→ end`）；定时按触及日。
 */

const today = todayOnly();
const weekdayLabels = weekdayLabelsMonFirst();

interface DayGroup {
  day: string;
  items: RecordT[];
}

export default function AgendaView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const renderEvents = useCalendarStore((s) => s.renderEvents);
  const startEditEvent = useCalendarStore((s) => s.startEditEvent);

  const groups = useMemo<DayGroup[]>(() => {
    const days = Array.from({ length: 30 }, (_, i) => addDays(cursor, i));
    return days
      .map((day) => {
        const starting = renderEvents.filter(
          (e) => e.data.all_day === true && (e.start_at ?? "") === day,
        );
        const timed = renderEvents.filter((e) => e.data.all_day !== true && eventOnDay(e, day));
        const items = [...starting, ...timed].sort((a, b) =>
          (a.start_at ?? "").localeCompare(b.start_at ?? ""),
        );
        return { day, items };
      })
      .filter((g) => g.items.length > 0);
  }, [cursor, renderEvents]);

  const dowOf = (day: string) => weekdayLabels[(new Date(day).getDay() + 6) % 7];

  return (
    <div className={styles.agenda}>
      {groups.length === 0 ? (
        <div className={styles.empty}>未来 30 天暂无事件</div>
      ) : (
        groups.map((g) => (
          <section key={g.day} className={styles.day}>
            <header className={`${styles["day-head"]}${isSameDay(g.day, today) ? ` ${styles.today}` : ""}`}>
              <span className={styles.date}>{formatDate(g.day)}</span>
              <span className={styles.dow}>{dowOf(g.day)}</span>
            </header>
            <ul className={styles.items}>
              {g.items.map((ev) => (
                <li key={ev.id}>
                  <button
                    type="button"
                    className={`${styles.row}${ev.data.all_day === true ? ` ${styles.allday}` : ""}${ev.status === "cancelled" ? ` ${styles.cancelled}` : ""}`}
                    onClick={() => startEditEvent(ev.id)}
                  >
                    {ev.data.all_day === true ? (
                      <span className={styles.time}>全天</span>
                    ) : (
                      <span className={styles.time}>{formatTime(ev.start_at)}</span>
                    )}
                    <span className={styles.title}>{ev.title}</span>
                    {typeof ev.data.location === "string" && ev.data.location ? (
                      <span className={styles.loc}>@ {ev.data.location as string}</span>
                    ) : null}
                    {ev.data.all_day === true && ev.end_at && ev.end_at !== ev.start_at ? (
                      <span className={styles.until}>→ {formatDate(ev.end_at)}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
