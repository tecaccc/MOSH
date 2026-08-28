//! SQLite 存储：统一 `records` 表 + 迁移 + 基础 CRUD。

use crate::agent::models::{AiModel, AiProvider, AiSyncResult, LegacyAiConfig};
use crate::error::CoreError;
use crate::model::{Kind, Record, RecordFilter, Status};
use rusqlite::{params, Connection};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// storage 写操作后置脏标记（同步防抖推的触发源，见 sync::engine）。
fn mark_dirty() {
    crate::sync::engine::mark_dirty();
}

/// Agent 会话消息行（对齐 `agent_messages` 表）。
/// id 为 UUIDv7（跨设备不撞号、按时间字典序可排序）。
/// `images` 为随 user 消息携带的图片 data URL（JSON 数组文本存库；同步随行携带）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentMessage {
    #[serde(default)]
    pub id: String,
    pub session_id: String,
    /// `user` | `assistant` | `tool`。
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_args: Option<String>,
    #[serde(default)]
    pub tool_result: Option<String>,
    /// 图片附件（data URL；仅 user 行可非空，旧数据/旧行无此字段 → 空）。
    #[serde(default)]
    pub images: Vec<String>,
    /// 生成该条 assistant 消息的模型 UniqueModelId（user/tool 行为 None；
    /// 旧数据无此字段 → None）。气泡头部展示模型图标用。
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: String,
}

/// 会话摘要（侧栏列表用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionSummary {
    pub session_id: String,
    pub title: String,
    pub message_count: i64,
}

/// 进程内 Agent 会话消息仓库（2026-08-26 起：历史不再落库，重启即清空）。
///
/// 背景：聊天历史落库价值有限（隐私敏感、体积随使用无限增长、跨设备同步
/// 意义不大），改为纯内存态。语义对齐旧 SQLite 实现：
/// - 追加时 id 为空则生成 UUIDv7；
/// - 删除会话记**内存墓碑**，在途轮次的滞后写入（如删除后落地的回复）
///   不得复活会话（与旧 `agent_session_tombstones` 同语义）；
/// - 会话摘要：标题取首条 user 消息截 24 字符，最近活跃在前。
///
/// 不参与多设备同步（dump 的 `agent_messages` 字段恒为空，见 sync::dump）。
#[derive(Default)]
pub struct MemoryAgentLog {
    /// session_id → 消息（追加序）。
    sessions: Mutex<HashMap<String, Vec<AgentMessage>>>,
    /// 已删会话集合（拒后续写入）。
    deleted: Mutex<HashSet<String>>,
}

impl MemoryAgentLog {
    /// 追加一条消息。`false` = 会话已删（墓碑拒写，与旧库同语义）。
    pub fn append(&self, msg: &AgentMessage) -> Result<bool, CoreError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| CoreError::Db("memory log lock poisoned".into()))?;
        if self.is_tombstoned(&msg.session_id)? {
            return Ok(false);
        }
        let mut m = msg.clone();
        if m.id.is_empty() {
            m.id = crate::model::new_id();
        }
        sessions.entry(msg.session_id.clone()).or_default().push(m);
        Ok(true)
    }

    /// 某会话全部消息（追加序 clone；无会话 → 空）。
    pub fn list(&self, session_id: &str) -> Result<Vec<AgentMessage>, CoreError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| CoreError::Db("memory log lock poisoned".into()))?;
        Ok(sessions.get(session_id).cloned().unwrap_or_default())
    }

    /// 会话摘要（最近活跃在前）：标题取首条 user 消息截 24 字符，无则「新会话」。
    pub fn list_sessions(&self) -> Result<Vec<AgentSessionSummary>, CoreError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| CoreError::Db("memory log lock poisoned".into()))?;
        let mut out: Vec<AgentSessionSummary> = sessions
            .iter()
            .map(|(sid, msgs)| AgentSessionSummary {
                session_id: sid.clone(),
                title: msgs
                    .iter()
                    .find(|m| m.role == "user")
                    .map(|m| truncate_title(&m.content))
                    .unwrap_or_else(|| "新会话".to_string()),
                message_count: msgs.len() as i64,
            })
            .collect();
        out.sort_by(|a, b| {
            // 活跃度：同会话内 created_at 非降序，取末条比较；再按 session_id 稳定序。
            let la = sessions
                .get(&a.session_id)
                .and_then(|v| v.last())
                .map(|m| m.created_at.as_str())
                .unwrap_or("");
            let lb = sessions
                .get(&b.session_id)
                .and_then(|v| v.last())
                .map(|m| m.created_at.as_str())
                .unwrap_or("");
            lb.cmp(la).then_with(|| a.session_id.cmp(&b.session_id))
        });
        Ok(out)
    }

    /// 删除整个会话并记墓碑（后续写入拒收）。返回删除的消息数。
    pub fn delete_session(&self, session_id: &str) -> Result<usize, CoreError> {
        let mut deleted = self
            .deleted
            .lock()
            .map_err(|_| CoreError::Db("memory log lock poisoned".into()))?;
        deleted.insert(session_id.to_string());
        drop(deleted);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| CoreError::Db("memory log lock poisoned".into()))?;
        Ok(sessions.remove(session_id).map(|v| v.len()).unwrap_or(0))
    }

    /// 会话是否已删（墓碑）。
    fn is_tombstoned(&self, session_id: &str) -> Result<bool, CoreError> {
        let deleted = self
            .deleted
            .lock()
            .map_err(|_| CoreError::Db("memory log lock poisoned".into()))?;
        Ok(deleted.contains(session_id))
    }
}

/// 会话标题：去首尾空白后截 24 字符，超长补省略号（对齐旧 SQL 版语义）。
fn truncate_title(s: &str) -> String {
    let t = s.trim();
    let cut: String = t.chars().take(24).collect();
    if t.chars().count() > 24 {
        format!("{cut}…")
    } else {
        cut
    }
}

/// settings 全量行（同步 dump / 合并用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingRow {
    pub key: String,
    pub value: String,
    /// LWW 时间戳（ISO8601）；v4 之前的旧行为空串，视为最早。
    pub updated_at: String,
}

