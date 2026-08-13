<script lang="ts">
  /**
   * 事件编辑/新建表单。
   * - `event === null` → 新建（createEvent，默认起止取自 cursor）。
   * - `event === RecordT` → 编辑（updateEvent patch）。
   *
   * 全天复选框切换两种输入：
   *  - 全天：`<input type="date">`，值 date-only（存即 date-only，不做时区换算）。
   *  - 定时：`<input type="datetime-local">`，值 `YYYY-MM-DDTHH:mm`（本地）→ ISO8601。
   */
  import {
    closeEditor,
    createEvent,
    deleteEvent,
    updateEvent,
    cursor,
  } from "../../calendar.svelte";
  import { fromLocalInput, toDateOnly, toLocalInput } from "../../datetime";
  import type { EventInput, Record as RecordT, Status } from "../../types";

  const { event }: { event: RecordT | null } = $props();

  const isNew = $derived(event === null);

  let title = $state("");
  let description = $state("");
  let allDay = $state(false);
  let startVal = $state("");
  let endVal = $state("");
  let location = $state("");
  let tagsText = $state("");
  let status = $state<Status>("active");
  let saving = $state(false);
  let deleting = $state(false);
  let error = $state<string | null>(null);

  // 从 event 同步字段（初始化 + 编辑目标切换时）。新建态用 cursor 取默认起止。
  $effect(() => {
    if (event) {
      title = event.title;
      description = event.description ?? "";
      allDay = event.data.all_day === true;
      status = event.status;
      location = event.data.location ?? "";
      tagsText = event.tags.join(", ");
      if (allDay) {
        startVal = event.start_at ?? cursor();
        endVal = event.end_at ?? startVal;
      } else {
        startVal = toLocalInput(event.start_at);
        endVal = toLocalInput(event.end_at);
      }
    } else {
      const c = cursor();
      title = "";
      description = "";
      allDay = false;
      location = "";
      tagsText = "";
      status = "active";
      startVal = `${c}T09:00`;
      endVal = `${c}T10:00`;
    }
    error = null;
  });

  /** 切换全天↔定时时，把起止值在 date-only 与 datetime-local 两格式间转换。 */
  function onToggleAllDay(e: Event): void {
    const next = (e.currentTarget as HTMLInputElement).checked;
    if (next === allDay) return;
    if (next) {
      // 定时 → 全天：取本地日期分量，保证 end >= start。
      const s = toDateOnly(startVal);
      let e2 = toDateOnly(endVal);
      if (e2 < s) e2 = s;
      startVal = s;
      endVal = e2;
    } else {
      // 全天 → 定时：补默认时刻 09:00–10:00。
      const base = startVal || cursor();
      startVal = `${base}T09:00`;
      endVal = `${base}T10:00`;
    }
    allDay = next;
  }

  function parseTags(text: string): string[] {
    return text.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  }

  /** 校验 + 收集要发送的 start/end（date-only 或 ISO）。 */
  function validateRange(): { startAt: string; endAt: string } | null {
    if (allDay) {
      if (!startVal || !endVal) {
        error = "起止日期必填";
        return null;
      }
      if (endVal < startVal) {
        error = "结束日期不能早于开始日期";
        return null;
      }
      return { startAt: startVal, endAt: endVal };
    }
    if (!startVal || !endVal) {
      error = "起止时间必填";
      return null;
    }
    const s = fromLocalInput(startVal);
    const en = fromLocalInput(endVal);
    if (!s || !en || en <= s) {
      error = "结束时间须晚于开始时间";
      return null;
    }
    return { startAt: s, endAt: en };
  }

  function buildInput(): EventInput | null {
    const r = validateRange();
    if (!r) return null;
    return {
      title: title.trim(),
      description: description.trim() || null,
      start_at: r.startAt,
      end_at: r.endAt,
      all_day: allDay,
      location: location.trim() || null,
      tags: parseTags(tagsText),
    };
  }

  function buildPatch(original: RecordT): Record<string, unknown> | null {
    const r = validateRange();
    if (!r) return null;
    const patch: Record<string, unknown> = {};
    const nextTitle = title.trim();
    if (nextTitle !== original.title) patch.title = nextTitle;

    const nextDesc = description.trim() || null;
    if (nextDesc !== original.description) patch.description = nextDesc;

    if (r.startAt !== original.start_at) patch.start_at = r.startAt;
    if (r.endAt !== original.end_at) patch.end_at = r.endAt;

    if (allDay !== (original.data.all_day === true)) patch.all_day = allDay;

    const nextLoc = location.trim() || null;
    if (nextLoc !== (original.data.location ?? null)) patch.location = nextLoc;

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

  async function onSave(submit: SubmitEvent) {
    submit.preventDefault();
    if (title.trim().length === 0) {
      error = "标题必填";
      return;
    }
    saving = true;
    error = null;
    try {
      if (isNew) {
        const input = buildInput();
        if (input) await createEvent(input);
      } else if (event) {
        const patch = buildPatch(event);
        if (patch && Object.keys(patch).length > 0) await updateEvent(event.id, patch);
      }
      closeEditor();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function onDelete() {
    if (isNew || !event) return;
    deleting = true;
    error = null;
    try {
      await deleteEvent(event.id);
      closeEditor();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      deleting = false;
    }
  }

  function onCancel() {
    closeEditor();
  }
</script>

<form class="editor" onsubmit={onSave}>
  <div class="header">
    <h2>{isNew ? "新建事件" : "编辑事件"}</h2>
    <button type="button" class="icon-btn" onclick={onCancel} aria-label="关闭">✕</button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <label class="field">
    <span class="label">标题</span>
    <input bind:value={title} placeholder="事件标题…" required />
  </label>

  <label class="field">
    <span class="label">描述</span>
    <textarea bind:value={description} rows="3" placeholder="支持 Markdown…"></textarea>
  </label>

  <label class="check">
    <input type="checkbox" checked={allDay} onchange={onToggleAllDay} />
    <span>全天事件</span>
  </label>

  <div class="row">
    <label class="field">
      <span class="label">{allDay ? "开始日期" : "开始时间"}</span>
      <input type={allDay ? "date" : "datetime-local"} bind:value={startVal} />
    </label>
    <label class="field">
      <span class="label">{allDay ? "结束日期" : "结束时间"}</span>
      <input type={allDay ? "date" : "datetime-local"} bind:value={endVal} />
    </label>
  </div>

  <label class="field">
    <span class="label">地点</span>
    <input bind:value={location} placeholder="会议室 / 地址…" />
  </label>

  {#if !isNew}
    <label class="field">
      <span class="label">状态</span>
      <select bind:value={status}>
        <option value="active">活跃</option>
        <option value="cancelled">已取消</option>
      </select>
    </label>
  {/if}

  <label class="field">
    <span class="label">标签（逗号分隔）</span>
    <input bind:value={tagsText} placeholder="work, personal" />
  </label>

  <div class="actions">
    {#if !isNew}
      <button
        type="button"
        class="danger"
        onclick={onDelete}
        disabled={deleting || saving}
      >
        {deleting ? "删除中…" : "删除"}
      </button>
    {/if}
    <button type="button" onclick={onCancel} disabled={saving || deleting}>取消</button>
    <button type="submit" class="primary" disabled={saving || deleting}>
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

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.92rem;
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
    align-items: center;
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

  .actions .danger {
    margin-right: auto;
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
