//! MOSH 共享核心：统一领域模型、SQLite 存储与领域服务。
//!
//! 被 `src-tauri`（桌面 app）与未来的同步服务器复用，保证两端语义一致。

pub mod agent;
pub mod error;
pub mod model;
pub mod service;
pub mod storage;
pub mod weather;
