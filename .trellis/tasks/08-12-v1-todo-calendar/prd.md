# v1: 待办与日程 (Todo + Calendar)

## Goal

交付 MOSH 的第一个可用版本（v1）：一个**本地优先的桌面应用**，让用户在统一界面中管理**待办（Todo）**与**日程（Calendar/Event）**——打开应用即可看到今天要做的事和即将到来的安排。

v1 同时验证产品地基——"统一 Record 模型 + 本地 SQLite + 共享 `mosh-core` + Tauri 桌面壳"——能否支撑后续横向扩展（日记、笔记、集成、同步）。

## Background

- MOSH = My Omni-Sync Hub。奠基决策见产品记忆：本地优先 + 自托管同步、PIM + 第三方集成、桌面优先、Rust + Tauri。
- v1 是 MVP 的第一阶段，**仅含 Todo + 日程**；其余全部后置（见 Out of Scope）。
- 任务结构（已与用户确认）：父任务 `08-12-v1-todo-calendar` + 子任务（Todo、Calendar）。共享地基在第一个子任务中落地。

## Scope

### In Scope (v1)

- **Todo（待办）**：CRUD；字段含 标题 / 描述 / 截止日期 / 优先级 / 标签；**子任务（parent/child 嵌套，Record 经 `parent_id` 关联）**；列表视图 + “今日”视图。**不含**（推迟）：清单/分组、重复、桌面提醒。
- **日程（Calendar）**：CRUD 事件（标题 / 描述 / 起止时间 / 地点 / 标签）；**日 / 周 / 月 / 议程 四种视图全部进 v1**。
- **共享地基**：Cargo workspace（`mosh-core` + Tauri 桌面 app）、SQLite 本地存储、统一 Record 模型（`kind = todo | event`）、前后端 Tauri IPC。
- **桌面平台**：macOS / Windows / Linux（Tauri 2.x）。

### Out of Scope (v1)

- 多端同步、自托管同步服务器
- 日记 / 历史时间线
- 笔记 / 双链
- 第三方集成（Google Calendar / CalDAV / 邮件 / RSS 等）
- 移动端（Tauri Mobile）、Web
- 全局命令面板（⌘K）、活动日志、自动化规则（产品规划中属后续阶段）
- 标签 / 跨 Record 链接 UI（v1 可在 schema 预留字段，但不做功能 —— 待确认）

## Confirmed Facts

- 技术栈：Rust 核心 + Tauri 2.x 桌面壳 + SQLite（嵌入式）。
- 架构：共享 `mosh-core` crate（领域模型 + 存储 + IPC 命令）；前端经 Tauri IPC 调用后端命令。
- 数据本地优先，**v1 无同步**（离线即默认）。
- `.trellis/spec/{frontend,backend}` 当前为空模板，未限定具体框架 / ORM / 库 → 选型为用户决策。
- **前端框架：Svelte 5 + Vite**（Tauri 官方 `create-tauri-app` 模板）。后续 `spec/frontend` 按 Svelte 约定填充。

## Task Mapping

- **子任务 A — Todo**：落地共享地基（workspace + `mosh-core` + SQLite + Record 模型 + IPC + 前端脚手架）+ Todo 全功能。
- **子任务 B — Calendar**：在 A 的地基上增加 `Event` kind + 日历视图。
- 依赖：B 依赖 A 的地基；该排序写入 B 的 `prd.md` / `implement.md`，不靠树位置隐式表达。

## Key Decisions (resolved)

- **前端框架**：Svelte 5 + Vite（Tauri 官方模板）。
- **v1 Todo**：默认集（CRUD / 标题 / 描述 / 截止日期 / 优先级 / 标签 / 今日视图）+ **子任务**；不含 清单分组 / 重复 / 桌面提醒。
- **v1 Calendar**：日 / 周 / 月 / 议程 四视图全做。
- **数据模型**：v1 即落地**统一 Record 底座**——`kind` 字段区分 `todo` / `event`，`parent_id` 支持子任务嵌套；后续类型（日记/笔记）直接新增 `kind` 即可扩展。
- **同步**：v1 无同步，纯本地 SQLite（离线即默认）。
- **文档语言**：中文（`spec` 模板默认英文，如需可统一切换）。

## Acceptance Criteria

- [ ] 应用可在 macOS / Windows / Linux 上 `cargo tauri dev` 启动并运行。
- [ ] 用户可创建 / 编辑 / 完成 / 删除待办，带截止日期，并在"今日"视图中查看。
- [ ] 用户可创建 / 编辑 / 删除带起止时间的事件，并在日历视图中查看。
- [ ] 数据持久化到本地 SQLite，重启不丢失；离线可用。
- [ ] （跨子任务）Todo 与 Event 共享同一 Record 底座与存储层（统一 `kind` 字段）。
- [ ] 前后端通过 Tauri IPC 通信；后端领域逻辑位于 `mosh-core`。
- [ ] 代码符合 `.trellis/spec` 编码规范（选型确定后回填实际规范）。

## Notes

- 复杂任务：每个子任务各自需 `prd.md` / `design.md` / `implement.md` 齐备并经审阅后，才可 `task.py start`。
- 选型确定后，回填 `.trellis/spec/frontend` 与 `backend` 的实际规范（作为 Phase 3.3 spec 更新或独立 bootstrap）。
- 文档语言：当前用中文撰写；`spec` 模板默认英文，若你要求可统一切英文。
