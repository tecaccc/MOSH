//! 核心错误类型。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("record not found: {0}")]
    NotFound(String),

    #[error("database error: {0}")]
    Db(String),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("invalid parent: {0}")]
    InvalidParent(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("weather error: {0}")]
    Weather(String),

    #[error("network error: {0}")]
    Network(String),
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        CoreError::Db(e.to_string())
    }
}

impl From<rusqlite_migration::Error> for CoreError {
    fn from(e: rusqlite_migration::Error) -> Self {
        CoreError::Db(e.to_string())
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        // reqwest 的 Display 只有一层（如 `error sending request for url (…)`），
        // DNS 解析失败/超时/TLS 握手等真因藏在 source 链里，必须展开才可排查。
        let hint = if e.is_timeout() {
            "请求超时（网络不通或防火墙拦截）"
        } else if e.is_connect() {
            "无法建立连接（域名无法解析、网络或代理不可达）"
        } else {
            "网络请求失败"
        };
        CoreError::Network(format!("{hint}：{}", error_chain(&e)))
    }
}

/// 逐层展开 error source 链并以 `: ` 拼接（`外层: 中层: 根因`）。
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rusqlite_error_converts() {
        let e = rusqlite::Error::InvalidColumnIndex(99);
        let c: CoreError = e.into();
        assert!(matches!(c, CoreError::Db(_)));
    }

    #[test]
    fn error_chain_expands_all_sources() {
        #[derive(Debug, thiserror::Error)]
        #[error("error sending request for url (https://x.example.com/)")]
        struct Outer(#[source] Mid);
        #[derive(Debug, thiserror::Error)]
        #[error("error trying to connect")]
        struct Mid(#[source] Inner);
        #[derive(Debug, thiserror::Error)]
        #[error("dns error: failed to lookup address information")]
        struct Inner;

        let e = Outer(Mid(Inner));
        assert_eq!(
            error_chain(&e),
            "error sending request for url (https://x.example.com/): \
             error trying to connect: dns error: failed to lookup address information"
        );
    }
}
