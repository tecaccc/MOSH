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
  Record as RecordT,
  RecordFilter,
  RecordPatch,
  Status,
  TodoInput,
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
