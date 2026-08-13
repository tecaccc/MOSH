<script lang="ts">
  /**
   * 任务列表视图：全部 todo（顶层 + 嵌套子任务），按截止/优先级排序。
   * 只渲染顶层 todo；子任务由 TodoItem 内部递归展开。
   */
  import { topLevelTodos } from "../store.svelte";
  import TodoItem from "./TodoItem.svelte";
  import type { Priority, Record as RecordT } from "../types";

  const PRIO_RANK: Record<Priority, number> = {
    high: 0,
    medium: 1,
    low: 2,
    none: 3,
  };

  function sortKey(r: RecordT): string {
    // 无截止的排到最后（用远期占位）。
    const due = r.end_at ?? "9999-12-31T23:59:59Z";
    return `${due}|${PRIO_RANK[r.data.priority ?? "none"]}|${r.title}`;
  }

  /** 排序后的顶层 todo（截止升序 → 优先级降序 → 标题）。 */
  const sorted = $derived(
    [...topLevelTodos()].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  );
</script>

<section class="view">
  <header class="view-header">
    <h1>任务</h1>
    <span class="count">{topLevelTodos().length} 项</span>
  </header>

  {#if topLevelTodos().length === 0}
    <div class="empty">
      <p>还没有任务。</p>
      <p class="hint">点击侧栏「+ 新建待办」开始。</p>
    </div>
  {:else}
    <div class="list">
      {#each sorted as todo (todo.id)}
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
