import { useMemo } from "react";
import { useCalendarStore } from "../../state/calendar";
import { addDays, mondayOfWeek } from "../../lib/calendar-grid";
import TimeGrid from "./TimeGrid";

/** 周视图：当前 cursor 所在周（周一首）的 7 天时间网格。 */

export default function WeekView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const days = useMemo(() => {
    const start = mondayOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [cursor]);

  return <TimeGrid days={days} />;
}
