//! 对话循环：LLM → tool_calls → 执行（service 落库）→ 回填 → …，步数硬上限。
//!
//! 事件协议与持久化：
//! - 每轮以 [`AgentEvent::Start`] 开始、[`AgentEvent::End`] 恰好一次收尾（含错误/中断路径）；
//! - user/assistant/tool 行均落 `agent_messages`（UI 历史回看用）；
//! - LLM 上下文重建只取 user/assistant 行（跳过 tool 行）：assistant 收尾文本通常已
//!   复述工具结果，扁平存储无法还原协议要求的 tool_call_id 配对（design §6 注记）。

use crate::agent::events::{AgentEvent, EndReason};
use crate::agent::llm::{ChatMessage, LlmClient, ToolCallMsg};
use crate::agent::mcp::{self, McpServerConfig, McpToolInfo};
use crate::agent::skills::{skills_prompt, SkillDef};
use crate::agent::tools::{self, PermissionMode};
use crate::error::CoreError;
use crate::model::now_iso;
use crate::storage::{AgentMessage, SqliteStorage};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};

/// 循环步数硬上限（防发散）。
pub const MAX_STEPS: usize = 8;
/// 送入 LLM 的历史消息条数上限（截断防 token 膨胀）。
pub const HISTORY_LIMIT: usize = 40;

/// 一轮对话的外部增强（Skills + MCP 工具 + 审批模式）。
/// - `skills`：启用的技能，其 prompt 追加到系统提示词；
/// - `mcp`：已解析工具的启用服务器列表（发送前由 src-tauri 拉取 tools/list）；
/// - `permission`：工具审批模式（Auto=全免，默认）。
#[derive(Default)]
pub struct TurnExtras {
    pub skills: Vec<SkillDef>,
    pub mcp: Vec<(McpServerConfig, Vec<McpToolInfo>)>,
    pub permission: PermissionMode,
}

impl TurnExtras {
    /// 全部 MCP 工具的 LLM 规格（name 已为 `mcp__…` 注册名）。
    fn mcp_specs(&self) -> Vec<crate::agent::llm::ToolSpec> {
        self.mcp
            .iter()
            .flat_map(|(_, tools)| tools.iter().map(|t| t.spec.clone()))
            .collect()
    }

    /// 按 tool_id 找回所属服务器配置。
    fn server_of(&self, tool_id: &str) -> Option<&McpServerConfig> {
        self.mcp
            .iter()
            .find(|(_, tools)| tools.iter().any(|t| t.tool_id == tool_id))
            .map(|(cfg, _)| cfg)
    }
}

