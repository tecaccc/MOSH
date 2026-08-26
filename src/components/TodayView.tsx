import { useEffect, useMemo, useRef, useState } from "react";
import { addDays } from "../lib/calendar-grid";
import { useToday } from "../lib/use-today";
import { formatCompletedAt, formatTime } from "../lib/datetime";
import { useAppStore } from "../state/store";
import { editingEventOf, useCalendarStore } from "../state/calendar";
import { useProfileStore } from "../state/profile";
import type { Priority, RecordData as RecordT } from "../lib/types";
import Avatar from "./Avatar";
import styles from "./TodayView.module.css";

/**
 * 今日视图：问候头（时段问候 + 大标题 + 日期/ISO 周 + 三项统计）、
 * 今日日程时间轴、今日到期 & 已逾期任务（含内联子任务）、已完成折叠头。
 */

const DOW = "日一二三四五六";

/** 时段问候（按小时）。 */
function greetingOf(d: Date): string {
  const h = d.getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dueOnDay(r: RecordT, ref: Date): boolean {
  if (r.end_at === null) return false;
  const d = new Date(r.end_at);
  return !Number.isNaN(d.getTime()) && isSameDay(d, ref);
}
function isOverdue(r: RecordT, now: Date): boolean {
  if (r.end_at === null) return false;
  const d = new Date(r.end_at);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < now.getTime() && !isSameDay(d, now);
}

/** 截止标签（DuePill 文案 + 是否逾期着色）。 */
function dueLabel(r: RecordT, now: Date): { text: string; overdue: boolean } {
  if (!r.end_at) return { text: "", overdue: false };
  const d = new Date(r.end_at);
  if (Number.isNaN(d.getTime())) return { text: "", overdue: false };
  if (isSameDay(d, now)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.end_at)) return { text: "今天", overdue: false };
    return { text: `今天 · ${formatTime(r.end_at)}`, overdue: d.getTime() < now.getTime() };
  }
  if (d.getTime() < now.getTime()) {
    const days = Math.max(1, Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000));
    return { text: `逾期 ${days} 天`, overdue: true };
  }
  return { text: "", overdue: false };
}

function priColor(p: Priority): string {
  switch (p) {
    case "high":
      return "var(--pri-high)";
    case "medium":
      return "var(--pri-med)";
    case "low":
      return "var(--pri-low)";
    default:
      return "var(--text-muted)";
  }
}
function priorityOf(r: RecordT): Priority {
  return r.data.priority ?? "none";
}

const CAL_COLORS = ["var(--cal-1)", "var(--cal-2)", "var(--cal-3)", "var(--cal-4)"];

function CheckMark() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" viewBox="0 0 24 24">
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  );
}

function Check({
  done,
  small,
  onToggle,
}: {
  done: boolean;
  small?: boolean;
  onToggle: (e: React.MouseEvent | React.KeyboardEvent) => void;
}) {
  return (
    <span
      className={`${styles.check}${small ? ` ${styles.sm}` : ""}${done ? ` ${styles.done}` : ""}`}
      role="checkbox"
      aria-checked={done}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => e.key === " " && onToggle(e)}
    >
      {done ? <CheckMark /> : null}
    </span>
  );
}

interface DueInfo {
  text: string;
  overdue: boolean;
}
interface TaskItem {
  t: RecordT;
  due: DueInfo;
  subs: { s: RecordT; due: DueInfo }[];
  subsActive: number;
  subsDone: number;
}

