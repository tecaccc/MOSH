//! 同步配置回显(视图):从 settings 读取全部配置项拼装给前端的回显结构。
//!
//! 由 src-tauri 的 `sync_get_config` / `sync_configure` 薄壳调用(领域逻辑在
//! mosh-core 的项目约定)。`generated_key` 仅在 configure 首次生成加密密钥时
//! 由调用方注入一次,视图本身恒为 None。

use crate::storage::SqliteStorage;

use super::engine::{
    KEY_ACCESS_KEY, KEY_ADDRESSING, KEY_BUCKET, KEY_DEVICE_ID, KEY_ENABLED, KEY_ENDPOINT,
    KEY_LAST_SYNC_AT, KEY_NEEDS_KEY_IMPORT, KEY_REGION, KEY_SECRET_KEY, KEY_SYNC_KEY,
    KEY_TIMEOUT, KEY_TLS_VERIFY,
};

/// 同步配置回显。`secret_key` 回明文:与 access_key 同级凭据,本地单机存储,
/// 前端密文框 + 小眼睛需要真实值才能查看(TODO-List BUG:眼睛对空输入无效)。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SyncConfigView {
    pub enabled: bool,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    /// 已保存的 SecretKey 明文(未保存 = None)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<String>,
    /// secret 已配置(兼容旧前端判断;等价于 secret_key.is_some())。
    pub has_secret: bool,
    /// 加密密钥已配置(可导出)。
    pub has_key: bool,
    pub device_id: Option<String>,
    pub last_sync_at: Option<String>,
    /// 寻址风格:virtual | path。
    pub addressing: String,
    /// 单请求超时(秒)。
    pub timeout_secs: u64,
    /// 是否校验 TLS 证书。
    pub tls_verify: bool,
    /// 仅本次 configure 首次生成密钥时由调用方注入(视图恒 None)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_key: Option<String>,
    /// 远端已有同步数据但本机无密钥:需从旧设备导入后才能启用。
    pub needs_key_import: bool,
}

/// 读取 settings 拼装回显视图。读失败的字段按未配置处理(容错,不阻断)。
pub fn config_view(db: &SqliteStorage) -> SyncConfigView {
    let get = |k: &str| db.get_setting(k).ok().flatten().filter(|s| !s.is_empty());
    let has_key = get(KEY_SYNC_KEY).is_some();
    SyncConfigView {
        enabled: get(KEY_ENABLED).as_deref() == Some("true"),
        endpoint: get(KEY_ENDPOINT).unwrap_or_default(),
        region: get(KEY_REGION).unwrap_or_default(),
        bucket: get(KEY_BUCKET).unwrap_or_default(),
        access_key: get(KEY_ACCESS_KEY).unwrap_or_default(),
        secret_key: get(KEY_SECRET_KEY),
        has_secret: get(KEY_SECRET_KEY).is_some(),
        has_key,
        device_id: get(KEY_DEVICE_ID),
        last_sync_at: get(KEY_LAST_SYNC_AT),
        addressing: get(KEY_ADDRESSING).unwrap_or_else(|| "virtual".into()),
        timeout_secs: get(KEY_TIMEOUT)
            .and_then(|s| s.parse().ok())
            .unwrap_or(30),
        tls_verify: get(KEY_TLS_VERIFY).map(|s| s != "false").unwrap_or(true),
        generated_key: None,
        needs_key_import: !has_key && get(KEY_NEEDS_KEY_IMPORT).as_deref() == Some("true"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归(TODO-List BUG:同步 SecretKey 小眼睛无效):已保存的 secret 必须
    /// 能从回显视图拿到真实值,前端密文框才有内容可切换明文。
    #[test]
    fn saved_secret_round_trips_through_config_view() {
        let db = SqliteStorage::open_in_memory().unwrap();
        db.set_setting(KEY_ENDPOINT, "https://s3.example.com").unwrap();
        db.set_setting(KEY_ACCESS_KEY, "AKIA-test").unwrap();
        db.set_setting(KEY_SECRET_KEY, "<REDACTED-dummy>").unwrap();

        let view = config_view(&db);
        assert_eq!(view.secret_key.as_deref(), Some("<REDACTED-dummy>"));
        assert!(view.has_secret);
        assert_eq!(view.access_key, "AKIA-test");

        // 未保存 secret → None + has_secret=false(前端空态)。
        db.set_setting(KEY_SECRET_KEY, "").unwrap();
        let view = config_view(&db);
        assert_eq!(view.secret_key, None);
        assert!(!view.has_secret);
    }

    #[test]
    fn defaults_when_unconfigured() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let view = config_view(&db);
        assert!(!view.enabled);
        assert_eq!(view.addressing, "virtual");
        assert_eq!(view.timeout_secs, 30);
        assert!(view.tls_verify);
        assert!(!view.needs_key_import);
    }
}