/// 初始迁移：统一 `records` 表（见 design §3）。
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(
            r#"
        CREATE TABLE records (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          title       TEXT NOT NULL,
          description TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          start_at    TEXT,
          end_at      TEXT,
          parent_id   TEXT REFERENCES records(id),
          source      TEXT NOT NULL DEFAULT 'local',
          tags        TEXT NOT NULL DEFAULT '[]',
          data        TEXT NOT NULL DEFAULT '{}',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          deleted_at  TEXT,
          revision    INTEGER NOT NULL DEFAULT 1,
          CHECK (kind IN ('todo','event'))
        );
        CREATE INDEX idx_records_kind   ON records(kind)      WHERE deleted_at IS NULL;
        CREATE INDEX idx_records_parent ON records(parent_id)  WHERE parent_id IS NOT NULL;
        CREATE INDEX idx_records_end    ON records(end_at)     WHERE deleted_at IS NULL;
        CREATE INDEX idx_records_start  ON records(start_at)   WHERE deleted_at IS NULL;
        "#,
        ),
        M::up(r#"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);"#),
        M::up(
            r#"
        CREATE TABLE agent_messages (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT NOT NULL,
          role        TEXT NOT NULL,
          content     TEXT NOT NULL DEFAULT '',
          tool_name   TEXT,
          tool_args   TEXT,
          tool_result TEXT,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
        "#,
        ),
        // v4：settings 加 updated_at——多设备同步按 key LWW 的时间戳依据（docs/sync-design.md §3.3）。
        M::up(r#"ALTER TABLE settings ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';"#),
        // v5：agent_messages.id 改 TEXT UUID——自增整数在两台设备各自从 1 起，跨设备
        // 并集合并会撞号串消息（sync design §2）。旧行加 `legacy-` 前缀；
        // 排序语义改按 created_at（id 不再保证插入顺序）。
        M::up(
            r#"
        CREATE TABLE agent_messages_v5 (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          role        TEXT NOT NULL,
          content     TEXT NOT NULL DEFAULT '',
          tool_name   TEXT,
          tool_args   TEXT,
          tool_result TEXT,
          created_at  TEXT NOT NULL
        );
        INSERT INTO agent_messages_v5
          SELECT 'legacy-' || id, session_id, role, content, tool_name, tool_args, tool_result, created_at
          FROM agent_messages;
        DROP TABLE agent_messages;
        ALTER TABLE agent_messages_v5 RENAME TO agent_messages;
        CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
        "#,
        ),
        // v6：会话删除墓碑——agent_messages 为 append-only 并集合并，删除无法经消息
        // 传播；墓碑表只增不删，同步时并集合并并压制对应会话的消息（否则删除的
        // 会话会被他机旧 dump 复活，见 sync design §3.3）。
        M::up(
            r#"
        CREATE TABLE agent_session_tombstones (
          session_id TEXT PRIMARY KEY,
          deleted_at TEXT NOT NULL
        );
        "#,
        ),
        // v7：agent_messages 加 images——user 消息的图片附件（data URL JSON 数组；
        // NULL = 无图）。图片进 LLM 上下文与同步 dump/merge（随 AgentMessage serde）。
        M::up("ALTER TABLE agent_messages ADD COLUMN images TEXT;"),
        // v8：AI 会话历史去持久化——消息改存进程内存（重启即清空），
        // 不再落库/同步；旧表连同会话墓碑一并 DROP（存量聊天记录波奔）。
        M::up(
            r#"
        DROP TABLE agent_messages;
        DROP TABLE agent_session_tombstones;
        "#,
        ),
        // v9：AI Provider/Model 实体化（借鉴 Cherry Studio 架构：模型以
        // `providerId::modelId` 为全局唯一键，非空列即用户覆盖）。
        // ai_meta 存本机私有标记（如旧配置导入位），不参与同步。
        M::up(
            r#"
        CREATE TABLE ai_provider (
          id         TEXT PRIMARY KEY,
          preset_id  TEXT,
          name       TEXT NOT NULL,
          base_url   TEXT NOT NULL,
          api_key    TEXT NOT NULL DEFAULT '',
          enabled    INTEGER NOT NULL DEFAULT 1,
          sort_order REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE ai_model (
          id             TEXT PRIMARY KEY,
          provider_id    TEXT NOT NULL REFERENCES ai_provider(id) ON DELETE CASCADE,
          model_id       TEXT NOT NULL,
          name           TEXT,
          capabilities   TEXT NOT NULL DEFAULT '[]',
          context_window INTEGER,
          notes          TEXT,
          pinned         INTEGER NOT NULL DEFAULT 0,
          enabled        INTEGER NOT NULL DEFAULT 1,
          hidden         INTEGER NOT NULL DEFAULT 0,
          sort_order     REAL NOT NULL DEFAULT 0,
          UNIQUE(provider_id, model_id)
        );
        CREATE INDEX idx_ai_model_provider ON ai_model(provider_id);
        CREATE TABLE ai_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        "#,
        ),
    ])
}

/// 线程安全的 SQLite 存储。`Mutex` 包裹 `Connection` 以满足 Tauri `State` 的 `Send + Sync`。
pub struct SqliteStorage {
    conn: Mutex<Connection>,
}

impl SqliteStorage {
    /// 打开（或创建）磁盘上的数据库文件，并执行迁移。
    pub fn open(path: &Path) -> Result<Self, CoreError> {
        let mut conn = Connection::open(path)?;
        Self::init(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 内存数据库（测试用）。
    pub fn open_in_memory() -> Result<Self, CoreError> {
        let mut conn = Connection::open_in_memory()?;
        Self::init(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn init(conn: &mut Connection) -> Result<(), CoreError> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrations().to_latest(conn)?;
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, CoreError> {
        self.conn
            .lock()
            .map_err(|_| CoreError::Db("storage lock poisoned".to_string()))
    }

    /// 插入完整记录（调用方负责构造所有字段）。
    pub fn insert(&self, record: &Record) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        let kind = kind_to_str(record.kind);
        let status = status_to_str(record.status);
        let tags = serde_json::to_string(&record.tags)?;
        let data = serde_json::to_string(&record.data)?;
        conn.execute(
            "INSERT INTO records
               (id, kind, title, description, status, start_at, end_at,
                parent_id, source, tags, data, created_at, updated_at, deleted_at, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                record.id,
                kind,
                record.title,
                record.description,
                status,
                record.start_at,
                record.end_at,
                record.parent_id,
                record.source,
                tags,
                data,
                record.created_at,
                record.updated_at,
                record.deleted_at,
                record.revision,
            ],
        )?;
        Ok(())
    }

    /// 按 id 读取（含已软删记录；由 service 决定可见性）。不存在返回 `NotFound`。
    pub fn get(&self, id: &str) -> Result<Record, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT * FROM records WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(row_to_record(row)?),
            None => Err(CoreError::NotFound(id.to_string())),
        }
    }

    /// 整行覆盖更新（按 id）。调用方须已设置 `updated_at` / `revision`；不存在返回 `NotFound`。
    pub fn update(&self, record: &Record) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        let kind = kind_to_str(record.kind);
        let status = status_to_str(record.status);
        let tags = serde_json::to_string(&record.tags)?;
        let data = serde_json::to_string(&record.data)?;
        let n = conn.execute(
            "UPDATE records SET
               kind = ?1, title = ?2, description = ?3, status = ?4, start_at = ?5, end_at = ?6,
               parent_id = ?7, source = ?8, tags = ?9, data = ?10, created_at = ?11, updated_at = ?12,
               deleted_at = ?13, revision = ?14
             WHERE id = ?15",
            params![
                kind,
                record.title,
                record.description,
                status,
                record.start_at,
                record.end_at,
                record.parent_id,
                record.source,
                tags,
                data,
                record.created_at,
                record.updated_at,
                record.deleted_at,
                record.revision,
                record.id,
            ],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(record.id.clone()));
        }
        Ok(())
    }

    /// 同步合并回放：按 id 整行覆盖写入（INSERT OR REPLACE）。
    /// LWW 裁决由调用方（sync::merge）完成，这里只负责落盘。
    pub fn upsert_record(&self, record: &Record) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        let kind = kind_to_str(record.kind);
        let status = status_to_str(record.status);
        let tags = serde_json::to_string(&record.tags)?;
        let data = serde_json::to_string(&record.data)?;
        conn.execute(
            "INSERT OR REPLACE INTO records
               (id, kind, title, description, status, start_at, end_at,
                parent_id, source, tags, data, created_at, updated_at, deleted_at, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                record.id,
                kind,
                record.title,
                record.description,
                status,
                record.start_at,
                record.end_at,
                record.parent_id,
                record.source,
                tags,
                data,
                record.created_at,
                record.updated_at,
                record.deleted_at,
                record.revision,
            ],
        )?;
        Ok(())
    }

    /// 按过滤条件列表。默认不含软删；`filter.include_deleted == Some(true)` 时含之。
    pub fn list(&self, filter: &RecordFilter) -> Result<Vec<Record>, CoreError> {
        let conn = self.lock()?;
        let (sql, params_vec) = build_list_query(filter);
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(rusqlite::params_from_iter(params_vec.iter()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row_to_record(row)?);
        }
        Ok(out)
    }

    /// 列出与 `[from, to]` 区间重叠的 event（`deleted_at IS NULL`）。
    /// 重叠语义：`start_at < to`（排他上界）AND `end_at >= from`（含下界）。
    /// 该比较对全天（date-only `YYYY-MM-DD`）与定时（ISO8601）两种格式同时成立：
    /// 调用方传 `from` = 窗口首日（含）、`to` = 窗口末日 + 1 天（排他）。
    pub fn list_events_in_range(&self, from: &str, to: &str) -> Result<Vec<Record>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM records
             WHERE kind = 'event' AND deleted_at IS NULL
               AND start_at IS NOT NULL AND end_at IS NOT NULL
               AND start_at < ?1 AND end_at >= ?2
             ORDER BY start_at ASC",
        )?;
        let mut rows = stmt.query(params![to, from])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row_to_record(row)?);
        }
        Ok(out)
    }

    /// 软删：置 `deleted_at` + 递增 `revision`。不存在或已删时返回 `NotFound`。
    pub fn soft_delete(&self, id: &str) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        let now = crate::model::now_iso();
        let n = conn.execute(
            "UPDATE records SET deleted_at = ?1, updated_at = ?1, revision = revision + 1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![now, id],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// 读取 kv 配置项；不存在返回 `None`。
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// 写入 kv 配置项（UPSERT：存在则覆盖），`updated_at` 自动置为当前时间
    /// （同步 LWW 依据，见 docs/sync-design.md §3.3）。
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), CoreError> {
        self.set_setting_with_time(key, value, &crate::model::now_iso())
    }

    /// 写入 kv 配置项并显式指定 `updated_at`（同步合并恢复远端值时用；
    /// 本地常规写入走 [`Self::set_setting`]）。
    pub fn set_setting_with_time(
        &self,
        key: &str,
        value: &str,
        updated_at: &str,
    ) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, updated_at],
        )?;
        Ok(())
    }

    /// 全量 settings（含 updated_at）。同步 dump / 合并用。
    pub fn list_settings(&self) -> Result<Vec<SettingRow>, CoreError> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT key, value, updated_at FROM settings ORDER BY key ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok(SettingRow {
                key: row.get(0)?,
                value: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    // ── AI Provider / Model 实体（08-28-ai-model-management）──

    /// 旧配置导入标记（ai_meta，本机私有不参与同步）。
    const AI_LEGACY_IMPORTED: &'static str = "ai_legacy_imported";

    /// Provider 全量（sort_order 升序、同序按 name）。
    pub fn list_ai_providers(&self) -> Result<Vec<AiProvider>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, preset_id, name, base_url, api_key, enabled, sort_order, created_at
             FROM ai_provider ORDER BY sort_order ASC, name ASC",
        )?;
        let rows = stmt.query_map([], row_to_ai_provider)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// 按 id 取 Provider。
    pub fn get_ai_provider(&self, id: &str) -> Result<Option<AiProvider>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, preset_id, name, base_url, api_key, enabled, sort_order, created_at
             FROM ai_provider WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_ai_provider)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// 按 name 精确找（旧命令兼容层用）。
    pub fn find_ai_provider_by_name(&self, name: &str) -> Result<Option<AiProvider>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, preset_id, name, base_url, api_key, enabled, sort_order, created_at
             FROM ai_provider WHERE name = ?1",
        )?;
        let mut rows = stmt.query_map(params![name], row_to_ai_provider)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// upsert Provider（id 冲突即更新；created_at 空则补当前时间）。
    pub fn upsert_ai_provider(&self, p: &AiProvider) -> Result<(), CoreError> {
        mark_dirty();
        let created_at = if p.created_at.is_empty() {
            crate::model::now_iso()
        } else {
            p.created_at.clone()
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO ai_provider (id, preset_id, name, base_url, api_key, enabled, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               preset_id = excluded.preset_id,
               name = excluded.name,
               base_url = excluded.base_url,
               api_key = excluded.api_key,
               enabled = excluded.enabled,
               sort_order = excluded.sort_order",
            params![
                p.id,
                p.preset_id,
                p.name,
                p.base_url,
                p.api_key,
                p.enabled,
                p.sort_order,
                created_at
            ],
        )?;
        Ok(())
    }

    /// 删 Provider（级联删模型；若默认模型属于它则顺带清空默认）。
    pub fn delete_ai_provider(&self, id: &str) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        conn.execute("DELETE FROM ai_provider WHERE id = ?1", params![id])?;
        drop(conn);
        self.clear_default_model_if_matches(id)
    }

    /// 模型列表。`provider_id` None = 全部；sort_order 升序、同序按 model_id。
    pub fn list_ai_models(&self, provider_id: Option<&str>) -> Result<Vec<AiModel>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, provider_id, model_id, name, capabilities, context_window, notes,
                    pinned, enabled, hidden, sort_order
             FROM ai_model
             WHERE (?1 IS NULL OR provider_id = ?1)
             ORDER BY sort_order ASC, model_id ASC",
        )?;
        let rows = stmt.query_map(params![provider_id], row_to_ai_model)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// 按 UniqueModelId 取模型。
    pub fn get_ai_model(&self, unique_id: &str) -> Result<Option<AiModel>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, provider_id, model_id, name, capabilities, context_window, notes,
                    pinned, enabled, hidden, sort_order
             FROM ai_model WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![unique_id], row_to_ai_model)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// upsert 模型。校验 id 与 provider_id/model_id 一致（防错位写）。
    pub fn upsert_ai_model(&self, m: &AiModel) -> Result<(), CoreError> {
        if m.id != format!("{}{}{}", m.provider_id, crate::agent::models::MODEL_ID_SEP, m.model_id) {
            return Err(CoreError::Validation(format!(
                "模型 id 与 provider/model 不一致: {}",
                m.id
            )));
        }
        mark_dirty();
        let caps = serde_json::to_string(&m.capabilities)
            .map_err(|e| CoreError::Db(format!("capabilities 序列化失败: {e}")))?;
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO ai_model (id, provider_id, model_id, name, capabilities, context_window,
                                  notes, pinned, enabled, hidden, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               capabilities = excluded.capabilities,
               context_window = excluded.context_window,
               notes = excluded.notes,
               pinned = excluded.pinned,
               enabled = excluded.enabled,
               hidden = excluded.hidden,
               sort_order = excluded.sort_order",
            params![
                m.id,
                m.provider_id,
                m.model_id,
                m.name,
                caps,
                m.context_window,
                m.notes,
                m.pinned,
                m.enabled,
                m.hidden,
                m.sort_order
            ],
        )?;
        Ok(())
    }

    /// 删模型；若是默认模型则顺带清空默认。
    pub fn delete_ai_model(&self, unique_id: &str) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        conn.execute("DELETE FROM ai_model WHERE id = ?1", params![unique_id])?;
        drop(conn);
        self.clear_default_model_if_matches(unique_id)
    }

    /// 同步远端模型 id 列表：新增入库（enabled=1），本地多余标 hidden=1（不物理删）。
    /// 返回 (新增的原始 model_id, 被隐藏的 UniqueModelId)。
    pub fn sync_ai_models(
        &self,
        provider_id: &str,
        remote_ids: &[String],
    ) -> Result<AiSyncResult, CoreError> {
        mark_dirty();
        let existing = self.list_ai_models(Some(provider_id))?;
        let mut known: std::collections::HashSet<&str> =
            existing.iter().map(|m| m.model_id.as_str()).collect();

        let mut added = Vec::new();
        let mut sort = existing
            .iter()
            .map(|m| m.sort_order)
            .fold(0.0_f64, f64::max);
        for rid in remote_ids {
            if !known.insert(rid.as_str()) {
                continue; // 已在库（HashSet 返回 false = 原本存在，顺带去重远端重复项）
            }
            let id = crate::agent::models::unique_model_id(provider_id, rid)
                .ok_or_else(|| CoreError::Validation(format!("非法模型 id: {rid}")))?;
            sort += 1.0;
            self.upsert_ai_model(&AiModel {
                id,
                provider_id: provider_id.to_string(),
                model_id: rid.clone(),
                name: None,
                capabilities: Vec::new(),
                context_window: None,
                notes: None,
                pinned: false,
                enabled: true,
                hidden: false,
                sort_order: sort,
            })?;
            added.push(rid.clone());
        }

        // 远端仍在的曾隐藏模型恢复可见；本地多余且未隐藏的标记 hidden。
        let remote_set: std::collections::HashSet<&str> =
            remote_ids.iter().map(|s| s.as_str()).collect();
        let mut hidden_ids = Vec::new();
        for m in &existing {
            let on_remote = remote_set.contains(m.model_id.as_str());
            if on_remote == !m.hidden {
                continue; // 状态已一致（在远端且未隐藏 / 不在远端且已隐藏）
            }
            let mut next = m.clone();
            next.hidden = !on_remote;
            self.upsert_ai_model(&next)?;
            if !on_remote {
                hidden_ids.push(m.id.clone());
            }
        }
        Ok(AiSyncResult {
            added,
            hidden: hidden_ids,
        })
    }

    /// 旧版 settings JSON（ai_providers / ai_model）一次性导入新表；幂等。
    /// 仅当 ai_provider 为空且未导入过时执行；旧 key 保留只读（旧版本回退安全）。
    pub fn migrate_legacy_ai_config(&self) -> Result<usize, CoreError> {
        let imported = self.get_ai_meta(Self::AI_LEGACY_IMPORTED)?;
        if imported.as_deref() == Some("1") {
            return Ok(0);
        }
        let count = self.list_ai_providers()?.len();
        if count > 0 {
            // 已有数据（新装后自建过）：直接标记，避免后续旧 key 同步进来误导入。
            self.set_ai_meta(Self::AI_LEGACY_IMPORTED, "1")?;
            return Ok(0);
        }

        let mut imported_count = 0usize;
        let mut default_unique: Option<String> = None;
        let legacy_list: Vec<LegacyAiConfig> = self
            .get_setting("ai_providers")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for (i, lc) in legacy_list.into_iter().enumerate() {
            let pid = self.import_legacy_provider(lc, "ai_providers", (i as f64) + 1.0)?;
            imported_count += 1;
            if default_unique.is_none() {
                default_unique = self.first_enabled_model_of(&pid)?;
            }
        }

        // 激活配置（ai_model）：不在列表中时补为独立 Provider。
        let active: Option<LegacyAiConfig> = self
            .get_setting("ai_model")?
            .and_then(|s| serde_json::from_str(&s).ok());
        if let Some(active) = active {
            let complete = !active.base_url.trim().is_empty() && !active.model.trim().is_empty();
            if complete {
                let name = if active.name.trim().is_empty() {
                    "默认提供商".to_string()
                } else {
                    active.name.trim().to_string()
                };
                let already = self.find_ai_provider_by_name(&name)?;
                let pid = match already {
                    Some(p) => p.id.clone(),
                    None => {
                        let mut lc = active.clone();
                        lc.name = name;
                        self.import_legacy_provider(lc, "ai_model", 999.0)?
                    }
                };
                let uid = crate::agent::models::unique_model_id(&pid, active.model.trim())
                    .ok_or_else(|| {
                        CoreError::Validation(format!("非法模型 id: {}", active.model))
                    })?;
                if self.get_ai_model(&uid)?.is_none() {
                    self.upsert_ai_model(&AiModel {
                        id: uid.clone(),
                        provider_id: pid,
                        model_id: active.model.trim().to_string(),
                        name: None,
                        capabilities: Vec::new(),
                        context_window: None,
                        notes: None,
                        pinned: false,
                        enabled: true,
                        hidden: false,
                        sort_order: 1.0,
                    })?;
                }
                default_unique = Some(uid);
            }
        }

        if let Some(uid) = default_unique {
            self.set_setting("ai_default_model", &uid)?;
        }
        self.set_ai_meta(Self::AI_LEGACY_IMPORTED, "1")?;
        Ok(imported_count)
    }

    /// 单条旧 Provider 导入：预置名匹配预置键，否则 custom-<uuid8>；带 model 插一行模型。
    fn import_legacy_provider(
        &self,
        lc: LegacyAiConfig,
        source: &str,
        sort_order: f64,
    ) -> Result<String, CoreError> {
        let name = if lc.name.trim().is_empty() {
            format!("未命名-{source}")
        } else {
            lc.name.trim().to_string()
        };
        let id = match self.find_ai_provider_by_name(&name)? {
            Some(existing) => existing.id.clone(),
            None => {
                let slug = preset_slug_of(&name).unwrap_or_else(|| format!("custom-{}", short_uuid()));
                slug
            }
        };
        let p = AiProvider {
            id: id.clone(),
            preset_id: preset_slug_of(&name),
            name,
            base_url: lc.base_url.trim().trim_end_matches('/').to_string(),
            api_key: lc.api_key.trim().to_string(),
            enabled: true,
            sort_order,
            created_at: String::new(),
        };
        self.upsert_ai_provider(&p)?;
        let model_id = lc.model.trim();
        if !model_id.is_empty() {
            let uid = crate::agent::models::unique_model_id(&id, model_id)
                .ok_or_else(|| CoreError::Validation(format!("非法模型 id: {model_id}")))?;
            if self.get_ai_model(&uid)?.is_none() {
                self.upsert_ai_model(&AiModel {
                    id: uid,
                    provider_id: id.clone(),
                    model_id: model_id.to_string(),
                    name: None,
                    capabilities: Vec::new(),
                    context_window: None,
                    notes: None,
                    pinned: false,
                    enabled: true,
                    hidden: false,
                    sort_order: 1.0,
                })?;
            }
        }
        Ok(id)
    }

    /// 某 Provider 首个可用（enabled 且未隐藏）模型的 UniqueModelId。
    fn first_enabled_model_of(&self, provider_id: &str) -> Result<Option<String>, CoreError> {
        Ok(self
            .list_ai_models(Some(provider_id))?
            .into_iter()
            .find(|m| m.enabled && !m.hidden)
            .map(|m| m.id))
    }

    /// 默认模型失效（被删/前缀是已删 Provider）时清空默认设置。
    fn clear_default_model_if_matches(&self, unique_or_prefix: &str) -> Result<(), CoreError> {
        if let Some(cur) = self.get_setting("ai_default_model")? {
            let stale = cur == unique_or_prefix
                || cur.starts_with(&format!("{unique_or_prefix}{}", crate::agent::models::MODEL_ID_SEP));
            if stale {
                self.set_setting("ai_default_model", "")?;
            }
        }
        Ok(())
    }

    /// ai_meta 读。
    fn get_ai_meta(&self, key: &str) -> Result<Option<String>, CoreError> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT value FROM ai_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(CoreError::from(other)),
        })
    }

    /// ai_meta 写（不 mark_dirty：本机私有，不入同步）。
    fn set_ai_meta(&self, key: &str, value: &str) -> Result<(), CoreError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO ai_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