/// 审批闸门：审批模式下工具执行前请求人工批准（返回 false=拒绝/中止）。
/// 由调用方注入（src-tauri 用 oneshot 通道接 Tauri 事件；单测用恒定实现）。
pub trait ApprovalGate: Send + Sync {
    fn request(
        &self,
        call_id: &str,
        tool: &str,
        args: &Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>>;
}

/// 免审批闸门（恒放行；Auto 模式/旧调用方使用）。
#[derive(Default)]
pub struct AutoApprove;

impl ApprovalGate for AutoApprove {
    fn request(
        &self,
        _call_id: &str,
        _tool: &str,
        _args: &Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        Box::pin(async { true })
    }
}

/// 驱动一轮对话：落 user 消息 → 循环调 LLM/工具 → 落 assistant 消息。
///
/// `on_event` 同步回调（src-tauri 转发 Tauri 事件）；`abort` 由外部命令置位，
/// 在每个 LLM 步与每个工具执行前检查——中断时已落库的操作保留（卡片可撤销）。
///
/// 返回 `Err` 仅表示持久化故障等严重错误（此时 End{error} 也已发出）。
pub async fn run_turn<C: LlmClient>(
    db: &SqliteStorage,
    client: &C,
    session_id: &str,
    user_text: &str,
    turn_id: &str,
    on_event: &(dyn Fn(AgentEvent) + Send + Sync),
    abort: &AtomicBool,
) -> Result<(), CoreError> {
    run_turn_with(
        db,
        client,
        session_id,
        user_text,
        turn_id,
        on_event,
        abort,
        &TurnExtras::default(),
        &AutoApprove,
    )
    .await
}

/// [`run_turn`] 的增强版：附加 Skills 提示词、MCP 外部工具与审批闸门。
#[allow(clippy::too_many_arguments)] // 与 run_turn 同构 + extras + gate，签名即文档
pub async fn run_turn_with<C: LlmClient>(
    db: &SqliteStorage,
    client: &C,
    session_id: &str,
    user_text: &str,
    turn_id: &str,
    on_event: &(dyn Fn(AgentEvent) + Send + Sync),
    abort: &AtomicBool,
    extras: &TurnExtras,
    gate: &dyn ApprovalGate,
) -> Result<(), CoreError> {
    on_event(AgentEvent::Start {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
    });

    let finish = |reason, error| -> Result<(), CoreError> {
        on_event(AgentEvent::End {
            turn_id: turn_id.to_string(),
            reason,
            error,
        });
        Ok(())
    };

    // 1) user 消息落库并进入上下文。
    db.append_agent_message(&AgentMessage {
        id: String::new(),
        session_id: session_id.to_string(),
        role: "user".into(),
        content: user_text.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        created_at: now_iso(),
    })?;

    let mut messages = build_context(db, session_id, extras)?;
    let mut specs = tools::specs();
    specs.extend(extras.mcp_specs());

    // 2) 主循环。
    for _ in 0..MAX_STEPS {
        if abort.load(Ordering::Relaxed) {
            return finish(EndReason::Aborted, None);
        }
        let reply = match client
            .chat(messages.clone(), &specs, &|text| {
                on_event(AgentEvent::Delta {
                    turn_id: turn_id.to_string(),
                    text: text.to_string(),
                });
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = e.to_string();
                persist_text(db, session_id, &format!("（出错了：{msg}）"))?;
                return finish(EndReason::Error, Some(msg));
            }
        };

        // 纯文本收尾：落库 + 结束。
        if reply.tool_calls.is_empty() {
            let text = reply.content.trim().to_string();
            persist_text(db, session_id, &text)?;
            return finish(EndReason::Done, None);
        }

        // 工具调用：assistant(tool_calls) 进上下文 → 逐个（审批→）执行 → tool 结果回填。
        messages.push(ChatMessage::assistant_tool_calls(reply.tool_calls.clone()));
        for tc in &reply.tool_calls {
            if abort.load(Ordering::Relaxed) {
                return finish(EndReason::Aborted, None);
            }
            let args: Value =
                serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}));
            // 审批模式：需批准的工具先弹人工确认，拒绝则回填错误结果（回合继续）。
            let approved = if tools::requires_approval(extras.permission, &tc.function.name) {
                on_event(AgentEvent::ApprovalRequired {
                    turn_id: turn_id.to_string(),
                    call_id: tc.id.clone(),
                    tool: tc.function.name.clone(),
                    args: args.clone(),
                });
                gate.request(&tc.id, &tc.function.name, &args).await
            } else {
                true
            };
            let (event, tool_msg) = if approved {
                exec_tool(db, session_id, turn_id, tc, &args, extras).await
            } else {
                rejected_tool(session_id, turn_id, tc, &args)
            };
            if let Err(e) = db.append_agent_message(&tool_msg) {
                return finish(EndReason::Error, Some(e.to_string()));
            }
            // 先落库后发事件：前端看到卡片时历史已可回放。
            on_event(event);
            messages.push(ChatMessage::tool(
                tc.id.clone(),
                tool_msg.tool_result.unwrap_or_else(|| "{}".into()),
            ));
        }
    }

    let msg = format!("达到单轮工具调用步数上限（{MAX_STEPS}），已停止。");
    persist_text(db, session_id, &msg)?;
    finish(EndReason::Error, Some(msg))
}

