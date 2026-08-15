//! 工具注册表：JSON Schema + handler 直调 [`crate::service`]（无 IPC 跳变）。
//!
//! v1 安全策略：仅创建/查询/完成类工具，**不含 update/delete**——最坏结果是多建
//! 一条记录，前端工具卡片「撤销」（软删）即可回滚。`requires_confirm` 字段是 v2
//! MCP 外部工具的授权插槽（内置工具恒 false）。

use crate::error::CoreError;
use crate::model::{EventInput, Priority, RecordFilter, Status, TodoInput};
use crate::service;
use crate::storage::SqliteStorage;
use serde_json::{json, Value};

/// 工具定义（LLM 侧元数据 + 执行元数据）。
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
    /// v2 MCP 外部工具授权插槽；v1 内置工具全 false。
    #[allow(dead_code)]
    pub requires_confirm: bool,
}

/// 全部内置工具定义（静态注册）。
pub fn registry() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "create_todo",
            description: "创建一条待办任务。due_at 为 ISO8601 时刻或 YYYY-MM-DD（当天截止）。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "待办标题（必填）"},
                    "description": {"type": "string", "description": "详细描述，可省略"},
                    "due_at": {"type": "string", "description": "截止时间：ISO8601（如 2026-08-16T17:00:00）或 date-only（2026-08-16）"},
                    "priority": {"type": "string", "enum": ["none", "low", "medium", "high"], "description": "优先级，默认 none"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"}
                },
                "required": ["title"]
            }),
            requires_confirm: false,
        },
        ToolDef {
            name: "create_event",
            description: "在日历上创建日程事件。定时事件用 ISO8601 时刻（end 晚于 start）；全天事件 all_day=true 且用 YYYY-MM-DD（end 含当日）。recurrence 可设为 daily/weekly/monthly/yearly 以创建周期事件。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "日程标题（必填）"},
                    "start_at": {"type": "string", "description": "开始：ISO8601 时刻，或全天事件的 YYYY-MM-DD"},
                    "end_at": {"type": "string", "description": "结束：同上；全天含末日"},
                    "all_day": {"type": "boolean", "description": "是否全天事件，默认 false"},
                    "location": {"type": "string", "description": "地点，可省略"},
                    "description": {"type": "string", "description": "备注，可省略"},
                    "recurrence": {"type": "string", "enum": ["none", "daily", "weekly", "monthly", "yearly"], "description": "周期重复：none=不重复（默认）"},
                    "reminder_minutes": {"type": "integer", "description": "提前多少分钟提醒（0/缺省=不提醒）"}
                },
                "required": ["title", "start_at", "end_at"]
            }),
            requires_confirm: false,
        },
        ToolDef {
            name: "update_event",
            description: "修改一条已存在的日程事件（仅需传要改的字段；id 来自 list_events 或创建结果）。起止时间须成对且 end 晚于 start（全天为含末日）。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "日程 id（必填，来自 list_events 或创建结果）"},
                    "title": {"type": "string", "description": "新标题"},
                    "start_at": {"type": "string", "description": "新开始时间"},
                    "end_at": {"type": "string", "description": "新结束时间"},
                    "all_day": {"type": "boolean", "description": "是否全天"},
                    "location": {"type": "string", "description": "新地点"},
                    "description": {"type": "string", "description": "新备注"},
                    "recurrence": {"type": "string", "enum": ["none", "daily", "weekly", "monthly", "yearly"], "description": "新周期（none=取消重复）"},
                    "reminder_minutes": {"type": "integer", "description": "新提醒分钟数（0=取消提醒）"}
                },
                "required": ["id"]
            }),
            requires_confirm: false,
        },
        ToolDef {
            name: "list_todos",
            description: "查询待办列表。可按状态过滤；默认只返回未完成（active）。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["active", "done", "cancelled"], "description": "按状态过滤，缺省=active"},
                    "include_done": {"type": "boolean", "description": "true 时返回全部状态"}
                }
            }),
            requires_confirm: false,
        },
        ToolDef {
            name: "list_events",
            description: "查询某时间区间的日程。from/to 为 YYYY-MM-DD（to 为排他上界，即末日+1）。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "from": {"type": "string", "description": "起始日 YYYY-MM-DD（含）"},
                    "to": {"type": "string", "description": "结束日 YYYY-MM-DD（排他，=末日+1）"}
                },
                "required": ["from", "to"]
            }),
            requires_confirm: false,
        },
        ToolDef {
            name: "set_todo_status",
            description: "设置待办状态：done=标记完成，active=恢复为进行中，cancelled=取消。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "待办 id（来自 list_todos 或创建结果）"},
                    "status": {"type": "string", "enum": ["active", "done", "cancelled"]}
                },
                "required": ["id", "status"]
            }),
            requires_confirm: false,
        },
        ToolDef {
            name: "add_subtask",
            description: "为某条顶层待办添加子任务（仅一层嵌套）。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "parent_id": {"type": "string", "description": "父待办 id"},
                    "title": {"type": "string", "description": "子任务标题"}
                },
                "required": ["parent_id", "title"]
            }),
            requires_confirm: false,
        },
    ]
}

