<script lang="ts">
  /**
   * 今日视图：今日到期（end_at 落在今天）+ 未完成（status=active）。
   * 数据来源：store.records（已含全部未软删 todo），本地派生过滤。
   */
  import { records } from "../store.svelte";
  import TodoItem from "./TodoItem.svelte";
  import type { Record as RecordT } from "../types";

  function isToday(iso: string | null): boolean {
    if (!iso) return false;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  }

  /** 今日到期 + 未完成（含顶层与子任务）。 */
  const todayTodos = $derived(
    records.filter(
      (r: RecordT) => r.status === "active" && isToday(r.end_at),
    ),
  );
</script>

<section class="view">
  <header class="view-header">
    <h1>今日</h1>
    <span class="count">{todayTodos.length} 项</span>
  </header>

  {#if todayTodos.length === 0}
    <div class="empty">
      <p>今日无到期未完成的待办。</p>
      <p class="hint">在「任务」中新建，并将截止日期设为今天。</p>
    </div>
  {:else}
    <div class="list">
      {#each todayTodos as todo (todo.id)}
        <TodoItem record={todo} />
      {/each}
    </div>
  {/if}
</section>

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .view-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .view-header h1 {
    margin: 0;
    font-size: 1.25rem;
  }

  .count {
    color: var(--text-dim);
    font-size: 0.85rem;
  }

  .empty {
    padding: 3rem 1.5rem;
    text-align: center;
    color: var(--text-dim);
  }

  .empty .hint {
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }

  .list {
    flex: 1;
    overflow-y: auto;
  }
</style>
