//! 对话循环：LLM → tool_calls → 执行（service 落库）→ 回填 → …，步数硬上限。
//!
//! 事件协议与持久化：
//! - 每轮以 [`AgentEvent::Start`] 开始、[`AgentEvent::End`] 恰好一次收尾（含错误/中断路径）；
//! - user/assistant/tool 行均落 `agent_messages`（UI 历史回看用）；
//! - LLM 上下文重建只取 user/assistant 行（跳过 tool 行）：assistant 收尾文本通常已
//!   复述工具结果，扁平存储无法还原协议要求的 tool_call_id 配对（design §6 注记）。

use crate::agent::events::{AgentEvent, EndReason};
use crate::agent::llm::{ChatMessage, LlmClient, ToolCallMsg};
use crate::agent::tools;
use crate::error::CoreError;
use crate::model::now_iso;
use crate::storage::{AgentMessage, SqliteStorage};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

/// 循环步数硬上限（防发散）。
pub const MAX_STEPS: usize = 8;
/// 送入 LLM 的历史消息条数上限（截断防 token 膨胀）。
pub const HISTORY_LIMIT: usize = 40;

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
        id: 0,
        session_id: session_id.to_string(),
        role: "user".into(),
        content: user_text.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        created_at: now_iso(),
    })?;

    let mut messages = build_context(db, session_id)?;
    let specs = tools::specs();

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

        // 工具调用：assistant(tool_calls) 进上下文 → 逐个执行 → tool 结果回填。
        messages.push(ChatMessage::assistant_tool_calls(reply.tool_calls.clone()));
        for tc in &reply.tool_calls {
            if abort.load(Ordering::Relaxed) {
                return finish(EndReason::Aborted, None);
            }
            let (event, tool_msg) = exec_tool(db, session_id, turn_id, tc);
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

/// 执行单个工具调用：参数解析 → dispatch → 结果 JSON（失败也转 JSON 回填模型）。
/// 返回 (Tool 事件, 持久化行)；事件由调用方在落库成功后发射。
fn exec_tool(
    db: &SqliteStorage,
    session_id: &str,
    turn_id: &str,
    tc: &ToolCallMsg,
) -> (AgentEvent, AgentMessage) {
    let args: Value = serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}));
    let (ok, result) = match tools::dispatch(db, &tc.function.name, &args) {
        Ok(v) => (true, v),
        Err(e) => (false, json!({ "ok": false, "error": e.to_string() })),
    };
    let event = AgentEvent::Tool {
        turn_id: turn_id.to_string(),
        tool: tc.function.name.clone(),
        args: args.clone(),
        ok,
        result: result.clone(),
    };
    let row = AgentMessage {
        id: 0,
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

/// 重建 LLM 上下文：system（含当前时间）+ 历史 user/assistant 行（跳过 tool 行）。
fn build_context(db: &SqliteStorage, session_id: &str) -> Result<Vec<ChatMessage>, CoreError> {
    let history = db.list_agent_messages(session_id)?;
    let mut msgs = vec![ChatMessage::system(system_prompt())];
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

/// 系统提示词：注入当前本地日期/时间/星期（相对日期解析的锚点）+ 工具守则。
fn system_prompt() -> String {
    let now = chrono::Local::now();
    let wd = ["一", "二", "三", "四", "五", "六", "日"]
        [now.format("%u").to_string().parse::<usize>().unwrap_or(1) - 1];
    format!(
        "你是 MOSH（本地个人信息管理应用）的内置助手，帮用户管理待办与日程。\n\
         当前本地时间：{}（星期{}，时区 {}）。\n\n\
         规则：\n\
         1. 解析「明天/下周五/明早」等相对日期时，以上面的当前时间为锚点换算成具体日期。\n\
         2. 创建/修改成功后，用一两句话向用户复述结果（标题与时间）。\n\
         3. 调用工具时用经过校验的参数：id 只能来自工具结果，不要编造。\n\
         4. 查询类请求先调 list_todos / list_events，再基于结果回答，不要臆造数据。\n\
         5. 修改已有日程用 update_event（只需传要改的字段）；你没有删除工具，用户要求删除时说明请在应用内手动操作。\n\
         6. 周期事件可用 recurrence（daily/weekly/monthly/yearly）；提醒用 reminder_minutes（提前分钟数）。\n\
         7. 用户意图不清（如缺时间、标题不明）时，先追问再创建。",
        now.format("%Y-%m-%d %H:%M"),
        wd,
        now.format("%:z"),
    )
}

fn persist_text(db: &SqliteStorage, session_id: &str, content: &str) -> Result<(), CoreError> {
    db.append_agent_message(&AgentMessage {
        id: 0,
        session_id: session_id.to_string(),
        role: "assistant".into(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        created_at: now_iso(),
    })
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
        let p = system_prompt();
        assert!(p.contains("当前本地时间"));
        assert!(p.contains("星期"));
        assert!(p.contains("时区"));
    }

    #[test]
    fn build_context_skips_tool_rows() {
        let db = SqliteStorage::open_in_memory().unwrap();
        for (role, content) in [("user", "q1"), ("tool", "{}"), ("assistant", "a1")] {
            db.append_agent_message(&AgentMessage {
                id: 0,
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
        let ctx = build_context(&db, "s").unwrap();
        assert_eq!(ctx.len(), 3); // system + user + assistant
        assert_eq!(ctx[0].role, "system");
        assert_eq!(ctx[1].content.as_deref(), Some("q1"));
        assert_eq!(ctx[2].content.as_deref(), Some("a1"));
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
