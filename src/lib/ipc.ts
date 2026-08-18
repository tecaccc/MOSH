/**
 * Tauri IPC 封装：7 个命令的强类型包装。
 *
 * 命令名 snake_case 原样调用；JS payload 的参数 key 默认 camelCase（Tauri 2）。
 * 但 payload *内部* 字段（filter/patch/input）保持 snake_case，对齐后端 serde。
 *
 * 关键陷阱：`add_subtask` 的参数 key 必须是 `parentId`（camelCase），
 * 若写成 `parent_id` 会被 Tauri 视为缺失参数而静默失败（得到默认空串）。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentMessage,
  AgentSessionSummary,
  AiConfig,
  CloseBehavior,
  CurrentWeather,
  EventInput,
  McpServerConfig,
  PermissionMode,
  Record as RecordT,
  RecordFilter,
  RecordPatch,
  SkillDef,
  SkillInfo,
  Status,
  SyncConfigInfo,
  SyncConfigInput,
  SyncOutcome,
  SyncUi,
  TodoInput,
  UserProfile,
  StorageInfo,
  WeatherConfig,
} from "./types";

/** 按 id 读取记录（含已软删）。 */
export async function getRecord(id: string): Promise<RecordT> {
  return invoke<RecordT>("get_record", { id });
}

/**
 * 通用列表。`filter` 可省略/为 null → 不过滤。
 * 注意：传 `null` 与不传都会被后端 `unwrap_or_default()` 视作空 filter。
 */
export async function listRecords(filter?: RecordFilter | null): Promise<RecordT[]> {
  return invoke<RecordT[]>("list_records", filter === undefined ? {} : { filter });
}

/** 创建待办。 */
export async function createTodo(input: TodoInput): Promise<RecordT> {
  return invoke<RecordT>("create_todo", { input });
}

/** 创建日程事件（定时或全天）。 */
export async function createEvent(input: EventInput): Promise<RecordT> {
  return invoke<RecordT>("create_event", { input });
}

/**
 * 列出与 [from, to] 区间重叠的事件（from 含、to 排他）。
 * `from`/`to` 为 date-only `YYYY-MM-DD`（from=窗口首日、to=末日+1）。
 */
export async function listEvents(from: string, to: string): Promise<RecordT[]> {
  return invoke<RecordT[]>("list_events", { from, to });
}

/**
 * 为顶层待办添加子任务（service 内含 1 层嵌套校验）。
 * 必须用 `parentId`（camelCase）作为 invoke 的 key。
 */
export async function addSubtask(parentId: string, input: TodoInput): Promise<RecordT> {
  return invoke<RecordT>("add_subtask", { parentId, input });
}

/** 部分更新记录（合并 patch，刷新 updated_at/revision）。 */
export async function updateRecord(id: string, patch: RecordPatch): Promise<RecordT> {
  return invoke<RecordT>("update_record", { id, patch });
}

/** 设置待办状态（active/done/cancelled）。 */
export async function setTodoStatus(id: string, status: Status): Promise<RecordT> {
  return invoke<RecordT>("set_todo_status", { id, status });
}

/** 软删记录（置墓碑，不出现在默认列表，保留于库）。 */
export async function deleteRecord(id: string): Promise<void> {
  await invoke<null>("delete_record", { id });
}

/** 读取天气城市配置；未配置（无设置或 query 空）返回 null。 */
export async function getWeatherConfig(): Promise<WeatherConfig | null> {
  return invoke<WeatherConfig | null>("get_weather_config");
}

/**
 * 设置当前城市（`query` 为 geocode 查询串）。切换城市会清空已缓存坐标，
 * 下次取天气对新城市重新 geocode。
 */
export async function setCity(query: string): Promise<void> {
  await invoke<void>("set_city", { query });
}

/**
 * 取当前天气。`null` = 未配置城市；非空 = 有数据（新取或同城市缓存回退）；
 * reject = 配置了但取不到且无可用缓存。
 */
export async function getCurrentWeather(): Promise<CurrentWeather | null> {
  return invoke<CurrentWeather | null>("get_current_weather");
}

// —— 个人资料（首页/今日问候与头像展示） ——

/** 读个人资料；未配置返回 null（前端用默认展示）。 */
export async function getProfile(): Promise<UserProfile | null> {
  return invoke<UserProfile | null>("get_profile");
}

/** 保存个人资料（名称非空；头像 data URL 或 emoji: 前缀）。 */
export async function setProfile(profile: UserProfile): Promise<void> {
  await invoke<void>("set_profile", { profile });
}

/** 数据目录与配置文件位置（修改 config.toml 后重启生效）。 */
export async function getStorageInfo(): Promise<StorageInfo | null> {
  try {
    return await invoke<StorageInfo>("get_storage_info");
  } catch {
    return null; // 非 Tauri 环境
  }
}

/** 读窗口关闭行为（exit/background；缺省 exit）。 */
export async function getCloseBehavior(): Promise<CloseBehavior> {
  try {
    const v = await invoke<string>("get_close_behavior");
    return v === "background" ? "background" : "exit";
  } catch {
    return "exit";
  }
}

/** 写窗口关闭行为（即时生效；background 需托盘可用）。 */
export async function setCloseBehavior(behavior: CloseBehavior): Promise<void> {
  await invoke<void>("set_close_behavior", { behavior });
}

// —— Agent（08-15-agent-v1）——

/** 发送消息并驱动一轮循环；流式事件经 `agent://*` Tauri 事件回传。 */
export async function agentSend(
  sessionId: string,
  message: string,
  model: string,
): Promise<void> {
  await invoke<void>("agent_send", { sessionId, message, model });
}

