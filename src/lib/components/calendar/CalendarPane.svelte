<script lang="ts">
  /**
   * 日历面板：工具栏（模式切换 / 翻页 / 今天 / 新建）+ 当前模式视图。
   * 在 mode()/cursor() 变化时（含首挂载）触发 loadRange 刷新区间事件。
   * EventEditor 由根 +page.svelte 统一作为右栏挂载（与 TodoEditor 同构）。
   */
  import {
    cursor,
    goToday,
    loadRange,
    mode,
    moveCursor,
    setMode,
    startCreateEvent,
  } from "../../calendar.svelte";
  import { addDays, mondayOfWeek, monthLabel } from "../../calendar-grid";
  import { formatDate } from "../../datetime";
  import type { CalMode } from "../../calendar.svelte";
  import MonthView from "./MonthView.svelte";
  import WeekView from "./WeekView.svelte";
  import DayView from "./DayView.svelte";
  import AgendaView from "./AgendaView.svelte";

  const modes: { key: CalMode; label: string }[] = [
    { key: "month", label: "月" },
    { key: "week", label: "周" },
    { key: "day", label: "日" },
    { key: "agenda", label: "议程" },
  ];

  // 区间标题（响应式：依赖 mode/cursor）。
  const title = $derived.by(() => {
    const c = cursor();
    switch (mode()) {
      case "month":
        return monthLabel(c);
      case "week": {
        const s = mondayOfWeek(c);
        return `${formatDate(s)} – ${formatDate(addDays(s, 6))}`;
      }
      case "day": {
        const dow = ["日", "一", "二", "三", "四", "五", "六"][new Date(c).getDay()];
        return `${formatDate(c)} 周${dow}`;
      }
      case "agenda":
        return `议程 · ${formatDate(c)} 起`;
    }
  });

  // 首挂载 + mode/cursor 变化时刷新区间。
  $effect(() => {
    void mode();
    void cursor();
    void loadRange();
  });

  function onNew() {
    startCreateEvent();
  }
</script>

<div class="pane">
  <header class="toolbar">
    <div class="nav">
      <button type="button" class="btn" onclick={() => moveCursor(-1)} aria-label="上一页">‹</button>
      <button type="button" class="today" onclick={goToday}>今天</button>
      <button type="button" class="btn" onclick={() => moveCursor(1)} aria-label="下一页">›</button>
    </div>
    <h2 class="title">{title}</h2>
    <div class="right">
      <div class="modes" role="tablist">
        {#each modes as m (m.key)}
          <button
            type="button"
            role="tab"
            class="mode"
            class:active={mode() === m.key}
            aria-selected={mode() === m.key}
            onclick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        {/each}
      </div>
      <button type="button" class="new" onclick={onNew}>+ 新建事件</button>
    </div>
  </header>

  <div class="view">
    {#if mode() === "month"}
      <MonthView />
    {:else if mode() === "week"}
      <WeekView />
    {:else if mode() === "day"}
      <DayView />
    {:else}
      <AgendaView />
    {/if}
  </div>
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .btn {
    width: 1.8rem;
    height: 1.8rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }

  .btn:hover {
    background: var(--surface-1);
  }

  .today {
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .today:hover {
    background: var(--surface-1);
  }

  .title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .modes {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .mode {
    border: none;
    background: var(--surface);
    color: var(--text-dim);
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.85rem;
    border-right: 1px solid var(--border);
  }

  .mode:last-child {
    border-right: none;
  }

  .mode.active {
    background: var(--accent);
    color: #fff;
  }

  .new {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    border-radius: 6px;
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .new:hover {
    filter: brightness(1.05);
  }

  .view {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