/// 预置名 → 预置键（与前端 aiPresets 键对齐；仅迁移匹配用）。
fn preset_slug_of(name: &str) -> Option<String> {
    let slug = name.trim().to_lowercase();
    let known = [
        "deepseek",
        "qwen",
        "kimi",
        "moonshot",
        "openai",
        "groq",
        "ollama",
        "zhipu",
        "gemini",
        "mistral",
        "anthropic",
        "hunyuan",
        "doubao",
    ];
    known.iter().find(|k| slug.contains(*k)).map(|k| k.to_string())
}

/// uuid 取前 8 位（custom Provider id 用）。
fn short_uuid() -> String {
    crate::model::new_id().replace('-', "")
        .chars()
        .take(8)
        .collect()
}

fn row_to_ai_provider(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProvider> {
    Ok(AiProvider {
        id: row.get(0)?,
        preset_id: row.get(1)?,
        name: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        sort_order: row.get(6)?,
        created_at: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
    })
}

fn row_to_ai_model(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiModel> {
    let caps_raw: Option<String> = row.get(4)?;
    let capabilities = caps_raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(AiModel {
        id: row.get(0)?,
        provider_id: row.get(1)?,
        model_id: row.get(2)?,
        name: row.get(3)?,
        capabilities,
        context_window: row.get(5)?,
        notes: row.get(6)?,
        pinned: row.get::<_, i64>(7)? != 0,
        enabled: row.get::<_, i64>(8)? != 0,
        hidden: row.get::<_, i64>(9)? != 0,
        sort_order: row.get(10)?,
    })
}

fn kind_to_str(k: Kind) -> &'static str {
    match k {
        Kind::Todo => "todo",
        Kind::Event => "event",
    }
}

fn status_to_str(s: Status) -> &'static str {
    match s {
        Status::Active => "active",
        Status::Done => "done",
        Status::Cancelled => "cancelled",
    }
}