/// 执行单个工具调用（args 已解析）：`mcp__` 前缀路由到对应 MCP 服务器（HTTP）；
/// 其余走内置注册表。失败也转 JSON 回填模型（不中断回合）。
/// 返回 (Tool 事件, 持久化行)；事件由调用方在落库成功后发射。
async fn exec_tool(
    db: &SqliteStorage,
    session_id: &str,
    turn_id: &str,
    tc: &ToolCallMsg,
    args: &Value,
    extras: &TurnExtras,
) -> (AgentEvent, AgentMessage) {
    let name = tc.function.name.as_str();
    let (ok, result) = if name.starts_with("mcp__") {
        match extras.server_of(name) {
            Some(cfg) => match mcp::parse_tool_id(name) {
                Some((_, original)) => match mcp::call_tool(cfg, &original, args).await {
                    Ok(v) => (
                        true,
                        json!({"ok": true, "server": cfg.name, "tool": original, "result": v}),
                    ),
                    Err(e) => (false, json!({"ok": false, "error": e})),
                },
                None => (
                    false,
                    json!({"ok": false, "error": format!("非法 MCP 工具名：{name}")}),
                ),
            },
            None => (
                false,
                json!({"ok": false, "error": format!("MCP 工具 {name} 不在当前启用服务器中")}),
            ),
        }
    } else {
        match tools::dispatch(db, name, args) {
            Ok(v) => (true, v),
            Err(e) => (false, json!({ "ok": false, "error": e.to_string() })),
        }
    };
    let event = AgentEvent::Tool {
        turn_id: turn_id.to_string(),
        tool: tc.function.name.clone(),
        args: args.clone(),
        ok,
        result: result.clone(),
    };
    let row = AgentMessage {
        id: String::new(),
        session_id: session_id.to_string(),
        role: "tool".into(),
        content: String::new(),
        tool_name: Some(tc.function.name.clone()),
        tool_args: Some(tc.function.arguments.clone()),
        tool_result: Some(result.to_string()),
        created_at: now_iso(),
    };
    (event, row)
}

/// 用户拒绝审批的工具调用：回填 ok:false 结果（模型可见、可换方案），同样落库发卡片。
fn rejected_tool(
    session_id: &str,
    turn_id: &str,
    tc: &ToolCallMsg,
    args: &Value,
) -> (AgentEvent, AgentMessage) {
    let result = json!({ "ok": false, "error": "用户拒绝了本次工具调用" });
    let event = AgentEvent::Tool {
        turn_id: turn_id.to_string(),
        tool: tc.function.name.clone(),
        args: args.clone(),
        ok: false,
        result: result.clone(),
    };
    let row = AgentMessage {
        id: String::new(),
        session_id: session_id.to_string(),
        role: "tool".into(),
        content: String::new(),
        tool_name: Some(tc.function.name.clone()),
        tool_args: Some(tc.function.arguments.clone()),
        tool_result: Some(result.to_string()),
        created_at: now_iso(),
    };
    (event, row)
}

/// 重建 LLM 上下文：system（含当前时间 + 启用技能）+ 历史 user/assistant 行（跳过 tool 行）。
fn build_context(
    db: &SqliteStorage,
    session_id: &str,
    extras: &TurnExtras,
) -> Result<Vec<ChatMessage>, CoreError> {
    let history = db.list_agent_messages(session_id)?;
    let mut msgs = vec![ChatMessage::system(system_prompt(
        skills_prompt(&extras.skills).as_deref(),
    ))];
    for row in history.iter().rev().take(HISTORY_LIMIT).rev() {
        let m = match row.role.as_str() {
            "user" => ChatMessage::user(&row.content),
            "assistant" if !row.content.trim().is_empty() => ChatMessage::assistant(&row.content),
            _ => continue, // tool 行：见模块注释
        };
        msgs.push(m);
    }
    Ok(msgs)
}

