//! 领域服务：Todo CRUD + 子任务 + 校验，封装存储之上的业务语义。

use crate::error::CoreError;
use crate::model::{
    now_iso, new_id, set_location, set_priority, Kind, Record, RecordFilter, RecordPatch, Status,
    TodoInput,
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

/// 设置待办状态（仅 `kind = todo`）。
pub fn set_todo_status(db: &SqliteStorage, id: &str, status: Status) -> Result<Record, CoreError> {
    let mut record = db.get(id)?;
    if record.kind != Kind::Todo {
        return Err(CoreError::Validation(format!("{id} is not a todo")));
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
        CoreError::NotFound(_) => CoreError::InvalidParent(format!(
            "parent {parent_id} does not exist"
        )),
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
        record.status = status;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Priority, RecordFilter, Status, TodoInput};

    fn input(title: &str) -> TodoInput {
        TodoInput {
            title: title.to_string(),
            description: None,
            due_at: None,
            priority: Priority::None,
            tags: vec![],
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
        assert_eq!(crate::model::location_of(&updated).as_deref(), Some("会议室"));

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
}
