//! 全量快照：本地库 ⇄ 可同步 dump（version=1 协议）。
//!
//! 管线（docs/sync-design.md §3.1）：`Dump ⇄ JSON ⇄ gzip`，加解密由 engine 挂在
//! `to_bytes`/`from_bytes` 之外（先压后密）。

use crate::error::CoreError;
use crate::model::Record;
use crate::storage::{AgentMessage, SettingRow, SqliteStorage};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

/// 当前 dump 协议版本。
pub const DUMP_VERSION: u32 = 1;

/// 设备本地配置键前缀：COS 凭证 / 密钥 / device_id 等，永不入 dump
/// （拉取云端数据之前就必须先有它们，逻辑上不可能通过同步到达）。
pub const DEVICE_LOCAL_KEY_PREFIX: &str = "sync.";

/// 全量快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dump {
    pub version: u32,
    pub device_id: String,
    /// 快照生成时间（ISO8601；诊断用，不参与合并裁决）。
    pub dumped_at: String,
    /// 全量 records，含软删墓碑。
    pub records: Vec<Record>,
    /// 全量 settings（已排除 `sync.*` 设备本地键）。
    pub settings: Vec<SettingRow>,
    /// 全量 agent 会话消息。
    pub agent_messages: Vec<AgentMessage>,
}

/// 从本地库抓取全量快照。
pub fn capture(db: &SqliteStorage, device_id: &str) -> Result<Dump, CoreError> {
    Ok(Dump {
        version: DUMP_VERSION,
        device_id: device_id.to_string(),
        dumped_at: crate::model::now_iso(),
        records: db.list(&crate::model::RecordFilter {
            include_deleted: Some(true),
            ..Default::default()
        })?,
        settings: db
            .list_settings()?
            .into_iter()
            .filter(|row| !is_device_local(&row.key))
            .collect(),
        agent_messages: db.list_all_agent_messages()?,
    })
}

/// `sync.*` 键为设备本地配置，不入 dump、不参与合并。
pub fn is_device_local(key: &str) -> bool {
    key.starts_with(DEVICE_LOCAL_KEY_PREFIX)
}

/// Dump → JSON → gzip 字节流（明文，待 engine 加密）。
pub fn to_bytes(dump: &Dump) -> Result<Vec<u8>, CoreError> {
    let json = serde_json::to_vec(dump)?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&json)
        .map_err(|e| CoreError::Db(format!("gzip 压缩失败：{e}")))?;
    gz.finish()
        .map_err(|e| CoreError::Db(format!("gzip 结束失败：{e}")))
}

/// gzip → JSON → Dump。版本高于当前协议时拒绝（前向兼容：提示升级 App）。
pub fn from_bytes(bytes: &[u8]) -> Result<Dump, CoreError> {
    let mut gz = flate2::read::GzDecoder::new(bytes);
    let mut json = Vec::new();
    gz.read_to_end(&mut json)
        .map_err(|e| CoreError::Validation(format!("gzip 解压失败：{e}")))?;
    let dump: Dump = serde_json::from_slice(&json)?;
    if dump.version > DUMP_VERSION {
        return Err(CoreError::Validation(format!(
            "远端数据为同步协议 v{}，当前 App 只支持到 v{DUMP_VERSION}，请升级 App",
            dump.version
        )));
    }
    Ok(dump)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Kind, Status};

    fn sample_db() -> SqliteStorage {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.insert(&Record {
            id: "t1".into(),
            kind: Kind::Todo,
            title: "买菜".into(),
            description: None,
            status: Status::Active,
            start_at: None,
            end_at: None,
            parent_id: None,
            source: "local".into(),
            tags: vec![],
            data: serde_json::json!({}),
            created_at: "2026-08-18T09:00:00+00:00".into(),
            updated_at: "2026-08-18T09:00:00+00:00".into(),
            deleted_at: None,
            revision: 1,
        })
        .unwrap();
        db.set_setting("weather", "\"Hangzhou\"").unwrap();
        db.set_setting("sync.secret_key", "LEAKED").unwrap();
        db.append_agent_message(&AgentMessage {
            id: String::new(),
            session_id: "s1".into(),
            role: "user".into(),
            content: "你好".into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            created_at: "2026-08-18T09:00:00+00:00".into(),
        })
        .unwrap();
        db
    }

    #[test]
    fn capture_excludes_device_local_keys_and_keeps_tombstones() {
        let db = sample_db();
        db.soft_delete("t1").unwrap(); // 变墓碑，仍应入 dump
        let dump = capture(&db, "device-a").unwrap();
        assert_eq!(dump.records.len(), 1);
        assert!(dump.records[0].deleted_at.is_some());
        assert_eq!(dump.settings.len(), 1);
        assert_eq!(dump.settings[0].key, "weather"); // sync.* 被排除
        assert_eq!(dump.agent_messages.len(), 1);
    }

    #[test]
    fn bytes_roundtrip() {
        let db = sample_db();
        let dump = capture(&db, "device-a").unwrap();
        let bytes = to_bytes(&dump).unwrap();
        let back = from_bytes(&bytes).unwrap();
        assert_eq!(back.version, DUMP_VERSION);
        assert_eq!(back.device_id, "device-a");
        assert_eq!(back.records, dump.records);
        assert_eq!(back.settings, dump.settings);
        assert_eq!(back.agent_messages, dump.agent_messages);
    }

    #[test]
    fn future_version_rejected() {
        let mut dump = capture(&sample_db(), "device-a").unwrap();
        dump.version = 2;
        let bytes = to_bytes(&dump).unwrap();
        let err = from_bytes(&bytes).unwrap_err();
        assert!(err.to_string().contains("升级"));
    }

    #[test]
    fn corrupted_gzip_rejected() {
        assert!(from_bytes(b"not gzip at all").is_err());
    }
}