/// 系统提示词：注入当前本地日期/时间/星期（相对日期解析的锚点）+ 工具守则 + 启用技能。
fn system_prompt(skills: Option<&str>) -> String {
    let now = chrono::Local::now();
    let wd = ["一", "二", "三", "四", "五", "六", "日"]
        [now.format("%u").to_string().parse::<usize>().unwrap_or(1) - 1];
    let mut p = format!(
        "你是 MOSH（本地个人信息管理应用）的内置助手，帮用户管理待办与日程。\n\
         当前本地时间：{}（星期{}，时区 {}）。\n\n\
         规则：\n\
         1. 解析「明天/下周五/明早」等相对日期时，以上面的当前时间为锚点换算成具体日期。\n\
         2. 创建/修改成功后，用一两句话向用户复述结果（标题与时间）。\n\
         3. 调用工具时用经过校验的参数：id 只能来自工具结果，不要编造。\n\
         4. 查询类请求先调 list_todos / list_events，再基于结果回答，不要臆造数据。\n\
         5. 修改已有日程用 update_event（只需传要改的字段）；删除日程用 delete_event（单条）或 delete_events（批量）：id 必须来自 list_events 或创建结果，删除前先查询确认目标，删除后向用户复述删了什么；不确定时先列出候选向用户确认再删。\n\
         6. 周期事件可用 recurrence（daily/weekly/monthly/yearly）；提醒用 reminder_minutes（提前分钟数）。\n\
         7. 用户意图不清（如缺时间、标题不明）时，先追问再创建。",
        now.format("%Y-%m-%d %H:%M"),
        wd,
        now.format("%:z"),
    );
    if let Some(s) = skills {
        p.push_str(s);
    }
    p
}

