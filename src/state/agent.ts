/**
 * Agent 聊天状态（zustand；原 agent.svelte.ts 迁移）。
 *
 * 事件监听在 initAgent() 注册一次（ChatPanel useEffect 调用；幂等）。
 * UI 消息模型在内存消息行之上叠加流式气泡状态。2026-08-26 起历史不再
 * 落库/同步：会话消息存进程内存，重启即清空；会话侧栏已移除，
 * 顶栏「+ 新会话」随时重开对话。
 */

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  agentAbort as ipcAbort,
  agentApprove,
  agentSend as ipcSend,
  deleteRecord as ipcDeleteRecord,
  getPermissionMode,
  listMcpServers,
  listSkills,
  setMcpEnabled,
  setPermissionMode,
  setSkillActive,
} from "../lib/ipc";
import { useModelsStore } from "./models";
import type {
  AgentEventPayload,
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
  /** 图片附件（data URL；仅 user 消息）。 */
  images?: string[];
  /** 生成该条回复的模型 UniqueModelId(assistant 气泡展示用)。 */
  modelId?: string;
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
  currentSession: string;
  /** null = 尚未探测；false = 未配置；true = 已配置。 */
  configured: boolean | null;
  error: string | null;
  /** 技能（含启用状态；聊天工具条/设置页共用）。 */
  skills: SkillInfo[];
  /** MCP 服务器列表。 */
  mcpServers: McpServerConfig[];
  /** 工具审批模式。 */
  permissionMode: PermissionMode;
  /** 当前待批准的工具调用（null=无）。 */
  pendingApproval: PendingApproval | null;

  init(): Promise<void>;
  newSession(): void;
  send(text: string, images?: string[]): Promise<void>;
  abort(): Promise<void>;
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
/** 当前轮使用的模型 UniqueModelId(start 事件携带;气泡标识用)。 */
let activeTurnModel: string | null = null;
let listenersBound = false;
let seq = 0;
const nextKey = (): string => `m${++seq}`;

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
  currentSession: "",
  configured: null,
  error: null,
  skills: [],
  mcpServers: [],
  permissionMode: "auto",
  pendingApproval: null,

  /** 初始化：读配置 + 可选模型 + 技能/MCP + 绑定事件（幂等）。 */
  init: async () => {
    try {
      // 实体 store(08-28-ai-model-management):providers/models/defaultModel 一次拉齐。
      await useModelsStore.getState().load();
      set({ configured: useModelsStore.getState().defaultModel !== null });
    } catch {
      set({ configured: false });
    }
    await get().loadChatTools();
    try {
      set({ permissionMode: await getPermissionMode() });
    } catch {
      /* 非 Tauri 环境忽略 */
    }
    // 默认落在新会话页（空输入位，首条消息发送时自然成会话）。
    if (!get().currentSession) {
      get().newSession();
    }
    if (!listenersBound) {
      listenersBound = true;
      await listen<AgentEventPayload>("agent://start", (e) => {
        if (e.payload.type === "start") {
          activeTurnSession = e.payload.session_id;
          lastTurnSession = activeTurnSession;
          activeTurnModel = e.payload.model_id ?? null;
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
          const modelId = activeTurnModel ?? undefined;
          set((s) => ({
            messages: [
              ...s.messages,
              { key: streamingKey!, role: "assistant", text: "", streaming: true, modelId },
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
      });
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

  /** 新建会话（前端生成 id；首条消息发送时自然成会话）。 */
  newSession: () => {
    streamingKey = null;
    set({ currentSession: crypto.randomUUID(), messages: [], error: null });
  },

  /** 发送消息（可附图片）：落 UI 气泡 + 驱动后端循环；失败（未配置/在跑）→ error。 */
  send: async (text, images) => {
    const t = text.trim();
    const imgs = images ?? [];
    if ((t.length === 0 && imgs.length === 0) || get().streaming) return;
    if (!get().currentSession) get().newSession();
    lastTurnSession = get().currentSession;
    set((s) => ({
      error: null,
      streaming: true,
      messages: [
        ...s.messages,
        {
          key: nextKey(),
          role: "user",
          text: t,
          images: imgs.length > 0 ? imgs : undefined,
        },
      ],
    }));
    try {
      await ipcSend(
        get().currentSession,
        t,
        useModelsStore.getState().defaultModel?.model.id ?? "",
        imgs.length > 0 ? imgs : undefined,
      );
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
