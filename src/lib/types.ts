/**
 * 前端类型镜像（手写对齐 `crates/mosh-core/src/model.rs`）。
 *
 * 字段名一律 snake_case，与后端 serde `rename_all = "snake_case"` 对齐。
 * 所有经过 `invoke` 的 payload 均按这些类型构造。
 *
 * 注意：JS payload 的命令参数 key 默认 camelCase（Tauri 2 行为），
 * 但 payload 内部字段（filter/patch/input）保持 snake_case。
 */

export type Kind = "todo" | "event";

export type Status = "active" | "done" | "cancelled";

export type Priority = "none" | "low" | "medium" | "high";

/**
 * kind 专属扩展字段（JSON）。todo 存 `priority`；event 存 `location`/`attendees`。
 * 后端为 `serde_json::Value`，前端按宽松对象建模（未知键保留）。
 */
export interface RecordData {
  priority?: Priority;
  location?: string;
  attendees?: string[];
  [key: string]: unknown;
}

/** 统一记录，字段对齐 `records` 表。 */
export interface Record {
  id: string;
  kind: Kind;
  title: string;
  description: string | null;
  status: Status;
  /** ISO8601；event 的开始时间。 */
  start_at: string | null;
  /** ISO8601；event 的结束时间；todo 复用为 due_at（截止）。 */
  end_at: string | null;
  /** 子任务挂载点（v1 限 1 层嵌套）。 */
  parent_id: string | null;
  source: string;
  tags: string[];
  data: RecordData;
  created_at: string;
  updated_at: string;
  /** 墓碑（NULL=存活）；默认列表排除非空。 */
  deleted_at: string | null;
  revision: number;
}

/** 创建 todo 的输入。`due_at` 复用为 record.end_at。 */
export interface TodoInput {
  title: string;
  description?: string | null;
  due_at?: string | null;
  /** 缺省 "none"。 */
  priority?: Priority;
  /** 缺省 []。 */
  tags?: string[];
}

/**
 * 部分更新。只放要改的字段；省略=不改。
 *
 * 嵌套字段（description/start_at/end_at/location）为"双层 Option"：
 *   - 传 `string | null`（前端视角）：有值=设，null=清空；
 *   - 省略该键=不改。
 *
 * 底层 serde 形如 `Option<Option<String>>`；前端只关心"设/清/不动"三态。
 * 这里用平铺的可选字段表达，构造 patch 时仅写入要改的字段。
 */
export interface RecordPatch {
  title?: string;
  /** null=清空，省略=不改。 */
  description?: string | null;
  status?: Status;
  start_at?: string | null;
  end_at?: string | null;
  priority?: Priority;
  location?: string | null;
  tags?: string[];
}

/** 列表过滤维度。所有字段可选，缺省不过滤。 */
export interface RecordFilter {
  kind?: Kind;
  status?: Status;
  parent_id?: string | null;
  /** 只取顶层（parent_id IS NULL）。 */
  top_only?: boolean;
  /** 仅返回 end_at 落在 [date_from, date_to] 区间。 */
  date_from?: string;
  date_to?: string;
  /** 含已软删（默认 false）。 */
  include_deleted?: boolean;
}
