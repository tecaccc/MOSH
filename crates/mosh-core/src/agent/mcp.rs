//! MCP（Model Context Protocol）客户端 v1：Streamable HTTP 传输。
//!
//! 范围（对齐 cherry-studio 的外部工具思路，v1 取最小可用集）：
//! - 仅 HTTP JSON-RPC（`initialize` → `notifications/initialized` → `tools/list`
//!   / `tools/call`），覆盖绝大多数远程 MCP 服务与 `mcp-proxy` 暴露的本地服务；
//! - stdio 传输暂不支持（Tauri 侧后续可加 `mcp-proxy` 桥接）；
//! - 响应解析容忍 `text/event-stream`（SSE 单 data 帧回退）；
//! - 工具 id 规则：`mcp__{server_id}__{原始名}`，runner 按 `mcp__` 前缀路由回本模块。
//!
//! 本模块不持有长连接（Streamable HTTP 允许无状态调用）：每次调用独立 POST，
//! `initialize` 仅做握手探测（`list_tools` / `test` 用），`tools/call` 直发。

use crate::agent::llm::ToolSpec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// MCP 服务器配置（settings key=`ai_mcp_servers`，前端设置页 CRUD）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct McpServerConfig {
    /// 稳定 id（uuid）。
    pub id: String,
    pub name: String,
    /// JSON-RPC 端点（Streamable HTTP），如 `https://mcp.example.com/mcp`。
    pub url: String,
    /// 可选 Bearer Token（Authorization 头）。
    #[serde(default)]
    pub token: Option<String>,
    /// 总开关：关闭后不注入任何工具。
    #[serde(default)]
    pub enabled: bool,
}

/// 一台服务器解析出的一个 MCP 工具（含路由信息）。
#[derive(Debug, Clone)]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_name: String,
    /// 服务器上的原始工具名。
    pub original_name: String,
    /// LLM 侧注册名（`mcp__{server_id}__{original_name}`）。
    pub tool_id: String,
    /// OpenAI function 规格（name 已替换为 tool_id）。
    pub spec: ToolSpec,
}

/// MCP 工具的 LLM 侧注册名。
pub fn tool_id(server_id: &str, name: &str) -> String {
    format!("mcp__{server_id}__{name}")
}

/// 由注册名反解 `(server_id, 原始名)`；非 `mcp__` 前缀 → None。
pub fn parse_tool_id(tool_id_str: &str) -> Option<(String, String)> {
    let rest = tool_id_str.strip_prefix("mcp__")?;
    let (sid, name) = rest.split_once("__")?;
    if sid.is_empty() || name.is_empty() {
        return None;
    }
    Some((sid.to_string(), name.to_string()))
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))
}

fn auth_headers(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token.filter(|t| !t.trim().is_empty()) {
        Some(t) => req.header("Authorization", format!("Bearer {}", t.trim())),
        None => req,
    }
}

/// 解析 JSON-RPC 响应体：优先 JSON；SSE 文本则取首个 `data:` 帧。
fn parse_rpc_body(text: &str) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Ok(v);
    }
    // SSE 回退：`data: {...}`（取第一帧非空 data）。
    for line in text.lines() {
        let line = line.trim();
        if let Some(payload) = line.strip_prefix("data:") {
            let payload = payload.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(payload) {
                return Ok(v);
            }
        }
    }
    Err("响应既非 JSON 也非 SSE data 帧".into())
}

/// 发送一次 JSON-RPC 并取 `result`（错误时 `error.message` 上抛）。
async fn rpc(
    cfg: &McpServerConfig,
    method: &str,
    params: Value,
    id: i64,
    timeout: Duration,
) -> Result<Value, String> {
    let client = http_client(timeout)?;
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let resp = auth_headers(
        client
            .post(&cfg.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&body),
        cfg.token.as_deref(),
    )
    .send()
    .await
    .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}：{}", truncate(&text, 200)));
    }
    let v = parse_rpc_body(&text)?;
    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
        return Err(format!(
            "服务器返回错误：{}",
            err.get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("未知")
        ));
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| "响应缺 result 字段".into())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// 握手 + 列工具（设置页“测试连接”与发送前装载共用）。
/// 返回原始工具定义（`name` + `description` + `inputSchema`）。
pub async fn list_tools(cfg: &McpServerConfig) -> Result<Vec<Value>, String> {
    let init = rpc(
        cfg,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "mosh", "version": env!("CARGO_PKG_VERSION")}
        }),
        1,
        Duration::from_secs(10),
    )
    .await?;
    let _ = init; // 服务器信息仅探测用；无状态 HTTP 不必存 session id。
    let result = rpc(cfg, "tools/list", json!({}), 2, Duration::from_secs(10)).await?;
    let tools = result
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .ok_or("tools/list 结果缺 tools 数组")?;
    Ok(tools)
}

