<script lang="ts">
  /**
   * 待办编辑/新建表单。
   * - `record === null` → 新建模式（调 createTodo）。
   * - `record === RecordT` → 编辑模式（调 updateRecord，只放改动字段）。
   * 保存成功后刷新 store 并关闭编辑器。
   */
  import {
    closeEditor,
    createTodo,
    updateRecord,
  } from "../store.svelte";
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

  /** ISO8601 → datetime-local 控件所需的 `YYYY-MM-DDTHH:mm`。 */
  function toLocalInput(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  }

  /** `datetime-local` 值 → ISO8601（UTC）。空串 → null。 */
  function fromLocalInput(value: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

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
</style>
