//! 领域服务：Todo CRUD + 子任务 + 校验，封装存储之上的业务语义。

use crate::error::CoreError;
use crate::model::{
    new_id, now_iso, set_all_day, set_location, set_priority, set_recurrence, set_reminder_minutes,
    EventInput, Kind, Record, RecordFilter, RecordPatch, Status, TodoInput,
};
use crate::storage::SqliteStorage;

/// 由输入构造一条 `kind = todo` 的 `Record`（不落库）。
fn build_todo(input: TodoInput) -> Result<Record, CoreError> {
    if input.title.trim().is_empty() {
        return Err(CoreError::Validation("title is required".to_string()));
    }
    let now = now_iso();
    let mut data = serde_json::json!({});
    set_priority(&mut data, input.priority);
    Ok(Record {
        id: new_id(),
        kind: Kind::Todo,
        title: input.title,
        description: input.description,
        status: Status::Active,
        start_at: None,
        end_at: input.due_at,
        parent_id: None,
        source: "local".to_string(),
        tags: input.tags,
        data,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        revision: 1,
    })
}

/// 创建待办。
pub fn create_todo(db: &SqliteStorage, input: TodoInput) -> Result<Record, CoreError> {
    let record = build_todo(input)?;
    db.insert(&record)?;
    Ok(record)
}

/// 列出待办（强制 `kind = todo`）。
pub fn list_todos(db: &SqliteStorage, mut filter: RecordFilter) -> Result<Vec<Record>, CoreError> {
    filter.kind = Some(Kind::Todo);
    db.list(&filter)
}

/// 由输入构造一条 `kind = event` 的 `Record`（不落库）。
///
/// - 全天（`all_day`）：`start_at`/`end_at` 为 date-only，校验 `end >= start`。
/// - 定时：`start_at`/`end_at` 为 ISO8601，校验 `end > start`。
fn build_event(input: EventInput) -> Result<Record, CoreError> {
    if input.title.trim().is_empty() {
        return Err(CoreError::Validation("title is required".to_string()));
    }
    if input.all_day {
        if input.end_at < input.start_at {
            return Err(CoreError::Validation(
                "end_at must not precede start_at".to_string(),
            ));
        }
    } else {
        let start = parse_instant(&input.start_at)?;
        let end = parse_instant(&input.end_at)?;
        if end <= start {
            return Err(CoreError::Validation(
                "end_at must be after start_at".to_string(),
            ));
        }
    }
    let now = now_iso();
    let mut data = serde_json::json!({});
    if let Some(loc) = input.location.as_deref() {
        set_location(&mut data, Some(loc));
    }
    if input.all_day {
        set_all_day(&mut data, true);
    }
    if let Some(rec) = input.recurrence.as_deref() {
        set_recurrence(&mut data, Some(rec));
    }
    if let Some(minutes) = input.reminder_minutes {
        set_reminder_minutes(&mut data, minutes);
    }
    Ok(Record {
        id: new_id(),
        kind: Kind::Event,
        title: input.title,
        description: input.description,
        status: Status::Active,
        start_at: Some(input.start_at),
        end_at: Some(input.end_at),
        parent_id: None,
        source: "local".to_string(),
        tags: input.tags,
        data,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        revision: 1,
    })
}

/// 解析 ISO8601 时刻（拒绝 date-only 等无时间的形式）。
fn parse_instant(s: &str) -> Result<chrono::DateTime<chrono::Utc>, CoreError> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .map_err(|_| CoreError::Validation(format!("invalid ISO8601 datetime: {s}")))
}

/// 创建日程事件。
pub fn create_event(db: &SqliteStorage, input: EventInput) -> Result<Record, CoreError> {
    let record = build_event(input)?;
    db.insert(&record)?;
    Ok(record)
}

/// 列出与 `[from, to]` 区间重叠的事件（`from` 含、`to` 排他；转 storage 区间查询）。
pub fn list_events(db: &SqliteStorage, from: &str, to: &str) -> Result<Vec<Record>, CoreError> {
    db.list_events_in_range(from, to)
}

/// 部分更新记录：合并 patch、刷新 `updated_at`/`revision` 后落库。
pub fn update_record(
    db: &SqliteStorage,
    id: &str,
    patch: RecordPatch,
) -> Result<Record, CoreError> {
    let mut record = db.get(id)?;
    apply_patch(&mut record, patch);
    record.updated_at = now_iso();
    record.revision += 1;
    db.update(&record)?;
    Ok(record)
}

/// 部分更新日程事件（仅 `kind = event`），并对合并后的起止时间做范围校验。
pub fn update_event(db: &SqliteStorage, id: &str, patch: RecordPatch) -> Result<Record, CoreError> {
    let mut record = db.get(id)?;
    if record.kind != Kind::Event {
        return Err(CoreError::Validation(format!("{id} is not an event")));
    }
    apply_patch(&mut record, patch);
    validate_event_range(&record)?;
    record.updated_at = now_iso();
    record.revision += 1;
    db.update(&record)?;
    Ok(record)
}

