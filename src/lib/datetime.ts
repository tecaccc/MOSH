/**
 * 日期/时间共享工具（TodoEditor 与 Calendar 视图复用）。
 *
 * 两类时间值的约定（见 calendar design §7）：
 *  - 定时：存 UTC ISO8601；输入用 `datetime-local`（本地）。
 *  - 全天：存 date-only `YYYY-MM-DD`；输入用 `<input type="date">`，不做时区换算。
 */

const pad = (n: number): string => String(n).padStart(2, "0");
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO8601 → `datetime-local` 控件所需的 `YYYY-MM-DDTHH:mm`（本地，无时区后缀）。 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** `datetime-local` 值 → ISO8601（UTC）。空串 → null。 */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * 取本地日期的 date-only `YYYY-MM-DD`。
 *  - 入参已是 date-only → 原样返回（全天事件不涉时区换算）；
 *  - 入参为 ISO8601 / datetime-local → 取本地日期分量。
 * 空或非法 → ""。
 */
export function toDateOnly(value: string | null | undefined): string {
  if (!value) return "";
  if (DATE_ONLY.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** date-only `YYYY-MM-DD` → 本地展示串（如 "8月13日"）。非法/空 → 原串。 */
export function formatDate(dateStr: string | null | undefined): string {
  const m = DATE_ONLY.exec(dateStr ?? "");
  if (!m) return dateStr ?? "";
  const [, , mo, da] = m;
  return `${parseInt(mo, 10)}月${parseInt(da, 10)}日`;
}

/** ISO8601 → 本地展示串（如 "8/13 09:00"）。空/非法 → ""。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** ISO8601 → 本地时刻串 `HH:mm`。空/非法 → ""。供时间轴/事件块显示起止。 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 待办完成时间点 → 本地展示串（如 "今天 14:30" / "8月15日 09:12" / "2025年12月30日 18:00"）。
 * 今天只显示时刻；同年省年份。空/非法 → ""。
 */
export function formatCompletedAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