/** 中止某会话在迷轮（已落库操作保留）。 */
export async function agentAbort(sessionId: string): Promise<void> {
  await invoke<void>("agent_abort", { sessionId });
}

/** 审批回传：对待批准工具调用的决定。 */
export async function agentApprove(callId: string, approved: boolean): Promise<void> {
  await invoke<void>("agent_approve", { callId, approved });
}

/** 读工具审批模式（缺省 auto）。 */
export async function getPermissionMode(): Promise<PermissionMode> {
  const s = await invoke<string>("get_permission_mode");
  return s === "write" || s === "all" ? s : "auto";
}

/** 写工具审批模式。 */
export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  await invoke<void>("set_permission_mode", { mode });
}

/** 读 AI 模型配置；未配置返回 null。 */
export async function getAiConfig(): Promise<AiConfig | null> {
  return invoke<AiConfig | null>("get_ai_config");
}

/** 写 AI 模型配置。 */
export async function setAiConfig(config: AiConfig): Promise<void> {
  await invoke<void>("set_ai_config", { config });
}

/** 提供商列表（设置页左侧菜单）。 */
export async function listAiProviders(): Promise<AiConfig[]> {
  return invoke<AiConfig[]>("list_ai_providers");
}

/** 保存单个提供商（按 name upsert）并设为激活。 */
export async function saveAiProvider(config: AiConfig): Promise<void> {
  await invoke<void>("save_ai_provider", { config });
}

/** 删除提供商（按 name）。 */
export async function deleteAiProvider(name: string): Promise<void> {
  await invoke<void>("delete_ai_provider", { name });
}

/** 拉取模型列表（设置页「获取模型列表」）：GET /models。 */
export async function listAiModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return invoke<string[]>("list_ai_models", { baseUrl, apiKey });
}

/** 连通性测试：以指定配置发一条极小请求，返回模型回复片段；失败 reject。 */
export async function testAiConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<string> {
  return invoke<string>("test_ai_connection", { baseUrl, apiKey, model });
}

/** 会话摘要列表（最近活跃在前）。 */
export async function listAgentSessions(): Promise<AgentSessionSummary[]> {
  return invoke<AgentSessionSummary[]>("list_agent_sessions");
}

/** 某会话全部消息（历史回看）。 */
export async function listAgentMessages(sessionId: string): Promise<AgentMessage[]> {
  return invoke<AgentMessage[]>("list_agent_messages", { sessionId });
}

/** 删除整个会话（含全部消息行）。 */
export async function deleteAgentSession(sessionId: string): Promise<void> {
  await invoke<void>("delete_agent_session", { sessionId });
}

// —— Skills ——

/** 全部技能（内置在前）+ 启用状态。 */
export async function listSkills(): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("list_skills");
}

/** 新建/更新自定义技能（返回后端补齐 id 的定义）。 */
export async function saveSkill(skill: SkillDef): Promise<SkillDef> {
  return invoke<SkillDef>("save_skill", { skill });
}

/** 删除自定义技能。 */
export async function deleteSkill(id: string): Promise<void> {
  await invoke<void>("delete_skill", { id });
}

/** 开/关技能。 */
export async function setSkillActive(id: string, active: boolean): Promise<void> {
  await invoke<void>("set_skill_active", { id, active });
}

// —— MCP ——

/** 服务器列表。 */
export async function listMcpServers(): Promise<McpServerConfig[]> {
  return invoke<McpServerConfig[]>("list_mcp_servers");
}

/** 新建/更新服务器（按 id upsert；返回补齐 id 的配置）。 */
export async function saveMcpServer(server: McpServerConfig): Promise<McpServerConfig> {
  return invoke<McpServerConfig>("save_mcp_server", { server });
}

/** 删除服务器。 */
export async function deleteMcpServer(id: string): Promise<void> {
  await invoke<void>("delete_mcp_server", { id });
}

/** 启/停某台服务器。 */
export async function setMcpEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke<void>("set_mcp_enabled", { id, enabled });
}

/** 探测端点：连接并返回工具名列表（设置页“测试连接”）。 */
export async function mcpListTools(baseUrl: string, token?: string | null): Promise<string[]> {
  return invoke<string[]>("mcp_list_tools", { baseUrl, token: token ?? null });
}

// —— 多设备同步（docs/sync-design.md）——

/** 读同步配置回显（不含 secret）。 */
export async function syncGetConfig(): Promise<SyncConfigInfo> {
  return invoke<SyncConfigInfo>("sync_get_config");
}

/** 保存远端配置；首次生成密钥时返回 `generated_key`（仅此一次）。 */
export async function syncConfigure(input: SyncConfigInput): Promise<SyncConfigInfo> {
  return invoke<SyncConfigInfo>("sync_configure", { input });
}

/** 测试连接（用表单当前值 LIST 前缀；返回前缀下对象数）。 */
export async function syncTestConnection(input: SyncConfigInput): Promise<number> {
  return invoke<number>("sync_test_connection", { input });
}

/** 导出加密密钥（base64 串，粘贴到新设备）。 */
export async function syncExportKey(): Promise<string> {
  return invoke<string>("sync_export_key");
}

/** 导入加密密钥（新设备粘贴）。 */
export async function syncImportKey(key: string): Promise<void> {
  await invoke<void>("sync_import_key", { key });
}

/** 启用/停用同步。 */
export async function syncSetEnabled(enabled: boolean): Promise<void> {
  await invoke<void>("sync_set_enabled", { enabled });
}

/** 手动立即同步。 */
export async function syncNow(): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("sync_now");
}

/** 读同步 UI 状态（事件丢失时的克底）。 */
export async function syncGetStatus(): Promise<SyncUi> {
  return invoke<SyncUi>("sync_get_status");
}