/// 把 `list_tools` 原始定义转为 LLM 侧工具信息（name 替换为 tool_id）。
pub fn to_tool_infos(cfg: &McpServerConfig, raw: &[Value]) -> Vec<McpToolInfo> {
    raw.iter()
        .filter_map(|t| {
            let original = t.get("name")?.as_str()?.to_string();
            if original.is_empty() {
                return None;
            }
            let description = t
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("MCP 外部工具")
                .to_string();
            let parameters = t
                .get("inputSchema")
                .cloned()
                .filter(|s| s.is_object())
                .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
            let tool_id = tool_id(&cfg.id, &original);
            Some(McpToolInfo {
                server_id: cfg.id.clone(),
                server_name: cfg.name.clone(),
                original_name: original,
                tool_id: tool_id.clone(),
                spec: ToolSpec {
                    name: tool_id,
                    description: format!("[{}/MCP] {}", cfg.name, description),
                    parameters,
                },
            })
        })
        .collect()
}

/// 调用一台服务器上的工具（`tools/call`）。内容块取首个 text 项。
pub async fn call_tool(cfg: &McpServerConfig, name: &str, args: &Value) -> Result<Value, String> {
    let result = rpc(
        cfg,
        "tools/call",
        json!({"name": name, "arguments": args}),
        3,
        Duration::from_secs(60),
    )
    .await?;
    let is_error = result
        .get("isError")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let text = mcp_result_text(&result);
    if is_error {
        return Err(format!(
            "工具执行失败：{}",
            text.unwrap_or_else(|| "(无输出)".to_string())
        ));
    }
    let parsed = text
        .as_deref()
        .and_then(|t| serde_json::from_str::<Value>(t).ok());
    Ok(parsed.unwrap_or(Value::String(text.unwrap_or_default())))
}

/// 从 `tools/call` 结果取首个 text 内容块。
fn mcp_result_text(result: &Value) -> Option<String> {
    result
        .get("content")?
        .as_array()?
        .iter()
        .find(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> McpServerConfig {
        McpServerConfig {
            id: "srv1".into(),
            name: "演示".into(),
            url: "http://localhost:9/mcp".into(),
            token: Some("tk".into()),
            enabled: true,
        }
    }

    #[test]
    fn tool_id_roundtrip() {
        let id = tool_id("srv1", "search");
        assert_eq!(id, "mcp__srv1__search");
        assert_eq!(parse_tool_id(&id), Some(("srv1".into(), "search".into())));
        assert_eq!(parse_tool_id("create_todo"), None);
        assert_eq!(parse_tool_id("mcp__srv1__"), None);
        assert_eq!(parse_tool_id("mcp____x"), None);
    }

    #[test]
    fn parse_rpc_body_json_and_sse() {
        let v = parse_rpc_body(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#).unwrap();
        assert_eq!(v["result"]["ok"], true);
        // SSE：取首个非空 data 帧。
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"n\":7}}\n\ndata: [DONE]";
        let v = parse_rpc_body(sse).unwrap();
        assert_eq!(v["result"]["n"], 7);
        assert!(parse_rpc_body("not json").is_err());
    }

    #[test]
    fn to_tool_infos_maps_and_filters() {
        let raw = vec![
            json!({"name": "search", "description": "搜索", "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}}),
            json!({"description": "缺 name 的脏数据"}),
            json!({"name": "no_schema"}),
        ];
        let infos = to_tool_infos(&cfg(), &raw);
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].tool_id, "mcp__srv1__search");
        assert_eq!(infos[0].spec.name, "mcp__srv1__search");
        assert!(infos[0].spec.description.contains("演示/MCP"));
        // 无 inputSchema → 空对象 schema。
        assert_eq!(
            infos[1].spec.parameters,
            json!({"type": "object", "properties": {}})
        );
    }

    #[test]
    fn mcp_result_text_takes_first_text_block() {
        let r = json!({"content": [
            {"type": "image", "data": "..."},
            {"type": "text", "text": "{\"ok\":true}"}
        ]});
        assert_eq!(mcp_result_text(&r).as_deref(), Some("{\"ok\":true}"));
        assert_eq!(mcp_result_text(&json!({"content": []})), None);
    }

    #[test]
    fn config_serde_defaults() {
        let j = r#"{"id":"a","name":"n","url":"http://x"}"#;
        let c: McpServerConfig = serde_json::from_str(j).unwrap();
        assert_eq!(c.token, None);
        assert!(!c.enabled);
    }
}
