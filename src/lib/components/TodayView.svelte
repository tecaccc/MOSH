<script lang="ts">
  /**
   * 今日视图：严格按 docs/pencil-new.pen 的「Home — Today」(z0EdN) 还原。
   *   - 问候头：时段问候 + 「这是你的一天」大标题 + 日期(含 ISO 周) + 右上三项小统计
   *   - 今日日程：当日事件时间轴列表（点事件 → 开 EventEditor；「+ 添加日程」新建）
   *   - 今日到期 & 已逾期：todo 列表（含内联子任务，勾选切换状态，点行 → 开 TodoEditor）
   *   - 已完成：今日已完成 todo 计数（折叠头）
   *
   * 数据：todo 取 store.records（本地派生）；事件取 calendar.loadEvents(今日)。
   */
  import { onMount } from "svelte";
  import {
    records,
    setTodoStatus,
    startEdit,
    subtasksOf,
  } from "../store.svelte";
  import {
    editingEvent,
    renderEvents,
    loadEvents,
    startCreateEvent,
    startEditEvent,
  } from "../calendar.svelte";
  import { addDays, todayOnly } from "../calendar-grid";
  import { formatTime } from "../datetime";
  import type { Priority, Record as RecordT } from "../types";

  const now = new Date();
  const today = todayOnly();
  const DOW = "日一二三四五六";
  const USER_NAME = "Connor";

  const greeting = (() => {
    const h = now.getHours();
    if (h < 6) return "夜深了";
    if (h < 11) return "早上好";
    if (h < 13) return "中午好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

  /** ISO 周序（用于日期行「第 N 周」）。 */
  function isoWeek(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  const dateLine = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${DOW[now.getDay()]} · 第${isoWeek(now)}周`;

  // —— 日期比对工具 ——
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

  // —— 今日事件（响应式）——
  onMount(async () => {
    try {
      await loadEvents(today, addDays(today, 1));
    } catch {
      /* 非 Tauri 环境忽略；根页有统一错误提示 */
    }
  });
  let wasEditing = $state(false);
  $effect(() => {
    const editing = editingEvent() !== undefined;
    if (wasEditing && !editing) {
      void loadEvents(today, addDays(today, 1));
    }
    wasEditing = editing;
  });

  function byStart(a: RecordT, b: RecordT): number {
    return (a.start_at ?? "").localeCompare(b.start_at ?? "");
  }
  const todayEvents = $derived(
    [...renderEvents()].filter((e) => e.status !== "cancelled").sort(byStart),
  );

  // —— 今日任务 / 逾期 / 已完成（响应式：依赖 records）——
  function dueOnDay(r: RecordT, ref: Date): boolean {
    if (r.end_at === null) return false;
    const d = new Date(r.end_at);
    return !Number.isNaN(d.getTime()) && isSameDay(d, ref);
  }
  function isOverdue(r: RecordT): boolean {
    if (r.end_at === null) return false;
    const d = new Date(r.end_at);
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() < now.getTime() && !isSameDay(d, now);
  }
  const dueToday = $derived(
    records.filter((r) => r.parent_id === null && r.status === "active" && dueOnDay(r, now)),
  );
  const overdue = $derived(
    records.filter((r) => r.parent_id === null && r.status === "active" && isOverdue(r)),
  );
  const doneToday = $derived(
    records.filter((r) => r.parent_id === null && r.status === "done" && dueOnDay(r, now)),
  );
  /** 今日到期（含逾期）顶层任务 + 各自子任务，按截止升序、逾期优先。 */
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
  const todayItems = $derived.by<TaskItem[]>(() => {
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
      const subs = subtasksOf(t.id).filter((s) => s.status !== "cancelled");
      return {
        t,
        due: dueLabel(t),
        subsActive: subs.filter((s) => s.status === "active").length,
        subsDone: subs.filter((s) => s.status === "done").length,
        subs: subs.map((s) => ({ s, due: dueLabel(s) })),
      };
    });
  });

  /** 截止标签（DuePill 文案 + 是否逾期着色）。 */
  function dueLabel(r: RecordT): { text: string; overdue: boolean } {
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

  function toggle(ev: MouseEvent | KeyboardEvent, r: RecordT): void {
    ev.stopPropagation();
    void setTodoStatus(r.id, r.status === "done" ? "active" : "done");
  }

  const CAL_COLORS = ["var(--cal-1)", "var(--cal-2)", "var(--cal-3)", "var(--cal-4)"];

  // 内联图标（currentColor 取色，stroke 风格贴近 lucide）。
  const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="17" height="17" viewBox="0 0 24 24"';
  const clockIcon = `<svg ${S}><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>`;
  const checkSquareIcon = `<svg ${S}><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M8.5 12l2.6 2.6 4.6-5.2"/></svg>`;
  const alarmIcon = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="10" height="10" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M5 3 2 6M19 3l3 3"/></svg>`;
  const chevRight = `<svg ${S}><path d="M9 6l6 6-6 6"/></svg>`;
  const sortIcon = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" viewBox="0 0 24 24"><path d="M3 7h13M13 4l3 3-3 3M21 17H8M11 20l-3-3 3-3"/></svg>`;
  const plusIcon = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`;
  const checkMark = `<svg fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" viewBox="0 0 24 24"><path d="M5 12l4.5 4.5L19 7"/></svg>`;
</script>

<section class="today">
  <!-- 问候头 -->
  <header class="head">
    <div class="greet-row">
      <div class="greet-col">
        <div class="greeting">{greeting}，{USER_NAME.toUpperCase()}</div>
        <h1 class="big-title">这是你的一天</h1>
        <div class="date-line">{dateLine}</div>
      </div>
      <div class="head-stats">
        <div class="hs">
          <span class="hs-v">{dueToday.length}</span>
          <span class="hs-l">今日任务</span>
        </div>
        <div class="hs">
          <span class="hs-v">{todayEvents.length}</span>
          <span class="hs-l">今日日程</span>
        </div>
        <div class="hs">
          <span class="hs-v">{doneToday.length} / {dueToday.length + doneToday.length}</span>
          <span class="hs-l">已完成</span>
        </div>
      </div>
    </div>
  </header>

  <!-- 今日日程 -->
  <section class="card schedule">
    <header class="sec-head">
      <div class="sec-left">
        <span class="sec-ico">{@html clockIcon}</span>
        <span class="sec-title">今日日程</span>
        <span class="sec-count">· {todayEvents.length} 个日程</span>
      </div>
      <button type="button" class="add-link" onclick={() => startCreateEvent()}>
        <span class="add-ico">{@html plusIcon}</span>添加日程
      </button>
    </header>

    {#if todayEvents.length === 0}
      <div class="empty">今日暂无日程。</div>
    {:else}
      <ul class="ev-list">
        {#each todayEvents as ev, i (ev.id)}
          <li>
            <button type="button" class="ev" onclick={() => startEditEvent(ev.id)}>
              <span class="tl">
                <span class="tl-time">
                  {ev.data.all_day === true
                    ? "全天"
                    : `${formatTime(ev.start_at)} — ${formatTime(ev.end_at)}`}
                </span>
                <span class="tl-dot" style:background={CAL_COLORS[i % 4]}></span>
                <span
                  class="tl-line"
                  style:background={i < todayEvents.length - 1
                    ? "var(--border-soft)"
                    : "transparent"}
                ></span>
              </span>
              <span class="ev-body">
                <span class="ev-title">{ev.title}</span>
                <span class="ev-meta">
                  {#if ev.data.location}<span class="ev-loc">{ev.data.location}</span>{/if}
                  {#if ev.source}<span class="ev-src">· {ev.source}</span>{/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- 今日到期 & 已逾期 -->
  <section class="tasks">
    <header class="tasks-head">
      <div class="sec-left">
        <span class="sec-ico">{@html checkSquareIcon}</span>
        <span class="sec-title">今日到期 &amp; 已逾期</span>
        <span class="sec-count">· {doneToday.length} / {dueToday.length + doneToday.length + overdue.length}</span>
      </div>
      <div class="filter-pill">
        <span>排序：到期时间</span>
        <span class="filter-ico">{@html sortIcon}</span>
      </div>
    </header>

    {#if todayItems.length === 0}
      <div class="empty">没有今日到期或逾期的任务，节奏不错 🎉</div>
    {:else}
      <ul class="task-list">
        {#each todayItems as item (item.t.id)}
          <li>
            <button type="button" class="task-row" onclick={() => startEdit(item.t.id)}>
              <span
                class="check"
                class:done={item.t.status === "done"}
                role="checkbox"
                aria-checked={item.t.status === "done"}
                tabindex="0"
                onclick={(e) => toggle(e, item.t)}
                onkeydown={(e) => e.key === " " && toggle(e, item.t)}
              >
                {#if item.t.status === "done"}{@html checkMark}{/if}
              </span>
              <span class="pri-dot" style:background={priColor(priorityOf(item.t))}></span>
              <span class="task-mid">
                <span class="task-title" class:done={item.t.status === "done"}>{item.t.title}</span>
                <span class="task-meta">
                  {#if item.due.text}
                    <span class="due-pill" class:overdue={item.due.overdue}>
                      <span class="due-ico">{@html alarmIcon}</span>{item.due.text}
                    </span>
                  {/if}
                  {#if item.subs.length}<span class="meta-sub">{item.subsDone} / {item.subs.length} 子任务</span>{/if}
                  {#each item.t.tags as tag (tag)}<span class="meta-tag">#{tag}</span>{/each}
                </span>
              </span>
              <span class="chev">{@html chevRight}</span>
            </button>

            {#if item.subs.length}
              <ul class="sub-list">
                {#each item.subs as ss (ss.s.id)}
                  <li>
                    <button type="button" class="task-row sub" onclick={() => startEdit(ss.s.id)}>
                      <span
                        class="check sm"
                        class:done={ss.s.status === "done"}
                        role="checkbox"
                        aria-checked={ss.s.status === "done"}
                        tabindex="0"
                        onclick={(e) => toggle(e, ss.s)}
                        onkeydown={(e) => e.key === " " && toggle(e, ss.s)}
                      >
                        {#if ss.s.status === "done"}{@html checkMark}{/if}
                      </span>
                      <span class="pri-dot sm" style:background={priColor(priorityOf(ss.s))}></span>
                      <span class="task-mid">
                        <span class="task-title sm" class:done={ss.s.status === "done"}>{ss.s.title}</span>
                        {#if ss.due.text}
                          <span class="task-meta">
                            <span class="due-pill" class:overdue={ss.due.overdue}>
                              <span class="due-ico">{@html alarmIcon}</span>{ss.due.text}
                            </span>
                          </span>
                        {/if}
                      </span>
                      <span class="chev">{@html chevRight}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- 已完成（折叠头） -->
  <section class="done-sec">
    <div class="done-head">
      <span class="done-chev">{@html chevRight}</span>
      <span class="done-title">已完成</span>
      <span class="done-count">· {doneToday.length}</span>
    </div>
  </section>
</section>

<style>
  .today {
    height: 100%;
    overflow-y: auto;
    padding: 24px 40px 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    background: var(--bg);
  }

  /* 问候头 */
  .head {
    flex-shrink: 0;
  }
  .greet-row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
  }
  .greet-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .greeting {
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: 0.04em;
  }
  .big-title {
    margin: 0;
    font-size: 34px;
    font-weight: 700;
    color: var(--text);
    line-height: 1.1;
  }
  .date-line {
    font-size: 15px;
    color: var(--text-dim);
  }
  .head-stats {
    display: flex;
    gap: 28px;
    align-items: flex-end;
  }
  .hs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: right;
  }
  .hs-v {
    font-size: 22px;
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .hs-l {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
  }

  /* 通用卡片 */
  .card {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    padding: 16px;
  }

  /* 区段头 */
  .sec-head,
  .tasks-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .sec-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sec-ico {
    width: 16px;
    height: 16px;
    color: var(--text-dim);
    display: flex;
  }
  .sec-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-dim);
  }
  .sec-count {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .add-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }
  .add-ico {
    display: flex;
  }
  .add-link:hover {
    filter: brightness(1.1);
  }

  .filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-dim);
  }
  .filter-ico {
    display: flex;
    color: var(--text-muted);
  }

  .empty {
    padding: 18px 8px;
    text-align: center;
    color: var(--text-dim);
    font-size: 14px;
  }

  /* 日程列表 */
  .ev-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ev {
    width: 100%;
    display: flex;
    gap: 14px;
    text-align: left;
    border: none;
    background: transparent;
    color: inherit;
    padding: 4px 8px;
    border-radius: var(--radius-md);
    cursor: pointer;
    align-items: flex-start;
  }
  .ev:hover {
    background: var(--surface-2);
  }
  .tl {
    width: 96px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding-top: 2px;
  }
  .tl-time {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tl-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--surface);
    box-shadow: 0 0 0 1px var(--border-soft);
  }
  .tl-line {
    width: 2px;
    flex: 1;
    min-height: 14px;
  }
  .ev-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 1px;
  }
  .ev-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .ev-meta {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .ev-loc {
    font-size: 11px;
    color: var(--text-muted);
  }
  .ev-src {
    font-size: 10px;
    color: var(--text-muted);
  }

  /* 任务列表 */
  .tasks {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .task-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
    border: none;
    background: transparent;
    color: inherit;
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
  }
  .task-row:hover {
    background: var(--surface);
  }
  .check {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-fg);
    background: transparent;
    cursor: pointer;
  }
  .check.sm {
    width: 18px;
    height: 18px;
    border-radius: 5px;
  }
  .check.done {
    background: var(--accent);
    border-color: var(--accent);
  }
  .pri-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pri-dot.sm {
    width: 7px;
    height: 7px;
  }
  .task-mid {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .task-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .task-title.sm {
    font-size: 13px;
    font-weight: 500;
  }
  .task-title.done {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .task-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .due-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
  }
  .due-pill.overdue {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .due-pill .due-ico {
    display: flex;
  }
  .meta-sub {
    font-size: 11px;
    color: var(--text-muted);
  }
  .meta-tag {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
  }
  .chev {
    display: flex;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* 子任务 */
  .sub-list {
    list-style: none;
    margin: 2px 0 0 32px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .task-row.sub {
    padding: 6px 10px;
  }
  .task-row.sub:hover {
    background: var(--surface-2);
  }

  /* 已完成折叠头 */
  .done-sec {
    flex-shrink: 0;
  }
  .done-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
  }
  .done-chev {
    display: flex;
  }
  .done-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .done-count {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }

  @media (max-width: 720px) {
    .today {
      padding: 20px 20px 12px;
    }
    .head-stats {
      gap: 18px;
    }
    .hs-v {
      font-size: 18px;
    }
  }
</style>
