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
 * kind 专属扩展字段（JSON）。todo 存 `priority`；event 存 `location`/`attendees` 等。
 * 后端为 `serde_json::Value`，前端按宽松对象建模（未知键保留）。
 */
export interface RecordData {
  priority?: Priority;
  location?: string;
  /** 全天事件标记（event 专属；缺省 false）。 */
  all_day?: boolean;
  attendees?: string[];
  /** 事件周期（event 专属）：none/daily/weekly/monthly/yearly。 */
  recurrence?: string;
  /** 提前多少分钟提醒（event 专属；缺省 0 = 不提醒）。 */
  reminder_minutes?: number;
  /** 待办完成时间点（todo 专属；后端状态变 done 时自动写入，恢复时清除）。 */
  completed_at?: string;
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
 * 创建 event 的输入。`start_at`/`end_at` 必填：
 *  - 定时：ISO8601（`...T09:00:00Z`）；后端校验 `end > start`。
 *  - 全天（`all_day`）：date-only `YYYY-MM-DD`；后端校验 `end >= start`（end 含当天）。
 */
export interface EventInput {
  title: string;
  description?: string | null;
  start_at: string;
  end_at: string;
  location?: string | null;
  /** 缺省 false。true 时 start_at/end_at 视为 date-only。 */
  all_day?: boolean;
  /** 缺省 []。 */
  tags?: string[];
  /** 周期：none/daily/weekly/monthly/yearly。 */
  recurrence?: string;
  /** 提前多少分钟提醒；0/缺省 = 不提醒。 */
  reminder_minutes?: number;
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
  /** 全天标记（event 专属）。后端为 `Option<bool>`（非双层）。 */
  all_day?: boolean;
  tags?: string[];
  /** 事件周期（缺省不改；"none"=取消重复）。 */
  recurrence?: string;
  /** 提前提醒分钟数（缺省不改；0=取消提醒）。 */
  reminder_minutes?: number;
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

/**
 * 当前天气（Open-Meteo `current` 子集）。字段对齐 `mosh_core::weather::CurrentWeather`。
 * `weather_code` 为原始 WMO 代码，文案/图标映射见 `weather-code.ts`。
 */
export interface CurrentWeather {
  temperature: number;
  apparent_temperature: number;
  humidity: number;
  weather_code: number;
}

/**
 * 天气城市配置。`query` 为 geocode 查询串（城市标识，持久化）；
 * `lat`/`lng`/`tz` 由后端首次解析后复用（缺省 null=尚未 geocode）。
 */
export interface WeatherConfig {
  query: string;
  lat?: number | null;
  lng?: number | null;
  tz?: string | null;
}

// —— Agent（任务 08-15-agent-v1，镜像 mosh-core::agent）——

/** AI 模型配置（OpenAI 兼容端点；settings key=`ai_model`）。 */
export interface AiConfig {
  /** 提供商名称（设置页列表用）。 */
  name: string;
  base_url: string;
  api_key: string;
  model: string;
}

/** 会话消息行（对齐 `agent_messages` 表）。 */
export interface AgentMessage {
  id: number;
  session_id: string;
  /** user | assistant | tool */
  role: string;
  content: string;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  created_at: string;
}

/** 会话摘要（侧栏列表）。 */
export interface AgentSessionSummary {
  session_id: string;
  title: string;
  message_count: number;
}

/** `agent://*` 事件载荷（serde tag="type"；前端按事件名分发，type 字段冗余校验用）。 */
export type AgentEventPayload =
  | { type: "start"; session_id: string; turn_id: string }
  | { type: "delta"; turn_id: string; text: string }
  | { type: "tool"; turn_id: string; tool: string; args: unknown; ok: boolean; result: unknown }
  | {
      type: "approval_required";
      turn_id: string;
      call_id: string;
      tool: string;
      args: unknown;
    }
  | { type: "end"; turn_id: string; reason: "done" | "aborted" | "error"; error?: string };

/** 工具审批模式（后端 PermissionMode 镜像）。 */
export type PermissionMode = "auto" | "write" | "all";

/** 审批模式展示元数据。 */
export const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  desc: string;
}[] = [
  { value: "auto", label: "免审批", desc: "所有工具直接执行（默认）" },
  { value: "write", label: "写操作审批", desc: "查询类放行；创建/修改/删除与 MCP 工具需批准" },
  { value: "all", label: "全部审批", desc: "每个工具调用都需人工批准" },
];

// —— Skills / MCP（对齐 mosh-core::agent::{skills, mcp}）——

/** 一条技能定义（启用后 prompt 追加到系统提示词）。 */
export interface SkillDef {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtin: boolean;
}

/** 技能 + 启用状态（后端 SkillInfo 扁平化）。 */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtin: boolean;
  active: boolean;
}

/** MCP 服务器配置（Streamable HTTP 端点）。 */
export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  token?: string | null;
  enabled: boolean;
}
