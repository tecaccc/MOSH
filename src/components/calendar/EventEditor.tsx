import { useEffect, useState, type FormEvent } from "react";
import { useCalendarStore } from "../../state/calendar";
import { fromLocalInput, toDateOnly, toLocalInput } from "../../lib/datetime";
import type { EventInput, Record as RecordT, Status } from "../../lib/types";
import styles from "./EventEditor.module.css";

/**
 * 事件编辑/新建表单。event===null → 新建（默认起止取自 cursor）；否则编辑（patch）。
 * 全天复选框切换 date / datetime-local 两种输入（date-only 存即所显，不做时区换算）。
 */

function parseTags(text: string): string[] {
  return text.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

function tagsDiffer(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.some((t, i) => t !== sb[i]);
}

export default function EventEditor({ event }: { event: RecordT | null }) {
  const isNew = event === null;
  const cursor = useCalendarStore((s) => s.cursor);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const closeEditor = useCalendarStore((s) => s.closeEditor);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startVal, setStartVal] = useState("");
  const [endVal, setEndVal] = useState("");
  const [location, setLocation] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [recurrence, setRecurrence] = useState<string>("none");
  const [reminderMinutes, setReminderMinutes] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 从 event 同步字段（初始化 + 编辑目标切换时）。新建态用 cursor 取默认起止。
  useEffect(() => {
    if (event) {
      setTitle(event.title);
      setDescription(event.description ?? "");
      const ad = event.data.all_day === true;
      setAllDay(ad);
      setStatus(event.status);
      setLocation(event.data.location ?? "");
      setTagsText(event.tags.join(", "));
      setRecurrence(typeof event.data.recurrence === "string" ? event.data.recurrence : "none");
      setReminderMinutes(
        typeof event.data.reminder_minutes === "number" ? event.data.reminder_minutes : 0,
      );
      if (ad) {
        setStartVal(event.start_at ?? cursor);
        setEndVal(event.end_at ?? event.start_at ?? cursor);
      } else {
        setStartVal(toLocalInput(event.start_at));
        setEndVal(toLocalInput(event.end_at));
      }
    } else {
      const c = cursor;
      setTitle("");
      setDescription("");
      setAllDay(false);
      setLocation("");
      setTagsText("");
      setStatus("active");
      setRecurrence("none");
      setReminderMinutes(0);
      setStartVal(`${c}T09:00`);
      setEndVal(`${c}T10:00`);
    }
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  /** 切换全天↔定时时，把起止值在 date-only 与 datetime-local 两格式间转换。 */
  function onToggleAllDay(next: boolean) {
    if (next === allDay) return;
    if (next) {
      const s = toDateOnly(startVal);
      let e2 = toDateOnly(endVal);
      if (e2 < s) e2 = s;
      setStartVal(s);
      setEndVal(e2);
    } else {
      const base = startVal || cursor;
      setStartVal(`${base}T09:00`);
      setEndVal(`${base}T10:00`);
    }
    setAllDay(next);
  }

  /** 校验 + 收集要发送的 start/end（date-only 或 ISO）。 */
  function validateRange(): { startAt: string; endAt: string } | null {
    if (allDay) {
      if (!startVal || !endVal) {
        setError("起止日期必填");
        return null;
      }
      if (endVal < startVal) {
        setError("结束日期不能早于开始日期");
        return null;
      }
      return { startAt: startVal, endAt: endVal };
    }
    if (!startVal || !endVal) {
      setError("起止时间必填");
      return null;
    }
    const s = fromLocalInput(startVal);
    const en = fromLocalInput(endVal);
    if (!s || !en || en <= s) {
      setError("结束时间须晚于开始时间");
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
      recurrence,
      reminder_minutes: reminderMinutes,
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

    const origRecurrence =
      typeof original.data.recurrence === "string" ? original.data.recurrence : "none";
    if (recurrence !== origRecurrence) patch.recurrence = recurrence;

    const origReminder =
      typeof original.data.reminder_minutes === "number" ? original.data.reminder_minutes : 0;
    if (reminderMinutes !== origReminder) patch.reminder_minutes = reminderMinutes;

    return patch;
  }

  async function onSave(submit: FormEvent) {
    submit.preventDefault();
    if (title.trim().length === 0) {
      setError("标题必填");
      return;
    }
    setSaving(true);
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (isNew || !event) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteEvent(event.id);
      closeEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form className={styles.editor} onSubmit={(e) => void onSave(e)}>
      <div className={styles.header}>
        <h2>{isNew ? "新建事件" : "编辑事件"}</h2>
        <button type="button" className={styles["icon-btn"]} onClick={closeEditor} aria-label="关闭">✕</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <label className={styles.field}>
        <span className={styles.label}>标题</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="事件标题…" required />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>描述</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="支持 Markdown…" />
      </label>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={allDay}
          onChange={(e) => onToggleAllDay(e.currentTarget.checked)}
        />
        <span>全天事件</span>
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>{allDay ? "开始日期" : "开始时间"}</span>
          <input
            type={allDay ? "date" : "datetime-local"}
            value={startVal}
            onChange={(e) => setStartVal(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{allDay ? "结束日期" : "结束时间"}</span>
          <input
            type={allDay ? "date" : "datetime-local"}
            value={endVal}
            onChange={(e) => setEndVal(e.target.value)}
          />
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>地点</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="会议室 / 地址…" />
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>重复</span>
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="none">不重复</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="yearly">每年</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>提醒</span>
          <select value={reminderMinutes} onChange={(e) => setReminderMinutes(Number(e.target.value))}>
            <option value={0}>不提醒</option>
            <option value={5}>提前 5 分钟</option>
            <option value={10}>提前 10 分钟</option>
            <option value={15}>提前 15 分钟</option>
            <option value={30}>提前 30 分钟</option>
            <option value={60}>提前 1 小时</option>
            <option value={1440}>提前 1 天</option>
          </select>
        </label>
      </div>

      {!isNew ? (
        <label className={styles.field}>
          <span className={styles.label}>状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="active">活跃</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>标签（逗号分隔）</span>
        <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="work, personal" />
      </label>

      <div className={styles.actions}>
        {!isNew ? (
          <button
            type="button"
            className={styles.danger}
            onClick={() => void onDelete()}
            disabled={deleting || saving}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        ) : null}
        <button type="button" onClick={closeEditor} disabled={saving || deleting}>取消</button>
        <button type="submit" className={styles.primary} disabled={saving || deleting}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
