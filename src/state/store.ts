/**
 * 全局应用状态（zustand；原 store.svelte.ts 迁移）。
 *
 * v1 策略不变：所有变更命令在调用 ipc 成功后整表 loadTodos() 刷新，
 * 简单可靠，不做乐观更新。派生数据（topLevelTodos/subtasksOf 等）
 * 以纯函数导出，组件在 useMemo 里计算。
 */

import { create } from "zustand";
import {
  addSubtask as ipcAddSubtask,
  createTodo as ipcCreateTodo,
  deleteRecord as ipcDeleteRecord,
  listRecords,
  setTodoStatus as ipcSetTodoStatus,
  updateRecord as ipcUpdateRecord,
} from "../lib/ipc";
import type {
  Priority,
  Record as RecordT,
  RecordPatch,
  Status,
  TodoInput,
} from "../lib/types";

/** 视图枚举（对齐设计稿侧栏导航）。 */
export type View = "home" | "today" | "calendar" | "agent" | "settings";

/** 设置页分区（与 SettingsView 的 SettingsSection 同构；深链用）。 */
export type SettingsSection = "weather" | "ai" | "aitools" | "about";
/** AI 工具子面板（深链用）。 */
export type SettingsPane = "skills" | "mcp";

/** 设置深链请求：openSettings 写入，SettingsView 挂载后消费。 */
export interface SettingsTarget {
  section: SettingsSection;
  pane?: SettingsPane;
}

interface AppState {
  /** 当前加载到内存的全部（未软删）todo。 */
  records: RecordT[];
  currentView: View;
  /** 当前编辑的 todo id；null=新建模式；undefined=编辑器关闭。 */
  selectedId: string | null | undefined;
  /** AI 聊天历史侧栏显隐（标题栏按钮切换，ChatPanel 消费）。 */
  chatSideVisible: boolean;
  /** 设置页深链目标（SettingsView 消费后清空）。 */
  settingsTarget: SettingsTarget | null;

  setView(view: View): void;
  /** 深链进设置：直接落到指定分区（与可选子面板）。 */
  openSettings(section: SettingsSection, pane?: SettingsPane): void;
  /** SettingsView 消费后清除目标。 */
  consumeSettingsTarget(): void;
  toggleChatSide(): void;
  loadTodos(): Promise<void>;
  startCreate(): void;
  startEdit(id: string): void;
  closeEditor(): void;
  createTodo(input: TodoInput): Promise<RecordT>;
  updateRecord(id: string, patch: RecordPatch): Promise<RecordT>;
  setTodoStatus(id: string, status: Status): Promise<RecordT>;
  addSubtask(parentId: string, input: TodoInput): Promise<RecordT>;
  deleteRecord(id: string): Promise<void>;
}

export const useAppStore = create<AppState>()((set) => ({
  records: [],
  currentView: "home",
  selectedId: undefined,
  chatSideVisible: true,
  settingsTarget: null,

  setView: (view) => set({ currentView: view }),

  openSettings: (section, pane) =>
    set({ currentView: "settings", settingsTarget: pane ? { section, pane } : { section } }),

  consumeSettingsTarget: () => set({ settingsTarget: null }),

  toggleChatSide: () => set((s) => ({ chatSideVisible: !s.chatSideVisible })),

  loadTodos: async () => {
    const list = await listRecords({ kind: "todo" });
    set({ records: list });
  },

  startCreate: () => set({ selectedId: null }),
  startEdit: (id) => set({ selectedId: id }),
  closeEditor: () => set({ selectedId: undefined }),

  createTodo: async (input) => {
    const rec = await ipcCreateTodo(input);
    await useAppStore.getState().loadTodos();
    // 选中刚创建的，便于继续编辑。
    set({ selectedId: rec.id });
    return rec;
  },

  updateRecord: async (id, patch) => {
    const rec = await ipcUpdateRecord(id, patch);
    await useAppStore.getState().loadTodos();
    return rec;
  },

  setTodoStatus: async (id, status) => {
    const rec = await ipcSetTodoStatus(id, status);
    await useAppStore.getState().loadTodos();
    return rec;
  },

  addSubtask: async (parentId, input) => {
    const rec = await ipcAddSubtask(parentId, input);
    await useAppStore.getState().loadTodos();
    return rec;
  },

  deleteRecord: async (id) => {
    await ipcDeleteRecord(id);
    set((s) => (s.selectedId === id ? { selectedId: undefined } : s));
    await useAppStore.getState().loadTodos();
  },
}));

// —— 派生纯函数（组件 useMemo 配用） ——

/** 顶层 todo（parent_id==null）。 */
export function topLevelTodos(records: RecordT[]): RecordT[] {
  return records.filter((r) => r.parent_id === null);
}

/** 取指定父的子任务。 */
export function subtasksOf(records: RecordT[], parentId: string): RecordT[] {
  return records.filter((r) => r.parent_id === parentId);
}

/** 按 id 取当前内存中的 record。 */
export function recordById(records: RecordT[], id: string): RecordT | undefined {
  return records.find((r) => r.id === id);
}

/**
 * 当前编辑器绑定的 record：selectedId 对应；新建为 null；关闭为 undefined。
 */
export function selectedRecordOf(
  records: RecordT[],
  selectedId: string | null | undefined,
): RecordT | null | undefined {
  if (selectedId === undefined) return undefined;
  if (selectedId === null) return null;
  return recordById(records, selectedId);
}

/** 便捷：取 record.data.priority（缺省 "none"）。 */
export function priorityOf(record: RecordT): Priority {
  return record.data.priority ?? "none";
}
