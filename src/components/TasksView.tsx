import { useMemo } from "react";
import { useAppStore } from "../state/store";
import type { Priority, RecordData as RecordT } from "../lib/types";
import TodoItem from "./TodoItem";
import styles from "./TasksView.module.css";

/** 任务列表视图：全部 todo（顶层 + 嵌套子任务），按截止/优先级排序。 */

const PRIO_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };

function sortKey(r: RecordT): string {
  const due = r.end_at ?? "9999-12-31T23:59:59Z";
  return `${due}|${PRIO_RANK[r.data.priority ?? "none"]}|${r.title}`;
}

export default function TasksView(): React.ReactElement {
  const records = useAppStore((s) => s.records);
  const top = useMemo(() => records.filter((r) => r.parent_id === null), [records]);
  const sorted = useMemo(
    () => [...top].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    [top],
  );

  return (
    <section className={styles.view}>
      <header className={styles["view-header"]}>
        <h1>任务</h1>
        <span className={styles.count}>{top.length} 项</span>
      </header>

      {top.length === 0 ? (
        <div className={styles.empty}>
          <p>还没有任务。</p>
          <p className={styles.hint}>点击侧栏「+ 新建待办」开始。</p>
        </div>
      ) : (
        <div className={styles.list}>
          {sorted.map((todo) => (
            <TodoItem key={todo.id} record={todo} />
          ))}
        </div>
      )}
    </section>
  );
}
