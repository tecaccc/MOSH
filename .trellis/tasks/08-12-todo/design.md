# Design — 子任务 A：Todo（含共享地基）

## 1. 架构总览

```
┌──────────────────────── 桌面应用 ────────────────────────┐
│  前端：Svelte 5 + Vite                                  │
│   views(Today/Tasks) · stores · ipc.ts(invoke 封装)      │
│              ↕  Tauri IPC (invoke)                       │
│  src-tauri：#[command] 薄壳 · State<Db>                  │
│              ↕                                           │
│  crates/mosh-core（共享库，纯领域逻辑）                  │
│   model · storage(sqlite) · service                      │
│              ↕                                           │
│  SQLite（本地文件，rusqlite bundled）                    │
└──────────────────────────────────────────────────────────┘
```

**关键边界**：所有领域逻辑与存储在 `mosh-core`；`src-tauri` 只做命令绑定 + DB 连接管理；前端只通过 IPC 调命令，绝不直连 DB。

## 2. 仓库结构（在 create-tauri-app 基座上叠加 workspace）

```
mosh/
├── Cargo.toml              # [workspace] members = ["src-tauri", "crates/mosh-core"]
├── package.json            # 前端 Svelte + Vite
├── src/                    # 前端 Svelte 源码
├── src-tauri/
│   ├── Cargo.toml          # 依赖 mosh-core = { path = "../crates/mosh-core" }
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         # tauri::Builder + State<Db> + 启动迁移
│       └── commands.rs     # #[command] 薄壳，调 mosh-core service
└── crates/
    └── mosh-core/
        ├── Cargo.toml      # serde, rusqlite(bundled), thiserror, uuid, chrono...
        └── src/
            ├── lib.rs
            ├── model.rs        # Record/Kind/Status/Priority/Input/Patch
            ├── storage.rs      # Storage trait + SqliteStorage
            ├── service.rs      # create_todo/list/update/complete/subtask/delete
            ├── error.rs        # CoreError (thiserror)
            └── migrations/     # 嵌入式 SQL 迁移
```

## 3. 数据模型（统一 Record）

单表 + `data` JSON 兜底（kind 专属字段），兼顾统一与扩展：

```sql
CREATE TABLE records (
  id          TEXT PRIMARY KEY,                 -- UUIDv7(text)
  kind        TEXT NOT NULL,                    -- 'todo' | 'event'
  title       TEXT NOT NULL,
  description TEXT,                             -- markdown
  status      TEXT NOT NULL DEFAULT 'active',   -- todo: active|done|cancelled
  start_at    TEXT,                             -- ISO8601; event 用
  end_at      TEXT,                             -- ISO8601; todo 当作 due_at
  parent_id   TEXT REFERENCES records(id),      -- 子任务
  source      TEXT NOT NULL DEFAULT 'local',
  tags        TEXT NOT NULL DEFAULT '[]',       -- JSON array[string]
  data        TEXT NOT NULL DEFAULT '{}',       -- JSON: priority/location/attendees...
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,                             -- 墓碑（NULL=存活）
  revision    INTEGER NOT NULL DEFAULT 1,
  CHECK (kind IN ('todo','event'))
);
CREATE INDEX idx_records_kind   ON records(kind)      WHERE deleted_at IS NULL;
CREATE INDEX idx_records_parent ON records(parent_id)  WHERE parent_id IS NOT NULL;
CREATE INDEX idx_records_end    ON records(end_at)     WHERE deleted_at IS NULL;
CREATE INDEX idx_records_start  ON records(start_at)   WHERE deleted_at IS NULL;
```

- Todo 专属：`priority`（none|low|medium|high）存 `data` JSON；`due` 复用 `end_at`。
- 子任务：`parent_id`；v1 应用层限制 **1 层**（顶层 todo 的子任务不可再嵌套）。
- 软删：`deleted_at`；所有查询默认 `WHERE deleted_at IS NULL`。
- 同步预留：`revision` + `deleted_at` 为未来多端同步埋点（v1 不使用）。
- 迁移：`rusqlite_migration`，v1 一份初始迁移，嵌入 `mosh-core`。

## 4. mosh-core 模块契约

- **model**：`Record`（serde struct，字段对齐表）、`Kind`/`Status`/`Priority` 枚举、`TodoInput`、`RecordPatch`、`TodoFilter`。`#[serde(rename_all = "snake_case")]`，前端 TS 镜像。
- **storage**：`trait Storage` + `SqliteStorage { conn: Mutex<Connection> }`。方法：`insert / update / get / list(filter) / soft_delete`；`list` 过滤维度 = kind / status / parent_id / 日期范围 / 含已删。
- **service**：领域函数，封装事务与校验：
  - `create_todo(db, TodoInput) -> Record`
  - `list_todos(db, TodoFilter) -> Vec<Record>`
  - `update_record(db, id, RecordPatch) -> Record`
  - `set_todo_status(db, id, Status) -> Record`
  - `add_subtask(db, parent_id, TodoInput) -> Record`（校验父存在 + 1 层限制）
  - `soft_delete(db, id) -> ()`
- **error**：`CoreError`（NotFound / Db / Validation / InvalidParent），`thiserror`。

## 5. Tauri IPC 契约

通用 + Todo 便捷：
- `get_record(id) -> Record`
- `list_records(filter) -> Vec<Record>`
- `create_todo(input: TodoInput) -> Record`
- `update_record(id, patch: RecordPatch) -> Record`
- `set_todo_status(id, status) -> Record`
- `delete_record(id) -> ()`（软删）

serde JSON 序列化；前端 `@tauri-apps/api` 的 `invoke` 封装 `ipc.ts`。TS 类型 v1 手写镜像（后续可上 `ts-rs`/`specta` 自动生成）。

## 6. 前端结构（Svelte 5）

```
src/
├── App.svelte              # 三栏布局 + 导航
├── lib/
│   ├── ipc.ts              # invoke 封装：listRecords/createTodo/...
│   ├── types.ts            # Kind/Status/Priority/Record/TodoInput（镜像后端）
│   ├── stores.ts           # writable stores: records, filter, currentView
│   └── components/
│       ├── Sidebar.svelte
│       ├── TodoItem.svelte # 完成/展开子任务/编辑/删除
│       └── TodoEditor.svelte
└── views/
    ├── Today.svelte        # 今日到期 + 未完成
    └── Tasks.svelte        # 全部任务，层级列表
```

导航：Sidebar（Today / Tasks，Calendar 项预留禁用占位）。视图切换用条件渲染（v1 不引入路由库）。

## 7. 关键权衡

| 决策 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 表结构 | 单表 + kind + `data` JSON | 统一、扩展新 kind 零迁移 | 基表+分表（更强类型，多迁移） |
| 存储 | rusqlite(bundled) | 同步、简单、无异步池；桌面足够 | sqlx（异步+编译期检查，复杂度高） |
| 类型同步 | v1 手写 TS 镜像 | 起步快 | ts-rs/specta（后续自动生成） |
| 子任务深度 | v1 限 1 层 | 控制 UI/逻辑复杂度 | 多层嵌套（后续） |
| 路由 | 无路由库，条件渲染 | v1 视图少 | SvelteKit SPA（后续） |

## 8. 兼容 / 迁移 / 回滚

- 迁移向前兼容：新字段走 `data` JSON，不改表即可加 kind。
- DB 文件：Tauri app data dir，不入仓库。
- 回滚：每个 implement 步骤后 `cargo test` + `cargo tauri dev` 验证，单步单 commit，出错 `git checkout` 对应提交。
