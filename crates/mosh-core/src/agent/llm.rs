//! OpenAI 兼容 chat/completions 客户端（SSE 流式）+ 消息/工具协议类型。
//!
//! 只实现 OpenAI 协议一种：DeepSeek/通义/Kimi/OpenAI 直填 base_url，
//! Ollama 指到 `http://localhost:11434/v1` 同样兼容（零供应商锁定，见 design）。

use crate::error::CoreError;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// 模型配置（settings 表 key=`ai_model`）。`base_url` 形如 `https://api.deepseek.com/v1`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AiConfig {
    /// 提供商名称（设置页列表用）。
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

impl AiConfig {
    /// 三项是否齐备（决定"已配置"与否）。
    pub fn is_complete(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    /// 规范化：去尾部 `/`（拼接 `/chat/completions` 用）。
    pub fn normalized(&self) -> AiConfig {
        AiConfig {
            name: self.name.trim().to_string(),
            base_url: self.base_url.trim().trim_end_matches('/').to_string(),
            api_key: self.api_key.trim().to_string(),
            model: self.model.trim().to_string(),
        }
    }
}

/// 提供给模型的工具规格（OpenAI function 格式）。
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema（parameters）。
    pub parameters: Value,
}

/// 对话消息（OpenAI 协议格式；tool 行须带 tool_call_id 引用 assistant 的 tool_calls）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    /// assistant 带 tool_calls 时可为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 仅 assistant 发起工具调用时非空。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallMsg>,
    /// 仅 role=tool 时非空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }

    pub fn assistant_tool_calls(tool_calls: Vec<ToolCallMsg>) -> Self {
        Self {
            role: "assistant".into(),
            content: None,
            tool_calls,
            tool_call_id: None,
        }
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: Some(tool_call_id.into()),
        }
    }
}

/// assistant 消息中的工具调用（协议格式）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallMsg {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCallMsg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCallMsg {
    pub name: String,
    pub arguments: String,
}

/// 一次 chat 的解析结果。
#[derive(Debug, Clone, Default)]
pub struct Reply {
    /// 文本内容（流式期间已通过 on_delta 逐段发出，这里为全量）。
    pub content: String,
    pub tool_calls: Vec<ToolCallMsg>,
}

/// LLM 客户端抽象（单测用 mock 实现，见 runner tests）。
/// 用 `impl Future` 而非 `async fn`：显式 `+ Send` 供跨线程调度（clippy 建议）。
pub trait LlmClient {
    /// 发起一次补全。`on_delta` 在收到文本增量时同步回调（转发流式事件用）。
    fn chat(
        &self,
        messages: Vec<ChatMessage>,
        tools: &[ToolSpec],
        on_delta: &(dyn Fn(&str) + Send + Sync),
    ) -> impl std::future::Future<Output = Result<Reply, CoreError>> + Send;

    /// 连通性测试（设置页「测试连接」）：发一条极小请求，返回模型回复片段。
    fn test_connection(
        &self,
    ) -> impl std::future::Future<Output = Result<String, CoreError>> + Send;
}

/// OpenAI 兼容端点客户端。
pub struct OpenAiClient {
    http: crate::weather::HttpClient,
    cfg: AiConfig,
}

impl OpenAiClient {
    pub fn new(cfg: &AiConfig) -> Self {
        Self {
            // 连接/读取分级超时：整体不设限，避免长流式被截断。
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            cfg: cfg.normalized(),
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.cfg.base_url)
    }

    /// HTTP 状态码 → 可读错误（鉴权/额度/限流给中文指引）。
    fn http_error(status: reqwest::StatusCode, body: &str) -> CoreError {
        let brief: String = body.chars().take(300).collect();
        match status.as_u16() {
            401 => CoreError::Network(format!("API Key 无效或未授权（401）：{brief}")),
            402 | 429 => CoreError::Network(format!("额度不足或请求过频（{status}）：{brief}")),
            404 => CoreError::Network(
                "端点不存在（404）：请检查 base_url 是否形如 https://api.deepseek.com/v1"
                    .to_string(),
            ),
            _ => CoreError::Network(format!("模型服务错误（{status}）：{brief}")),
        }
    }
}

