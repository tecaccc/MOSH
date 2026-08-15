import { useEffect } from "react";
import { formatDateTime } from "../lib/datetime";
import { startReminders, useReminderStore } from "../state/reminder";
import { useAppStore } from "../state/store";
import styles from "./ReminderToast.module.css";

/** 提醒弹出式通知：顶部右侧堆叠显示到点的事件提醒。 */

export default function ReminderToast() {
  const due = useReminderStore((s) => s.due);
  const dismiss = useReminderStore((s) => s.dismissReminder);
  const setView = useAppStore((s) => s.setView);

  useEffect(() => {
    startReminders();
  }, []);

  return (
    <>
      {due.map((r) => (
        <div key={r.id + (r.start_at ?? "")} className={styles.reminder} role="status">
          <span className={styles.rico}>⏰</span>
          <div className={styles.rtext}>
            <div className={styles.rtitle}>{r.title}</div>
            <div className={styles.rtime}>{formatDateTime(r.start_at)}</div>
          </div>
          <button type="button" className={styles.rview} onClick={() => setView("calendar")}>
            查看
          </button>
          <button
            type="button"
            className={styles.rclose}
            onClick={() => dismiss(r)}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}
