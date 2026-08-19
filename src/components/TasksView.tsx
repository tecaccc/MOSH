import { useMemo, useState } from "react";
import { useAppStore } from "../state/store";
import type { Priority, RecordData as RecordT } from "../lib/types";
import TodoItem from "./TodoItem";
import styles from "./TasksView.module.css";

/**
 * 待办事项视图：全部待办的统一入口（今日视图只看今天，这里看全部历史）。
 *
 * - 进行中按「已逾期 / 今天到期 / 即将到来 / 无截止日期」四组展示；
 * - 已完成独立折叠区（按完成时间倒序——历史待办在此回看/恢复）；
 * - 过滤：全部 / 进行中 / 已完成；
 * - 行组件复用 TodoItem（勾选、优先级、创建/截止/完成时间、子任务、编辑/删除）。
 */

const PRIO_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };

type Filter = "all" | "active" | "done";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "done", label: "已完成" },
];

/** 今天 00:00（本地）；分组与逾期判定共用。 */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 到期时间（NaN → null）。 */
function dueOf(r: RecordT): Date | null {
  if (!r.end_at) return null;
  const d = new Date(r.end_at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 进行中的排序：截止早的在前（无截止垫底）→ 优先级 → 标题。 */
function activeSortKey(r: RecordT): string {
  const due = r.end_at ?? "9999-12-31T23:59:59Z";
  return `${due}|${PRIO_RANK[r.data.priority ?? "none"]}|${r.title}`;
}

/** 已完成的排序：完成时间倒序（缺完成时间时以 updated_at 兑底）。 */
function doneSortKey(r: RecordT): string {
  return r.data.completed_at ?? r.updated_at ?? r.created_at ?? "";
}

function sortBy<T>(list: T[], key: (x: T) => string): T[] {
  return [...list].sort((a, b) => key(a).localeCompare(key(b)));
}

/** 分组标题定义（顺序即展示顺序）。 */
interface Group {
  key: string;
  title: string;
  items: RecordT[];
}

export default function TasksView(): React.ReactElement {
  const records = useAppStore((s) => s.records);
  const startCreate = useAppStore((s) => s.startCreate);

  const [filter, setFilter] = useState<Filter>("all");
  /** 已完成折叠（仅「全部」视图默认收起；「已完成」视图直接展开列表）。 */
  const [doneOpen, setDoneOpen] = useState(false);

  const { active, done } = useMemo(() => {
    const top = records.filter((r) => r.parent_id === null && r.status !== "cancelled");
    return {
      active: top.filter((r) => r.status === "active"),
      done: top.filter((r) => r.status === "done"),
    };
  }, [records]);

  const groups = useMemo<Group[]>(() => {
    const today = startOfToday();
    const byDue = (fn: (d: Date) => boolean) =>
      active.filter((r) => {
        const d = dueOf(r);
        return d !== null && fn(d);
      });
    const overdue = byDue((d) => d.getTime() < today.getTime());
    const dueToday = byDue((d) => isSameDay(d, today));
    const upcoming = byDue((d) => d.getTime() > today.getTime() && !isSameDay(d, today));
    const noDue = active.filter((r) => dueOf(r) === null);
    const mk = (key: string, title: string, items: RecordT[]): Group => ({
      key,
      title,
      items: sortBy(items, activeSortKey),
    });
    return [
      mk("overdue", "已逾期", overdue),
      mk("today", "今天到期", dueToday),
      mk("upcoming", "即将到来", upcoming),
      mk("nodue", "无截止日期", noDue),
    ];
  }, [active]);

  const doneSorted = useMemo(() => sortBy(done, doneSortKey).reverse(), [done]);
  const overdueCount = groups.find((g) => g.key === "overdue")?.items.length ?? 0;
  const showActive = filter !== "done";
  const showDone = filter !== "active";
  const activeEmpty = groups.every((g) => g.items.length === 0);

  return (
    <section className={styles.page}>
      <header className={styles.head}>
        <div className={styles["head-left"]}>
          <h1 className={styles.title}>待办事项</h1>
          <div className={styles.sub}>
            共 {active.length + done.length} 项 · 进行中 {active.length} · 已逾期{" "}
            {overdueCount} · 已完成 {done.length}
          </div>
        </div>
        <div className={styles["head-right"]}>
          <div className={styles.filters} role="tablist" aria-label="待办过滤">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                className={`${styles["filter-btn"]}${filter === f.key ? ` ${styles.active}` : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {f.key === "active" && active.length > 0 ? (
                  <span className={styles["filter-count"]}>{active.length}</span>
                ) : null}
                {f.key === "done" && done.length > 0 ? (
                  <span className={styles["filter-count"]}>{done.length}</span>
                ) : null}
              </button>
            ))}
          </div>
          <button type="button" className={styles["new-btn"]} onClick={() => startCreate()}>
            <svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
            新建待办
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {/* —— 进行中：四组卡片 —— */}
        {showActive ? (
          activeEmpty ? (
            // 无进行中：仅「进行中」过滤或彻底无待办时才占位（全部视图下有历史
            // 已完成时直接展示下方已完成区，不误导“暂无待办”）。
            filter === "active" || done.length === 0 ? (
              <div className={styles.empty}>
                <p>{filter === "active" ? "没有进行中的待办。" : "暂无待办。"}</p>
                <p className={styles.hint}>点击右上「新建待办」，或在 AI 助手里直接说一句。</p>
              </div>
            ) : null
          ) : (
            groups.map((g) =>
              g.items.length === 0 ? null : (
                <section key={g.key} className={`${styles.group}${g.key === "overdue" ? ` ${styles.overdue}` : ""}`}>
                  <header className={styles["group-head"]}>
                    <span className={styles["group-dot"]} aria-hidden="true" />
                    <span className={styles["group-title"]}>{g.title}</span>
                    <span className={styles["group-count"]}>· {g.items.length}</span>
                  </header>
                  <div className={styles.list}>
                    {g.items.map((t) => (
                      <TodoItem key={t.id} record={t} />
                    ))}
                  </div>
                </section>
              ),
            )
          )
        ) : null}

        {/* —— 已完成：折叠区（「已完成」过滤下直接展开） —— */}
        {showDone ? (
          done.length === 0 ? (
            <div className={styles.empty}>
              <p>还没有已完成的待办。</p>
            </div>
          ) : filter === "done" ? (
            <section className={styles.group}>
              <div className={styles.list}>
                {doneSorted.map((t) => (
                  <TodoItem key={t.id} record={t} />
                ))}
              </div>
            </section>
          ) : (
            <section className={styles.group}>
              <button
                type="button"
                className={styles["done-head"]}
                onClick={() => setDoneOpen(!doneOpen)}
                aria-expanded={doneOpen}
              >
                <span className={`${styles["done-chev"]}${doneOpen ? ` ${styles.open}` : ""}`} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </span>
                <span className={styles["group-title"]}>已完成</span>
                <span className={styles["group-count"]}>· {done.length}（按完成时间倒序）</span>
              </button>
              {doneOpen ? (
                <div className={styles.list}>
                  {doneSorted.map((t) => (
                    <TodoItem key={t.id} record={t} />
                  ))}
                </div>
              ) : null}
            </section>
          )
        ) : null}
      </div>
    </section>
  );
}
