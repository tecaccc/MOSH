# 子任务 A：Todo 待办（含共享地基）

> 父任务：`08-12-v1-todo-calendar`。本子任务交付 v1 的**共享地基** + **Todo 全功能**，是 Calendar（子任务 B）的前置依赖。

## Goal

搭建 MOSH 桌面应用的共享地基（Cargo workspace + `mosh-core` + SQLite + 统一 Record 模型 + Tauri IPC + Svelte 前端壳），并在其上实现完整的 Todo 待办（CRUD、字段、子任务、今日/列表视图）。地基须足以让子任务 B 直接复用。

## Requirements

### 地基（Foundation）
- **F1** Cargo workspace：根 `Cargo.toml` + `src-tauri`（桌面 app）+ `crates/mosh-core`（共享库）。
- **F2** `mosh-core`：领域模型（`Record`/`Kind`）、SQLite 存储、service（领域逻辑），serde 序列化。
- **F3** SQLite 本地存储：统一 `records` 表（`kind`/`parent_id`/时间/`tags`/`data` JSON/`revision`/墓碑）+ 迁移 + 必要索引。
- **F4** Tauri 2.x 应用壳：窗口、IPC 命令注册、`State` 持有 DB 连接。
- **F5** Svelte 5 + Vite 前端壳：三栏布局、IPC 客户端、TS 类型镜像、stores。
- **F6** 跨平台可运行：macOS / Windows / Linux（`cargo tauri dev`）。

### Todo 功能
- **T1** CRUD：创建 / 读取 / 更新 / 删除（软删）。
- **T2** 字段：标题（必填）、描述（markdown）、截止日期、优先级（无/低/中/高）、标签。
- **T3** 子任务：`parent_id` 挂载；v1 限 1 层嵌套；完成状态独立。
- **T4** 状态：`active` / `done`；完成/取消完成。
- **T5** 视图：**今日视图**（今日到期 + 未完成）、**任务列表视图**（全部，按截止/优先级排序，层级展开）。
- **T6** 持久化：变更落 SQLite，重启不丢。

## Acceptance Criteria

- [ ] `cargo tauri dev` 在至少一个桌面平台启动，显示三栏布局。
- [ ] `mosh-core` 可独立 `cargo test`（模型 + 存储单测通过）。
- [ ] 可创建含全部字段的待办，并在列表视图可见。
- [ ] 可为待办添加子任务，列表层级展示；子任务不可再挂子任务。
- [ ] 可完成/取消完成，状态正确更新并持久化。
- [ ] 今日视图正确显示今日到期与未完成项。
- [ ] 删除为软删（墓碑），不出现在列表但保留于库。
- [ ] 重启应用后数据完整。
- [ ] `records.kind` 既支持 `todo` 也为 `event` 预留（子任务 B 直接复用）。

## Out of Scope（本子任务不做）

- Calendar / Event 视图与逻辑（子任务 B）。
- 多端同步、自托管服务器。
- 日记、笔记、第三方集成。
- 重复、桌面提醒、清单分组（v1 全局推迟）。
- 全局命令面板（⌘K）。

## Dependencies / Notes

- 无前置子任务依赖；本任务产出共享地基。
- 子任务 B（Calendar）依赖本任务的 `records` 表、`mosh-core` service、IPC 与前端壳。
- 数据模型 / 模块边界 / IPC 契约见 `design.md`；执行步骤见 `implement.md`。
