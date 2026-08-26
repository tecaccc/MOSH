/**
 * Agent 聊天状态（zustand；原 agent.svelte.ts 迁移）。
 *
 * 事件监听在 initAgent() 注册一次（ChatPanel useEffect 调用；幂等）。
 * UI 消息模型在持久化行之上叠加流式气泡状态；会话切换时从 DB 重放。
 */

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  agentAbort as ipcAbort,
  agentApprove,
  agentSend as ipcSend,
  deleteAgentSession,
  deleteRecord as ipcDeleteRecord,
  getAiConfig,
  getPermissionMode,
  listAgentMessages,
  listAgentSessions,
  listAiModels,
  listMcpServers,
  listSkills,
  setMcpEnabled,
  setPermissionMode,
  setSkillActive,
} from "../lib/ipc";
import type {
  AgentEventPayload,
  AgentSessionSummary,
  McpServerConfig,
  PermissionMode,
  SkillInfo,
} from "../lib/types";
import { useAppStore } from "./store";

/** 会改动本地 todo/event 数据的工具：执行后需刷新前端各视图。 */
const MUTATING_TOOLS = new Set([
  "create_todo",
  "create_event",
  "update_event",
  "update_todo",
  "delete_event",
  "delete_events",
  "set_todo_status",
  "add_subtask",
]);

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
  update_todo: "修改待办",
  delete_event: "删除日程",
  delete_events: "批量删除",
  list_todos: "查询待办",
  list_events: "查询日程",
  set_todo_status: "设置状态",
  add_subtask: "添加子任务",
};

/** MCP 工具名 → 卡片标题：`mcp__{server}__{tool}` 取中段服务器名。 */
export function toolLabel(tool: string): string {
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    return parts.length === 3 ? `MCP·${parts[1]}` : tool;
  }
  return TOOL_LABELS[tool] ?? tool;
}

/** 待人工批准的工具调用（审批模式下）。 */
export interface PendingApproval {
  callId: string;
  turnId: string;
  tool: string;
  args: unknown;
}

interface AgentState {
  messages: UiMessage[];
  streaming: boolean;
  sessions: AgentSessionSummary[];
  currentSession: string;
  /** null = 尚未探测；false = 未配置；true = 已配置。 */
  configured: boolean | null;
  error: string | null;
  models: string[];
  selectedModel: string;
  /** 技能（含启用状态；聊天工具条/设置页共用）。 */
  skills: SkillInfo[];
  /** MCP 服务器列表。 */
  mcpServers: McpServerConfig[];
  /** 工具审批模式。 */
  permissionMode: PermissionMode;
  /** 当前待批准的工具调用（null=无）。 */
  pendingApproval: PendingApproval | null;

  init(): Promise<void>;
  refreshSessions(): Promise<void>;
  /** 同步落地他机消息后刷新：会话列表必刷；空闲且当前会话已持久化时重放其消息。 */
  reloadAfterSync(): Promise<void>;
  newSession(): void;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  selectModel(m: string): void;
  undoCreate(m: UiMessage): Promise<void>;
  loadChatTools(): Promise<void>;
  toggleSkill(id: string, active: boolean): Promise<void>;
  toggleMcpServer(id: string, enabled: boolean): Promise<void>;
  selectPermissionMode(mode: PermissionMode): Promise<void>;
  decideApproval(approved: boolean): Promise<void>;
}

/** 当前事件流所属会话（start 时记录，end 清除；跨会话 delta 丢弃）。 */
let activeTurnSession: string | null = null;
/** 最近一次 start 的会话（end.error 归属判定用）。 */
let lastTurnSession: string | null = null;
/** 当前流式气泡在 messages 中的 key。 */
let streamingKey: string | null = null;
let listenersBound = false;
let seq = 0;
const nextKey = (): string => `m${++seq}`;

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

