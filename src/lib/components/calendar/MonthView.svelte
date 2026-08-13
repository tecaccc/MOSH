<script lang="ts">
  /**
   * 月视图：6×7 网格，周一首。
   * 每格列当日事件（全天置顶，定时随后）；点格空白 → 当日新建；点事件 → 编辑。
   * 网格首格 = 月首所在周的周一；非当月日期淡显。
   */
  import {
    cursor,
    events,
    startCreateEvent,
    startEditEvent,
  } from "../../calendar.svelte";
  import {
    addDays,
    dayOfMonth,
    isSameDay,
    isSameMonth,
    monthGridStart,
    orderedForDay,
    todayOnly,
    weekdayLabelsMonFirst,
  } from "../../calendar-grid";
  import { formatTime } from "../../datetime";
  import type { Record as RecordT } from "../../types";

  const labels = weekdayLabelsMonFirst();

  // 42 天网格（响应式：依赖 cursor）。
  const days = $derived.by(() => {
    const start = monthGridStart(cursor());
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  });

  const curMonth = $derived(cursor());
  const today = todayOnly();

  function dayEvents(day: string): RecordT[] {
    return orderedForDay(events(), day);
  }

  function onCellCreate(day: string): void {
    startCreateEvent(day);
  }

  function onEventClick(id: string): void {
    startEditEvent(id);
  }
</script>

<div class="month">
  <div class="weekdays">
    {#each labels as label}
      <div class="weekday">{label}</div>
    {/each}
  </div>

  <div class="grid">
    {#each days as day (day)}
      <div
        class="cell"
        class:out={!isSameMonth(day, curMonth)}
        class:today={isSameDay(day, today)}
        role="button"
        tabindex="0"
        onclick={() => onCellCreate(day)}
        onkeydown={(e) => e.key === "Enter" && onCellCreate(day)}
      >
        <div class="daynum">{dayOfMonth(day)}</div>
        <div class="evts">
          {#each dayEvents(day) as ev (ev.id)}
            <button
              type="button"
              class="chip"
              class:allday={ev.data.all_day === true}
              class:cancelled={ev.status === "cancelled"}
              onclick={(e) => {
                e.stopPropagation();
                onEventClick(ev.id);
              }}
              title={`${ev.title}${ev.data.location ? " · " + ev.data.location : ""}`}
            >
              {#if ev.data.all_day === true}
                <span class="chip-title">{ev.title}</span>
              {:else}
                <span class="chip-time">{formatTime(ev.start_at)}</span>
                <span class="chip-title">{ev.title}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .month {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid var(--border);
  }

  .weekday {
    padding: 0.4rem 0.5rem;
    font-size: 0.78rem;
    color: var(--text-dim);
    text-align: left;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: 1fr;
    flex: 1;
    min-height: 0;
  }

  .cell {
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 0.2rem 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    overflow: hidden;
    cursor: pointer;
  }

  .cell.out {
    background: var(--surface-1);
  }

  .cell.today .daynum {
    background: var(--accent);
    color: #fff;
  }

  .daynum {
    font-size: 0.8rem;
    width: 1.4rem;
    height: 1.4rem;
    line-height: 1.4rem;
    text-align: center;
    border-radius: 50%;
    color: var(--text);
  }

  .cell.out .daynum {
    color: var(--text-dim);
  }

  .evts {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-height: 0;
    overflow: hidden;
  }

  .chip {
    border: none;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 4px;
    padding: 0.1rem 0.3rem;
    font-size: 0.74rem;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    gap: 0.25rem;
    align-items: baseline;
    min-width: 0;
  }

  .chip.allday {
    background: var(--surface-2);
    color: var(--text);
    font-weight: 600;
  }

  .chip.cancelled {
    opacity: 0.5;
    text-decoration: line-through;
  }

  .chip-time {
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
