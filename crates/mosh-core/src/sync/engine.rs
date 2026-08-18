//! 同步引擎：拉取所有远端 dump → 解密合并 → 写本地 → 推自己 dump。
//!
//! 网络侧抽象为 [`Remote`] trait：生产为 [`crate::sync::remote::S3Client`]，
//! 测试为内存实现（双设备交替推拉仿真）。

use crate::error::CoreError;
use crate::storage::SqliteStorage;
use crate::sync::crypto;
use crate::sync::dump::{self};
use crate::sync::merge::{self, MergeStats};
use crate::sync::remote::RemoteObject;
use serde::{Deserialize, Serialize};

/// 远端对象键前缀：`mosh-sync/<device-id>/dump.bin`。
pub const KEY_PREFIX: &str = "mosh-sync/";

/// —— settings 中的设备本地配置键（`sync.*`，永不入 dump）——
pub const KEY_ENABLED: &str = "sync.enabled";
pub const KEY_ENDPOINT: &str = "sync.endpoint";
pub const KEY_REGION: &str = "sync.region";
pub const KEY_BUCKET: &str = "sync.bucket";
pub const KEY_ACCESS_KEY: &str = "sync.access_key";
pub const KEY_SECRET_KEY: &str = "sync.secret_key";
pub const KEY_DEVICE_ID: &str = "sync.device_id";
pub const KEY_SYNC_KEY: &str = "sync.key";
pub const KEY_LAST_SYNC_AT: &str = "sync.last_sync_at";
pub const KEY_ADDRESSING: &str = "sync.addressing";
pub const KEY_TIMEOUT: &str = "sync.timeout";
pub const KEY_TLS_VERIFY: &str = "sync.tls_verify";

/// 远端存储抽象（list / get / put）。
pub trait Remote {
    /// 列出前缀下全部对象。
    fn list(
        &self,
        prefix: &str,
    ) -> impl std::future::Future<Output = Result<Vec<RemoteObject>, CoreError>> + Send;
    /// 取对象；不存在返回 `None`。
    fn get(
        &self,
        key: &str,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, CoreError>> + Send;
    /// 上传对象（整体覆盖）。
    fn put(
        &self,
        key: &str,
        body: &[u8],
    ) -> impl std::future::Future<Output = Result<(), CoreError>> + Send;
}

/// 一次完整同步的结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOutcome {
    /// 本机 dump 之外拉到的远端 dump 数。
    pub remote_dumps: usize,
    /// 合并应用统计。
    pub stats: MergeStats,
    /// 本机 dump 已推送。
    pub pushed: bool,
}

/// 同步是否已启用且配置齐全（endpoint/bucket/AK/SK/key/device_id）。
pub fn is_ready(db: &SqliteStorage) -> bool {
    let get = |k: &str| db.get_setting(k).ok().flatten().unwrap_or_default();
    get(KEY_ENABLED) == "true"
        && !get(KEY_ENDPOINT).is_empty()
        && !get(KEY_BUCKET).is_empty()
        && !get(KEY_ACCESS_KEY).is_empty()
        && !get(KEY_SECRET_KEY).is_empty()
        && !get(KEY_SYNC_KEY).is_empty()
        && !get(KEY_DEVICE_ID).is_empty()
}

/// 本机 device_id（首次启用时由命令层生成并写入 settings）。
pub fn device_id(db: &SqliteStorage) -> Result<String, CoreError> {
    db.get_setting(KEY_DEVICE_ID)?
        .ok_or_else(|| CoreError::Validation("未生成 device_id（先调用 sync_configure）".into()))
}

/// 本机 dump 对象键。
fn own_key(device: &str) -> String {
    format!("{KEY_PREFIX}{device}/dump.bin")
}