impl OpenAiClient {
    /// chat 实现体（trait 方法包装以显式 Send，见 trait 注释）。
    async fn chat_inner(
        &self,
        messages: Vec<ChatMessage>,
        tools: &[ToolSpec],
        on_delta: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<Reply, CoreError> {
        let tools_json: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();

        let body = json!({
            "model": self.cfg.model,
            "messages": messages,
            "tools": tools_json,
            "stream": true,
        });

        let resp = self
            .http
            .post(self.endpoint())
            .bearer_auth(&self.cfg.api_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Self::http_error(status, &text));
        }

        // —— SSE 解析：按行取 `data: {...}`，累积 content 增量与 tool_calls 分片 ——
        // 字节缓冲经 SseLineBuf（只在完整行上解码，避免多字节字符跨 TCP 分块被切开
        // 后逐块 lossy 产生 U+FFFD，见其注释）。
        let mut stream = resp.bytes_stream();
        let mut sse = SseLineBuf::default();
        let mut reply = Reply::default();
        // tool_calls 按 index 分片累积（id/name 首片到达，arguments 跨片拼接）。
        let mut acc: Vec<(usize, String, String, String)> = vec![]; // (index, id, name, args)

        let mut done = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            sse.push(&chunk);
            for line in sse.pop_lines() {
                if process_sse_line(&line, &mut reply, &mut acc, on_delta) {
                    done = true;
                    break;
                }
            }
            if done {
                return Ok(reply_with_calls(reply, acc));
            }
        }
        // 流结束：无换行结尾的残行也处理（部分服务末行不带 \n）；
        // 未发 [DONE] 即截断时尽力返回已累积内容。
        if let Some(line) = sse.finish() {
            process_sse_line(&line, &mut reply, &mut acc, on_delta);
        }
        Ok(reply_with_calls(reply, acc))
    }

    /// 连通性测试实现体。
    async fn test_connection_inner(&self) -> Result<String, CoreError> {
        let body = json!({
            "model": self.cfg.model,
            "messages": [ChatMessage::user("回复：OK")],
            "max_tokens": 8,
            "stream": false,
        });
        let resp = self
            .http
            .post(self.endpoint())
            .bearer_auth(&self.cfg.api_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Self::http_error(status, &text));
        }
        let v: Value = resp.json().await?;
        Ok(v.pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim()
            .to_string())
    }

    /// 拉取模型列表（设置页「获取模型列表」）：GET `/models`，返回模型 id 列表。
    /// OpenAI 兼容端点通用（DeepSeek/Ollama/OpenAI 均支持）；失败返回可读错误。
    pub async fn list_models(&self) -> Result<Vec<String>, CoreError> {
        let url = format!("{}/models", self.cfg.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.cfg.api_key)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Self::http_error(status, &text));
        }
        let v: Value = resp.json().await?;
        let mut out = Vec::new();
        if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
            for m in data {
                if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                    out.push(id.to_string());
                }
            }
        }
        Ok(out)
    }
}

impl LlmClient for OpenAiClient {
    fn chat(
        &self,
        messages: Vec<ChatMessage>,
        tools: &[ToolSpec],
        on_delta: &(dyn Fn(&str) + Send + Sync),
    ) -> impl std::future::Future<Output = Result<Reply, CoreError>> + Send {
        self.chat_inner(messages, tools, on_delta)
    }

    fn test_connection(
        &self,
    ) -> impl std::future::Future<Output = Result<String, CoreError>> + Send {
        self.test_connection_inner()
    }
}

/// SSE 单行处理：提取 `data:` 载荷，累积 content/tool_calls。
/// 返回 true = 收到 `[DONE]`（调用方应结束流循环）。
fn process_sse_line(
    line: &str,
    reply: &mut Reply,
    acc: &mut Vec<(usize, String, String, String)>,
    on_delta: &(dyn Fn(&str) + Send + Sync),
) -> bool {
    let Some(data) = line.strip_prefix("data:") else {
        return false; // 忽略注释行（`: keep-alive`）与空行
    };
    let data = data.trim();
    if data == "[DONE]" {
        return true;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return false; // 容忍非 JSON 片段
    };
    let Some(delta) = v.pointer("/choices/0/delta").and_then(|d| d.as_object()) else {
        return false;
    };
    if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
        if !text.is_empty() {
            reply.content.push_str(text);
            on_delta(text);
        }
    }
    if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            let id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let name = tc
                .pointer("/function/name")
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let args = tc
                .pointer("/function/arguments")
                .and_then(|a| a.as_str())
                .unwrap_or("");
            match acc.iter_mut().find(|(i, _, _, _)| *i == idx) {
                Some(slot) => {
                    if !id.is_empty() {
                        slot.1 = id.to_string();
                    }
                    if !name.is_empty() {
                        slot.2 = name.to_string();
                    }
                    slot.3.push_str(args);
                }
                None => acc.push((idx, id.to_string(), name.to_string(), args.to_string())),
            }
        }
    }
    false
}

