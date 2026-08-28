//! 事件载荷：runner 发射 → src-tauri 转发为 Tauri 事件（`agent://start` 等）→ 前端渲染。
//! 协议借鉴 GrenAgent（start/delta/tool/end），turn_id 关联一轮对话内的事件。

use serde::Serialize;
use serde_json::Value;

/// 一轮 Agent 交互中流出的增量事件。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 一轮开始（前端可据此建立流式气泡）。`model_id` 为本轮使用的
    /// 模型 UniqueModelId（气泡头部展示模型图标用）。
    Start {
        session_id: String,
        turn_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_id: Option<String>,
    },
    /// 助手文本增量（SSE 透传）。
    Delta { turn_id: String, text: String },
    /// 工具执行完成（前端渲染卡片：工具名 + 参数摘要 + 结果，失败同样发卡片）。
    Tool {
        turn_id: String,
        tool: String,
        args: Value,
        ok: bool,
        result: Value,
    },
    /// 工具待人工批准（审批模式下）：前端弹批准栏，用户决定经
    /// `agent_approve` 命令回传；随后仍会收到对应 Tool 事件。
    ApprovalRequired {
        turn_id: String,
        /// 对应 LLM tool_call 的 id（批准回传的键）。
        call_id: String,
        tool: String,
        args: Value,
    },
    /// 一轮结束（done / aborted / error）。
    End {
        turn_id: String,
        reason: EndReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// 结束原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    /// 正常完成（含模型自然收尾）。
    Done,
    /// 用户主动中断。
    Aborted,
    /// 出错（LLM 网络/鉴权/步数上限等）。
    Error,
}