fn str_to_kind(s: &str) -> Result<Kind, CoreError> {
    match s {
        "todo" => Ok(Kind::Todo),
        "event" => Ok(Kind::Event),
        other => Err(CoreError::Db(format!("unknown kind: {other}"))),
    }
}

fn str_to_status(s: &str) -> Result<Status, CoreError> {
    match s {
        "active" => Ok(Status::Active),
        "done" => Ok(Status::Done),
        "cancelled" => Ok(Status::Cancelled),
        other => Err(CoreError::Db(format!("unknown status: {other}"))),
    }
}


/// 从行映射为 `Record`。`tags`/`data` 以 JSON 文本存储，读时反序列化。
fn row_to_record(row: &rusqlite::Row<'_>) -> Result<Record, CoreError> {
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    let tags: String = row.get("tags")?;
    let data: String = row.get("data")?;
    Ok(Record {
        id: row.get("id")?,
        kind: str_to_kind(&kind)?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: str_to_status(&status)?,
        start_at: row.get("start_at")?,
        end_at: row.get("end_at")?,
        parent_id: row.get("parent_id")?,
        source: row.get("source")?,
        tags: serde_json::from_str(&tags)?,
        data: serde_json::from_str(&data)?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        revision: row.get("revision")?,
    })
}

/// 组装列表 SQL 与参数。过滤维度：deleted / kind / status / parent / 日期区间。
fn build_list_query(filter: &RecordFilter) -> (String, Vec<String>) {
    let mut sql = String::from("SELECT * FROM records WHERE 1=1");
    let mut params: Vec<String> = Vec::new();

    if !filter.include_deleted.unwrap_or(false) {
        sql.push_str(" AND deleted_at IS NULL");
    }
    if let Some(kind) = filter.kind {
        sql.push_str(" AND kind = ?");
        params.push(kind_to_str(kind).to_string());
    }
    if let Some(status) = filter.status {
        sql.push_str(" AND status = ?");
        params.push(status_to_str(status).to_string());
    }
    if filter.top_only == Some(true) {
        sql.push_str(" AND parent_id IS NULL");
    } else if let Some(pid) = &filter.parent_id {
        sql.push_str(" AND parent_id = ?");
        params.push(pid.clone());
    }
    if let Some(from) = &filter.date_from {
        sql.push_str(" AND end_at >= ?");
        params.push(from.clone());
    }
    if let Some(to) = &filter.date_to {
        sql.push_str(" AND end_at <= ?");
        params.push(to.clone());
    }

    // 排序：顶层（parent_id IS NULL）优先，再 end_at 升序（NULL 最后），再 created_at。
    sql.push_str(" ORDER BY parent_id IS NULL DESC, parent_id ASC, end_at IS NULL, end_at ASC, created_at ASC");
    (sql, params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Kind, Priority, Record, RecordFilter, Status};

    fn sample_todo(id: &str, title: &str, end_at: Option<&str>) -> Record {
        Record {
            id: id.to_string(),
            kind: Kind::Todo,
            title: title.to_string(),
            description: None,
            status: Status::Active,
            start_at: None,
            end_at: end_at.map(|s| s.to_string()),
            parent_id: None,
            source: "local".to_string(),
            tags: vec![],
            data: serde_json::json!({}),
            created_at: "2026-08-13T09:00:00Z".to_string(),
            updated_at: "2026-08-13T09:00:00Z".to_string(),
            deleted_at: None,
            revision: 1,
        }
    }

    fn sample_event(id: &str, title: &str, start: &str, end: &str) -> Record {
        Record {
            id: id.to_string(),
            kind: Kind::Event,
            title: title.to_string(),
            description: None,
            status: Status::Active,
            start_at: Some(start.to_string()),
            end_at: Some(end.to_string()),
            parent_id: None,
            source: "local".to_string(),
            tags: vec![],
            data: serde_json::json!({}),
            created_at: "2026-08-13T09:00:00Z".to_string(),
            updated_at: "2026-08-13T09:00:00Z".to_string(),
            deleted_at: None,
            revision: 1,
        }
    }

    #[test]
    fn insert_get_roundtrip() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = sample_todo("t1", "买菜", Some("2026-08-13T17:00:00Z"));
        db.insert(&rec).unwrap();
        let got = db.get("t1").unwrap();
        assert_eq!(got, rec);
    }

    #[test]
    fn get_missing_returns_not_found() {
        let db = SqliteStorage::open_in_memory().unwrap();
        assert!(matches!(db.get("nope"), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn list_filters_by_kind_status_and_date() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.insert(&sample_todo("t1", "A", Some("2026-08-13T10:00:00Z")))
            .unwrap();
        db.insert(&sample_todo("t2", "B", Some("2026-08-14T10:00:00Z")))
            .unwrap();

        let all = db
            .list(&RecordFilter {
                kind: Some(Kind::Todo),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(all.len(), 2);

        let range = db
            .list(&RecordFilter {
                date_from: Some("2026-08-13T00:00:00Z".to_string()),
                date_to: Some("2026-08-13T23:59:59Z".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(range.len(), 1);
        assert_eq!(range[0].id, "t1");
    }

    #[test]
    fn list_events_in_range_overlap_semantics() {
        let db = SqliteStorage::open_in_memory().unwrap();
        // 窗口 = 2026-08：from="2026-08-01"（含），to="2026-09-01"（排他）。
        // e1 定时窗口内
        db.insert(&sample_event(
            "e1",
            "定时内",
            "2026-08-15T09:00:00Z",
            "2026-08-15T10:00:00Z",
        ))
        .unwrap();
        // e2 全天单日
        db.insert(&sample_event("e2", "全天单日", "2026-08-20", "2026-08-20"))
            .unwrap();
        // e3 全天跨多日，横跨窗口边界（7/30–8/2）
        db.insert(&sample_event("e3", "全天跨月", "2026-07-30", "2026-08-02"))
            .unwrap();
        // e4 定时事件落在窗口末日深夜
        db.insert(&sample_event(
            "e4",
            "末日深夜",
            "2026-08-31T22:00:00Z",
            "2026-08-31T23:00:00Z",
        ))
        .unwrap();
        // e5 完全在窗口之后（9 月）
        db.insert(&sample_event(
            "e5",
            "窗外后",
            "2026-09-05T09:00:00Z",
            "2026-09-05T10:00:00Z",
        ))
        .unwrap();
        // e6 完全在窗口之前（7 月）
        db.insert(&sample_event(
            "e6",
            "窗外前",
            "2026-07-10T09:00:00Z",
            "2026-07-10T10:00:00Z",
        ))
        .unwrap();

        let list = db.list_events_in_range("2026-08-01", "2026-09-01").unwrap();
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"e1"), "定时窗口内应返回");
        assert!(ids.contains(&"e2"), "全天单日应返回");
        assert!(ids.contains(&"e3"), "全天跨月应返回");
        assert!(ids.contains(&"e4"), "窗口末日深夜定时事件应返回");
        assert!(!ids.contains(&"e5"), "窗外后不应返回");
        assert!(!ids.contains(&"e6"), "窗外前不应返回");
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn list_events_in_range_excludes_deleted_and_todos() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.insert(&sample_event(
            "e1",
            "事件",
            "2026-08-15T09:00:00Z",
            "2026-08-15T10:00:00Z",
        ))
        .unwrap();
        // todo 的 end_at 落在区间，但 kind!=event，不应返回。
        db.insert(&sample_todo(
            "t1",
            "待办在区间",
            Some("2026-08-15T12:00:00Z"),
        ))
        .unwrap();
        db.soft_delete("e1").unwrap();

        let list = db.list_events_in_range("2026-08-01", "2026-09-01").unwrap();
        // 软删的 event 不返回；todo 即便 end_at 在区间也不返回。
        assert!(list.is_empty());
    }

    #[test]
    fn list_hides_and_can_include_deleted() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.insert(&sample_todo("t1", "A", None)).unwrap();
        db.soft_delete("t1").unwrap();

        let active = db.list(&RecordFilter::default()).unwrap();
        assert!(active.is_empty());

        let with_deleted = db
            .list(&RecordFilter {
                include_deleted: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(with_deleted.len(), 1);
        assert!(with_deleted[0].deleted_at.is_some());
    }

    #[test]
    fn soft_delete_missing_errors() {
        let db = SqliteStorage::open_in_memory().unwrap();
        assert!(matches!(
            db.soft_delete("nope"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn update_overwrites_and_missing_errors() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let mut rec = sample_todo("t1", "A", None);
        db.insert(&rec).unwrap();

        rec.title = "A 改".to_string();
        rec.revision = 2;
        db.update(&rec).unwrap();
        assert_eq!(db.get("t1").unwrap().title, "A 改");

        let ghost = sample_todo("ghost", "x", None);
        assert!(matches!(db.update(&ghost), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn priority_roundtrips_via_data_json() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let mut rec = sample_todo("t1", "A", None);
        crate::model::set_priority(&mut rec.data, Priority::High);
        db.insert(&rec).unwrap();
        let got = db.get("t1").unwrap();
        assert_eq!(crate::model::priority_of(&got), Priority::High);
    }

    #[test]
    fn settings_kv_roundtrip_and_overwrite() {
        let db = SqliteStorage::open_in_memory().unwrap();
        // 默认不存在。
        assert_eq!(db.get_setting("weather").unwrap(), None);
        // 写入并读回。
        db.set_setting("weather", r#"{"query":"Hangzhou"}"#)
            .unwrap();
        assert_eq!(
            db.get_setting("weather").unwrap().as_deref(),
            Some(r#"{"query":"Hangzhou"}"#)
        );
        // 覆盖写入。
        db.set_setting("weather", r#"{"query":"Beijing"}"#).unwrap();
        assert_eq!(
            db.get_setting("weather").unwrap().as_deref(),
            Some(r#"{"query":"Beijing"}"#)
        );
        // 其它 key 互不干扰。
        db.set_setting("theme", "dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("dark"));
        assert_eq!(
            db.get_setting("weather").unwrap().as_deref(),
            Some(r#"{"query":"Beijing"}"#)
        );
    }


    #[test]
    fn open_disk_file_runs_migrations() {
        let dir = tempfile_dir();
        let path = dir.join("test_open.sqlite");
        {
            let db = SqliteStorage::open(&path).unwrap();
            db.insert(&sample_todo("t1", "磁盘", None)).unwrap();
        }
        // 重新打开同一文件：迁移幂等，且数据持久。
        let db = SqliteStorage::open(&path).unwrap();
        assert_eq!(db.get("t1").unwrap().title, "磁盘");
    }

    #[test]
    fn list_orders_parents_before_children() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let mut parent = sample_todo("p1", "父", None);
        parent.end_at = Some("2026-08-14T10:00:00Z".to_string());
        let mut child = sample_todo("c1", "子", None);
        child.parent_id = Some("p1".to_string());
        child.end_at = Some("2026-08-13T10:00:00Z".to_string()); // 子截止更早
        db.insert(&parent).unwrap();
        db.insert(&child).unwrap();

        let list = db.list(&RecordFilter::default()).unwrap();
        // 父（顶层）必须排在子之前，尽管子的 end_at 更早。
        assert_eq!(list[0].id, "p1");
        assert_eq!(list[1].id, "c1");
    }

    /// 测试用临时目录（避免引入 tempfile 依赖）。
    fn tempfile_dir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "mosh-core-test-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 旧 schema（v3：自增 id 的 agent_messages、无 updated_at 的 settings）升级到当前版本：
    /// v8 起 agent_messages/墓碑表被 DROP（历史去持久化，存量聊天记录波奔）；
    /// settings 数据保留，updated_at 视为最早。
    #[test]
    fn upgrades_v3_database_in_place() {
        let dir = tempfile_dir();
        let path = dir.join("v3_upgrade.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"
            CREATE TABLE records (
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
              status TEXT NOT NULL DEFAULT 'active', start_at TEXT, end_at TEXT,
              parent_id TEXT REFERENCES records(id), source TEXT NOT NULL DEFAULT 'local',
              tags TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
              revision INTEGER NOT NULL DEFAULT 1, CHECK (kind IN ('todo','event'))
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE agent_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
              content TEXT NOT NULL DEFAULT '', tool_name TEXT, tool_args TEXT, tool_result TEXT,
              created_at TEXT NOT NULL
            );
            INSERT INTO agent_messages (session_id, role, content, created_at)
              VALUES ('s1', 'user', '旧消息', '2026-08-01T10:00:00+00:00');
            INSERT INTO settings (key, value) VALUES ('weather', '"Hangzhou"');
            PRAGMA user_version = 3;
            "#,
            )
            .unwrap();
        }
        // 重新打开：自动跑到最新迁移。settings 保留；agent_messages 已被 v8 DROP
        // （历史去持久化——存量聊天记录波奔，预期行为）。
        let db = SqliteStorage::open(&path).unwrap();
        let rows = db.list_settings().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "weather");
        assert_eq!(rows[0].updated_at, "");
        // 新写入走新机制：UUID id + updated_at。
        db.set_setting("k", "v").unwrap();
        let row = db
            .list_settings()
            .unwrap()
            .into_iter()
            .find(|r| r.key == "k")
            .unwrap();
        assert!(!row.updated_at.is_empty());
        // 表确已不在（v8 DROP 生效）。
        let conn = Connection::open(&path).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('agent_messages','agent_session_tombstones')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    // —— MemoryAgentLog（进程内会话消息仓库，语义对齐旧 SQLite 实现）——

    fn agent_msg(session: &str, role: &str, content: &str) -> AgentMessage {
        AgentMessage {
            id: String::new(),
            session_id: session.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            images: vec![],
            model: None,
            created_at: crate::model::now_iso(),
        }
    }

    #[test]
    fn memory_log_append_list_and_sessions() {
        let log = MemoryAgentLog::default();
        log.append(&agent_msg("s1", "user", "明早十点开周会")).unwrap();
        log.append(&agent_msg("s1", "assistant", "已创建日程")).unwrap();
        log.append(&agent_msg(
            "s2",
            "user",
            "另一个会话的第一句话很长很长很长需要被截断处理才行",
        ))
        .unwrap();

        let msgs = log.list("s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].content, "已创建日程");
        // id 为空时自动生成。
        assert!(!msgs[0].id.is_empty());

        // 摘要：最近活跃在前，标题取首条 user 截 24 字符。
        let sessions = log.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, "s2");
        assert!(sessions[0].title.ends_with("…"));
        assert_eq!(sessions[1].title, "明早十点开周会");
        assert_eq!(sessions[1].message_count, 2);
    }

    #[test]
    fn memory_log_images_roundtrip() {
        let log = MemoryAgentLog::default();
        let mut msg = agent_msg("s1", "user", "看这张图");
        msg.images = vec!["data:image/jpeg;base64,AAA".to_string()];
        log.append(&msg).unwrap();
        assert_eq!(log.list("s1").unwrap()[0].images, msg.images);
    }

    #[test]
    fn memory_log_delete_and_tombstone() {
        let log = MemoryAgentLog::default();
        log.append(&agent_msg("s1", "user", "a")).unwrap();
        log.append(&agent_msg("s1", "assistant", "b")).unwrap();
        log.append(&agent_msg("s2", "user", "c")).unwrap();

        assert_eq!(log.delete_session("s1").unwrap(), 2);
        assert!(log.list("s1").unwrap().is_empty());
        assert_eq!(log.list_sessions().unwrap().len(), 1);

        // 重复删除不报错；其他会话不受影响。
        assert_eq!(log.delete_session("s1").unwrap(), 0);
        assert_eq!(log.list("s2").unwrap().len(), 1);

        // 墓碑拒写：删除后在途轮次的滞后写入不得复活会话（与旧库同语义）。
        assert!(!log.append(&agent_msg("s1", "assistant", "迟到的回复")).unwrap());
        assert!(log.list("s1").unwrap().is_empty());
        assert_eq!(log.list_sessions().unwrap().len(), 1);
    }
    // ── AI Provider / Model（08-28-ai-model-management）──

    fn sample_provider(id: &str, name: &str) -> AiProvider {
        AiProvider {
            id: id.to_string(),
            preset_id: None,
            name: name.to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            sort_order: 1.0,
            created_at: String::new(),
        }
    }

    fn sample_model(provider_id: &str, model_id: &str) -> AiModel {
        AiModel {
            id: format!("{provider_id}::{model_id}"),
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            name: None,
            capabilities: vec!["vision".to_string()],
            context_window: Some(128_000),
            notes: None,
            pinned: false,
            enabled: true,
            hidden: false,
            sort_order: 1.0,
        }
    }

    #[test]
    fn ai_provider_crud_and_cascade() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.upsert_ai_provider(&sample_provider("deepseek", "DeepSeek")).unwrap();
        assert_eq!(db.list_ai_providers().unwrap().len(), 1);
        assert!(db.get_ai_provider("deepseek").unwrap().is_some());
        assert!(db.find_ai_provider_by_name("DeepSeek").unwrap().is_some());

        db.upsert_ai_model(&sample_model("deepseek", "deepseek-chat")).unwrap();
        db.set_setting("ai_default_model", "deepseek::deepseek-chat").unwrap();

        // 级联删模型 + 清默认。
        db.delete_ai_provider("deepseek").unwrap();
        assert!(db.list_ai_providers().unwrap().is_empty());
        assert!(db.list_ai_models(None).unwrap().is_empty());
        assert_eq!(db.get_setting("ai_default_model").unwrap(), Some(String::new()));
    }

    #[test]
    fn ai_model_upsert_rejects_mismatched_id() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.upsert_ai_provider(&sample_provider("p1", "P1")).unwrap();
        let mut m = sample_model("p1", "m1");
        m.id = "p2::m1".to_string();
        assert!(db.upsert_ai_model(&m).is_err());
    }

    #[test]
    fn ai_sync_models_diff_and_restore() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.upsert_ai_provider(&sample_provider("p1", "P1")).unwrap();
        db.upsert_ai_model(&sample_model("p1", "old-model")).unwrap();

        // 首次同步：新增两个，old-model 仍在远端。
        let r = db.sync_ai_models("p1", &["a".into(), "b".into(), "old-model".into()]).unwrap();
        assert_eq!(r.added, vec!["a".to_string(), "b".to_string()]);
        assert!(r.hidden.is_empty());
        assert_eq!(db.list_ai_models(Some("p1")).unwrap().len(), 3);

        // 远端下架 old-model → 标 hidden；再同步回来 → 恢复。
        let r = db.sync_ai_models("p1", &["a".into(), "b".into()]).unwrap();
        assert_eq!(r.hidden, vec!["p1::old-model".to_string()]);
        assert!(db.get_ai_model("p1::old-model").unwrap().unwrap().hidden);
        let r = db.sync_ai_models("p1", &["a".into(), "b".into(), "old-model".into()]).unwrap();
        assert!(r.hidden.is_empty());
        assert!(!db.get_ai_model("p1::old-model").unwrap().unwrap().hidden);
    }

    #[test]
    fn ai_legacy_migration_is_idempotent() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let legacy = r#"[{"name":"DeepSeek","base_url":"https://api.deepseek.com/v1","api_key":"sk-1","model":"deepseek-chat"}]"#;
        db.set_setting("ai_providers", legacy).unwrap();
        db.set_setting("ai_model", r#"{"name":"DeepSeek","base_url":"https://api.deepseek.com/v1","api_key":"sk-1","model":"deepseek-chat"}"#).unwrap();

        let n = db.migrate_legacy_ai_config().unwrap();
        assert_eq!(n, 1);
        let providers = db.list_ai_providers().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name, "DeepSeek");
        // 默认模型指向迁移来的模型。
        assert_eq!(
            db.get_setting("ai_default_model").unwrap().as_deref(),
            Some("deepseek::deepseek-chat")
        );

        // 幂等：再来一次不重复导入。
        assert_eq!(db.migrate_legacy_ai_config().unwrap(), 0);
        assert_eq!(db.list_ai_providers().unwrap().len(), 1);
    }

    #[test]
    fn ai_legacy_migration_active_not_in_list() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.set_setting("ai_providers", "[]").unwrap();
        db.set_setting("ai_model", r#"{"name":"","base_url":"https://x.example.com/v1","api_key":"k","model":"m1"}"#).unwrap();

        let n = db.migrate_legacy_ai_config().unwrap();
        assert_eq!(n, 0); // 列表为空不算导入数，但激活配置补为独立 Provider
        let providers = db.list_ai_providers().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name, "默认提供商");
        assert_eq!(
            db.get_setting("ai_default_model").unwrap().as_deref(),
            Some(providers[0].id.clone() + "::m1").as_deref()
        );
    }

}
