# Implement — 子任务 A：Todo（含共享地基）

## 前置检查
- 工具链：`rustc`/`cargo`、Node、Tauri CLI（`cargo install tauri-cli --version "^2"` 或 `npm i -g @tauri-apps/cli`）。
- 干净 git 状态；为本子任务建分支（`task.py set-branch 08-12-todo <branch>`）。

## 执行清单（有序）

1. **脚手架基座**
   - 用 `create-tauri-app`（Svelte + Vite + Rust）生成到当前目录。
   - 根提升为 Cargo workspace（`members = ["src-tauri", "crates/mosh-core"]`）；新增 `crates/mosh-core`（lib）。
   - `src-tauri/Cargo.toml` 加 `mosh-core = { path = "../crates/mosh-core" }`。
   - 验证：`cargo tauri dev` 能起默认窗口。
2. **mosh-core：模型**
   - `model.rs`：`Record`/`Kind`/`Status`/`Priority`/`TodoInput`/`RecordPatch`/`TodoFilter` + serde。
   - `error.rs`：`CoreError`。
   - `cargo test -p mosh-core`（serde 往返测试）。
3. **mosh-core：存储**
   - 嵌入初始迁移（`records` 表 + 索引，见 design §3）。
   - `SqliteStorage`：open/insert/update/get/list/soft_delete；`Connection` 加 `Mutex`。
   - 单测：`:memory:` SQLite 跑 CRUD + 过滤。
4. **mosh-core：service**
   - `create_todo` / `list_todos` / `update_record` / `set_todo_status` / `add_subtask`(1 层校验) / `soft_delete`。
   - 单测：创建、子任务（含拒绝 2 层）、完成、过滤、软删。
5. **Tauri 命令层**
   - `commands.rs`：`get_record` / `list_records` / `create_todo` / `update_record` / `set_todo_status` / `delete_record`。
   - `main.rs`：`State<Db>`（包装 `SqliteStorage`），DB 路径取 `app_data_dir`，启动跑迁移。
   - 验证：`cargo tauri dev`，命令可从前端 invoke 调到。
6. **前端：IPC + 类型 + stores**
   - `types.ts` 镜像后端；`ipc.ts` 封装 invoke；`stores.ts` 持有列表/过滤/视图。
   - `Sidebar` + `App` 三栏布局；Today/Tasks 视图骨架。
7. **前端：Todo UI**
   - `TodoItem`（完成切换、子任务展开、编辑、删除）、`TodoEditor`（字段表单）。
   - Tasks 视图：层级列表 + 排序（截止/优先级）。
   - Today 视图：今日到期 + 未完成。
8. **联调与打磨**
   - 全流程：建待办 → 加子任务 → 完成 → 编辑 → 删除 → 重启校验持久化。
   - 跨平台抽检（至少 1 个平台）。
9. **质量门**
   - `cargo test`、`cargo clippy --all-targets -- -D warnings`、`npm run check`、`cargo tauri build`(或 dev) 通过。
   - 回填 `.trellis/spec/{frontend,backend}` 实际规范（Phase 3.3）。

## 验证命令
- `cargo test -p mosh-core`
- `cargo clippy --all-targets -- -D warnings`
- `npm run check` / `npm run build`
- `cargo tauri dev`

## 风险 / 回滚点
- **workspace 与 Tauri 配置冲突**：`create-tauri-app` 结构并入 workspace 时，核对 `tauri.conf.json` 的 `frontendDist`/`beforeBuildCommand` 与 workspace 成员；必要时手动调整。
- **rusqlite bundled**：`features = ["bundled"]`，避免依赖系统 SQLite。
- 单步单 commit，便于回滚到对应步骤。
