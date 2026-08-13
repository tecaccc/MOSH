<script lang="ts">
  /**
   * 单条 todo 渲染：完成切换、标题、优先级色标、截止、标签；
   * 操作：编辑、删除、添加子任务（仅顶层）；可折叠子任务。
   *
   * 子任务复用本组件递归渲染（但子任务不能再挂子任务——UI 上不渲染"添加子任务"按钮）。
   */
  import {
    addSubtask,
    deleteRecord,
    priorityOf,
    setTodoStatus,
    startEdit,
    subtasksOf,
  } from "../store.svelte";
  import type { Record as RecordT, Status } from "../types";

  const { record }: { record: RecordT } = $props();

  const isTopLevel = $derived(record.parent_id === null);
  const priority = $derived(priorityOf(record));
  const isDone = $derived(record.status === "done");
  const children = $derived(isTopLevel ? subtasksOf(record.id) : []);

  let expanded = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function onToggle() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const next: Status = isDone ? "active" : "done";
      await setTodoStatus(record.id, next);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function onDelete() {
    if (busy) return;
    if (!confirm(`删除「${record.title}」？此为软删，数据保留于库。`)) return;
    busy = true;
    error = null;
    try {
      await deleteRecord(record.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onEdit() {
    startEdit(record.id);
  }

  async function onAddSubtask() {
    const title = window.prompt("子任务标题：");
    if (!title || title.trim().length === 0) return;
    busy = true;
    error = null;
    try {
      await addSubtask(record.id, {
        title: title.trim(),
        priority: "none",
        tags: [],
      });
      expanded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** 截止日期（end_at）→ 友好展示（YYYY-MM-DD HH:mm）。 */
  const dueLabel = $derived(formatDue(record.end_at));

  function formatDue(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  }

  function priorityClass(p: string): string {
    return `p-${p}`;
  }

  const overdue = $derived.by(() => {
    if (!record.end_at || record.status === "done") return false;
    const d = new Date(record.end_at);
    return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
  });
</script>

<div class="todo-item" class:done={isDone}>
  <div class="row-main">
    <input
      type="checkbox"
      checked={isDone}
      onchange={onToggle}
      disabled={busy}
      aria-label={isDone ? "标记为未完成" : "标记为已完成"}
    />

    <span class="prio-dot {priorityClass(priority)}" title={`优先级: ${priority}`}></span>

    <button
      type="button"
      class="title-btn"
      onclick={onEdit}
      title="编辑"
    >
      <span class="title">{record.title}</span>
    </button>

    {#if dueLabel}
      <span class="due" class:overdue>{dueLabel}</span>
    {/if}

    {#if record.tags.length > 0}
      <span class="tags">
        {#each record.tags as tag}
          <span class="tag">#{tag}</span>
        {/each}
      </span>
    {/if}

    <div class="spacer"></div>

    <div class="actions">
      {#if isTopLevel}
        <button type="button" class="action" onclick={onAddSubtask} disabled={busy} title="添加子任务">+ 子任务</button>
      {/if}
      {#if isTopLevel && children.length > 0}
        <button type="button" class="action" onclick={() => (expanded = !expanded)}>
          {expanded ? "收起" : "展开"}({children.length})
        </button>
      {/if}
      <button type="button" class="action" onclick={onEdit} disabled={busy} title="编辑">编辑</button>
      <button type="button" class="action danger" onclick={onDelete} disabled={busy} title="删除">删除</button>
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if isTopLevel && expanded && children.length > 0}
    <ul class="subtasks">
      {#each children as child (child.id)}
        <li>
          <svelte:self record={child} />
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .todo-item {
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.5rem;
  }

  .todo-item.done .title {
    text-decoration: line-through;
    color: var(--text-dim);
  }

  .row-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  input[type="checkbox"] {
    width: 1.05rem;
    height: 1.05rem;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .prio-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-dim);
  }

  .prio-dot.p-none {
    background: transparent;
    border: 1px dashed var(--border);
  }
  .prio-dot.p-low {
    background: #6b7280;
  }
  .prio-dot.p-medium {
    background: #f59e0b;
  }
  .prio-dot.p-high {
    background: #ef4444;
  }

  .title-btn {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }

  .title-btn:hover .title {
    text-decoration: underline;
  }

  .title {
    font-size: 0.95rem;
  }

  .due {
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  .due.overdue {
    color: var(--danger);
    font-weight: 600;
  }

  .tags {
    display: inline-flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .tag {
    font-size: 0.72rem;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .actions {
    display: flex;
    gap: 0.25rem;
    opacity: 0.6;
  }

  .todo-item:hover .actions {
    opacity: 1;
  }

  .action {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
  }

  .action:hover:not(:disabled) {
    background: var(--surface-2);
  }

  .action.danger {
    color: var(--danger);
  }

  .action:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .error {
    color: var(--danger);
    font-size: 0.8rem;
    padding: 0.25rem 0 0.25rem 1.8rem;
  }

  .subtasks {
    list-style: none;
    margin: 0.25rem 0 0.25rem 1.4rem;
    padding: 0;
    border-left: 2px solid var(--border);
  }

  .subtasks li {
    padding-left: 0.4rem;
  }
</style>
