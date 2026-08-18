//! SQLite 存储：统一 `records` 表 + 迁移 + 基础 CRUD。

use crate::error::CoreError;
use crate::model::{Kind, Record, RecordFilter, Status};
use rusqlite::{params, Connection};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// storage 写操作后置脏标记（同步防抖推的触发源，见 sync::engine）。
fn mark_dirty() {
    crate::sync::engine::mark_dirty();
}

/// Agent 会话消息行（对齐 `agent_messages` 表）。
/// id 为 UUIDv7（跨设备不撞号、按时间字典序可排序）。
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
    pub created_at: String,
}

/// 会话摘要（侧栏列表用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionSummary {
    pub session_id: String,
    pub title: String,
    pub message_count: i64,
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

    // —— Agent 会话消息（见 agent 模块 design §3）——

    /// 追加一条会话消息（user/assistant/tool）。`id` 为空时自动生成 UUIDv7；
    /// 显式 id 用于同步合并回放。
    pub fn append_agent_message(&self, msg: &AgentMessage) -> Result<(), CoreError> {
        mark_dirty();
        let conn = self.lock()?;
        let id = if msg.id.is_empty() {
            crate::model::new_id()
        } else {
            msg.id.clone()
        };
        conn.execute(
            "INSERT INTO agent_messages
             (id, session_id, role, content, tool_name, tool_args, tool_result, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                msg.session_id,
                msg.role,
                msg.content,
                msg.tool_name,
                msg.tool_args,
                msg.tool_result,
                msg.created_at
            ],
        )?;
        Ok(())
    }

    /// 全部会话消息（跨会话，同步 dump 用），按 created_at 升序。
    pub fn list_all_agent_messages(&self) -> Result<Vec<AgentMessage>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, tool_name, tool_args, tool_result, created_at
             FROM agent_messages ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_agent_message)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// 按会话取全部消息（按创建时间升序；同秒内按 id，UUIDv7 保字典序近似时序）。
    pub fn list_agent_messages(&self, session_id: &str) -> Result<Vec<AgentMessage>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, tool_name, tool_args, tool_result, created_at
             FROM agent_messages WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], row_to_agent_message)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }

    /// 删除整个会话（全部消息行）；返回删除行数。
    pub fn delete_agent_session(&self, session_id: &str) -> Result<usize, CoreError> {
        let conn = self.lock()?;
        let n = conn.execute(
            "DELETE FROM agent_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(n)
    }

    /// 会话摘要（最近活跃在前）。标题取首条 user 消息截断。
    /// 活跃度按 created_at（id 已非自增整数，`legacy-` 前缀破坏字典序）。
    pub fn list_agent_sessions(&self) -> Result<Vec<AgentSessionSummary>, CoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT session_id,
                    (SELECT content FROM agent_messages m2
                      WHERE m2.session_id = m.session_id AND m2.role = 'user'
                      ORDER BY m2.created_at ASC, m2.id ASC LIMIT 1) AS first_user,
                    COUNT(*) AS n,
                    MAX(created_at) AS last_at
             FROM agent_messages m GROUP BY session_id ORDER BY last_at DESC, session_id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let first: Option<String> = row.get(1)?;
            let n: i64 = row.get(2)?;
            Ok(AgentSessionSummary {
                session_id: row.get(0)?,
                title: first
                    .map(|s| {
                        let t = s.trim();
                        let cut: String = t.chars().take(24).collect();
                        if t.chars().count() > 24 {
                            format!("{cut}…")
                        } else {
                            cut
                        }
                    })
                    .unwrap_or_else(|| "新会话".to_string()),
                message_count: n,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
    }
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

/// 从行映射为 `AgentMessage`（列序与查询保持一致）。
fn row_to_agent_message(row: &rusqlite::Row<'_>) -> Result<AgentMessage, rusqlite::Error> {
    Ok(AgentMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        tool_name: row.get(4)?,
        tool_args: row.get(5)?,
        tool_result: row.get(6)?,
        created_at: row.get(7)?,
    })
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

    fn agent_msg(session: &str, role: &str, content: &str) -> AgentMessage {
        AgentMessage {
            id: String::new(),
            session_id: session.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            created_at: crate::model::now_iso(),
        }
    }

    #[test]
    fn agent_messages_append_list_and_sessions() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.append_agent_message(&agent_msg("s1", "user", "明早十点开周会"))
            .unwrap();
        db.append_agent_message(&agent_msg("s1", "assistant", "已创建日程"))
            .unwrap();
        db.append_agent_message(&agent_msg(
            "s2",
            "user",
            "另一个会话的第一句话很长很长很长需要被截断处理才行",
        ))
        .unwrap();

        // 按会话取出且升序。
        let msgs = db.list_agent_messages("s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].content, "已创建日程");

        // 摘要：最近活跃在前，标题取首条 user 截断。
        let sessions = db.list_agent_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, "s2");
        assert!(sessions[0].title.ends_with("…"));
        assert_eq!(sessions[0].message_count, 1);
        assert_eq!(sessions[1].title, "明早十点开周会");
    }

    #[test]
    fn delete_agent_session_removes_only_target() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.append_agent_message(&agent_msg("s1", "user", "a"))
            .unwrap();
        db.append_agent_message(&agent_msg("s1", "assistant", "b"))
            .unwrap();
        db.append_agent_message(&agent_msg("s2", "user", "c"))
            .unwrap();

        let n = db.delete_agent_session("s1").unwrap();
        assert_eq!(n, 2);
        assert!(db.list_agent_messages("s1").unwrap().is_empty());
        // 其他会话不受影响。
        assert_eq!(db.list_agent_messages("s2").unwrap().len(), 1);
        let sessions = db.list_agent_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s2");

        // 重复删除 → 0 行，不报错。
        assert_eq!(db.delete_agent_session("s1").unwrap(), 0);
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
    /// 旧消息保留且加 legacy- 前缀；settings 数据保留，updated_at 视为最早。
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
        // 重新打开：自动跑到最新迁移。
        let db = SqliteStorage::open(&path).unwrap();
        let msgs = db.list_agent_messages("s1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].id.starts_with("legacy-"));
        assert_eq!(msgs[0].content, "旧消息");
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
        // 旧 id 与新 UUID 不撞：再追加一条，两条共存。
        db.append_agent_message(&agent_msg("s1", "user", "新消息"))
            .unwrap();
        assert_eq!(db.list_agent_messages("s1").unwrap().len(), 2);
    }
}
