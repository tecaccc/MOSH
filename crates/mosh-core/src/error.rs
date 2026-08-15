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
        CoreError::Network(e.to_string())
    }
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
}
