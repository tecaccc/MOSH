/**
 * Agent 全局状态（任务 08-15-agent-v1）。
 *
 * 遵循 `frontend/state-management` 铁律：可重赋值 `$state` 一律模块私有，
 * 外部经导出函数读取。UI 消息模型在持久化行之上叠加流式气泡状态；
 * 会话切换时从 DB 重放（工具行→卡片、文本行→气泡）。
 *
 * 事件监听在 `init()` 注册一次（ChatPanel onMount 调用；幂等）。
 */

import { listen } from "@tauri-apps/api/event";
import {
  agentAbort as ipcAbort,
  agentSend as ipcSend,
  deleteRecord as ipcDeleteRecord,
  getAiConfig,
  listAgentMessages,
  listAgentSessions,
  listAiModels,
} from "./ipc";
import { loadTodos } from "./store.svelte";
import type { AgentEventPayload, AgentSessionSummary } from "./types";

/** UI 消息（持久化行的超集：流式气泡/撤销标记仅存内存）。 */
export interface UiMessage {
  key: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
  streaming?: boolean;
  undone?: boolean;
}

/** 工具中文名（卡片标题）。 */
const TOOL_LABELS: Record<string, string> = {
  create_todo: "创建待办",
  create_event: "创建日程",
  update_event: "修改日程",
  list_todos: "查询待办",
  list_events: "查询日程",
  set_todo_status: "设置状态",
  add_subtask: "添加子任务",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

let _messages = $state<UiMessage[]>([]);
let _streaming = $state(false);
let _sessions = $state<AgentSessionSummary[]>([]);
let _currentSession = $state("");
/** null = 尚未探测；false = 未配置；true = 已配置。 */
let _configured = $state<boolean | null>(null);
let _error = $state<string | null>(null);
/** 可选模型列表（聊天界面选择用）。 */
let _models = $state<string[]>([]);
/** 当前聊天所用模型。 */
let _selectedModel = $state("");

/** 当前事件流所属会话（start 时记录，end 清除；跨会话 delta 丢弃）。 */
let activeTurnSession: string | null = null;
/** 最近一次 start 的会话（end.error 归属判定用）。 */
let lastTurnSession: string | null = null;
/** 当前流式气泡在 _messages 中的 key。 */
let streamingKey: string | null = null;
let listenersBound = false;
let seq = 0;
const nextKey = (): string => `m${++seq}`;

export function messages(): UiMessage[] {
  return _messages;
}
export function streaming(): boolean {
  return _streaming;
}
export function sessions(): AgentSessionSummary[] {
  return _sessions;
}
export function currentSession(): string {
  return _currentSession;
}
export function configured(): boolean | null {
  return _configured;
}
export function error(): string | null {
  return _error;
}
export function models(): string[] {
  return _models;
}
export function selectedModel(): string {
  return _selectedModel;
}
export function selectModel(m: string): void {
  _selectedModel = m;
}

/** 初始化：读配置 + 会话列表 + 可选模型 + 绑定事件（幂等）。 */
export async function init(): Promise<void> {
  try {
    const cfg = await getAiConfig();
    _configured = cfg !== null;
    if (cfg) {
      _selectedModel = cfg.model;
      // 已配置则拉取模型列表（供聊天界面选择）；失败静默，仅保留默认模型。
      try {
        _models = await listAiModels(cfg.base_url, cfg.api_key);
        if (_models.length === 0) _models = [cfg.model];
      } catch {
        _models = [cfg.model];
      }
    }
  } catch {
    _configured = false;
  }
  await refreshSessions();
  // 恢复最近会话（若有）。
  if (_sessions.length > 0 && !_currentSession) {
    await openSession(_sessions[0].session_id);
  }
  if (!listenersBound) {
    listenersBound = true;
    await listen<AgentEventPayload>("agent://start", (e) => {
      if (e.payload.type === "start") {
        activeTurnSession = e.payload.session_id;
        lastTurnSession = activeTurnSession;
        if (activeTurnSession === _currentSession) _streaming = true;
      }
    });
    await listen<AgentEventPayload>("agent://delta", (e) => {
      if (e.payload.type !== "delta") return;
      if (activeTurnSession !== _currentSession) return;
      // 追加到当前流式气泡；不存在则新建。
      if (!streamingKey) {
        streamingKey = nextKey();
        _messages.push({ key: streamingKey, role: "assistant", text: "", streaming: true });
      }
      const m = _messages.find((x) => x.key === streamingKey);
      if (m) m.text += e.payload.text;
    });
    await listen<AgentEventPayload>("agent://tool", (e) => {
      if (e.payload.type !== "tool") return;
      if (activeTurnSession !== _currentSession) return;
      // 工具卡片出现在（流式）文本之后：结算当前气泡，卡片随后。
      settleStreaming();
      _messages.push({
        key: nextKey(),
        role: "tool",
        text: "",
        tool: e.payload.tool,
        args: e.payload.args,
        result: e.payload.result,
        ok: e.payload.ok,
      });
    });
    await listen<AgentEventPayload>("agent://end", (e) => {
      if (e.payload.type !== "end") return;
      settleStreaming();
      activeTurnSession = null;
      _streaming = false;
      if (e.payload.reason === "error" && lastTurnSession === _currentSession) {
        _error = e.payload.error ?? "模型调用失败";
      }
      // 会话标题可能因首条 user 消息而新建；静默刷新。
      void refreshSessions();
    });
  }
}

/** 结算流式气泡（无文本则移除空气泡）。 */
function settleStreaming(): void {
  if (!streamingKey) return;
  const idx = _messages.findIndex((x) => x.key === streamingKey);
  if (idx >= 0) {
    if (_messages[idx].text.trim().length === 0) {
      _messages.splice(idx, 1);
    } else {
      _messages[idx].streaming = false;
    }
  }
  streamingKey = null;
}

/** 刷新会话摘要列表。 */
export async function refreshSessions(): Promise<void> {
  try {
    _sessions = await listAgentSessions();
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}

/** 打开历史会话（DB 重放）。 */
export async function openSession(id: string): Promise<void> {
  _currentSession = id;
  streamingKey = null;
  try {
    const rows = await listAgentMessages(id);
    _messages = rows.map((r) => ({
      key: `db${r.id}`,
      role: r.role as UiMessage["role"],
      text: r.content,
      tool: r.tool_name ?? undefined,
      args: safeJson(r.tool_args),
      result: safeJson(r.tool_result),
      ok: okOf(r.tool_result),
    }));
  } catch {
    _messages = [];
  }
}

function safeJson(s: string | null): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function okOf(resultJson: string | null): boolean | undefined {
  if (!resultJson) return undefined;
  try {
    const v = JSON.parse(resultJson);
    return typeof v?.ok === "boolean" ? v.ok : undefined;
  } catch {
    return undefined;
  }
}

/** 新建会话（前端生成 id；首条消息落库时自然成会话）。 */
export function newSession(): void {
  _currentSession = crypto.randomUUID();
  _messages = [];
  _error = null;
  streamingKey = null;
}

/** 发送消息：落 UI 气泡 + 驱动后端循环；失败（未配置/在跑）→ error。 */
export async function send(text: string): Promise<void> {
  const t = text.trim();
  if (t.length === 0 || _streaming) return;
  if (!_currentSession) newSession();
  _error = null;
  _messages.push({ key: nextKey(), role: "user", text: t });
  lastTurnSession = _currentSession;
  _streaming = true;
  try {
    await ipcSend(_currentSession, t, _selectedModel);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  }
}

/** 中止当前会话在途轮次。 */
export async function abort(): Promise<void> {
  if (_currentSession) {
    try {
      await ipcAbort(_currentSession);
    } catch {
      /* 中止尽力而为 */
    }
  }
}

/** 撤销创建类工具（软删记录 + 卡片标记）。 */
export async function undoCreate(m: UiMessage): Promise<void> {
  const id = (m.result as { id?: string } | undefined)?.id;
  if (!id) return;
  try {
    await ipcDeleteRecord(id);
    m.undone = true;
    // 刷新待办全局状态（agent 创建可能未同步到其它视图）。
    await loadTodos();
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  }
}
