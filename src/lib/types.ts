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
export interface RecordData {
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

/** 城市搜索候选（设置页选城市；数据源 GeoNames，同名城市靠 admin 消歧）。 */
export interface CityCandidate {
  name: string;
  admin1?: string | null;
  admin2?: string | null;
  latitude: number;
  longitude: number;
  timezone?: string | null;
  population?: number | null;
}

// —— 个人资料（settings key=profile；首页/今日问候与头像展示用） ——

/**
 * 用户资料。`avatar` 为图片 data URL、`emoji:表情` 前缀或 null（名称首字圆标兑底）。
 */
export interface UserProfile {
  name: string;
  avatar?: string | null;
}

/** 数据目录与配置文件位置（启动期解析；设置页关于展示）。 */
export interface StorageInfo {
  data_dir: string;
  config_path: string;
  customized: boolean;
}

// —— 多设备同步（docs/sync-design.md）——

/** 同步远端配置回显（不含 secret；`generated_key` 仅首次生成时返回一次）。 */
export interface SyncConfigInfo {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  access_key: string;
  has_secret: boolean;
  has_key: boolean;
  device_id: string | null;
  last_sync_at: string | null;
  /** virtual（桶名进域名）| path（桶名进路径，MinIO 等自建网关）。 */
  addressing: string;
  /** 单请求超时（秒）。 */
  timeout_secs: number;
  /** 是否校验 TLS 证书。 */
  tls_verify: boolean;
  generated_key?: string;
  /** 远端已有同步数据但本机无密钥：需从旧设备导入后才能启用同步。 */
  needs_key_import?: boolean;
}

/** 同步配置保存输入（secret_key 留空 = 保留原值；高级项缺省 = 默认值）。 */
export interface SyncConfigInput {
  endpoint: string;
  region: string;
  bucket: string;
  access_key: string;
  secret_key?: string | null;
  addressing?: string | null;
  timeout_secs?: number | null;
  tls_verify?: boolean | null;
}

/** 同步运行状态（事件 `sync://status` 同构；标题栏状态点消费）。 */
export interface SyncUi {
  /** idle | syncing | error */
  phase: string;
  last_success_at: string | null;
  error: string | null;
  /** 本次同步合并落地的记录/设置变更数；> 0 时刷新数据视图。 */
  applied: number;
}

/** 一次同步的结果统计。 */
export interface SyncOutcome {
  remote_dumps: number;
  stats: { records_applied: number; settings_applied: number };
  pushed: boolean;
}

/** 窗口关闭按钮行为：exit=直接退出；background=隐藏窗口后台驻留（需托盘）。 */
export type CloseBehavior = "exit" | "background";

/** 关闭行为展示元数据。 */
export const CLOSE_BEHAVIORS: {
  value: CloseBehavior;
  label: string;
  desc: string;
}[] = [
  {
    value: "exit",
    label: "直接退出",
    desc: "点击关闭按钮即退出程序（默认）",
  },
  {
    value: "background",
    label: "后台驻留",
    desc: "隐藏窗口到系统托盘，待办/日程提醒继续；左键点击托盘图标恢复窗口（Linux 需托盘扩展支持，不可用时自动回退直接退出）",
  },
];

// —— Agent（任务 08-15-agent-v1，镜像 mosh-core::agent）——

/** AI 模型配置（OpenAI 兼容端点；settings key=`ai_model`）。 */
export interface AiConfig {
  /** 提供商名称（设置页列表用）。 */
  name: string;
  base_url: string;
  api_key: string;
  model: string;
}

/** 会话消息行（对齐 `agent_messages` 表；id 为 UUIDv7 字符串）。 */
export interface AgentMessage {
  id: string;
  session_id: string;
  /** user | assistant | tool */
  role: string;
  content: string;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  /** 图片附件（data URL；仅 user 行可非空，旧数据无此字段 → 空）。 */
  images: string[] | null;
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

/** MCP 测试连接返回的工具详情。 */
export interface McpToolDetail {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// —— 通知方式（系统/邮件；对齐 mosh-core::notify）——

/** SMTP 加密方式。 */
export type EmailEncryption = "starttls" | "ssl" | "none";

/** 加密方式展示元数据（含各自缺省端口，切选项时联动回填表单）。 */
export const EMAIL_ENCRYPTIONS: {
  value: EmailEncryption;
  label: string;
  port: number;
  desc: string;
}[] = [
  {
    value: "starttls",
    label: "STARTTLS（587）",
    port: 587,
    desc: "明文连入后升级加密，绝大多数邮箱（QQ/163/Gmail 等）推荐",
  },
  {
    value: "ssl",
    label: "SSL（465）",
    port: 465,
    desc: "从一开始就是加密连接（隐式 TLS），部分服务商默认开启",
  },
  {
    value: "none",
    label: "不加密（25）",
    port: 25,
    desc: "仅限本机/内网中继；凭据与内容明文传输，公网邮箱勿选",
  },
];

/** SMTP 配置表单/入参（password 空串 = 保留已存值）。 */
export interface EmailConfigInput {
  host: string;
  port: number;
  encryption: EmailEncryption;
  username: string;
  password: string;
  from: string;
  to: string;
}

/** SMTP 配置回显（不含授权码）。 */
export interface EmailConfigInfo extends Omit<EmailConfigInput, "password"> {
  has_password: boolean;
}

/** 通知设置（回显形态；持久化在后端 settings 键 notify_settings）。 */
export interface NotifySettingsInfo {
  system: boolean;
  email_enabled: boolean;
  email: EmailConfigInfo | null;
}
