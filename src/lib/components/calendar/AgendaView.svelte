<script lang="ts">
  /**
   * 议程视图：窗口（cursor 起 30 天）内事件按日分组列表。
   * 全天事件归其 start 日（多日全天只显示一次，附 `→ end`）；定时事件按 eventOnDay 归各触及日。
   */
  import { cursor, events, startEditEvent } from "../../calendar.svelte";
  import { addDays, eventOnDay, isSameDay, todayOnly, weekdayLabelsMonFirst } from "../../calendar-grid";
  import { formatDate, formatTime } from "../../datetime";
  import type { Record as RecordT } from "../../types";

  // 窗口内的 30 天（响应式：依赖 cursor）。
  const days = $derived.by(() => {
    const start = cursor();
    return Array.from({ length: 30 }, (_, i) => addDays(start, i));
  });

  const today = todayOnly();

  interface DayGroup {
    day: string;
    items: RecordT[];
  }

  // 仅保留有事件的日子；全天归 start 日，定时按触及日。
  const groups = $derived.by(
    (): DayGroup[] => {
      const all = events();
      return days
        .map((day) => {
          const starting = all.filter(
            (e) => e.data.all_day === true && (e.start_at ?? "") === day,
          );
          const timed = all.filter(
            (e) => e.data.all_day !== true && eventOnDay(e, day),
          );
          const items = [...starting, ...timed].sort((a, b) =>
            (a.start_at ?? "").localeCompare(b.start_at ?? ""),
          );
          return { day, items };
        })
        .filter((g) => g.items.length > 0);
    },
  );

  function dowOf(day: string): string {
    return weekdayLabelsMonFirst()[(new Date(day).getDay() + 6) % 7];
  }

  function onEdit(id: string): void {
    startEditEvent(id);
  }
</script>

<div class="agenda">
  {#if groups.length === 0}
    <div class="empty">未来 30 天暂无事件</div>
  {:else}
    {#each groups as g (g.day)}
      <section class="day">
        <header class="day-head" class:today={isSameDay(g.day, today)}>
          <span class="date">{formatDate(g.day)}</span>
          <span class="dow">{dowOf(g.day)}</span>
        </header>
        <ul class="items">
          {#each g.items as ev (ev.id)}
            <li>
              <button
                type="button"
                class="row"
                class:allday={ev.data.all_day === true}
                class:cancelled={ev.status === "cancelled"}
                onclick={() => onEdit(ev.id)}
              >
                {#if ev.data.all_day === true}
                  <span class="time">全天</span>
                {:else}
                  <span class="time">{formatTime(ev.start_at)}</span>
                {/if}
                <span class="title">{ev.title}</span>
                {#if ev.data.location}
                  <span class="loc">@ {ev.data.location}</span>
                {/if}
                {#if ev.data.all_day === true && ev.end_at && ev.end_at !== ev.start_at}
                  <span class="until">→ {formatDate(ev.end_at)}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .agenda {
    height: 100%;
    overflow-y: auto;
    padding: 0.75rem 1rem 2rem;
  }

  .empty {
    color: var(--text-dim);
    padding: 2rem 0.5rem;
    text-align: center;
  }

  .day {
    margin-bottom: 1rem;
  }

  .day-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.25rem;
  }

  .day-head.today .date {
    color: var(--accent);
    font-weight: 700;
  }

  .date {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .dow {
    font-size: 0.78rem;
    color: var(--text-dim);
  }

  .items {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    text-align: left;
    border: none;
    background: transparent;
    color: inherit;
    padding: 0.35rem 0.4rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .row:hover {
    background: var(--surface-1);
  }

  .row.cancelled {
    opacity: 0.5;
    text-decoration: line-through;
  }

  .row .time {
    color: var(--text-dim);
    flex-shrink: 0;
    width: 3.2rem;
    font-variant-numeric: tabular-nums;
  }

  .row.allday .time {
    color: var(--accent);
    font-weight: 600;
  }

  .row .title {
    font-weight: 500;
  }

  .row .loc {
    color: var(--text-dim);
    font-size: 0.82rem;
  }

  .row .until {
    color: var(--text-dim);
    font-size: 0.82rem;
  }
</style>
