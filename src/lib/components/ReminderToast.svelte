<script lang="ts">
  /**
   * 提醒弹出式通知：顶部右侧堆叠显示到点的事件提醒。
   * 点击「查看」跳转日历、点击 ✕ 关闭。数据由 reminder.svelte.ts 驱动。
   */
  import { onMount } from "svelte";
  import { formatDateTime } from "../datetime";
  import { dismissReminder, dueReminders, startReminders } from "../reminder.svelte";
  import { setView } from "../store.svelte";
  import type { Record as RecordT } from "../types";

  onMount(() => {
    startReminders();
  });

  function onView(_e: RecordT): void {
    setView("calendar");
  }
</script>

{#each dueReminders() as r (r.id + (r.start_at ?? ""))}
  <div class="reminder" role="status">
    <span class="rico">⏰</span>
    <div class="rtext">
      <div class="rtitle">{r.title}</div>
      <div class="rtime">{formatDateTime(r.start_at)}</div>
    </div>
    <button type="button" class="rview" onclick={() => onView(r)}>查看</button>
    <button type="button" class="rclose" onclick={() => dismissReminder(r)} aria-label="关闭">✕</button>
  </div>
{/each}

<style>
  .reminder {
    position: fixed;
    top: 48px;
    right: 16px;
    z-index: 300;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 300px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-left: 3px solid var(--pri-med);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    animation: slide-in 0.18s ease-out;
  }

  .reminder + .reminder {
    margin-top: 8px;
  }

  .rico {
    font-size: 18px;
    flex-shrink: 0;
  }

  .rtext {
    flex: 1;
    min-width: 0;
  }

  .rtitle {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rtime {
    margin-top: 2px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .rview {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 4px;
    flex-shrink: 0;
  }

  .rview:hover {
    text-decoration: underline;
  }

  .rclose {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    padding: 2px 4px;
    flex-shrink: 0;
  }

  .rclose:hover {
    color: var(--text);
  }

  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
</style>
