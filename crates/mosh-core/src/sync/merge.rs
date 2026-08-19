//! LWW 合并器：远端 dump 与本地库的记录级裁决（docs/sync-design.md §3.3）。
//!
//! 规则：
//! - **records**：按 id 对齐；`updated_at` 新者赢，同值比 `revision`，再同值保留本地（幂等）。
//!   墓碑是普通记录（`deleted_at` 非空），走同一规则——删除动作由此传播。
//! - **settings**：按 key，`updated_at` 新者赢；`sync.*` 设备本地键直接忽略。
//! - **agent_messages**：按 id 并集（append-only 不可变，`ON CONFLICT DO NOTHING`）。
//!
//! 交替使用的前提（同秒并发概率≈0）使 LWW 足够；旧的静默丢弃，无冲突 UI。

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::model::Record;
use crate::storage::{SettingRow, SqliteStorage};
use crate::sync::dump::{is_device_local, Dump};

/// 合并结果统计（诊断 / 状态展示用）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeStats {
    pub records_applied: usize,
    pub settings_applied: usize,
    pub messages_applied: usize,
}

/// 单条 record 裁决：远端是否应覆盖本地。`local = None`（本地无此 id）→ 应用。
///
/// ISO8601 UTC 同格式字符串字典序比较即时间序（`now_iso()` 全端点统一产生该格式）。
pub fn should_apply_record(local: Option<&Record>, remote: &Record) -> bool {
    match local {
        None => true,
        Some(l) => {
            if remote.updated_at != l.updated_at {
                remote.updated_at > l.updated_at
            } else {
                remote.revision > l.revision
            }
        }
    }
}

/// 单条 setting 裁决。本地缺行（v4 前旧库 `updated_at = ""`）视为最早。
pub fn should_apply_setting(local: Option<&SettingRow>, remote: &SettingRow) -> bool {
    match local {
        None => true,
        Some(l) => remote.updated_at > l.updated_at,
    }
}

