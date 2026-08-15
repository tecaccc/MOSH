# Design — Agent 能力 v1

## 1. 架构总览

```
┌─────────────────────── Tauri 桌面应用 ───────────────────────┐
│ 前端 Svelte 5                                                     │
│  Sidebar(+助手) → ChatPanel.svelte（气泡/流式/工具卡片/输入框）     │
│  SettingsView +「AI 模型」卡片（base_url/key/model/测试连接）      │
│        │ invoke("agent_*")            ▲ listen("agent://*")      │
│ ───────┼──────────────────────────────┼─────────────────────── │
│ src-tauri 薄壳（async 命令 + event 转发，同 weather 模式）        │
│        │ 直调                                                       │
│ mosh-core::agent（新模块）                                         │
│  llm.rs      LlmClient trait + OpenAI 兼容实现（chat/completions,  │
│              tools, stream=true SSE）                             │
│  tools.rs    工具注册表：name + JSON Schema + handler（调 service） │
│  loop.rs     对话循环（步数≤8）：LLM → tool_calls → 执行 → 回填     │
│  session.rs  会话/消息存储（agent_messages 表，rusqlite 迁移 v2）   │
│  events.rs   事件 payload 类型（借鉴 GrenAgent 协议）              │
└──────────────────────────────────────────────────────────────────┘
```

边界铁律：领域逻辑全部在 mosh-core；src-tauri 只做命令绑定/State/event 转发；前端零 AI 协议知识。

## 2. 事件协议（Tauri events，借鉴 GrenAgent）

| event | payload | 时机 |
| --- | --- | --- |
| `agent://start` | `{session_id, turn_id}` | 一轮开始 |
| `agent://delta` | `{turn_id, text}` | 助手文本增量（SSE 透传） |
| `agent://tool` | `{turn_id, tool, args, result, record_id?}` | 工具执行完（卡片） |
| `agent://end` | `{turn_id, reason: "done"\|"error"\|"aborted", error?}` | 一轮结束 |
| `agent://abort` | `{turn_id}`（命令非事件） | 用户中断 |

## 3. 数据模型（SQLite 迁移 v2）

```sql
CREATE TABLE agent_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,           -- 分组键（会话）
  role        TEXT NOT NULL,           -- user | assistant | tool
  content     TEXT NOT NULL DEFAULT '',-- 文本（tool 行存 JSON 摘要）
  tool_name   TEXT,                    -- role=tool 时
  tool_args   TEXT,                    -- JSON
  tool_result TEXT,                    -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
```

模型配置（settings 表 KV，key=`ai_model`）：
`{"base_url":"https://api.deepseek.com/v1","api_key":"sk-…","model":"deepseek-chat"}`

## 4. LLM 客户端（llm.rs）

- `trait LlmClient { async fn chat(&self, messages, tools, tx: EventTx) -> Result<Reply> }`
- OpenAI 实现：`POST {base_url}/chat/completions`，`stream:true`，SSE 解析
  （reqwest 已有，加 `stream` feature）。
- `Reply = { content, tool_calls: Vec<{id,name,args_json}>, finish_reason }`。
- api_key 失效/额度（401/402/429）转可读错误文案。
- 单测用 mock 实现，不碰网络。

## 5. 工具注册表（tools.rs）——v2 动态化的插槽

```rust
pub struct ToolDef {
    pub name: &'static str,
    pub schema: serde_json::Value,      // OpenAI function parameters
    pub requires_confirm: bool,         // v1 全 false；v2 MCP 工具用
}
// registry: Vec<ToolDef> + dispatch(name, args) -> serde_json::Value（调 service::*）
```

v1 静态注册 6 工具（见 PRD）。`requires_confirm` 字段现在就埋，MCP（v2）外部工具设 true。

系统提示词注入：当前本地日期/星期/时间/时区 + 工具使用守则（创建成功须向用户复述结果）。

## 6. 对话循环（loop.rs）

```
user msg → 载入会话历史(截断最近40条) → loop (≤8步):
  LLM.chat(messages, tools)
  ├─ 有 tool_calls: 逐个 dispatch（service 层落库）→ emit agent://tool
  │   → tool 结果回填 messages → continue
  └─ 纯文本: emit agent://delta 流式 → break
abort: 每步检查 abort 标志（Mutex<bool>，命令可置位）；中断即停，已落库操作保留
       （卡片可撤销）。
```

## 7. IPC 命令（src-tauri）

- `agent_send(session_id, message)` → 驱动一轮循环（事件流回传）
- `agent_abort(session_id)`
- `list_agent_sessions()` / `list_agent_messages(session_id)` / `new_agent_session()`
- `get_ai_config()` / `set_ai_config(cfg)` / `test_ai_connection()`

## 8. 前端（Svelte 5）

- `Sidebar` 增「助手」项；`agent.svelte.ts` store（runes 函数导出模式，同 store.svelte.ts 铁律）。
- `ChatPanel.svelte`：消息列表（用户右/助手左气泡；工具卡片=名称+摘要+结果+撤销按钮，
  撤销=软删）；textarea 自适应高度；发送后流式追加；未配置模型 → 引导卡（setView("settings")）。
- `SettingsView` 增「AI 模型」卡片（三项输入 + 测试连接 + 结果行），样式对齐天气卡片。

## 9. 关键权衡（已裁决）

| 决策 | 选择 | 否决项 | 理由 |
| --- | --- | --- | --- |
| Agent 引擎 | 自建轻量循环（<1000行） | pi sidecar / lobe-editor | 单二进制纯净性；工具直连 service；可测试 |
| 写权限 | 6 安全工具自动执行 | 全自动 / 逐条确认 | 无 update/delete，撤销=软删，风险闭合 |
| 模型接入 | OpenAI 兼容单实现 | 每家一个 SDK | 云/Ollama 通吃，零锁定 |
| 会话存储 | v1 建表 | 内存态 | 历史是刚需，后补要迁数据 |
| Skills/MCP | v2 | v1 | 控制验收面；接口留 requires_confirm 插槽 |

## 10. 测试策略

- mosh-core：`LlmClient` mock 单测（tool_calls 分派/循环上限/abort 中断/参数校验重试）；
  service 层测试已有。
- 前端：`npm run check` + `npm run build`（改 .svelte.ts 以 build 为准，README 铁律）。
- 手工验收：PRD 四个自然语言样例 + 伪造错误 key 的失败路径。
