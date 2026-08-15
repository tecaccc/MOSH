import { useMemo, useState } from "react";
import { priorityOf, subtasksOf, useAppStore } from "../state/store";
import type { Record as RecordT, Status } from "../lib/types";
import styles from "./TodoItem.module.css";

/**
 * 单条 todo 渲染：完成切换、标题、优先级色标、截止、标签；
 * 操作：编辑、删除、添加子任务（仅顶层）；可折叠子任务。
 * 子任务复用本组件递归渲染（子任务不可再挂子任务）。
 */

const PRIO_CLASS: Record<string, string> = {
  none: styles.pNone,
  low: styles.pLow,
  medium: styles.pMedium,
  high: styles.pHigh,
};

function formatDue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TodoItem({ record }: { record: RecordT }) {
  const records = useAppStore((s) => s.records);
  const setTodoStatus = useAppStore((s) => s.setTodoStatus);
  const deleteRecord = useAppStore((s) => s.deleteRecord);
  const addSubtask = useAppStore((s) => s.addSubtask);
  const startEdit = useAppStore((s) => s.startEdit);

  const isTopLevel = record.parent_id === null;
  const priority = priorityOf(record);
  const isDone = record.status === "done";
  const children = useMemo(
    () => (isTopLevel ? subtasksOf(records, record.id) : []),
    [isTopLevel, records, record.id],
  );

  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dueLabel = formatDue(record.end_at);
  const overdue = useMemo(() => {
    if (!record.end_at || record.status === "done") return false;
    const d = new Date(record.end_at);
    return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
  }, [record.end_at, record.status]);

  async function onToggle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next: Status = isDone ? "active" : "done";
      await setTodoStatus(record.id, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (busy) return;
    if (!confirm(`删除「${record.title}」？此为软删，数据保留于库。`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRecord(record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAddSubtask() {
    const title = window.prompt("子任务标题：");
    if (!title || title.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await addSubtask(record.id, { title: title.trim(), priority: "none", tags: [] });
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles["todo-item"]}${isDone ? ` ${styles.done}` : ""}`}>
      <div className={styles["row-main"]}>
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => void onToggle()}
          disabled={busy}
          aria-label={isDone ? "标记为未完成" : "标记为已完成"}
        />

        <span
          className={`${styles["prio-dot"]} ${PRIO_CLASS[priority]}`}
          title={`优先级: ${priority}`}
        />

        <button type="button" className={styles["title-btn"]} onClick={() => startEdit(record.id)} title="编辑">
          <span className={styles.title}>{record.title}</span>
        </button>

        {dueLabel ? (
          <span className={`${styles.due}${overdue ? ` ${styles.overdue}` : ""}`}>{dueLabel}</span>
        ) : null}

        {record.tags.length > 0 ? (
          <span className={styles.tags}>
            {record.tags.map((tag) => (
              <span key={tag} className={styles.tag}>#{tag}</span>
            ))}
          </span>
        ) : null}

        <div className={styles.spacer} />

        <div className={styles.actions}>
          {isTopLevel ? (
            <button type="button" className={styles.action} onClick={() => void onAddSubtask()} disabled={busy} title="添加子任务">
              + 子任务
            </button>
          ) : null}
          {isTopLevel && children.length > 0 ? (
            <button type="button" className={styles.action} onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : "展开"}({children.length})
            </button>
          ) : null}
          <button type="button" className={styles.action} onClick={() => startEdit(record.id)} disabled={busy} title="编辑">
            编辑
          </button>
          <button type="button" className={`${styles.action} ${styles.danger}`} onClick={() => void onDelete()} disabled={busy} title="删除">
            删除
          </button>
        </div>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {isTopLevel && expanded && children.length > 0 ? (
        <ul className={styles.subtasks}>
          {children.map((child) => (
            <li key={child.id}>
              <TodoItem record={child} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