/// 把远端 dump 们合并进本地库。返回应用统计。
///
/// 注：逐行写入非单事务（连接 Mutex 逐次锁定）；中途崩溃留下的部分状态可被下次
/// 同步收敛（LWW 幂等）。
pub fn apply(db: &SqliteStorage, remotes: &[Dump]) -> Result<MergeStats, CoreError> {
    let mut stats = MergeStats::default();

    // 固定遍历序（dumped_at 升序）：完全同时间戳+revision 的极端 case 结果仍确定。
    let mut remotes: Vec<&Dump> = remotes.iter().collect();
    remotes.sort_by(|a, b| a.dumped_at.cmp(&b.dumped_at));

    let mut local_records: std::collections::HashMap<String, Record> = db
        .list(&crate::model::RecordFilter {
            include_deleted: Some(true),
            ..Default::default()
        })?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let mut local_settings: std::collections::HashMap<String, SettingRow> = db
        .list_settings()?
        .into_iter()
        .map(|s| (s.key.clone(), s))
        .collect();

    for dump in &remotes {
        for remote in &dump.records {
            if should_apply_record(local_records.get(&remote.id), remote) {
                db.upsert_record(remote)?;
                // 同步更新快照：同一次 apply 内后续 dump 的裁决必须看到本次写入。
                local_records.insert(remote.id.clone(), remote.clone());
                stats.records_applied += 1;
            }
        }
        for remote in &dump.settings {
            if is_device_local(&remote.key) {
                continue;
            }
            if should_apply_setting(local_settings.get(&remote.key), remote) {
                db.set_setting_with_time(&remote.key, &remote.value, &remote.updated_at)?;
                local_settings.insert(remote.key.clone(), remote.clone());
                stats.settings_applied += 1;
            }
        }
        for remote in &dump.agent_messages {
            // 并集：append 的 UPSERT 语义；仅统计真正新插入的行
            // （幂等重放已存在行不计——计数是同步事件的门控信号，须反映真实变更）。
            if db.append_agent_message(remote)? {
                stats.messages_applied += 1;
            }
        }
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Kind, Status};
    use crate::storage::AgentMessage;

    fn rec(id: &str, updated_at: &str, revision: i64) -> Record {
        Record {
            id: id.into(),
            kind: Kind::Todo,
            title: format!("title-{id}"),
            description: None,
            status: Status::Active,
            start_at: None,
            end_at: None,
            parent_id: None,
            source: "local".into(),
            tags: vec![],
            data: serde_json::json!({}),
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: updated_at.into(),
            deleted_at: None,
            revision,
        }
    }

    fn msg(id: &str, session: &str) -> AgentMessage {
        AgentMessage {
            id: id.into(),
            session_id: session.into(),
            role: "user".into(),
            content: format!("c-{id}"),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            created_at: "2026-08-18T09:00:00+00:00".into(),
        }
    }

    fn setting(key: &str, value: &str, updated_at: &str) -> SettingRow {
        SettingRow {
            key: key.into(),
            value: value.into(),
            updated_at: updated_at.into(),
        }
    }

    fn dump_from(
        device: &str,
        records: Vec<Record>,
        settings: Vec<SettingRow>,
        messages: Vec<AgentMessage>,
    ) -> Dump {
        Dump {
            version: 1,
            device_id: device.into(),
            dumped_at: "2026-08-18T10:00:00+00:00".into(),
            records,
            settings,
            agent_messages: messages,
        }
    }

    // —— 单条裁决 ——

    #[test]
    fn record_lww_by_updated_at_then_revision_then_local() {
        let local = rec("t1", "2026-08-18T09:00:00+00:00", 1);
        // 远端更新 → 应用。
        assert!(should_apply_record(
            Some(&local),
            &rec("t1", "2026-08-18T10:00:00+00:00", 1)
        ));
        // 远端更旧 → 拒绝。
        assert!(!should_apply_record(
            Some(&local),
            &rec("t1", "2026-08-17T10:00:00+00:00", 9)
        ));
        // updated_at 相同：revision 大者赢。
        assert!(should_apply_record(
            Some(&local),
            &rec("t1", "2026-08-18T09:00:00+00:00", 2)
        ));
        assert!(!should_apply_record(
            Some(&local),
            &rec("t1", "2026-08-18T09:00:00+00:00", 1)
        ));
        // 全同 → 保留本地（幂等）。
        // 本地无此记录 → 应用。
        assert!(should_apply_record(
            None,
            &rec("new", "2000-01-01T00:00:00+00:00", 1)
        ));
    }

    #[test]
    fn setting_lww_by_updated_at() {
        let local = setting("theme", "dark", "2026-08-18T09:00:00+00:00");
        assert!(should_apply_setting(
            Some(&local),
            &setting("theme", "light", "2026-08-18T10:00:00+00:00")
        ));
        assert!(!should_apply_setting(
            Some(&local),
            &setting("theme", "light", "2026-08-18T08:00:00+00:00")
        ));
        // 同时间 → 保留本地（不覆盖）。
        assert!(!should_apply_setting(
            Some(&local),
            &setting("theme", "light", "2026-08-18T09:00:00+00:00")
        ));
        // 旧行 updated_at 为空串 → 任何远端时间都更新。
        let legacy = setting("theme", "dark", "");
        assert!(should_apply_setting(
            Some(&legacy),
            &setting("theme", "light", "2000-01-01T00:00:00+00:00")
        ));
    }

    // —— 整库合并 ——

    #[test]
    fn apply_merges_records_settings_messages() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.insert(&rec("t1", "2026-08-18T09:00:00+00:00", 1))
            .unwrap();
        db.set_setting("theme", "dark").unwrap();
        db.append_agent_message(&msg("m1", "s1")).unwrap();

        let remote = dump_from(
            "peer",
            vec![
                rec("t1", "2026-08-18T10:00:00+00:00", 2), // 更新 → 覆盖
                rec("t2", "2026-08-18T08:00:00+00:00", 1), // 新 id → 应用（即便时间更旧）
            ],
            vec![setting("theme", "light", "2999-01-01T00:00:00+00:00")],
            vec![msg("m1", "s1"), msg("m2", "s1")], // m1 已存在（并集）
        );

        let stats = apply(&db, &[remote]).unwrap();
        assert_eq!(stats.records_applied, 2);
        assert_eq!(stats.settings_applied, 1);
        assert_eq!(stats.messages_applied, 1); // 仅 m2 新插入；m1 已存在不计（幂等）

        let t1 = db.get("t1").unwrap();
        assert_eq!(t1.revision, 2);
        assert_eq!(db.get("t2").unwrap().id, "t2");
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("light"));
        let msgs = db.list_agent_messages("s1").unwrap();
        let ids: Vec<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2"]);
    }

    #[test]
    fn apply_ignores_device_local_settings() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.set_setting("sync.secret_key", "LOCAL").unwrap();
        let remote = dump_from(
            "peer",
            vec![],
            vec![setting(
                "sync.secret_key",
                "LEAKED",
                "2999-01-01T00:00:00+00:00",
            )],
            vec![],
        );
        let stats = apply(&db, &[remote]).unwrap();
        assert_eq!(stats.settings_applied, 0);
        assert_eq!(
            db.get_setting("sync.secret_key").unwrap().as_deref(),
            Some("LOCAL")
        );
    }

    #[test]
    fn tombstone_propagates_and_resurrects_locally() {
        // 场景：设备 B 删了 t1（墓碑），设备 A 本地 t1 仍活跃 → 同步后 A 应见到墓碑。
        let db = SqliteStorage::open_in_memory().unwrap();
        db.insert(&rec("t1", "2026-08-18T09:00:00+00:00", 1))
            .unwrap();

        let mut deleted = rec("t1", "2026-08-18T12:00:00+00:00", 2);
        deleted.deleted_at = Some("2026-08-18T12:00:00+00:00".into());
        let remote = dump_from("peer", vec![deleted], vec![], vec![]);

        apply(&db, &[remote]).unwrap();
        let t1 = db.get("t1").unwrap();
        assert!(t1.deleted_at.is_some());
        // 常规列表不再可见。
        let visible = db.list(&crate::model::RecordFilter::default()).unwrap();
        assert!(visible.is_empty());
    }

    #[test]
    fn apply_is_idempotent() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let remote = dump_from(
            "peer",
            vec![rec("t1", "2026-08-18T10:00:00+00:00", 2)],
            vec![setting("theme", "light", "2026-08-18T10:00:00+00:00")],
            vec![msg("m1", "s1")],
        );
        apply(&db, std::slice::from_ref(&remote)).unwrap();
        let once = db.get("t1").unwrap();
        // 第二次：无新增（幂等）。
        let stats = apply(&db, &[remote]).unwrap();
        assert_eq!(stats.records_applied, 0);
        assert_eq!(stats.settings_applied, 0);
        assert_eq!(stats.messages_applied, 0);
        assert_eq!(db.get("t1").unwrap(), once);
        assert_eq!(db.list_agent_messages("s1").unwrap().len(), 1);
    }

    #[test]
    fn multiple_dumps_latest_write_wins() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let d1 = dump_from(
            "a",
            vec![rec("t1", "2026-08-18T09:00:00+00:00", 1)],
            vec![],
            vec![],
        );
        let d2 = dump_from(
            "b",
            vec![rec("t1", "2026-08-18T11:00:00+00:00", 5)],
            vec![],
            vec![],
        );
        // 顺序无关：b 更新，最终胜出。
        apply(&db, &[d2.clone(), d1.clone()]).unwrap();
        assert_eq!(db.get("t1").unwrap().revision, 5);
        let db2 = SqliteStorage::open_in_memory().unwrap();
        apply(&db2, &[d1, d2]).unwrap();
        assert_eq!(db2.get("t1").unwrap().revision, 5);
    }
}