/** 结算流式气泡（无文本则移除空气泡）。 */
function settleStreaming(set: (fn: (s: AgentState) => Partial<AgentState>) => void): void {
  if (!streamingKey) return;
  set((s) => {
    const idx = s.messages.findIndex((x) => x.key === streamingKey);
    if (idx < 0) return {};
    const messages = [...s.messages];
    if (messages[idx].text.trim().length === 0) {
      messages.splice(idx, 1);
    } else {
      messages[idx] = { ...messages[idx], streaming: false };
    }
    return { messages };
  });
  streamingKey = null;
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  messages: [],
  streaming: false,
  sessions: [],
  currentSession: "",
  configured: null,
  error: null,
  models: [],
  selectedModel: "",
  skills: [],
  mcpServers: [],
  permissionMode: "auto",
  pendingApproval: null,

  /** 初始化：读配置 + 会话列表 + 可选模型 + 技能/MCP + 绑定事件（幂等）。 */
  init: async () => {
    try {
      const cfg = await getAiConfig();
      set({ configured: cfg !== null });
      if (cfg) {
        set({ selectedModel: cfg.model });
        try {
          const models = await listAiModels(cfg.base_url, cfg.api_key);
          set({ models: models.length > 0 ? models : [cfg.model] });
        } catch {
          set({ models: [cfg.model] });
        }
      }
    } catch {
      set({ configured: false });
    }
    await get().refreshSessions();
    await get().loadChatTools();
    try {
      set({ permissionMode: await getPermissionMode() });
    } catch {
      /* 非 Tauri 环境忽略 */
    }
    // 默认落在新会话页（空输入位，首条消息发送时自然成会话）；
    // 历史会话从右侧侧栏点开——不再自动恢复最近会话，避免误接旧上下文。
    if (!get().currentSession) {
      get().newSession();
    }
    if (!listenersBound) {
      listenersBound = true;
      await listen<AgentEventPayload>("agent://start", (e) => {
        if (e.payload.type === "start") {
          activeTurnSession = e.payload.session_id;
          lastTurnSession = activeTurnSession;
          if (activeTurnSession === get().currentSession) set({ streaming: true });
        }
      });
      await listen<AgentEventPayload>("agent://delta", (e) => {
        const p = e.payload;
        if (p.type !== "delta") return;
        if (activeTurnSession !== get().currentSession) return;
        // 追加到当前流式气泡；不存在则新建。
        if (!streamingKey) {
          streamingKey = nextKey();
          set((s) => ({
            messages: [
              ...s.messages,
              { key: streamingKey!, role: "assistant", text: "", streaming: true },
            ],
          }));
        }
        const key = streamingKey;
        const text = p.text;
        set((s) => ({
          messages: s.messages.map((m) => (m.key === key ? { ...m, text: m.text + text } : m)),
        }));
      });
      await listen<AgentEventPayload>("agent://tool", (e) => {
        const p = e.payload;
        if (p.type !== "tool") return;
        // 变更类工具已落库：立即刷新 todos 与各视图的事件窗口（无论当前展示哪个会话）。
        if (MUTATING_TOOLS.has(p.tool) && p.ok) {
          void useAppStore.getState().refreshData();
        }
        if (activeTurnSession !== get().currentSession) return;
        // 工具卡片出现在（流式）文本之后：结算当前气泡，卡片随后。
        settleStreaming(set);
        set((s) => ({
          messages: [
            ...s.messages,
            {
              key: nextKey(),
              role: "tool",
              text: "",
              tool: p.tool,
              args: p.args,
              result: p.result,
              ok: p.ok,
            },
          ],
        }));
      });
      await listen<AgentEventPayload>("agent://approval", (e) => {
        const p = e.payload;
        if (p.type !== "approval_required") return;
        if (activeTurnSession !== get().currentSession) return;
        set({
          pendingApproval: {
            callId: p.call_id,
            turnId: p.turn_id,
            tool: p.tool,
            args: p.args,
          },
        });
      });
      await listen<AgentEventPayload>("agent://end", (e) => {
        const p = e.payload;
        if (p.type !== "end") return;
        settleStreaming(set);
        activeTurnSession = null;
        set({ streaming: false, pendingApproval: null });
        if (p.reason === "error" && lastTurnSession === get().currentSession) {
          set({ error: p.error ?? "模型调用失败" });
        }
        // 会话标题可能因首条 user 消息而新建；静默刷新。
        void get().refreshSessions();
      });
    }
  },

  refreshSessions: async () => {
    try {
      set({ sessions: await listAgentSessions() });
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  },

  /** 同步合并落地他机的聊天消息后：刷新会话侧栏（新会话/计数）；
   * 空闲且当前会话已持久化时重放其消息（在途流式/新建未发送会话不覆盖）。 */
  reloadAfterSync: async () => {
    await get().refreshSessions();
    if (get().streaming) return; // 流式中不重放（轮次结束/切换会话时自然看到）
    const cur = get().currentSession;
    if (cur && get().sessions.some((s) => s.session_id === cur)) {
      await get().openSession(cur);
    }
  },

  /** 拉取技能与 MCP 服务器（静默失败，非 Tauri 环境忽略）。 */
  loadChatTools: async () => {
    try {
      const [skills, mcpServers] = await Promise.all([listSkills(), listMcpServers()]);
      set({ skills, mcpServers });
    } catch {
      /* 忽略 */
    }
  },

  /** 开/关技能（成功后同步本地状态）。 */
  toggleSkill: async (id, active) => {
    try {
      await setSkillActive(id, active);
      set((s) => ({
        skills: s.skills.map((k) => (k.id === id ? { ...k, active } : k)),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 启/停 MCP 服务器（成功后同步本地状态）。 */
  toggleMcpServer: async (id, enabled) => {
    try {
      await setMcpEnabled(id, enabled);
      set((s) => ({
        mcpServers: s.mcpServers.map((m) => (m.id === id ? { ...m, enabled } : m)),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 切换审批模式（持久化 + 本地同步）。 */
  selectPermissionMode: async (mode) => {
    set({ permissionMode: mode });
    try {
      await setPermissionMode(mode);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 对待批准工具调用回传决定；成功后清除待审批栏。 */
  decideApproval: async (approved) => {
    const p = get().pendingApproval;
    if (!p) return;
    try {
      await agentApprove(p.callId, approved);
      set({ pendingApproval: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 打开历史会话（DB 重放）。 */
  openSession: async (id) => {
    streamingKey = null;
    set({ currentSession: id });
    try {
      const rows = await listAgentMessages(id);
      set({
        messages: rows.map((r) => ({
          key: `db${r.id}`,
          role: r.role as UiMessage["role"],
          text: r.content,
          tool: r.tool_name ?? undefined,
          args: safeJson(r.tool_args),
          result: safeJson(r.tool_result),
          ok: okOf(r.tool_result),
        })),
      });
    } catch {
      set({ messages: [] });
    }
  },

  /** 新建会话（前端生成 id；首条消息落库时自然成会话）。 */
  newSession: () => {
    streamingKey = null;
    set({ currentSession: crypto.randomUUID(), messages: [], error: null });
  },

  /** 删除会话：删库 + 刷新列表；删的是当前会话则另起一个空的新会话页
   * （与「打开聊天默认新会话」一致；后端墓碑同时拦截在途轮次的滞后写入）。 */
  deleteSession: async (id) => {
    try {
      await deleteAgentSession(id);
      await get().refreshSessions();
      if (get().currentSession === id) {
        get().newSession();
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 发送消息：落 UI 气泡 + 驱动后端循环；失败（未配置/在跑）→ error。 */
  send: async (text) => {
    const t = text.trim();
    if (t.length === 0 || get().streaming) return;
    if (!get().currentSession) get().newSession();
    lastTurnSession = get().currentSession;
    set((s) => ({
      error: null,
      streaming: true,
      messages: [...s.messages, { key: nextKey(), role: "user", text: t }],
    }));
    try {
      await ipcSend(get().currentSession, t, get().selectedModel);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 中止当前会话在途轮次。 */
  abort: async () => {
    if (get().currentSession) {
      try {
        await ipcAbort(get().currentSession);
      } catch {
        /* 中止尽力而为 */
      }
    }
  },

  selectModel: (m) => set({ selectedModel: m }),

  /** 撤销创建类工具（软删记录 + 卡片标记）。 */
  undoCreate: async (m) => {
    const id = (m.result as { id?: string } | undefined)?.id;
    if (!id) return;
    try {
      await ipcDeleteRecord(id);
      set((s) => ({
        messages: s.messages.map((x) => (x.key === m.key ? { ...x, undone: true } : x)),
      }));
      await useAppStore.getState().refreshData();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