/// 转为 LLM 侧工具规格。
pub fn specs() -> Vec<crate::agent::llm::ToolSpec> {
    registry()
        .into_iter()
        .map(|t| crate::agent::llm::ToolSpec {
            name: t.name.to_string(),
            description: t.description.to_string(),
            parameters: t.parameters,
        })
        .collect()
}

/// 按名分派执行。返回给模型/前端的结果 JSON（错误转 `{"ok":false,"error":…}`，
/// 不中断回合——让模型看到失败并自我纠正）。
pub fn dispatch(db: &SqliteStorage, name: &str, args: &Value) -> Result<Value, CoreError> {
    let result = match name {
        "create_todo" => create_todo(db, args)?,
        "create_event" => create_event(db, args)?,
        "update_event" => update_event(db, args)?,
        "list_todos" => list_todos(db, args)?,
        "list_events" => list_events(db, args)?,
        "set_todo_status" => set_todo_status(db, args)?,
        "add_subtask" => add_subtask(db, args)?,
        other => {
            return Err(CoreError::Validation(format!("unknown tool: {other}")));
        }
    };
    Ok(result)
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// —— 各工具 handler（参数宽松解析：多余字段忽略，枚举小写）——

fn create_todo(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let title =
        arg_str(args, "title").ok_or_else(|| CoreError::Validation("title is required".into()))?;
    let priority: Priority =
        serde_json::from_value(args.get("priority").cloned().unwrap_or(json!("none")))
            .unwrap_or(Priority::None);
    let input = TodoInput {
        title,
        description: arg_str(args, "description"),
        due_at: arg_str(args, "due_at"),
        priority,
        tags: args
            .get("tags")
            .and_then(|t| serde_json::from_value(t.clone()).ok())
            .unwrap_or_default(),
    };
    let rec = service::create_todo(db, input)?;
    Ok(json!({
        "ok": true, "kind": "todo", "id": rec.id, "title": rec.title,
        "due_at": rec.end_at, "status": rec.status
    }))
}

fn create_event(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let title =
        arg_str(args, "title").ok_or_else(|| CoreError::Validation("title is required".into()))?;
    let start_at = arg_str(args, "start_at")
        .ok_or_else(|| CoreError::Validation("start_at is required".into()))?;
    let end_at = arg_str(args, "end_at")
        .ok_or_else(|| CoreError::Validation("end_at is required".into()))?;
    let input = EventInput {
        title,
        description: arg_str(args, "description"),
        start_at,
        end_at,
        location: arg_str(args, "location"),
        all_day: args
            .get("all_day")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        tags: vec![],
        recurrence: arg_str(args, "recurrence"),
        reminder_minutes: args.get("reminder_minutes").and_then(|v| v.as_i64()),
    };
    let rec = service::create_event(db, input)?;
    Ok(json!({
        "ok": true, "kind": "event", "id": rec.id, "title": rec.title,
        "start_at": rec.start_at, "end_at": rec.end_at,
        "all_day": crate::model::is_all_day(&rec),
        "recurrence": crate::model::recurrence_of(&rec),
        "reminder_minutes": crate::model::reminder_minutes_of(&rec)
    }))
}

fn update_event(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let id = arg_str(args, "id").ok_or_else(|| CoreError::Validation("id is required".into()))?;
    let mut patch = crate::model::RecordPatch::default();
    if let Some(t) = arg_str(args, "title") {
        patch.title = Some(t);
    }
    if let Some(d) = arg_str(args, "description") {
        patch.description = Some(Some(d));
    }
    if let Some(s) = arg_str(args, "start_at") {
        patch.start_at = Some(Some(s));
    }
    if let Some(e) = arg_str(args, "end_at") {
        patch.end_at = Some(Some(e));
    }
    if let Some(l) = arg_str(args, "location") {
        patch.location = Some(Some(l));
    }
    if let Some(all_day) = args.get("all_day").and_then(|v| v.as_bool()) {
        patch.all_day = Some(all_day);
    }
    if let Some(rec) = arg_str(args, "recurrence") {
        patch.recurrence = Some(rec);
    }
    if let Some(minutes) = args.get("reminder_minutes").and_then(|v| v.as_i64()) {
        patch.reminder_minutes = Some(minutes);
    }
    let rec = service::update_event(db, &id, patch)?;
    Ok(json!({
        "ok": true, "kind": "event", "id": rec.id, "title": rec.title,
        "start_at": rec.start_at, "end_at": rec.end_at,
        "all_day": crate::model::is_all_day(&rec),
        "recurrence": crate::model::recurrence_of(&rec),
        "reminder_minutes": crate::model::reminder_minutes_of(&rec)
    }))
}

fn list_todos(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let include_all = args
        .get("include_done")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut filter = RecordFilter {
        kind: Some(crate::model::Kind::Todo),
        ..Default::default()
    };
    if !include_all {
        filter.status = Some(
            serde_json::from_value(args.get("status").cloned().unwrap_or(json!("active")))
                .unwrap_or(Status::Active),
        );
    }
    let todos = service::list_todos(db, filter)?;
    let items: Vec<Value> = todos
        .iter()
        .take(50)
        .map(|r| {
            json!({
                "id": r.id, "title": r.title, "status": r.status,
                "due_at": r.end_at, "priority": crate::model::priority_of(r),
            })
        })
        .collect();
    Ok(json!({ "ok": true, "count": items.len(), "todos": items }))
}

fn list_events(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let from =
        arg_str(args, "from").ok_or_else(|| CoreError::Validation("from is required".into()))?;
    let to = arg_str(args, "to").ok_or_else(|| CoreError::Validation("to is required".into()))?;
    let events = service::list_events(db, &from, &to)?;
    let items: Vec<Value> = events
        .iter()
        .filter(|e| e.status != crate::model::Status::Cancelled)
        .take(50)
        .map(|r| {
            json!({
                "id": r.id, "title": r.title,
                "start_at": r.start_at, "end_at": r.end_at,
                "all_day": crate::model::is_all_day(r),
                "location": crate::model::location_of(r),
            })
        })
        .collect();
    Ok(json!({ "ok": true, "count": items.len(), "events": items }))
}

fn set_todo_status(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let id = arg_str(args, "id").ok_or_else(|| CoreError::Validation("id is required".into()))?;
    let status: Status = serde_json::from_value(args.get("status").cloned().unwrap_or(Value::Null))
        .map_err(|_| CoreError::Validation("invalid status".into()))?;
    let rec = service::set_todo_status(db, &id, status)?;
    Ok(json!({ "ok": true, "id": rec.id, "title": rec.title, "status": rec.status }))
}

fn add_subtask(db: &SqliteStorage, args: &Value) -> Result<Value, CoreError> {
    let parent_id = arg_str(args, "parent_id")
        .ok_or_else(|| CoreError::Validation("parent_id is required".into()))?;
    let title =
        arg_str(args, "title").ok_or_else(|| CoreError::Validation("title is required".into()))?;
    let rec = service::add_subtask(
        db,
        &parent_id,
        TodoInput {
            title,
            description: None,
            due_at: None,
            priority: Priority::None,
            tags: vec![],
        },
    )?;
    Ok(json!({ "ok": true, "id": rec.id, "parent_id": parent_id, "title": rec.title }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_create_todo_and_list() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let r = dispatch(
            &db,
            "create_todo",
            &json!({"title": "交季度报告", "due_at": "2026-08-21", "priority": "high", "tags": ["work"]}),
        )
        .unwrap();
        assert_eq!(r["ok"], true);
        let id = r["id"].as_str().unwrap().to_string();

        let listed = dispatch(&db, "list_todos", &json!({})).unwrap();
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["todos"][0]["priority"], "high");

        let done = dispatch(&db, "set_todo_status", &json!({"id": id, "status": "done"})).unwrap();
        assert_eq!(done["status"], "done");

        // 默认列表只剩 active → 空。
        let listed = dispatch(&db, "list_todos", &json!({})).unwrap();
        assert_eq!(listed["count"], 0);
    }

    #[test]
    fn dispatch_create_event_timed_and_all_day() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let r = dispatch(
            &db,
            "create_event",
            &json!({"title": "周会", "start_at": "2026-08-16T10:00:00Z", "end_at": "2026-08-16T11:00:00Z"}),
        )
        .unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["all_day"], false);

        let allday = dispatch(
            &db,
            "create_event",
            &json!({"title": "休假", "start_at": "2026-08-20", "end_at": "2026-08-22", "all_day": true}),
        )
        .unwrap();
        assert_eq!(allday["all_day"], true);

        let listed = dispatch(
            &db,
            "list_events",
            &json!({"from": "2026-08-16", "to": "2026-08-23"}),
        )
        .unwrap();
        assert_eq!(listed["count"], 2);
    }

    #[test]
    fn dispatch_add_subtask_and_errors() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let parent = dispatch(&db, "create_todo", &json!({"title": "大任务"})).unwrap();
        let pid = parent["id"].as_str().unwrap().to_string();
        let sub = dispatch(
            &db,
            "add_subtask",
            &json!({"parent_id": pid, "title": "子任务"}),
        )
        .unwrap();
        assert_eq!(sub["ok"], true);

        // 未知工具 / 缺参数 → Err（调用方转工具失败结果）。
        assert!(dispatch(&db, "nope", &json!({})).is_err());
        assert!(dispatch(&db, "create_todo", &json!({})).is_err());
        assert!(dispatch(
            &db,
            "set_todo_status",
            &json!({"id": "ghost", "status": "done"})
        )
        .is_err());
    }

    #[test]
    fn specs_cover_seven_tools() {
        let names: Vec<String> = specs().into_iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec![
                "create_todo",
                "create_event",
                "update_event",
                "list_todos",
                "list_events",
                "set_todo_status",
                "add_subtask"
            ]
        );
    }

    #[test]
    fn dispatch_update_event_changes_fields() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let r = dispatch(
            &db,
            "create_event",
            &json!({"title": "周会", "start_at": "2026-08-16T10:00:00Z", "end_at": "2026-08-16T11:00:00Z"}),
        )
        .unwrap();
        let id = r["id"].as_str().unwrap().to_string();

        // 改标题 + 改时间 + 设周期与提醒。
        let u = dispatch(
            &db,
            "update_event",
            &json!({"id": id, "title": "改期周会", "start_at": "2026-08-17T10:00:00Z",
                     "end_at": "2026-08-17T11:00:00Z", "recurrence": "weekly", "reminder_minutes": 15}),
        )
        .unwrap();
        assert_eq!(u["ok"], true);
        assert_eq!(u["title"], "改期周会");
        assert_eq!(u["recurrence"], "weekly");
        assert_eq!(u["reminder_minutes"], 15);
        assert_eq!(u["start_at"], "2026-08-17T10:00:00Z");
    }

    #[test]
    fn dispatch_update_event_rejects_non_event_and_bad_range() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let todo = dispatch(&db, "create_todo", &json!({"title": "待办"})).unwrap();
        let tid = todo["id"].as_str().unwrap().to_string();
        assert!(dispatch(&db, "update_event", &json!({"id": tid, "title": "x"})).is_err());

        let ev = dispatch(
            &db,
            "create_event",
            &json!({"title": "会议", "start_at": "2026-08-16T10:00:00Z", "end_at": "2026-08-16T11:00:00Z"}),
        )
        .unwrap();
        let eid = ev["id"].as_str().unwrap().to_string();
        // end 早于 start → 拒绝。
        assert!(dispatch(
            &db,
            "update_event",
            &json!({"id": eid, "start_at": "2026-08-16T12:00:00Z", "end_at": "2026-08-16T11:00:00Z"})
        )
        .is_err());
    }

    #[test]
    fn dispatch_create_event_with_recurrence_and_reminder() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let r = dispatch(
            &db,
            "create_event",
            &json!({"title": "每日站会", "start_at": "2026-08-16T09:00:00Z", "end_at": "2026-08-16T09:30:00Z",
                     "recurrence": "daily", "reminder_minutes": 10}),
        )
        .unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["recurrence"], "daily");
        assert_eq!(r["reminder_minutes"], 10);
    }
}