/// 校验 event 的起止时间范围：全天 `end >= start`；定时 `end > start`（ISO8601）。
fn validate_event_range(record: &Record) -> Result<(), CoreError> {
    let (Some(start), Some(end)) = (record.start_at.as_deref(), record.end_at.as_deref()) else {
        return Err(CoreError::Validation(
            "start_at and end_at are required for events".to_string(),
        ));
    };
    if crate::model::is_all_day(record) {
        if end < start {
            return Err(CoreError::Validation(
                "end_at must not precede start_at".to_string(),
            ));
        }
    } else {
        let s = parse_instant(start)?;
        let e = parse_instant(end)?;
        if e <= s {
            return Err(CoreError::Validation(
                "end_at must be after start_at".to_string(),
            ));
        }
    }
    Ok(())
}

/// 设置待办状态（仅 `kind = todo`）。置 `done` 时在 `data.completed_at` 记录
/// 完成时间点；恢复为其它状态时清除（重复置 done 不刷新原时间点）。
pub fn set_todo_status(db: &SqliteStorage, id: &str, status: Status) -> Result<Record, CoreError> {
    let mut record = db.get(id)?;
    if record.kind != Kind::Todo {
        return Err(CoreError::Validation(format!("{id} is not a todo")));
    }
    if record.status != Status::Done && status == Status::Done {
        crate::model::set_completed_at(&mut record.data, Some(&now_iso()));
    } else if status != Status::Done {
        crate::model::set_completed_at(&mut record.data, None);
    }
    record.status = status;
    record.updated_at = now_iso();
    record.revision += 1;
    db.update(&record)?;
    Ok(record)
}

/// 为顶层待办添加子任务（v1 限 1 层：父须是 todo 且自身无父）。
pub fn add_subtask(
    db: &SqliteStorage,
    parent_id: &str,
    input: TodoInput,
) -> Result<Record, CoreError> {
    let parent = db.get(parent_id).map_err(|e| match e {
        CoreError::NotFound(_) => {
            CoreError::InvalidParent(format!("parent {parent_id} does not exist"))
        }
        other => other,
    })?;
    if parent.kind != Kind::Todo {
        return Err(CoreError::InvalidParent(format!(
            "{parent_id} is not a todo"
        )));
    }
    if parent.parent_id.is_some() {
        return Err(CoreError::InvalidParent(
            "subtasks can only nest 1 level".to_string(),
        ));
    }
    let mut child = build_todo(input)?;
    child.parent_id = Some(parent_id.to_string());
    db.insert(&child)?;
    Ok(child)
}

/// 软删记录。
pub fn soft_delete(db: &SqliteStorage, id: &str) -> Result<(), CoreError> {
    db.soft_delete(id)
}

