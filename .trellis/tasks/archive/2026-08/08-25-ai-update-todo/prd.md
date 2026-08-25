# AI 修改待办：update_todo 工具

## 背景

TODO-List：「待办事项应当支持对已经创建的事项进行修改，支持 AI 修改」。

手动编辑已完备（TodoEditor + `update_record` IPC）。AI 工具侧缺口：日程有
`update_event`，待办只有 `create_todo` / `set_todo_status` / `add_subtask`——
AI 无法修改已有待办的标题/描述/截止/优先级/标签。

## 需求

新增内置 AI 工具 `update_todo`：

- 参数：`id`（必填，来自 list_todos 或创建结果）、`title`、`description`、
  `due_at`、`priority`、`tags`——只需传要改的字段（与 update_event 同风格）。
- `description` / `due_at` 显式传 `null` → 清除该字段（待办两者皆可空）。
- kind 校验：id 必须指向 todo（event id → Validation 错误，模型可自纠）。

## 实现要点

- `service.rs`：`update_todo(db, id, patch)`（kind=todo 校验 + 合并后标题非空）。
- `agent/tools.rs`：ToolDef + dispatch + handler（null vs 缺省区分清除与不改）。
- `agent/runner.rs`：系统提示词第 5 条补充待办修改守则。
- 前端 `state/agent.ts`：`MUTATING_TOOLS` 加 `update_todo`（落库后刷新视图）、
  `TOOL_LABELS` 加「修改待办」。

## 验收

- `cargo test -p mosh-core`、`cargo clippy -p mosh-core --all-targets -- -D warnings` 通过。
- 新单测：改字段生效、null 清除 due、event id 拒绝、幽灵 id NotFound、specs 十工具。
- 前端 `npm run build`（或 tsc）通过。
