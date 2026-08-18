//! 多设备同步（docs/sync-design.md）。
//!
//! 传输层 = S3 兼容对象存储（主用腾讯云 COS）；端到端加密；每设备全量 dump；
//! 客户端 LWW 合并。云端是哑管道，不理解任何内容。

pub mod crypto;
pub mod dump;
pub mod engine;
pub mod merge;
pub mod remote;

pub use engine::{full_sync, is_ready, SyncOutcome};