/// 把 `RecordPatch` 的字段合并进 `Record`。`None` 表示"不改"。
fn apply_patch(record: &mut Record, patch: RecordPatch) {
    if let Some(title) = patch.title {
        record.title = title;
    }
    if let Some(description) = patch.description {
        record.description = description;
    }
    if let Some(status) = patch.status {
        let was = record.status;
        record.status = status;
        // 状态变更同步维护完成时间点（与 set_todo_status 同语义：
        // 新完成→写入；恢复→清除；重复 done 不刷新）。event 不产生 done 状态，无副作用。
        if was != Status::Done && status == Status::Done {
            crate::model::set_completed_at(&mut record.data, Some(&now_iso()));
        } else if status != Status::Done {
            crate::model::set_completed_at(&mut record.data, None);
        }
    }
    if let Some(start_at) = patch.start_at {
        record.start_at = start_at;
    }
    if let Some(end_at) = patch.end_at {
        record.end_at = end_at;
    }
    if let Some(tags) = patch.tags {
        record.tags = tags;
    }
    if let Some(priority) = patch.priority {
        set_priority(&mut record.data, priority);
    }
    if let Some(location) = patch.location {
        set_location(&mut record.data, location.as_deref());
    }
    if let Some(all_day) = patch.all_day {
        set_all_day(&mut record.data, all_day);
    }
    if let Some(recurrence) = patch.recurrence {
        set_recurrence(&mut record.data, Some(&recurrence));
    }
    if let Some(minutes) = patch.reminder_minutes {
        set_reminder_minutes(&mut record.data, minutes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EventInput, Priority, RecordFilter, Status, TodoInput};

    fn input(title: &str) -> TodoInput {
        TodoInput {
            title: title.to_string(),
            description: None,
            due_at: None,
            priority: Priority::None,
            tags: vec![],
        }
    }

    fn event_input(title: &str, start: &str, end: &str) -> EventInput {
        EventInput {
            title: title.to_string(),
            description: None,
            start_at: start.to_string(),
            end_at: end.to_string(),
            location: None,
            all_day: false,
            tags: vec![],
            recurrence: None,
            reminder_minutes: None,
        }
    }

    #[test]
    fn create_todo_requires_title() {
        let db = SqliteStorage::open_in_memory().unwrap();
        assert!(matches!(
            create_todo(&db, input("   ")),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn create_and_list_todos() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("写周报")).unwrap();
        assert_eq!(rec.kind, Kind::Todo);
        assert_eq!(rec.status, Status::Active);

        let todos = list_todos(&db, RecordFilter::default()).unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].title, "写周报");
    }

    #[test]
    fn add_subtask_one_level_and_reject_second() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let parent = create_todo(&db, input("大任务")).unwrap();
        let child = add_subtask(&db, &parent.id, input("子任务")).unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));

        // 2 层：以 child 为父再挂子任务应被拒绝。
        assert!(matches!(
            add_subtask(&db, &child.id, input("孙任务")),
            Err(CoreError::InvalidParent(_))
        ));
    }

    #[test]
    fn set_todo_status_persists() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("任务")).unwrap();
        let updated = set_todo_status(&db, &rec.id, Status::Done).unwrap();
        assert_eq!(updated.status, Status::Done);
        assert_eq!(db.get(&rec.id).unwrap().status, Status::Done);
    }

    #[test]
    fn done_records_completed_at_and_reactivate_clears() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("任务")).unwrap();
        assert!(crate::model::completed_at_of(&rec).is_none());

        // 完成时写入时间点。
        let done = set_todo_status(&db, &rec.id, Status::Done).unwrap();
        let at = crate::model::completed_at_of(&done).expect("completed_at should be set");
        assert!(chrono::DateTime::parse_from_rfc3339(&at).is_ok());

        // 重复置 done 不刷新。
        let again = set_todo_status(&db, &rec.id, Status::Done).unwrap();
        assert_eq!(crate::model::completed_at_of(&again).as_deref(), Some(at.as_str()));

        // 恢复为进行中时清除。
        let revived = set_todo_status(&db, &rec.id, Status::Active).unwrap();
        assert!(crate::model::completed_at_of(&revived).is_none());
    }

    #[test]
    fn patch_status_done_records_completed_at() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("任务")).unwrap();
        let patch = RecordPatch {
            status: Some(Status::Done),
            ..Default::default()
        };
        let updated = update_record(&db, &rec.id, patch).unwrap();
        assert!(crate::model::completed_at_of(&updated).is_some());

        // patch 恢复 active → 清除。
        let patch = RecordPatch {
            status: Some(Status::Active),
            ..Default::default()
        };
        let revived = update_record(&db, &rec.id, patch).unwrap();
        assert!(crate::model::completed_at_of(&revived).is_none());
    }

    #[test]
    fn update_record_merges_and_bumps_revision() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("原标题")).unwrap();
        let patch = RecordPatch {
            title: Some("新标题".to_string()),
            ..Default::default()
        };
        let updated = update_record(&db, &rec.id, patch).unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.revision, rec.revision + 1);
    }

    #[test]
    fn soft_delete_hides_from_list() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("待删")).unwrap();
        soft_delete(&db, &rec.id).unwrap();
        assert!(list_todos(&db, RecordFilter::default()).unwrap().is_empty());
        // 软删后 get 仍可读（墓碑保留），但默认列表不含。
        assert!(db.get(&rec.id).unwrap().deleted_at.is_some());
    }

    #[test]
    fn add_subtask_missing_parent_is_invalid_parent() {
        let db = SqliteStorage::open_in_memory().unwrap();
        // 父不存在：按契约应返回 InvalidParent（而非 NotFound）。
        assert!(matches!(
            add_subtask(&db, "ghost", input("孤儿子任务")),
            Err(CoreError::InvalidParent(_))
        ));
    }

    #[test]
    fn create_todo_writes_priority_into_data() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let input = TodoInput {
            title: "重要任务".to_string(),
            description: Some("详情".to_string()),
            due_at: Some("2026-08-13T17:00:00Z".to_string()),
            priority: Priority::High,
            tags: vec!["work".to_string()],
        };
        let rec = create_todo(&db, input).unwrap();
        assert_eq!(rec.end_at.as_deref(), Some("2026-08-13T17:00:00Z"));
        assert_eq!(rec.tags, vec!["work".to_string()]);
        assert_eq!(crate::model::priority_of(&rec), Priority::High);
        assert_eq!(rec.data["priority"], "high");
    }

    #[test]
    fn update_record_nested_option_set_clear_keep() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let input = TodoInput {
            title: "原标题".to_string(),
            description: Some("原描述".to_string()),
            due_at: Some("2026-08-13T17:00:00Z".to_string()),
            priority: Priority::Medium,
            tags: vec![],
        };
        let rec = create_todo(&db, input).unwrap();
        let original_updated = rec.updated_at.clone();

        // description: 设 → 清 → 不动（三层语义）。
        // 1) 设
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                description: Some(Some("新描述".to_string())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.description.as_deref(), Some("新描述"));

        // 2) 清
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                description: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.description, None);

        // 3) 不动：传 None 时 description 保持 None。
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                title: Some("只改标题".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.description, None);
        assert_eq!(updated.title, "只改标题");

        // 每次更新都 bump revision / updated_at。
        let final_rec = db.get(&rec.id).unwrap();
        assert_eq!(final_rec.revision, rec.revision + 3);
        assert_ne!(final_rec.updated_at, original_updated);
    }

    #[test]
    fn update_record_priority_and_location_in_data() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("任务")).unwrap();

        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                priority: Some(Priority::High),
                location: Some(Some("会议室".to_string())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(crate::model::priority_of(&updated), Priority::High);
        assert_eq!(
            crate::model::location_of(&updated).as_deref(),
            Some("会议室")
        );

        // 清除 location：Some(None) 应删除 data.location 键。
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                location: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(crate::model::location_of(&updated).is_none());
        // priority 不受影响。
        assert_eq!(crate::model::priority_of(&updated), Priority::High);
    }

    #[test]
    fn update_record_tags_replace() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_todo(&db, input("任务")).unwrap();
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                tags: Some(vec!["a".to_string(), "b".to_string()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.tags, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn update_missing_record_is_not_found() {
        let db = SqliteStorage::open_in_memory().unwrap();
        assert!(matches!(
            update_record(&db, "ghost", RecordPatch::default()),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn create_event_timed_and_all_day() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let timed = create_event(
            &db,
            event_input("会议", "2026-08-15T09:00:00Z", "2026-08-15T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(timed.kind, Kind::Event);
        assert_eq!(timed.start_at.as_deref(), Some("2026-08-15T09:00:00Z"));
        assert!(!crate::model::is_all_day(&timed));

        let mut allday = event_input("休假", "2026-08-20", "2026-08-22");
        allday.all_day = true;
        allday.location = Some("杭州".to_string());
        let rec = create_event(&db, allday).unwrap();
        assert!(crate::model::is_all_day(&rec));
        assert_eq!(crate::model::location_of(&rec).as_deref(), Some("杭州"));
    }

    #[test]
    fn create_event_rejects_empty_title_and_bad_range() {
        let db = SqliteStorage::open_in_memory().unwrap();
        assert!(matches!(
            create_event(
                &db,
                event_input("  ", "2026-08-15T09:00:00Z", "2026-08-15T10:00:00Z")
            ),
            Err(CoreError::Validation(_))
        ));
        // 定时 end < start
        assert!(matches!(
            create_event(
                &db,
                event_input("x", "2026-08-15T10:00:00Z", "2026-08-15T09:00:00Z")
            ),
            Err(CoreError::Validation(_))
        ));
        // 定时 start == end（须严格之后）
        assert!(matches!(
            create_event(
                &db,
                event_input("x", "2026-08-15T09:00:00Z", "2026-08-15T09:00:00Z")
            ),
            Err(CoreError::Validation(_))
        ));
        // 定时 date-only（缺时间）无法解析
        assert!(matches!(
            create_event(&db, event_input("x", "2026-08-15", "2026-08-16")),
            Err(CoreError::Validation(_))
        ));
        // 全天 end < start
        let mut bad = event_input("x", "2026-08-20", "2026-08-19");
        bad.all_day = true;
        assert!(matches!(
            create_event(&db, bad),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn list_events_uses_overlap_range() {
        let db = SqliteStorage::open_in_memory().unwrap();
        create_event(
            &db,
            event_input("A", "2026-08-15T09:00:00Z", "2026-08-15T10:00:00Z"),
        )
        .unwrap();
        create_event(
            &db,
            event_input("B", "2026-09-05T09:00:00Z", "2026-09-05T10:00:00Z"),
        )
        .unwrap();
        let aug = list_events(&db, "2026-08-01", "2026-09-01").unwrap();
        assert_eq!(aug.len(), 1);
        assert_eq!(aug[0].title, "A");
    }

    #[test]
    fn update_event_all_day_toggle() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let rec = create_event(
            &db,
            event_input("会议", "2026-08-15T09:00:00Z", "2026-08-15T10:00:00Z"),
        )
        .unwrap();
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                all_day: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(crate::model::is_all_day(&updated));
        let updated = update_record(
            &db,
            &rec.id,
            RecordPatch {
                all_day: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!crate::model::is_all_day(&updated));
    }
}