fn persist_text(db: &SqliteStorage, session_id: &str, content: &str) -> Result<(), CoreError> {
    db.append_agent_message(&AgentMessage {
        id: String::new(),
        session_id: session_id.to_string(),
        role: "assistant".into(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        created_at: now_iso(),
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::llm::Reply;
    use crate::service;
    use serde_json::json;
    use std::sync::Mutex;

    /// mock 客户端：按脚本依次返回预设 Reply；记录收到的消息数与工具数。
    struct MockLlm {
        script: Mutex<Vec<Reply>>,
        saw_tool_results: Mutex<Vec<String>>,
    }

    impl MockLlm {
        fn new(script: Vec<Reply>) -> Self {
            Self {
                script: Mutex::new(script),
                saw_tool_results: Mutex::new(vec![]),
            }
        }
    }

    impl LlmClient for MockLlm {
        async fn chat(
            &self,
            messages: Vec<ChatMessage>,
            _tools: &[crate::agent::llm::ToolSpec],
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<Reply, CoreError> {
            // 记录最后一条 tool 消息内容（校验回填）。
            if let Some(last) = messages.last() {
                if last.role == "tool" {
                    self.saw_tool_results
                        .lock()
                        .unwrap()
                        .push(last.content.clone().unwrap_or_default());
                }
            }
            let reply = self.script.lock().unwrap().pop().unwrap_or_default();
            if !reply.content.is_empty() {
                on_delta(&reply.content);
            }
            Ok(reply)
        }

        async fn test_connection(&self) -> Result<String, CoreError> {
            Ok("OK".into())
        }
    }

    fn tc(id: &str, name: &str, args: Value) -> ToolCallMsg {
        ToolCallMsg {
            id: id.into(),
            call_type: "function".into(),
            function: crate::agent::llm::FunctionCallMsg {
                name: name.into(),
                arguments: args.to_string(),
            },
        }
    }

    fn collector() -> (std::sync::Arc<Mutex<Vec<String>>>, impl Fn(AgentEvent)) {
        let log = std::sync::Arc::new(Mutex::new(Vec::new()));
        let l2 = log.clone();
        let f = move |e: AgentEvent| {
            let tag = match &e {
                AgentEvent::Start { .. } => "start".to_string(),
                AgentEvent::Delta { text, .. } => format!("delta:{text}"),
                AgentEvent::Tool { tool, ok, .. } => format!("tool:{tool}:ok={ok}"),
                AgentEvent::ApprovalRequired { tool, .. } => format!("approval:{tool}"),
                AgentEvent::End { reason, .. } => format!("end:{:?}", reason),
            };
            l2.lock().unwrap().push(tag);
        };
        (log, f)
    }

    #[tokio::test]
    async fn plain_reply_persists_and_ends_done() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let mock = MockLlm::new(vec![Reply {
            content: "你好，我能帮你安排待办与日程。".into(),
            tool_calls: vec![],
        }]);
        let (log, on_event) = collector();
        run_turn(
            &db,
            &mock,
            "s1",
            "你好",
            "t1",
            &on_event,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        let log = log.lock().unwrap();
        assert_eq!(log.first().unwrap(), "start");
        assert_eq!(log.last().unwrap(), "end:Done");
        // user + assistant 两行。
        let msgs = db.list_agent_messages("s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].role, "assistant");
    }

    #[tokio::test]
    async fn tool_call_creates_and_feeds_back() {
        let db = SqliteStorage::open_in_memory().unwrap();
        // 脚本按 pop 顺序：最后 push 的是第一次 chat 返回。
        let mock = MockLlm::new(vec![
            Reply {
                content: "已创建待办「交季度报告」。".into(),
                tool_calls: vec![],
            },
            Reply {
                content: String::new(),
                tool_calls: vec![tc(
                    "c1",
                    "create_todo",
                    json!({"title": "交季度报告", "priority": "high"}),
                )],
            },
        ]);
        let (log, on_event) = collector();
        run_turn(
            &db,
            &mock,
            "s1",
            "建个待办：交季度报告",
            "t1",
            &on_event,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();

        let log = log.lock().unwrap();
        assert!(log.contains(&"tool:create_todo:ok=true".to_string()));
        assert_eq!(log.last().unwrap(), "end:Done");
        drop(log);

        // 工具结果回填给模型（含 ok:true 与新记录 id）。
        let saw = mock.saw_tool_results.lock().unwrap()[0].clone();
        let v: serde_json::Value = serde_json::from_str(&saw).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["kind"], "todo");
        assert_eq!(v["title"], "交季度报告");
        assert!(v["id"].as_str().unwrap().len() > 10);
        // 记录真实落库。
        let todos = service::list_todos(&db, Default::default()).unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].title, "交季度报告");
        // 持久化行：user + tool + assistant = 3。
        let msgs = db.list_agent_messages("s1").unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1].role, "tool");
    }

    #[tokio::test]
    async fn tool_failure_feeds_error_not_abort() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let mock = MockLlm::new(vec![
            Reply {
                content: "没找到这条待办。".into(),
                tool_calls: vec![],
            },
            Reply {
                content: String::new(),
                tool_calls: vec![tc(
                    "c1",
                    "set_todo_status",
                    json!({"id": "ghost", "status": "done"}),
                )],
            },
        ]);
        let (log, on_event) = collector();
        run_turn(
            &db,
            &mock,
            "s1",
            "完成那条",
            "t1",
            &on_event,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        // 失败转 ok:false 回填，回合照常 Done。
        let log = log.lock().unwrap();
        assert!(log.contains(&"tool:set_todo_status:ok=false".to_string()));
        assert_eq!(log.last().unwrap(), "end:Done");
    }

    #[tokio::test]
    async fn abort_stops_before_first_step() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let mock = MockLlm::new(vec![]);
        let (log, on_event) = collector();
        let abort = AtomicBool::new(true);
        run_turn(&db, &mock, "s1", "算了", "t1", &on_event, &abort)
            .await
            .unwrap();
        let log = log.lock().unwrap();
        assert_eq!(log.last().unwrap(), "end:Aborted");
    }

    #[tokio::test]
    async fn step_limit_ends_error() {
        let db = SqliteStorage::open_in_memory().unwrap();
        // 每步都要求工具调用 → 触发上限。
        let endless = Reply {
            content: String::new(),
            tool_calls: vec![tc("cx", "list_todos", json!({}))],
        };
        let mock = MockLlm::new(vec![endless; MAX_STEPS + 2]);
        let (log, on_event) = collector();
        run_turn(
            &db,
            &mock,
            "s1",
            "刷",
            "t1",
            &on_event,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        let log = log.lock().unwrap();
        assert!(log.last().unwrap().starts_with("end:Error"));
        let tool_count = log.iter().filter(|l| l.starts_with("tool:")).count();
        assert_eq!(tool_count, MAX_STEPS);
    }

    #[tokio::test]
    async fn system_prompt_contains_datetime() {
        let p = system_prompt(None);
        assert!(p.contains("当前本地时间"));
        assert!(p.contains("星期"));
        assert!(p.contains("时区"));
    }

    #[test]
    fn build_context_skips_tool_rows() {
        let db = SqliteStorage::open_in_memory().unwrap();
        for (role, content) in [("user", "q1"), ("tool", "{}"), ("assistant", "a1")] {
            db.append_agent_message(&AgentMessage {
                id: String::new(),
                session_id: "s".into(),
                role: role.into(),
                content: content.into(),
                tool_name: None,
                tool_args: None,
                tool_result: None,
                created_at: now_iso(),
            })
            .unwrap();
        }
        let ctx = build_context(&db, "s", &TurnExtras::default()).unwrap();
        assert_eq!(ctx.len(), 3); // system + user + assistant
        assert_eq!(ctx[0].role, "system");
        assert_eq!(ctx[1].content.as_deref(), Some("q1"));
        assert_eq!(ctx[2].content.as_deref(), Some("a1"));
    }

    #[test]
    fn build_context_appends_skills_prompt() {
        let db = SqliteStorage::open_in_memory().unwrap();
        let extras = TurnExtras {
            skills: vec![crate::agent::skills::SkillDef {
                id: "planner".into(),
                name: "日程规划师".into(),
                description: String::new(),
                prompt: "拆解目标并落成日程".into(),
                builtin: true,
            }],
            mcp: vec![],
            ..Default::default()
        };
        let ctx = build_context(&db, "s", &extras).unwrap();
        let sys = ctx[0].content.as_deref().unwrap();
        assert!(sys.contains("技能已启用"));
        assert!(sys.contains("日程规划师"));
        assert!(sys.contains("拆解目标并落成日程"));
        // 无技能时不追加。
        let plain = build_context(&db, "s", &TurnExtras::default()).unwrap();
        assert!(!plain[0].content.as_deref().unwrap().contains("技能已启用"));
    }

    #[test]
    fn turn_extras_mcp_specs_and_lookup() {
        let cfg = mcp::McpServerConfig {
            id: "srv".into(),
            name: "演示".into(),
            url: "http://x/mcp".into(),
            token: None,
            enabled: true,
        };
        let infos = mcp::to_tool_infos(&cfg, &[json!({"name": "search", "description": "搜索"})]);
        let extras = TurnExtras {
            skills: vec![],
            mcp: vec![(cfg, infos)],
            ..Default::default()
        };
        let specs = extras.mcp_specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "mcp__srv__search");
        assert!(extras.server_of("mcp__srv__search").is_some());
        assert!(extras.server_of("mcp__other__search").is_none());
    }

    #[tokio::test]
    async fn mcp_tool_not_in_servers_feeds_error() {
        // 模型调用未启用的 MCP 工具 → ok:false 回填（不中断回合）。
        let db = SqliteStorage::open_in_memory().unwrap();
        let mock = MockLlm::new(vec![
            Reply {
                content: "该外部工具不可用。".into(),
                tool_calls: vec![],
            },
            Reply {
                content: String::new(),
                tool_calls: vec![tc("c1", "mcp__ghost__search", json!({"q": "x"}))],
            },
        ]);
        let (log, on_event) = collector();
        run_turn_with(
            &db,
            &mock,
            "s1",
            "搜一下",
            "t1",
            &on_event,
            &AtomicBool::new(false),
            &TurnExtras::default(),
            &AutoApprove,
        )
        .await
        .unwrap();
        let log = log.lock().unwrap();
        assert!(log.contains(&"tool:mcp__ghost__search:ok=false".to_string()));
        assert_eq!(log.last().unwrap(), "end:Done");
    }

    /// 恒拒绝闸门（审批测试用）。
    struct DenyGate;

    impl crate::agent::ApprovalGate for DenyGate {
        fn request(
            &self,
            _c: &str,
            _t: &str,
            _a: &Value,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            Box::pin(async { false })
        }
    }

    #[tokio::test]
    async fn approval_denied_feeds_error_and_skips_exec() {
        // 全部审批模式下拒绝 create_todo：先发 ApprovalRequired，再回填 ok:false，
        // 工具不真实落库，回合照常 Done。
        let db = SqliteStorage::open_in_memory().unwrap();
        let mock = MockLlm::new(vec![
            Reply {
                content: "好的，已取消创建。".into(),
                tool_calls: vec![],
            },
            Reply {
                content: String::new(),
                tool_calls: vec![tc("c1", "create_todo", json!({"title": "x"}))],
            },
        ]);
        let (log, on_event) = collector();
        let extras = TurnExtras {
            permission: crate::agent::tools::PermissionMode::All,
            ..Default::default()
        };
        run_turn_with(
            &db,
            &mock,
            "s1",
            "建个待办",
            "t1",
            &on_event,
            &AtomicBool::new(false),
            &extras,
            &DenyGate,
        )
        .await
        .unwrap();
        let log = log.lock().unwrap();
        assert!(log.contains(&"approval:create_todo".to_string()));
        assert!(log.contains(&"tool:create_todo:ok=false".to_string()));
        assert_eq!(log.last().unwrap(), "end:Done");
        drop(log);
        // 拒绝 → 未真实创建。
        let todos = service::list_todos(&db, Default::default()).unwrap();
        assert!(todos.is_empty());
        // 拒绝结果回填给模型。
        let saw = mock.saw_tool_results.lock().unwrap()[0].clone();
        let v: Value = serde_json::from_str(&saw).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("拒绝"));
    }

    #[test]
    fn requires_approval_covers_modes() {
        use crate::agent::tools::{requires_approval, PermissionMode as M};
        // Auto：全部放行。
        assert!(!requires_approval(M::Auto, "delete_event"));
        // All：全部需批。
        assert!(requires_approval(M::All, "list_todos"));
        // Write：只读放行，写/删/MCP 需批。
        assert!(!requires_approval(M::Write, "list_todos"));
        assert!(!requires_approval(M::Write, "list_events"));
        assert!(requires_approval(M::Write, "create_todo"));
        assert!(requires_approval(M::Write, "update_event"));
        assert!(requires_approval(M::Write, "delete_event"));
        assert!(requires_approval(M::Write, "set_todo_status"));
        assert!(requires_approval(M::Write, "mcp__srv__search"));
    }

    #[tokio::test]
    async fn event_created_by_tools_is_json_value() {
        // 轻烟测：事件可序列化（src-tauri 直接透传）。
        let e = AgentEvent::Tool {
            turn_id: "t".into(),
            tool: "create_todo".into(),
            args: json!({"title": "x"}),
            ok: true,
            result: json!({"ok": true, "id": "1"}),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "tool");
        assert_eq!(v["tool"], "create_todo");
    }
}
