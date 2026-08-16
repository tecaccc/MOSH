//! 统一领域模型：一切信息以 `Record` 原子建模，`kind` 区分类型。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Record 种类。v1 支持 todo 与 event；未来新增类型（journal/note）只是新增变体。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Todo,
    Event,
}

/// 状态。todo 用 active/done/cancelled；event 复用（cancelled 表示取消的事件）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Active,
    Done,
    Cancelled,
}

/// 优先级（todo 专属，存于 `data.priority`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    #[default]
    None,
    Low,
    Medium,
    High,
}

/// 统一记录。字段对齐 `records` 表；`data` 承载 kind 专属扩展字段（JSON）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Status,
    /// ISO8601；event 的开始时间。
    #[serde(default)]
    pub start_at: Option<String>,
    /// ISO8601；event 的结束时间；todo 复用为 due_at（截止）。
    #[serde(default)]
    pub end_at: Option<String>,
    /// 子任务挂载点（v1 限 1 层嵌套）。
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// kind 专属字段：todo 存 `priority`；event 存 `location`/`attendees` 等。
    #[serde(default)]
    pub data: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default = "default_revision")]
    pub revision: i64,
}

fn default_source() -> String {
    "local".to_string()
}

fn default_revision() -> i64 {
    1
}

/// 创建 todo 的输入。`due_at` 复用为 record.end_at。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 创建 event 的输入。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub start_at: String,
    pub end_at: String,
    #[serde(default)]
    pub location: Option<String>,
    /// 全天事件：true 时 start_at/end_at 为 date-only（YYYY-MM-DD）。
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 周期：none/daily/weekly/monthly/yearly（缺省 none）。
    #[serde(default)]
    pub recurrence: Option<String>,
    /// 提前多少分钟提醒；None/0 = 不提醒。
    #[serde(default)]
    pub reminder_minutes: Option<i64>,
}

/// 部分更新。所有字段为 `Option<T>`；`None` 表示"不改"。
/// 使用 `#[serde(default)]` + `skip_serializing_if = "Option::is_none"` 以支持 JSON merge 语义。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_at: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_day: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 事件周期（None=不改；Some("none"/空)=清除；Some(其它)=设置）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<String>,
    /// 提前提醒分钟数（None=不改；Some(0)=清除；Some(n>0)=设置）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_minutes: Option<i64>,
}

/// 列表过滤维度。所有字段为 `Option`；`None` 表示不过滤该维度。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 只取顶层（parent_id IS NULL）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_only: Option<bool>,
    /// 仅返回 end_at 落在 [date_from, date_to] 区间的记录（事件/截止）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_to: Option<String>,
    /// 含已软删（默认 false）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_deleted: Option<bool>,
}

/// 生成新的 UUIDv7 字符串（基于时间有序）。
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// 当前 UTC 时间 ISO8601 字符串。
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 从 `data` JSON 读 priority。
pub fn priority_of(record: &Record) -> Priority {
    record
        .data
        .get("priority")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(Priority::None)
}

/// 把 priority 写入 `data` JSON。
pub fn set_priority(data: &mut serde_json::Value, p: Priority) {
    if data.is_null() {
        *data = serde_json::Value::Object(BTreeMap::new().into_iter().collect());
    }
    if let Some(obj) = data.as_object_mut() {
        obj.insert("priority".to_string(), serde_json::to_value(p).unwrap());
    }
}

