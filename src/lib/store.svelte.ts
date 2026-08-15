/**
 * 全局 reactive 状态（Svelte 5 runes 模块级 `$state`）。
 *
 * `.svelte.ts` 模块内的 `$state` 是 reactive 的。注意 Svelte 5 的硬限制：
 * 既不可「导出被重新赋值的 `$state`」（state_invalid_export），也不可
 * 「导出 `$derived`」（derived_invalid_export）。因此可重赋值原语
 * （_currentView / selectedId）及所有派生值都保持模块私有，外部读访问
 * 一律通过**导出函数**（currentView / topLevelTodos / selectedRecord / …）：
 * 函数体在调用方的响应式上下文里读取 `$state`，从而维持响应式；
 * 只做 mutate 不重赋值的 `records` 可直接导出 const。
 *
 * v1 策略：所有变更命令在调用 ipc 成功后整表 `loadTodos()` 刷新，
 * 简单可靠，不做乐观更新。
 */

import {
  addSubtask as ipcAddSubtask,
  createTodo as ipcCreateTodo,
  deleteRecord as ipcDeleteRecord,
  listRecords,
  setTodoStatus as ipcSetTodoStatus,
  updateRecord as ipcUpdateRecord,
} from "./ipc";
import type {
  Priority,
  Record as RecordT,
  RecordPatch,
  Status,
  TodoInput,
} from "./types";

/**
 * 视图枚举（对齐设计稿 docs/pencil-new.pen 侧栏导航）：
 * 首页（home 仪表盘）/ 今日（today，聚焦当天）/ 日历（calendar）/
 * 助手（agent，AI 聊天面板，任务 08-15-agent-v1）/ 设置（settings）。
 */
export type View = "home" | "today" | "calendar" | "agent" | "settings";

/** 当前加载到内存的全部（未软删）todo。 */
export const records = $state<RecordT[]>([]);

/** 当前激活的视图（私有可重赋值状态）。 */
let _currentView = $state<View>("home");

/** 只读响应式访问：当前激活的视图（组件在响应式上下文里调用读取）。 */
export function currentView(): View {
  return _currentView;
}

/**
 * 当前编辑的 todo id；`null` 表示新建模式；`undefined` 表示编辑器关闭。
 * 用 `string | null | undefined` 区分"新建"与"关闭"两种空态。
 */
let selectedId = $state<string | null | undefined>(undefined);

/** 顶层 todo（parent_id==null）；响应式（读取 records $state）。 */
export function topLevelTodos(): RecordT[] {
  return records.filter((r) => r.parent_id === null);
}

/** 派生：子任务映射，按 parent_id 分组（私有：派生值不可导出）。 */
const subtasksByParent = $derived.by(() => {
  const map = new Map<string, RecordT[]>();
  for (const r of records) {
    if (r.parent_id !== null) {
      const arr = map.get(r.parent_id);
      if (arr) {
        arr.push(r);
      } else {
        map.set(r.parent_id, [r]);
      }
    }
  }
  return map;
});

/** 取指定父的子任务（响应式：依赖 records）。 */
export function subtasksOf(parentId: string): RecordT[] {
  return subtasksByParent.get(parentId) ?? [];
}

/** 按 id 取当前内存中的 record（响应式）。 */
export function recordById(id: string): RecordT | undefined {
  return records.find((r) => r.id === id);
}

/** 当前编辑器绑定的 record（selectedId 对应；新建为 null；关闭为 undefined）。 */
export function selectedRecord(): RecordT | null | undefined {
  if (selectedId === undefined) return undefined;
  if (selectedId === null) return null;
  return recordById(selectedId);
}

/** 切换当前视图。 */
export function setView(view: View): void {
  _currentView = view;
}

/**
 * 重新加载全部未软删 todo。
 * 子任务 B（Calendar）接入后可改用通用 listRecords（不过滤 kind）。
 */
export async function loadTodos(): Promise<void> {
  const list = await listRecords({ kind: "todo" });
  records.splice(0, records.length, ...list);
}

/** 打开新建表单。 */
export function startCreate(): void {
  selectedId = null;
}

/** 打开指定 todo 的编辑器。 */
export function startEdit(id: string): void {
  selectedId = id;
}

/** 关闭编辑器。 */
export function closeEditor(): void {
  selectedId = undefined;
}

/** 创建 todo 后刷新。 */
export async function createTodo(input: TodoInput): Promise<RecordT> {
  const rec = await ipcCreateTodo(input);
  await loadTodos();
  // 选中刚创建的，便于继续编辑。
  selectedId = rec.id;
  return rec;
}

/** 更新 record 后刷新。 */
export async function updateRecord(
  id: string,
  patch: RecordPatch,
): Promise<RecordT> {
  const rec = await ipcUpdateRecord(id, patch);
  await loadTodos();
  return rec;
}

/** 切换状态后刷新。 */
export async function setTodoStatus(id: string, status: Status): Promise<RecordT> {
  const rec = await ipcSetTodoStatus(id, status);
  await loadTodos();
  return rec;
}

/** 为顶层 todo 添加子任务后刷新。 */
export async function addSubtask(
  parentId: string,
  input: TodoInput,
): Promise<RecordT> {
  const rec = await ipcAddSubtask(parentId, input);
  await loadTodos();
  return rec;
}

/** 软删后刷新（并关掉对应编辑器）。 */
export async function deleteRecord(id: string): Promise<void> {
  await ipcDeleteRecord(id);
  if (selectedId === id) {
    selectedId = undefined;
  }
  await loadTodos();
}

/** 便捷：取 record.data.priority（缺省 "none"）。 */
export function priorityOf(record: RecordT): Priority {
  return record.data.priority ?? "none";
}