/// 一次完整同步：LIST → GET（他机）→ 解密解析 → LWW 合并 → capture → 加密 → PUT。
///
/// 任一远端 dump 解密失败（密钥不匹配/损坏）时跳过该 dump 并继续——
/// 单个坏对象不应阻塞其余设备的同步。
pub async fn full_sync<R: Remote>(
    db: &SqliteStorage,
    remote: &R,
) -> Result<SyncOutcome, CoreError> {
    let device = device_id(db)?;
    let key = crypto::decode_key(
        &db.get_setting(KEY_SYNC_KEY)?
            .ok_or_else(|| CoreError::Validation("未配置同步密钥".into()))?,
    )?;

    // 1) 拉取所有远端 dump。
    let objects = remote.list(KEY_PREFIX).await?;
    let mut remotes = Vec::new();
    for obj in &objects {
        if obj.key == own_key(&device) || !obj.key.ends_with("/dump.bin") {
            continue;
        }
        let Some(bytes) = remote.get(&obj.key).await? else {
            continue;
        };
        let decrypted = match crypto::open(&bytes, &key) {
            Ok(d) => d,
            Err(_) => continue, // 坏对象：跳过，不阻塞
        };
        match dump::from_bytes(&decrypted) {
            Ok(d) => remotes.push(d),
            Err(_) => continue,
        }
    }
    let remote_dumps = remotes.len();

    // 2) 合并写本地。
    let stats = merge::apply(db, &remotes)?;

    // 3) 推自己 dump（capture 在合并之后：把合并结果一并带给下一台设备）。
    let own = dump::capture(db, &device)?;
    let sealed = crypto::seal(&dump::to_bytes(&own)?, &key)?;
    remote.put(&own_key(&device), &sealed).await?;

    db.set_setting(KEY_LAST_SYNC_AT, &crate::model::now_iso())?;
    // 在 LAST_SYNC_AT 写入之后清脏：避免自身写入再触发一次冗余推送。
    clear_dirty();
    Ok(SyncOutcome {
        remote_dumps,
        stats,
        pushed: true,
    })
}

// —— 变更脏标记（防抖推的触发源）——

static DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// storage 层写操作后调用：标记有未推送的本地变更。
pub fn mark_dirty() {
    DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// 防抖循环消费：取走脏标记（有变更返回 true 并清零）。
pub fn take_dirty() -> bool {
    DIRTY.swap(false, std::sync::atomic::Ordering::Relaxed)
}

/// 同步完成后清零（合并写入也过 storage，不构成新的推送需求）。
fn clear_dirty() {
    DIRTY.store(false, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Kind, Record, Status};
    use crate::storage::AgentMessage;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// 内存远端：模拟共享 bucket。
    #[derive(Default)]
    struct MemoryRemote {
        objects: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl Remote for MemoryRemote {
        async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, CoreError> {
            Ok(self
                .objects
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, _)| k.starts_with(prefix))
                .map(|(k, _)| RemoteObject {
                    key: k.clone(),
                    etag: String::new(),
                    last_modified: String::new(),
                })
                .collect())
        }
        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
            Ok(self.objects.lock().unwrap().get(key).cloned())
        }
        async fn put(&self, key: &str, body: &[u8]) -> Result<(), CoreError> {
            self.objects
                .lock()
                .unwrap()
                .insert(key.to_string(), body.to_vec());
            Ok(())
        }
    }

    fn rec(id: &str, title: &str, updated_at: &str) -> Record {
        Record {
            id: id.into(),
            kind: Kind::Todo,
            title: title.into(),
            description: None,
            status: Status::Active,
            start_at: None,
            end_at: None,
            parent_id: None,
            source: "local".into(),
            tags: vec![],
            data: serde_json::json!({}),
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
            deleted_at: None,
            revision: 1,
        }
    }

    /// 配置一台"设备"：内存库 + settings 就绪（同一把密钥，不同 device_id）。
    fn device(remote_key: &str, device_name: &str) -> SqliteStorage {
        let db = SqliteStorage::open_in_memory().unwrap();
        for (k, v) in [
            (KEY_ENABLED, "true"),
            (KEY_ENDPOINT, "cos.example.com"),
            (KEY_BUCKET, "b"),
            (KEY_ACCESS_KEY, "ak"),
            (KEY_SECRET_KEY, "sk"),
            (KEY_DEVICE_ID, device_name),
            (KEY_SYNC_KEY, remote_key),
        ] {
            db.set_setting(k, v).unwrap();
        }
        db
    }

    /// 端到端验收场景的自动化仿真（PRD：设备 A 改 → 推；设备 B 拉 → 可见）。
    #[tokio::test]
    async fn two_devices_alternating_push_pull() {
        let remote = MemoryRemote::default();
        let key = crypto::encode_key(&crypto::generate_key());

        // 设备 A（公司）：有两条待办，同步上云。
        // fixture 时间取过去（2020）：soft_delete 用真实 now_iso()，须保证新于 fixture。
        let a = device(&key, "work-pc");
        a.insert(&rec("t1", "写周报", "2020-01-01T09:00:00+00:00"))
            .unwrap();
        a.insert(&rec("t2", "订机票", "2020-01-01T10:00:00+00:00"))
            .unwrap();
        let out = full_sync(&a, &remote).await.unwrap();
        assert_eq!(out.remote_dumps, 0);
        assert_eq!(out.stats.records_applied, 0);
        assert!(out.pushed);
        // 云端只有密文：对象内容不是合法 dump（不可解压解析）。
        let blob = {
            let cloud = remote.objects.lock().unwrap();
            cloud.values().next().unwrap().clone()
        };
        assert!(dump::from_bytes(&blob).is_err());

        // 设备 B（家）：冷启动拉取 → A 的待办可见。
        let b = device(&key, "home-pc");
        let out = full_sync(&b, &remote).await.unwrap();
        assert_eq!(out.remote_dumps, 1);
        assert_eq!(out.stats.records_applied, 2);
        assert_eq!(b.get("t1").unwrap().title, "写周报");

        // B 修改 t1 并删除 t2（墓碑），同步。
        let mut t1 = b.get("t1").unwrap();
        t1.title = "写完周报".into();
        t1.updated_at = "2026-08-18T20:00:00+00:00".into();
        t1.revision = 2;
        b.update(&t1).unwrap();
        b.soft_delete("t2").unwrap();
        full_sync(&b, &remote).await.unwrap();

        // 回到 A：拉取 → 修改与删除都到达。
        let out = full_sync(&a, &remote).await.unwrap();
        assert_eq!(out.stats.records_applied, 2);
        assert_eq!(a.get("t1").unwrap().title, "写完周报");
        assert!(a.get("t2").unwrap().deleted_at.is_some());
        let visible = a.list(&crate::model::RecordFilter::default()).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].title, "写完周报");
    }

    /// 设置与聊天历史也随 dump 同步；`sync.*` 键不串台。
    #[tokio::test]
    async fn settings_and_messages_sync_but_device_keys_do_not() {
        let remote = MemoryRemote::default();
        let key = crypto::encode_key(&crypto::generate_key());
        let a = device(&key, "a");
        a.set_setting("theme", "dark").unwrap();
        a.set_setting(KEY_SECRET_KEY, "A_MACHINE_SK").unwrap();
        a.append_agent_message(&AgentMessage {
            id: String::new(),
            session_id: "s1".into(),
            role: "user".into(),
            content: "帮我建个日程".into(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            created_at: "2026-08-18T09:00:00+00:00".into(),
        })
        .unwrap();
        full_sync(&a, &remote).await.unwrap();

        let b = device(&key, "b");
        full_sync(&b, &remote).await.unwrap();
        assert_eq!(b.get_setting("theme").unwrap().as_deref(), Some("dark"));
        assert_eq!(b.list_agent_messages("s1").unwrap().len(), 1);
        // B 的密钥/凭证未被 A 覆盖。
        assert_eq!(
            b.get_setting(KEY_SECRET_KEY).unwrap().as_deref(),
            Some("sk")
        );
    }

    /// 密钥不匹配的远端对象：跳过且不阻塞（换钥重置场景的另一半仍可同步）。
    #[tokio::test]
    async fn wrong_key_dump_is_skipped() {
        let remote = MemoryRemote::default();
        let key1 = crypto::encode_key(&crypto::generate_key());
        let key2 = crypto::encode_key(&crypto::generate_key());
        let a = device(&key1, "a");
        a.insert(&rec("t1", "A 的数据", "2026-08-18T09:00:00+00:00"))
            .unwrap();
        full_sync(&a, &remote).await.unwrap();

        let b = device(&key2, "b");
        b.insert(&rec("t2", "B 的数据", "2026-08-18T10:00:00+00:00"))
            .unwrap();
        let out = full_sync(&b, &remote).await.unwrap();
        assert_eq!(out.remote_dumps, 0); // A 的 dump 解不开 → 跳过
        assert!(b.get("t1").is_err()); // A 数据未到达
        assert!(b.get("t2").is_ok()); // B 自身不受影响
    }

    #[test]
    fn dirty_flag_roundtrip() {
        // 注：全局 static 会被并行测试污染初态，不断言初始 false；
        // 只验证 set → take 一次清零语义。
        mark_dirty();
        assert!(take_dirty());
        assert!(!take_dirty());
    }

    #[test]
    fn is_ready_requires_full_config() {
        let db = SqliteStorage::open_in_memory().unwrap();
        assert!(!is_ready(&db));
        let key = crypto::encode_key(&crypto::generate_key());
        for (k, v) in [
            (KEY_ENABLED, "true"),
            (KEY_ENDPOINT, "cos.example.com"),
            (KEY_BUCKET, "b"),
            (KEY_ACCESS_KEY, "ak"),
            (KEY_SECRET_KEY, "sk"),
            (KEY_DEVICE_ID, "dev"),
            (KEY_SYNC_KEY, key.as_str()),
        ] {
            db.set_setting(k, v).unwrap();
            // 逐项补齐过程中保持 false 或最终 true。
        }
        assert!(is_ready(&db));
        db.set_setting(KEY_ENABLED, "false").unwrap();
        assert!(!is_ready(&db));
    }
}
