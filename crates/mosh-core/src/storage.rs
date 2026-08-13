//! SQLite 存储：统一 `records` 表 + 迁移 + 基础 CRUD。

use crate::error::CoreError;
use crate::model::{Kind, Record, RecordFilter, Status};
use rusqlite::{params, Connection};
use rusqlite_migration::{Migrations, M};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// 初始迁移：统一 `records` 表（见 design §3）。
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(
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
    )])
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

    /// 软删：置 `deleted_at` + 递增 `revision`。不存在或已删时返回 `NotFound`。
    pub fn soft_delete(&self, id: &str) -> Result<(), CoreError> {
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
        assert!(matches!(db.soft_delete("nope"), Err(CoreError::NotFound(_))));
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
}
