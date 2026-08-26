import { useMemo } from "react";
import { useCalendarStore } from "../../state/calendar";
import {
  eventOnDay,
  isSameDay,
  layoutTimedDay,
  parseDateOnly,
  weekdayLabelsMonFirst,
} from "../../lib/calendar-grid";
import { useToday } from "../../lib/use-today";
import { formatTime } from "../../lib/datetime";
import type { RecordData as RecordData } from "../../lib/types";
import styles from "./TimeGrid.module.css";

/**
 * 周/日视图共用的时间网格：顶部全天带 + 24h 时间轴。
 * days 为 1（日视图）或 7（周视图）个 date-only。
 * 定时事件绝对定位；重叠按通道并排；跨日截断到当日并标 `…`。
 */

const HOUR_H = 44;
const hours = Array.from({ length: 24 }, (_, h) => h);
const weekdayLabels = weekdayLabelsMonFirst();

interface BlockStyleInput {
  startMin: number;
  endMin: number;
  lane: number;
  laneCount: number;
}

function blockStyle(b: BlockStyleInput): React.CSSProperties {
  const top = (b.startMin / 60) * HOUR_H;
  const height = Math.max(((b.endMin - b.startMin) / 60) * HOUR_H, 16);
  const widthPct = 100 / b.laneCount;
  const leftPct = b.lane * widthPct;
  return { top, height, left: `${leftPct}%`, width: `${widthPct}%` };
}

export default function TimeGrid({ days }: { days: string[] }) {
  const renderEvents = useCalendarStore((s) => s.renderEvents);
  const openDay = useCalendarStore((s) => s.openDay);
  const startCreateEvent = useCalendarStore((s) => s.startCreateEvent);
  const startEditEvent = useCalendarStore((s) => s.startEditEvent);
  // 响应式今日：跨午夜后日头部高亮跟随。
  const today = useToday();

  const gridTemplate = { gridTemplateColumns: `48px repeat(${days.length}, 1fr)` };
  const axisHeight = { height: HOUR_H * 24 };

  const allDayChips = (day: string): RecordData[] =>
    renderEvents.filter((e) => e.data.all_day === true && eventOnDay(e, day));
  const timedBlocks = (day: string) => layoutTimedDay(renderEvents, day);

  return (
    <div className={styles.tg}>
      {/* 日头部：空角 + 各日 */}
      <div className={styles.head} style={gridTemplate}>
        <div className={styles.corner} />
        {days.map((day) => (
          <button
            key={day}
            type="button"
            className={`${styles.dayhead}${isSameDay(day, today) ? ` ${styles.today}` : ""}`}
            onClick={() => openDay(day)}
          >
            <span className={styles.dow}>{weekdayLabels[(parseDateOnly(day).getDay() + 6) % 7]}</span>
            <span className={styles.dnum}>{Number(day.slice(8, 10))}</span>
          </button>
        ))}
      </div>

      {/* 全天带 */}
      <div className={styles.allday} style={gridTemplate}>
        <div className={`${styles.corner} ${styles["allday-label"]}`}>全天</div>
        {days.map((day) => (
          <div key={day} className={styles["ad-cell"]}>
            {allDayChips(day).map((ev) => (
              <button
                key={ev.id}
                type="button"
                className={`${styles["ad-chip"]}${ev.status === "cancelled" ? ` ${styles.cancelled}` : ""}`}
                onClick={() => startEditEvent(ev.id)}
                title={ev.title}
              >
                {ev.title}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 时间轴 */}
      <div className={styles.timeline}>
        <div className={styles.axis} style={gridTemplate}>
          <div className={styles.gutter} style={axisHeight}>
            {hours.map((h) => (
              <div key={h} className={styles["hour-label"]} style={{ top: h * HOUR_H }}>
                {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>

          {days.map((day) => (
            <div
              key={day}
              className={styles.daycol}
              style={axisHeight}
              role="button"
              tabIndex={0}
              onClick={() => startCreateEvent(day)}
              onKeyDown={(e) => e.key === "Enter" && startCreateEvent(day)}
            >
              {hours.map((h) => (
                <div key={h} className={styles["hour-line"]} style={{ top: h * HOUR_H }} />
              ))}
              {timedBlocks(day).map((b) => (
                <button
                  key={b.event.id}
                  type="button"
                  className={`${styles.block}${b.event.status === "cancelled" ? ` ${styles.cancelled}` : ""}`}
                  style={blockStyle(b)}
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditEvent(b.event.id);
                  }}
                  title={b.event.title}
                >
                  <div className={styles["block-time"]}>{formatTime(b.event.start_at)}</div>
                  <div className={styles["block-title"]}>{b.event.title}{b.clipped ? " …" : ""}</div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