/// 把分片累积的 (index, id, name, args) 收尾为协议 tool_calls（按 index 排序）。
fn reply_with_calls(mut reply: Reply, acc: Vec<(usize, String, String, String)>) -> Reply {
    let mut acc = acc;
    acc.sort_by_key(|(i, _, _, _)| *i);
    reply.tool_calls = acc
        .into_iter()
        .map(|(_, id, name, args)| ToolCallMsg {
            id,
            call_type: "function".into(),
            function: FunctionCallMsg {
                name,
                arguments: args,
            },
        })
        .collect();
    reply
}

/// SSE 字节流 → 行提取。
///
/// TCP 分块边界可能落在任意字节上（含多字节 UTF-8 字符内部）：
/// 逐 chunk lossy 解码会把被切开的 CJK/emoji 变成 U+FFFD（用户可见症状：
/// 「还���要」）。因此字节只进 `Vec<u8>` 缓冲，仅在完整行上解码。
#[derive(Default)]
struct SseLineBuf {
    buf: Vec<u8>,
}

impl SseLineBuf {
    fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// 弹出所有以 `\n` 结尾的完整行（`\r` 剥离）；残行留在缓冲里。
    fn pop_lines(&mut self) -> Vec<String> {
        let mut out = vec![];
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            out.push(line.trim_end_matches('\r').to_string());
        }
        out
    }

    /// 流结束：残行（可能无换行结尾）也吐出。
    fn finish(self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let line = String::from_utf8_lossy(&self.buf);
        Some(line.trim_end_matches('\r').to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_config_normalize_and_complete() {
        let cfg = AiConfig {
            name: " DeepSeek ".into(),
            base_url: " https://api.deepseek.com/v1/ ".into(),
            api_key: " sk-x ".into(),
            model: " deepseek-chat ".into(),
        };
        let n = cfg.normalized();
        assert_eq!(n.name, "DeepSeek");
        assert_eq!(n.base_url, "https://api.deepseek.com/v1");
        assert_eq!(n.api_key, "sk-x");
        assert_eq!(n.model, "deepseek-chat");
        assert!(n.is_complete());
        assert!(!AiConfig::default().is_complete());
    }

    #[test]
    fn chat_message_serialization_matches_openai() {
        // assistant + tool_calls
        let m = ChatMessage::assistant_tool_calls(vec![ToolCallMsg {
            id: "call_1".into(),
            call_type: "function".into(),
            function: FunctionCallMsg {
                name: "create_event".into(),
                arguments: r#"{"title":"周会"}"#.into(),
            },
        }]);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["tool_calls"][0]["function"]["name"], "create_event");
        assert!(v.get("content").is_none() || v["content"].is_null());

        // tool 行
        let t = ChatMessage::tool("call_1", r#"{"ok":true}"#);
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["role"], "tool");
        assert_eq!(v["tool_call_id"], "call_1");
        assert_eq!(v["content"], r#"{"ok":true}"#);
    }

    /// 回归：多字节 UTF-8 字符被 TCP 分块切开时，行重组不得产生 U+FFFD
    /// （用户症状：「还���要」）。字节块故意在 CJK 字符内部切开。
    #[test]
    fn sse_line_buf_survives_multibyte_char_split_across_chunks() {
        let events = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"还要再安排\"}}]}\n\n",
            "data: [DONE]\n",
        );
        let bytes = events.as_bytes();
        // 精确定位「安」的首字节位置，在其内部（+1 字节）切开。
        let anchor = events.find("安").expect("测试事件串含「安」");
        let split = anchor + 1;
        assert!(split < bytes.len());

        let mut sse = SseLineBuf::default();
        sse.push(&bytes[..split]);
        // 残行不得提前吐出（边界安全）。
        assert!(sse.pop_lines().is_empty(), "切开处不在行尾，不应产出完整行");
        sse.push(&bytes[split..]);

        let lines = sse.pop_lines();
        assert_eq!(
            lines,
            vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"还要再安排\"}}]}".to_string(),
                "".to_string(),
                "data: [DONE]".to_string(),
            ]
        );
        // 核心断言：重组结果零 U+FFFD，且内容与原始事件串逐字节一致。
        assert!(!lines.iter().any(|l| l.contains('\u{FFFD}')));
    }

    /// 回归：流结束时无换行结尾的残行也应被吐出（finish 语义）。
    #[test]
    fn sse_line_buf_finish_flushes_trailing_line_without_newline() {
        let mut sse = SseLineBuf::default();
        sse.push(b"data: [DONE]"); // 无尾换行
        assert!(sse.pop_lines().is_empty());
        assert_eq!(sse.finish(), Some("data: [DONE]".to_string()));
    }
}
