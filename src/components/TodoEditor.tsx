import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fromLocalInput, formatCompletedAt, toLocalInput } from "../lib/datetime";
import { subtasksOf, useAppStore } from "../state/store";
import { useDialogStore } from "../state/dialog";
import type { Priority, Record as RecordT, Status } from "../lib/types";
import styles from "./TodoEditor.module.css";

/**
 * 待办编辑/新建表单。record===null → 新建（createTodo）；否则编辑（只放改动字段）。
 * 编辑顶层待办时展示「子任务」区（计数 + 进度条 + 列表 + 快速添加）。
 * 编辑子任务时不可再嵌套（v1 限 1 层），提供「返回父任务」。
 */

function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function tagsDiffer(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.some((t, i) => t !== sb[i]);
}

export default function TodoEditor({ record }: { record: RecordT | null }) {
  const isNew = record === null;
  const records = useAppStore((s) => s.records);
  const createTodo = useAppStore((s) => s.createTodo);
  const updateRecord = useAppStore((s) => s.updateRecord);
  const deleteRecord = useAppStore((s) => s.deleteRecord);
  const setTodoStatus = useAppStore((s) => s.setTodoStatus);
  const addSubtask = useAppStore((s) => s.addSubtask);
  const startEdit = useAppStore((s) => s.startEdit);
  const closeEditor = useAppStore((s) => s.closeEditor);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [tagsText, setTagsText] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 从 record 同步字段到表单（初始化 + 编辑目标/后台刷新替换对象时）。
  useEffect(() => {
    if (record) {
      setTitle(record.title);
      setDescription(record.description ?? "");
      setDueAt(toLocalInput(record.end_at));
      setPriority(record.data.priority ?? "none");
      setTagsText(record.tags.join(", "));
      setStatus(record.status);
    } else {
      setTitle("");
      setDescription("");
      setDueAt("");
      setPriority("none");
      setTagsText("");
      setStatus("active");
    }
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record]);

  function buildInput() {
    return {
      title: title.trim(),
      description: description.trim() || null,
      due_at: fromLocalInput(dueAt),
      priority,
      tags: parseTags(tagsText),
    };
  }

  /** 与原 record 比对，只收集改动字段（编辑模式专用）。 */
  function buildPatch(original: RecordT) {
    const patch: Record<string, string | string[] | Priority | Status | null> = {};
    const nextTitle = title.trim();
    if (nextTitle !== original.title) patch.title = nextTitle;

    const nextDesc = description.trim() || null;
    if (nextDesc !== original.description) patch.description = nextDesc;

    const nextDue = fromLocalInput(dueAt);
    if (nextDue !== original.end_at) patch.end_at = nextDue;

    if (priority !== (original.data.priority ?? "none")) patch.priority = priority;

    const nextTags = parseTags(tagsText);
    if (tagsDiffer(nextTags, original.tags)) patch.tags = nextTags;

    if (!isNew && status !== original.status) patch.status = status;

    return patch;
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (title.trim().length === 0) {
      setError("标题必填");
      return;
    }
    setSaving(true);
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // —— 子任务区（仅编辑顶层待办时展示）——
  const isTopTodo = record !== null && record.parent_id === null;
  const subs = useMemo(
    () => (record !== null && record.parent_id === null ? subtasksOf(records, record.id) : []),
    [record, records],
  );
  const subsLive = useMemo(() => subs.filter((s) => s.status !== "cancelled"), [subs]);
  const subsDone = subsLive.filter((s) => s.status === "done").length;
  const progressPct = subsLive.length === 0 ? 0 : (subsDone / subsLive.length) * 100;

  const [subInput, setSubInput] = useState("");
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  async function onAddSub(e: Event) {
    e.preventDefault();
    if (!record || record.parent_id !== null) return;
    const t = subInput.trim();
    if (t.length === 0) {
      setSubError("子任务标题必填");
      return;
    }
    setSubBusy(true);
    setSubError(null);
    try {
      await addSubtask(record.id, { title: t, priority: "none", tags: [] });
      setSubInput("");
    } catch (err) {
      setSubError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubBusy(false);
    }
  }

  async function onToggleSub(s: RecordT) {
    if (subBusy) return;
    setSubBusy(true);
    setSubError(null);
    try {
      await setTodoStatus(s.id, s.status === "done" ? "active" : "done");
    } catch (e) {
      setSubError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubBusy(false);
    }
  }

  async function onDeleteSub(s: RecordT) {
    if (subBusy) return;
    const ok = await useDialogStore.getState().confirm({
      title: "删除子任务",
      message: `将删除子任务「${s.title}」。此为软删，数据保留于库可恢复。`,
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    setSubBusy(true);
    setSubError(null);
    try {
      await deleteRecord(s.id);
    } catch (e) {
      setSubError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubBusy(false);
    }
  }

  return (
    <form className={styles.editor} onSubmit={(e) => void onSave(e)}>
      <div className={styles.header}>
        <h2>{isNew ? "新建待办" : "编辑待办"}</h2>
        <button type="button" className={styles["icon-btn"]} onClick={closeEditor} aria-label="关闭">✕</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <label className={styles.field}>
        <span className={styles.label}>标题</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="待办标题…" required />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>描述</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="支持 Markdown…" />
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>截止日期</span>
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>优先级</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            <option value="none">无</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
      </div>

      {!isNew ? (
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>状态</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="active">进行中</option>
              <option value="done">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
          {status === "done" && record.data.completed_at ? (
            <div className={styles.field}>
              <span className={styles.label}>完成时间</span>
              <div className={styles["completed-at"]}>✓ {formatCompletedAt(record.data.completed_at)}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>标签（逗号分隔）</span>
        <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="work, personal" />
      </label>

      {!isNew && isTopTodo ? (
        <div className={styles["subtasks-sec"]}>
          <div className={styles["sub-head"]}>
            <span className={styles["sub-title"]}>子任务</span>
            {subsLive.length > 0 ? (
              <span className={styles["sub-count"]}>{subsDone} / {subsLive.length}</span>
            ) : null}
          </div>
          {subsLive.length > 0 ? (
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${progressPct}%` }} />
            </div>
          ) : null}
          {subs.length > 0 ? (
            <ul className={styles["sub-list"]}>
              {subs.map((s) => (
                <li key={s.id} className={`${styles["sub-row"]}${s.status === "cancelled" ? ` ${styles.cancelled}` : ""}`}>
                  <input
                    type="checkbox"
                    checked={s.status === "done"}
                    onChange={() => void onToggleSub(s)}
                    disabled={subBusy}
                    aria-label={s.status === "done" ? "标记为未完成" : "标记为已完成"}
                  />
                  <button
                    type="button"
                    className={`${styles["sub-name"]}${s.status !== "active" ? ` ${styles.done}` : ""}`}
                    onClick={() => startEdit(s.id)}
                    title="编辑子任务"
                  >
                    {s.title}
                  </button>
                  <button
                    type="button"
                    className={styles["sub-del"]}
                    onClick={() => void onDeleteSub(s)}
                    disabled={subBusy}
                    aria-label="删除子任务"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles["sub-empty"]}>暂无子任务</div>
          )}
          <div className={styles["sub-add"]}>
            <input
              value={subInput}
              onChange={(e) => setSubInput(e.target.value)}
              placeholder="添加子任务，回车确认…"
              disabled={subBusy}
              onKeyDown={(e) => e.key === "Enter" && void onAddSub(e.nativeEvent)}
            />
            <button
              type="button"
              className={styles["sub-add-btn"]}
              onClick={(e) => void onAddSub(e.nativeEvent)}
              disabled={subBusy || subInput.trim().length === 0}
            >
              添加
            </button>
          </div>
          {subError ? <div className={styles["sub-error"]}>{subError}</div> : null}
        </div>
      ) : record ? (
        <div className={styles["sub-note"]}>
          这是子任务（v1 限 1 层，不可再嵌套）。
          {record.parent_id ? (
            <button
              type="button"
              className={styles["back-link"]}
              onClick={() => startEdit(record.parent_id!)}
            >
              ← 返回父任务
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.actions}>
        <button type="button" onClick={closeEditor} disabled={saving}>取消</button>
        <button type="submit" className={styles.primary} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
