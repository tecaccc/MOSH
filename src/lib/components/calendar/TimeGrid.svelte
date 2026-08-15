<script lang="ts">
  /**
   * 周/日视图共用的时间网格：顶部全天带 + 24h 时间轴。
   * `days` 为 1（日视图）或 7（周视图）个 date-only。
   * 定时事件用绝对定位（top/height）落在时间轴；重叠事件按通道并排（layoutTimedDay）。
   * 跨日定时事件截断到当日 [0,24h] 并标 `…`。
   */
  import {
    renderEvents,
    openDay,
    startCreateEvent,
    startEditEvent,
  } from "../../calendar.svelte";
  import {
    eventOnDay,
    isSameDay,
    layoutTimedDay,
    todayOnly,
    weekdayLabelsMonFirst,
  } from "../../calendar-grid";
  import { formatTime } from "../../datetime";
  import type { Record as RecordT } from "../../types";

  const { days }: { days: string[] } = $props();

  /** 每小时高度（px）。脚本算定位、样式画网格线均用此值。 */
  const HOUR_H = 44;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const today = todayOnly();

  function allDayChips(day: string): RecordT[] {
    return renderEvents().filter((e) => e.data.all_day === true && eventOnDay(e, day));
  }

  function timedBlocks(day: string) {
    return layoutTimedDay(renderEvents(), day);
  }

  function blockStyle(b: {
    startMin: number;
    endMin: number;
    lane: number;
    laneCount: number;
  }): string {
    const top = (b.startMin / 60) * HOUR_H;
    const height = Math.max((b.endMin - b.startMin) / 60 * HOUR_H, 16);
    const widthPct = 100 / b.laneCount;
    const leftPct = b.lane * widthPct;
    return `top:${top}px;height:${height}px;left:${leftPct}%;width:${widthPct}%`;
  }

  function onCreate(day: string): void {
    startCreateEvent(day);
  }
  function onEdit(id: string): void {
    startEditEvent(id);
  }
</script>

<div class="tg">
  <!-- 日头部：空角 + 各日 -->
  <div class="head" style={`grid-template-columns: 48px repeat(${days.length}, 1fr)`}>
    <div class="corner"></div>
    {#each days as day (day)}
      <button
        type="button"
        class="dayhead"
        class:today={isSameDay(day, today)}
        onclick={() => openDay(day)}
      >
        <span class="dow">{weekdayLabelsMonFirst()[(new Date(day).getDay() + 6) % 7]}</span>
        <span class="dnum">{Number(day.slice(8, 10))}</span>
      </button>
    {/each}
  </div>

  <!-- 全天带 -->
  <div class="allday" style={`grid-template-columns: 48px repeat(${days.length}, 1fr)`}>
    <div class="corner allday-label">全天</div>
    {#each days as day (day)}
      <div class="ad-cell">
        {#each allDayChips(day) as ev (ev.id)}
          <button
            type="button"
            class="ad-chip"
            class:cancelled={ev.status === "cancelled"}
            onclick={() => onEdit(ev.id)}
            title={ev.title}
          >
            {ev.title}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <!-- 时间轴 -->
  <div class="timeline">
    <div class="axis" style={`grid-template-columns: 48px repeat(${days.length}, 1fr)`}>
      <!-- 左侧小时标尺 -->
      <div class="gutter" style={`height:${HOUR_H * 24}px`}>
        {#each hours as h}
          <div class="hour-label" style={`top:${h * HOUR_H}px`}>
            {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
          </div>
        {/each}
      </div>

      <!-- 各日列 -->
      {#each days as day (day)}
        <div
          class="daycol"
          style={`height:${HOUR_H * 24}px`}
          role="button"
          tabindex="0"
          onclick={() => onCreate(day)}
          onkeydown={(e) => e.key === "Enter" && onCreate(day)}
        >
          {#each hours as h}
            <div class="hour-line" style={`top:${h * HOUR_H}px`}></div>
          {/each}
          {#each timedBlocks(day) as b (b.event.id)}
            <button
              type="button"
              class="block"
              class:cancelled={b.event.status === "cancelled"}
              style={blockStyle(b)}
              onclick={(e) => {
                e.stopPropagation();
                onEdit(b.event.id);
              }}
              title={b.event.title}
            >
              <div class="block-time">{formatTime(b.event.start_at)}</div>
              <div class="block-title">{b.event.title}{b.clipped ? " …" : ""}</div>
            </button>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .tg {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .head,
  .allday {
    display: grid;
    border-bottom: 1px solid var(--border);
  }

  .corner {
    border-right: 1px solid var(--border);
  }

  .allday-label {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.74rem;
    color: var(--text-dim);
  }

  .dayhead {
    border: none;
    border-right: 1px solid var(--border);
    background: transparent;
    color: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.35rem 0;
    gap: 0.1rem;
    cursor: pointer;
  }

  .dayhead .dow {
    font-size: 0.72rem;
    color: var(--text-dim);
  }

  .dayhead .dnum {
    font-size: 1rem;
    font-weight: 600;
  }

  .dayhead.today .dnum {
    background: var(--accent);
    color: #fff;
    width: 1.6rem;
    height: 1.6rem;
    line-height: 1.6rem;
    border-radius: 50%;
    text-align: center;
  }

  .ad-cell {
    border-right: 1px solid var(--border);
    padding: 0.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-height: 1.6rem;
  }

  .ad-chip {
    border: none;
    background: var(--surface-2);
    color: var(--text);
    font-weight: 600;
    font-size: 0.74rem;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ad-chip.cancelled {
    opacity: 0.5;
    text-decoration: line-through;
  }

  .timeline {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .axis {
    display: grid;
    position: relative;
  }

  .gutter {
    position: relative;
    border-right: 1px solid var(--border);
  }

  .hour-label {
    position: absolute;
    right: 0.3rem;
    transform: translateY(-50%);
    font-size: 0.68rem;
    color: var(--text-dim);
  }

  .daycol {
    position: relative;
    border-right: 1px solid var(--border);
    cursor: pointer;
  }

  .hour-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid var(--border);
    pointer-events: none;
  }

  .block {
    position: absolute;
    border: none;
    border-left: 2px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 3px;
    padding: 0.1rem 0.3rem;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    box-sizing: border-box;
  }

  .block.cancelled {
    opacity: 0.5;
    text-decoration: line-through;
  }

  .block-time {
    font-size: 0.68rem;
    color: var(--text-dim);
  }

  .block-title {
    font-size: 0.76rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
