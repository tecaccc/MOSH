//! Agent 能力 v1（任务 08-15-agent-v1）：自然语言 → 工具调用 → 自动创建/查询待办与日程。
//!
//! 模块划分（见 tasks/08-15-agent-v1/design.md）：
//! - [`events`]   事件载荷（src-tauri 以 `agent://*` Tauri 事件转发前端）
//! - [`llm`]      `LlmClient` trait + OpenAI 兼容实现（chat/completions，SSE 流式）
//! - [`tools`]    工具注册表：JSON Schema + handler 直调 [`crate::service`]
//! - [`runner`]   对话循环（步数上限 / abort / 事件发射 / 会话持久化）
//!
//! 边界：本模块不含任何 UI 与 Tauri 依赖；LLM 通过 trait 注入以便单测 mock。

pub mod events;
pub mod llm;
pub mod runner;
pub mod tools;

pub use events::{AgentEvent, EndReason};
pub use llm::{AiConfig, ChatMessage, LlmClient, OpenAiClient, Reply, ToolCallMsg, ToolSpec};
pub use runner::{run_turn, MAX_STEPS};