/// 从 `data` JSON读待办完成时间点（todo 专属；None=未完成/未记录）。
/// ISO8601；由 `set_todo_status` / patch status→done 时自动写入。
pub fn completed_at_of(record: &Record) -> Option<String> {
    record
        .data
        .get("completed_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 把完成时间点写入（或清除）`data.completed_at`。`None` 表示移除该字段
/// （恢复为未完成时清除，避免残留过期时间点）。
pub fn set_completed_at(data: &mut serde_json::Value, at: Option<&str>) {
    if data.is_null() {
        *data = serde_json::Value::Object(BTreeMap::new().into_iter().collect());
    }
    if let Some(obj) = data.as_object_mut() {
        match at {
            Some(s) => {
                obj.insert("completed_at".to_string(), serde_json::Value::String(s.to_string()));
            }
            None => {
                obj.remove("completed_at");
            }
        }
    }
}

/// 从 `data` JSON 读 location（event 专属）。
pub fn location_of(record: &Record) -> Option<String> {
    record
        .data
        .get("location")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 把 location 写入（或清除）`data` JSON。`None` 表示移除该字段。
pub fn set_location(data: &mut serde_json::Value, location: Option<&str>) {
    if data.is_null() {
        *data = serde_json::Value::Object(BTreeMap::new().into_iter().collect());
    }
    if let Some(obj) = data.as_object_mut() {
        match location {
            Some(s) => {
                obj.insert(
                    "location".to_string(),
                    serde_json::Value::String(s.to_string()),
                );
            }
            None => {
                obj.remove("location");
            }
        }
    }
}

/// 从 `data` JSON 读 all_day（event 专属；缺省 false）。
pub fn is_all_day(record: &Record) -> bool {
    record
        .data
        .get("all_day")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 写入（true）或移除（false）`data.all_day`。false 时删键，使缺省语义一致。
pub fn set_all_day(data: &mut serde_json::Value, all_day: bool) {
    if data.is_null() {
        *data = serde_json::Value::Object(BTreeMap::new().into_iter().collect());
    }
    if let Some(obj) = data.as_object_mut() {
        if all_day {
            obj.insert("all_day".to_string(), serde_json::Value::Bool(true));
        } else {
            obj.remove("all_day");
        }
    }
}

/// 从 `data` JSON 读事件周期（event 专属；缺省 "none"）。
pub fn recurrence_of(record: &Record) -> String {
    record
        .data
        .get("recurrence")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "none".to_string())
}

/// 把周期写入（或清除）`data.recurrence`。`None`/`""`/`"none"` 视为清除（删键）。
pub fn set_recurrence(data: &mut serde_json::Value, recurrence: Option<&str>) {
    if data.is_null() {
        *data = serde_json::Value::Object(BTreeMap::new().into_iter().collect());
    }
    if let Some(obj) = data.as_object_mut() {
        match recurrence {
            Some(s) if !s.is_empty() && s != "none" => {
                obj.insert(
                    "recurrence".to_string(),
                    serde_json::Value::String(s.to_string()),
                );
            }
            _ => {
                obj.remove("recurrence");
            }
        }
    }
}

/// 从 `data` JSON 读提前提醒分钟数（event 专属；缺省 0 = 不提醒）。
pub fn reminder_minutes_of(record: &Record) -> i64 {
    record
        .data
        .get("reminder_minutes")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

/// 写入（>0）或移除（<=0）`data.reminder_minutes`。
pub fn set_reminder_minutes(data: &mut serde_json::Value, minutes: i64) {
    if data.is_null() {
        *data = serde_json::Value::Object(BTreeMap::new().into_iter().collect());
    }
    if let Some(obj) = data.as_object_mut() {
        if minutes > 0 {
            obj.insert(
                "reminder_minutes".to_string(),
                serde_json::Value::from(minutes),
            );
        } else {
            obj.remove("reminder_minutes");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_serde_roundtrip() {
        let rec = Record {
            id: "0195test".to_string(),
            kind: Kind::Todo,
            title: "提交季度报告".to_string(),
            description: Some("整理 Q2 数据".to_string()),
            status: Status::Active,
            start_at: None,
            end_at: Some("2026-08-13T17:00:00Z".to_string()),
            parent_id: None,
            source: "local".to_string(),
            tags: vec!["work".to_string()],
            data: serde_json::json!({"priority": "high"}),
            created_at: "2026-08-13T09:00:00Z".to_string(),
            updated_at: "2026-08-13T09:00:00Z".to_string(),
            deleted_at: None,
            revision: 1,
        };
        let json = serde_json::to_string(&rec).unwrap();
        let back: Record = serde_json::from_str(&json).unwrap();
        assert_eq!(rec, back);
        // snake_case 检查
        assert!(json.contains("\"todo\""));
        assert!(json.contains("\"active\""));
    }

    #[test]
    fn enums_use_snake_case() {
        assert_eq!(serde_json::to_string(&Kind::Todo).unwrap(), "\"todo\"");
        assert_eq!(serde_json::to_string(&Kind::Event).unwrap(), "\"event\"");
        assert_eq!(serde_json::to_string(&Status::Done).unwrap(), "\"done\"");
        assert_eq!(serde_json::to_string(&Priority::High).unwrap(), "\"high\"");
    }

    #[test]
    fn patch_merge_semantics() {
        let json = r#"{"status":"done"}"#;
        let patch: RecordPatch = serde_json::from_str(json).unwrap();
        assert_eq!(patch.status, Some(Status::Done));
        assert_eq!(patch.title, None);
    }

    #[test]
    fn priority_roundtrip_in_data() {
        let mut data = serde_json::json!({});
        set_priority(&mut data, Priority::Medium);
        assert_eq!(data["priority"], "medium");
        let val = data.get("priority").unwrap().clone();
        let p: Priority = serde_json::from_value(val).unwrap();
        assert_eq!(p, Priority::Medium);
    }

    #[test]
    fn location_set_and_clear_in_data() {
        let mut data = serde_json::json!({});
        set_location(&mut data, Some("会议室 A"));
        assert_eq!(data["location"], "会议室 A");
        set_location(&mut data, None);
        assert!(data.get("location").is_none());
    }

    #[test]
    fn all_day_set_and_clear_in_data() {
        let mut data = serde_json::json!({});
        set_all_day(&mut data, true);
        assert_eq!(data["all_day"], true);
        set_all_day(&mut data, false);
        assert!(data.get("all_day").is_none());
    }
}