export default function TodayView() {
  const records = useAppStore((s) => s.records);
  const setTodoStatusFn = useAppStore((s) => s.setTodoStatus);
  const startEdit = useAppStore((s) => s.startEdit);
  // 个人资料（可配置名称/头像；未配置时问候不带称呼 + 首字圆标兑底）。
  const profileName = useProfileStore((s) => s.name);
  const profileAvatar = useProfileStore((s) => s.avatar);
  const renderEvents = useCalendarStore((s) => s.renderEvents);
  const loadEvents = useCalendarStore((s) => s.loadEvents);
  const editingId = useCalendarStore((s) => s.editingId);
  const calEvents = useCalendarStore((s) => s.events);
  const startCreateEvent = useCalendarStore((s) => s.startCreateEvent);
  const startEditEvent = useCalendarStore((s) => s.startEditEvent);
  // AI 工具等外部变更后自增，触发本视图重载今日事件。
  const dataVersion = useAppStore((s) => s.dataVersion);

  // 响应式「今天」+ 分钟级时钟：托盘常驻跨午夜后，日期文案/问候/今日过滤/逾期
  // 判定全部跟随滚动（模块顶层固化 now/today 是「定位到昨天」BUG 的根因）。
  const today = useToday();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    return () => clearTimeout(id);
  }, []);
  const greeting = greetingOf(now);
  const dateLine = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${DOW[now.getDay()]} · 第${isoWeek(now)}周`;

  useEffect(() => {
    void loadEvents(today, addDays(today, 1)).catch(() => {
      /* 非 Tauri 环境忽略；根页有统一错误提示 */
    });
  }, [loadEvents, dataVersion, today]);

  // 编辑器关闭后重取今日事件（与 Svelte $effect 等价）。
  const editing = editingEventOf(calEvents, editingId) !== undefined;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      void loadEvents(today, addDays(today, 1)).catch(() => {});
    }
    wasEditing.current = editing;
  }, [editing, loadEvents, today]);

  const todayEvents = useMemo(
    () => [...renderEvents].filter((e) => e.status !== "cancelled")
      .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? "")),
    [renderEvents],
  );

  const dueToday = useMemo(
    () => records.filter((r) => r.parent_id === null && r.status === "active" && dueOnDay(r, now)),
    [records, now],
  );
  const overdue = useMemo(
    () => records.filter((r) => r.parent_id === null && r.status === "active" && isOverdue(r, now)),
    [records, now],
  );
  const doneToday = useMemo(
    () => records.filter((r) => r.parent_id === null && r.status === "done" && dueOnDay(r, now)),
    [records, now],
  );
  /** 已完成条目（含截止信息；与今日任务同构，供折叠区渲染）。 */
  const doneItems = useMemo<TaskItem[]>(
    () =>
      doneToday.map((t) => ({
        t,
        due: dueLabel(t, now),
        subs: [],
        subsActive: 0,
        subsDone: 0,
      })),
    [doneToday, now],
  );

  const todayItems = useMemo<TaskItem[]>(() => {
    const seen = new Set<string>();
    const list: RecordT[] = [];
    for (const r of [...overdue, ...dueToday]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        list.push(r);
      }
    }
    list.sort((a, b) => (a.end_at ?? "").localeCompare(b.end_at ?? ""));
    return list.map((t) => {
      const subs = records.filter((s) => s.parent_id === t.id && s.status !== "cancelled");
      return {
        t,
        due: dueLabel(t, now),
        subsActive: subs.filter((s) => s.status === "active").length,
        subsDone: subs.filter((s) => s.status === "done").length,
        subs: subs.map((s) => ({ s, due: dueLabel(s, now) })),
      };
    });
  }, [overdue, dueToday, records, now]);

  const toggle = (e: React.MouseEvent | React.KeyboardEvent, r: RecordT) => {
    e.stopPropagation();
    void setTodoStatusFn(r.id, r.status === "done" ? "active" : "done");
  };

  // 已完成折叠区（默认收起；展开可恢复/编辑）。
  const [doneOpen, setDoneOpen] = useState(false);

  return (
    <section className={styles.today}>
      <header className={styles.head}>
        <div className={styles["greet-row"]}>
          <div className={styles["greet-left"]}>
            <Avatar name={profileName} avatar={profileAvatar} size={52} />
            <div className={styles["greet-col"]}>
              <div className={styles.greeting}>
                {profileName ? `${greeting}，${profileName}` : greeting}
              </div>
              <h1 className={styles["big-title"]}>这是你的一天</h1>
              <div className={styles["date-line"]}>{dateLine}</div>
            </div>
          </div>
          <div className={styles["head-stats"]}>
            <div className={styles.hs}>
              <span className={styles["hs-v"]}>{dueToday.length}</span>
              <span className={styles["hs-l"]}>今日任务</span>
            </div>
            <div className={styles.hs}>
              <span className={styles["hs-v"]}>{todayEvents.length}</span>
              <span className={styles["hs-l"]}>今日日程</span>
            </div>
            <div className={styles.hs}>
              <span className={styles["hs-v"]}>{doneToday.length} / {dueToday.length + doneToday.length}</span>
              <span className={styles["hs-l"]}>已完成</span>
            </div>
          </div>
        </div>
      </header>

      <section className={`${styles.card} ${styles.schedule}`}>
        <header className={styles["sec-head"]}>
          <div className={styles["sec-left"]}>
            <span className={styles["sec-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5V12l3 1.8" />
              </svg>
            </span>
            <span className={styles["sec-title"]}>今日日程</span>
            <span className={styles["sec-count"]}>· {todayEvents.length} 个日程</span>
          </div>
          <button type="button" className={styles["add-link"]} onClick={() => startCreateEvent()}>
            <span className={styles["add-ico"]}>
              <svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            添加日程
          </button>
        </header>

        {todayEvents.length === 0 ? (
          <div className={styles.empty}>今日暂无日程。</div>
        ) : (
          <ul className={styles["ev-list"]}>
            {todayEvents.map((ev, i) => (
              <li key={ev.id}>
                <button type="button" className={styles.ev} onClick={() => startEditEvent(ev.id)}>
                  <span className={styles.tl}>
                    <span className={styles["tl-time"]}>
                      {ev.data.all_day === true
                        ? "全天"
                        : `${formatTime(ev.start_at)} — ${formatTime(ev.end_at)}`}
                    </span>
                    <span className={styles["tl-dot"]} style={{ background: CAL_COLORS[i % 4] }} />
                    <span
                      className={styles["tl-line"]}
                      style={{
                        background: i < todayEvents.length - 1 ? "var(--border-soft)" : "transparent",
                      }}
                    />
                  </span>
                  <span className={styles["ev-body"]}>
                    <span className={styles["ev-title"]}>{ev.title}</span>
                    <span className={styles["ev-meta"]}>
                      {typeof ev.data.location === "string" ? (
                        <span className={styles["ev-loc"]}>{ev.data.location as string}</span>
                      ) : null}
                      {ev.source ? <span className={styles["ev-src"]}>· {ev.source}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.tasks}>
        <header className={styles["tasks-head"]}>
          <div className={styles["sec-left"]}>
            <span className={styles["sec-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
                <path d="M8.5 12l2.6 2.6 4.6-5.2" />
              </svg>
            </span>
            <span className={styles["sec-title"]}>今日到期 &amp; 已逾期</span>
            <span className={styles["sec-count"]}>· {doneToday.length} / {dueToday.length + doneToday.length + overdue.length}</span>
          </div>
          <div className={styles["filter-pill"]}>
            <span>排序：到期时间</span>
            <span className={styles["filter-ico"]}>
              <svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12" viewBox="0 0 24 24">
                <path d="M3 7h13M13 4l3 3-3 3M21 17H8M11 20l-3-3 3-3" />
              </svg>
            </span>
          </div>
        </header>

        {todayItems.length === 0 ? (
          <div className={styles.empty}>没有今日到期或逾期的任务，节奏不错 🎉</div>
        ) : (
          <ul className={styles["task-list"]}>
            {todayItems.map((item) => (
              <li key={item.t.id}>
                <button type="button" className={styles["task-row"]} onClick={() => startEdit(item.t.id)}>
                  <Check done={item.t.status === "done"} onToggle={(e) => toggle(e, item.t)} />
                  <span className={styles["pri-dot"]} style={{ background: priColor(priorityOf(item.t)) }} />
                  <span className={styles["task-mid"]}>
                    <span className={`${styles["task-title"]}${item.t.status === "done" ? ` ${styles.done}` : ""}`}>
                      {item.t.title}
                    </span>
                    <span className={styles["task-meta"]}>
                      {item.due.text ? (
                        <span className={`${styles["due-pill"]}${item.due.overdue ? ` ${styles.overdue}` : ""}`}>
                          <span className={styles["due-ico"]}>
                            <svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="10" height="10" viewBox="0 0 24 24">
                              <circle cx="12" cy="13" r="8" />
                              <path d="M12 9v4l2.5 1.5" />
                              <path d="M5 3 2 6M19 3l3 3" />
                            </svg>
                          </span>
                          {item.due.text}
                        </span>
                      ) : null}
                      {item.subs.length ? (
                        <span className={styles["meta-sub"]}>{item.subsDone} / {item.subs.length} 子任务</span>
                      ) : null}
                      {item.t.tags.map((tag) => (
                        <span key={tag} className={styles["meta-tag"]}>#{tag}</span>
                      ))}
                    </span>
                  </span>
                  <span className={styles.chev}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>

                {item.subs.length ? (
                  <ul className={styles["sub-list"]}>
                    {item.subs.map((ss) => (
                      <li key={ss.s.id}>
                        <button type="button" className={`${styles["task-row"]} ${styles.sub}`} onClick={() => startEdit(ss.s.id)}>
                          <Check small done={ss.s.status === "done"} onToggle={(e) => toggle(e, ss.s)} />
                          <span className={`${styles["pri-dot"]} ${styles.sm}`} style={{ background: priColor(priorityOf(ss.s)) }} />
                          <span className={styles["task-mid"]}>
                            <span className={`${styles["task-title"]} ${styles.sm}${ss.s.status === "done" ? ` ${styles.done}` : ""}`}>
                              {ss.s.title}
                            </span>
                            {ss.due.text ? (
                              <span className={styles["task-meta"]}>
                                <span className={`${styles["due-pill"]}${ss.due.overdue ? ` ${styles.overdue}` : ""}`}>
                                  <span className={styles["due-ico"]}>
                                    <svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="10" height="10" viewBox="0 0 24 24">
                                      <circle cx="12" cy="13" r="8" />
                                      <path d="M12 9v4l2.5 1.5" />
                                      <path d="M5 3 2 6M19 3l3 3" />
                                    </svg>
                                  </span>
                                  {ss.due.text}
                                </span>
                              </span>
                            ) : null}
                          </span>
                          <span className={styles.chev}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                              <path d="M9 6l6 6-6 6" />
                            </svg>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles["done-sec"]}>
        <button
          type="button"
          className={styles["done-head"]}
          onClick={() => setDoneOpen(!doneOpen)}
          aria-expanded={doneOpen}
        >
          <span className={`${styles["done-chev"]}${doneOpen ? ` ${styles.open}` : ""}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
          <span className={styles["done-title"]}>已完成</span>
          <span className={styles["done-count"]}>· {doneToday.length}</span>
        </button>

        {/* 完成的待办仍可编辑/恢复：取消勾选回到进行中，点行打开编辑器。 */}
        {doneOpen && doneItems.length > 0 ? (
          <ul className={styles["done-list"]}>
            {doneItems.map((item) => (
              <li key={item.t.id}>
                <button
                  type="button"
                  className={`${styles["task-row"]} ${styles["done-row"]}`}
                  onClick={() => startEdit(item.t.id)}
                >
                  <Check done onToggle={(e) => toggle(e, item.t)} />
                  <span className={styles["pri-dot"]} style={{ background: priColor(priorityOf(item.t)) }} />
                  <span className={styles["task-mid"]}>
                    <span className={`${styles["task-title"]} ${styles.done}`}>{item.t.title}</span>
                    <span className={styles["task-meta"]}>
                      {item.due.text ? (
                        <span className={styles["due-pill"]}>{item.due.text}</span>
                      ) : null}
                      {item.t.data.completed_at ? (
                        <span className={`${styles["due-pill"]} ${styles["done-pill"]}`}>
                          ✓ 完成于 {formatCompletedAt(item.t.data.completed_at)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className={styles.chev}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}
