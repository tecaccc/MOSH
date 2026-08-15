<script lang="ts">
  /**
   * 待办编辑/新建表单。
   * - `record === null` → 新建模式（调 createTodo）。
   * - `record === RecordT` → 编辑模式（调 updateRecord，只放改动字段）。
   * 编辑顶层待办时展示「子任务」区（设计稿 Detail · Progress）：
   * 计数（done/total）+ 6px 进度条 + 子任务列表（勾选/编辑/删除）+ 快速添加。
   * 编辑子任务时不可再嵌套（v1 限 1 层），提供「返回父任务」。
   * 保存成功后刷新 store 并关闭编辑器。
   */
  import {
    addSubtask,
    closeEditor,
    createTodo,
    deleteRecord,
    setTodoStatus,
    startEdit,
    subtasksOf,
    updateRecord,
  } from "../store.svelte";
  import { fromLocalInput, toLocalInput } from "../datetime";
  import type { Priority, Record as RecordT, Status } from "../types";

  const { record }: { record: RecordT | null } = $props();

  const isNew = $derived(record === null);

  // 本地表单状态（用 $state，初始化自 record）。编辑模式下若 record 变化（切到另一条），
  // 用 $effect 同步表单字段。
  let title = $state("");
  let description = $state("");
  let dueAt = $state("");
  let priority = $state<Priority>("none");
  let tagsText = $state("");
  let status = $state<Status>("active");
  let saving = $state(false);
  let error = $state<string | null>(null);

  // 从 record 同步字段到表单（初始化 + 编辑目标切换时）。
  $effect(() => {
    if (record) {
      title = record.title;
      description = record.description ?? "";
      // datetime-local 需要 `YYYY-MM-DDTHH:mm`（本地，无时区后缀）。
      dueAt = toLocalInput(record.end_at);
      priority = record.data.priority ?? "none";
      tagsText = record.tags.join(", ");
      status = record.status;
    } else {
      title = "";
      description = "";
      dueAt = "";
      priority = "none";
      tagsText = "";
      status = "active";
    }
    error = null;
  });

  /** 解析逗号分隔标签。 */
  function parseTags(text: string): string[] {
    return text
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  function buildInput() {
    return {
      title: title.trim(),
      description: description.trim() || null,
      due_at: fromLocalInput(dueAt),
      priority,
      tags: parseTags(tagsText),
    };
  }

  async function onSave(event: SubmitEvent) {
    event.preventDefault();
    if (title.trim().length === 0) {
      error = "标题必填";
      return;
    }
    saving = true;
    error = null;
    try {
      if (record === null) {
        await createTodo(buildInput());
      } else {
        const patch = buildPatch(record);
        if (Object.keys(patch).length > 0) {
          await updateRecord(record.id, patch);
        }
      }
      closeEditor();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /** 与原 record 比对，只收集改动字段（编辑模式专用）。 */
  function buildPatch(original: RecordT) {
    const patch: Record<
      string,
      string | string[] | Priority | Status | null
    > = {};
    const nextTitle = title.trim();
    if (nextTitle !== original.title) patch.title = nextTitle;

    const nextDesc = description.trim() || null;
    if (nextDesc !== original.description) patch.description = nextDesc;

    const nextDue = fromLocalInput(dueAt);
    if (nextDue !== original.end_at) patch.end_at = nextDue;

    const nextPriority = priority;
    if (nextPriority !== (original.data.priority ?? "none")) {
      patch.priority = nextPriority;
    }

    const nextTags = parseTags(tagsText);
    if (tagsDiffer(nextTags, original.tags)) patch.tags = nextTags;

    if (!isNew && status !== original.status) patch.status = status;

    return patch;
  }

  function tagsDiffer(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return true;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.some((t, i) => t !== sb[i]);
  }

  // —— 子任务区（仅编辑顶层待办时展示；响应式：依赖 records）——
  const isTopTodo = $derived(record !== null && record.parent_id === null);
  const subs = $derived(record !== null && record.parent_id === null ? subtasksOf(record.id) : []);
  /** 计数口径：排除已取消（cancelled 不计入进度）。 */
  const subsLive = $derived(subs.filter((s) => s.status !== "cancelled"));
  const subsDone = $derived(subsLive.filter((s) => s.status === "done").length);
  const progressPct = $derived(
    subsLive.length === 0 ? 0 : (subsDone / subsLive.length) * 100,
  );

  let subInput = $state("");
  let subBusy = $state(false);
  let subError = $state<string | null>(null);

  async function onAddSub(event: Event) {
    event.preventDefault();
    if (!record || !isTopLevel(record)) return;
    const title = subInput.trim();
    if (title.length === 0) {
      subError = "子任务标题必填";
      return;
    }
    subBusy = true;
    subError = null;
    try {
      await addSubtask(record.id, { title, priority: "none", tags: [] });
      subInput = "";
    } catch (e) {
      subError = e instanceof Error ? e.message : String(e);
    } finally {
      subBusy = false;
    }
  }

  async function onToggleSub(s: RecordT) {
    if (subBusy) return;
    subBusy = true;
    subError = null;
    try {
      await setTodoStatus(s.id, s.status === "done" ? "active" : "done");
    } catch (e) {
      subError = e instanceof Error ? e.message : String(e);
    } finally {
      subBusy = false;
    }
  }

  async function onDeleteSub(s: RecordT) {
    if (subBusy) return;
    if (!confirm(`删除子任务「${s.title}」？此为软删，数据保留于库。`)) return;
    subBusy = true;
    subError = null;
    try {
      await deleteRecord(s.id);
    } catch (e) {
      subError = e instanceof Error ? e.message : String(e);
    } finally {
      subBusy = false;
    }
  }

  function isTopLevel(r: RecordT): boolean {
    return r.parent_id === null;
  }

  function onCancel() {
    closeEditor();
  }
</script>

<form class="editor" onsubmit={onSave}>
  <div class="header">
    <h2>{isNew ? "新建待办" : "编辑待办"}</h2>
    <button type="button" class="icon-btn" onclick={onCancel} aria-label="关闭">✕</button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <label class="field">
    <span class="label">标题</span>
    <input bind:value={title} placeholder="待办标题…" required />
  </label>

  <label class="field">
    <span class="label">描述</span>
    <textarea bind:value={description} rows="4" placeholder="支持 Markdown…"></textarea>
  </label>

  <div class="row">
    <label class="field">
      <span class="label">截止日期</span>
      <input type="datetime-local" bind:value={dueAt} />
    </label>

    <label class="field">
      <span class="label">优先级</span>
      <select bind:value={priority}>
        <option value="none">无</option>
        <option value="low">低</option>
        <option value="medium">中</option>
        <option value="high">高</option>
      </select>
    </label>
  </div>

  {#if !isNew}
    <label class="field">
      <span class="label">状态</span>
      <select bind:value={status}>
        <option value="active">进行中</option>
        <option value="done">已完成</option>
        <option value="cancelled">已取消</option>
      </select>
    </label>
  {/if}

  <label class="field">
    <span class="label">标签（逗号分隔）</span>
    <input bind:value={tagsText} placeholder="work, personal" />
  </label>

  {#if !isNew && isTopTodo}
    <div class="subtasks-sec">
      <div class="sub-head">
        <span class="sub-title">子任务</span>
        {#if subsLive.length > 0}
          <span class="sub-count">{subsDone} / {subsLive.length}</span>
        {/if}
      </div>
      {#if subsLive.length > 0}
        <div class="track">
          <div class="fill" style:width="{progressPct}%"></div>
        </div>
      {/if}
      {#if subs.length > 0}
        <ul class="sub-list">
          {#each subs as s (s.id)}
            <li class="sub-row" class:cancelled={s.status === "cancelled"}>
              <input
                type="checkbox"
                checked={s.status === "done"}
                onchange={() => onToggleSub(s)}
                disabled={subBusy}
                aria-label={s.status === "done" ? "标记为未完成" : "标记为已完成"}
              />
              <button
                type="button"
                class="sub-name"
                class:done={s.status !== "active"}
                onclick={() => startEdit(s.id)}
                title="编辑子任务"
              >{s.title}</button>
              <button
                type="button"
                class="sub-del"
                onclick={() => onDeleteSub(s)}
                disabled={subBusy}
                aria-label="删除子任务">✕</button>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="sub-empty">暂无子任务</div>
      {/if}
      <div class="sub-add">
        <input
          bind:value={subInput}
          placeholder="添加子任务，回车确认…"
          disabled={subBusy}
          onkeydown={(e) => e.key === "Enter" && onAddSub(e)}
        />
        <button
          type="button"
          class="sub-add-btn"
          onclick={(e) => onAddSub(e)}
          disabled={subBusy || subInput.trim().length === 0}>添加</button
        >
      </div>
      {#if subError}
        <div class="sub-error">{subError}</div>
      {/if}
    </div>
  {:else if record}
    <div class="sub-note">
      这是子任务（v1 限 1 层，不可再嵌套）。
      {#if record.parent_id}
        <button
          type="button"
          class="back-link"
          onclick={() => startEdit(record.parent_id!)}
        >← 返回父任务</button>
      {/if}
    </div>
  {/if}

  <div class="actions">
    <button type="button" onclick={onCancel} disabled={saving}>取消</button>
    <button type="submit" class="primary" disabled={saving}>
      {saving ? "保存中…" : "保存"}
    </button>
  </div>
</form>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1.25rem;
    height: 100%;
    overflow-y: auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  .icon-btn {
    border: none;
    background: transparent;
    color: inherit;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }

  .icon-btn:hover {
    background: var(--surface-2);
  }

  .error {
    background: var(--danger-soft);
    color: var(--danger);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.9rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .label {
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  input,
  textarea,
  select {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: inherit;
    font-size: 0.92rem;
    font-family: inherit;
  }

  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }

  textarea {
    resize: vertical;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .actions button {
    padding: 0.5rem 1.1rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.92rem;
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .actions .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  /* —— 子任务区（设计稿 Detail · Progress）—— */
  .subtasks-sec {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.2rem;
    border-top: 1px solid var(--border);
  }

  .sub-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sub-title {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .sub-count {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .track {
    height: 6px;
    border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: 3px;
    background: var(--accent);
    transition: width 0.2s ease;
  }

  .sub-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .sub-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.2rem;
    border-radius: 6px;
  }

  .sub-row:hover {
    background: var(--surface-2);
  }

  .sub-row input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .sub-name {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font: inherit;
    font-size: 0.88rem;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub-name.done {
    color: var(--text-dim);
    text-decoration: line-through;
  }

  .sub-row.cancelled .sub-name {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  .sub-del {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .sub-del:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .sub-del:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .sub-empty {
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 0.15rem 0.2rem;
  }

  .sub-add {
    display: flex;
    gap: 0.4rem;
  }

  .sub-add input {
    flex: 1;
    min-width: 0;
    font-size: 0.85rem;
  }

  .sub-add-btn {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    border-radius: 6px;
    padding: 0.35rem 0.8rem;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .sub-add-btn:hover:not(:disabled) {
    filter: brightness(1.05);
  }

  .sub-add-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .sub-error {
    background: var(--danger-soft);
    color: var(--danger);
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    font-size: 0.82rem;
  }

  .sub-note {
    font-size: 0.82rem;
    color: var(--text-dim);
    padding-top: 0.2rem;
    border-top: 1px solid var(--border);
  }

  .back-link {
    border: none;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.82rem;
    padding: 0;
    margin-left: 0.25rem;
  }

  .back-link:hover {
    text-decoration: underline;
  }
</style>
