import { useCalendarStore } from "../../state/calendar";
import TimeGrid from "./TimeGrid";

/** 日视图：当前 cursor 当日的全天带 + 时间轴。 */

export default function DayView() {
  const cursor = useCalendarStore((s) => s.cursor);
  return <TimeGrid days={[cursor]} />;
}
