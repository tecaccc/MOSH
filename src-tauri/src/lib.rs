//! Tauri 命令层：薄壳，仅做命令绑定 + DB 连接管理。
//!
//! 所有领域逻辑在 `mosh-core`；此处 `#[tauri::command]` 函数把前端 IPC
//! 参数转发到 `service` / `storage`，并用 `.map_err(|e| e.to_string())`
//! 把 `CoreError` 转成前端可读字符串。`State<SqliteStorage>` 在 `setup`
//! 中由 `app_data_dir/mosh.sqlite` 打开并注入。

use mosh_core::agent::{
    self, AgentEvent, AiConfig, LlmClient, McpServerConfig, SkillDef, TurnExtras,
};
use mosh_core::model::{EventInput, Record, RecordFilter, RecordPatch, Status, TodoInput};
use mosh_core::service;
use mosh_core::storage::{AgentMessage, AgentSessionSummary, SqliteStorage};
use mosh_core::weather::{CurrentWeather, HttpClient, WeatherConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

/// 天气内存缓存有效期（节流，避免每次访问都打 API）。
const WEATHER_TTL: Duration = Duration::from_secs(30 * 60);

/// 单条缓存：城市查询串 + 取数时刻 + 数据。
struct WeatherCacheEntry {
    query: String,
    fetched_at: Instant,
    data: CurrentWeather,
}

/// 进程内天气缓存（重启即失效；城市坐标另在 SQLite 的 `settings` 表持久复用）。
#[derive(Default)]
struct WeatherCache(Mutex<Option<WeatherCacheEntry>>);

/// 按 id 读取记录（含已软删记录；列表默认不含软删，由前端按需过滤）。
#[tauri::command]
fn get_record(id: String, state: State<'_, SqliteStorage>) -> Result<Record, String> {
    state.get(&id).map_err(|e| e.to_string())
}

/// 通用列表：按 `filter` 过滤。前端传 `filter.kind` 区分 todo/event，
/// 以便子任务 B（Calendar）直接复用同一条命令。
#[tauri::command]
fn list_records(
    filter: Option<RecordFilter>,
    state: State<'_, SqliteStorage>,
) -> Result<Vec<Record>, String> {
    let filter = filter.unwrap_or_default();
    state.list(&filter).map_err(|e| e.to_string())
}

/// 创建待办。
#[tauri::command]
fn create_todo(input: TodoInput, state: State<'_, SqliteStorage>) -> Result<Record, String> {
    service::create_todo(&state, input).map_err(|e| e.to_string())
}

/// 创建日程事件（定时或全天）。
#[tauri::command]
fn create_event(input: EventInput, state: State<'_, SqliteStorage>) -> Result<Record, String> {
    service::create_event(&state, input).map_err(|e| e.to_string())
}

/// 列出与 [from, to] 区间重叠的事件（from 含、to 排他）。供日历视图按可视窗口加载。
#[tauri::command]
fn list_events(
    from: String,
    to: String,
    state: State<'_, SqliteStorage>,
) -> Result<Vec<Record>, String> {
    service::list_events(&state, &from, &to).map_err(|e| e.to_string())
}

/// 为顶层待办添加子任务（service 内含 1 层嵌套校验）。
#[tauri::command]
fn add_subtask(
    parent_id: String,
    input: TodoInput,
    state: State<'_, SqliteStorage>,
) -> Result<Record, String> {
    service::add_subtask(&state, &parent_id, input).map_err(|e| e.to_string())
}

/// 部分更新记录（合并 patch，刷新 updated_at/revision）。
#[tauri::command]
fn update_record(
    id: String,
    patch: RecordPatch,
    state: State<'_, SqliteStorage>,
) -> Result<Record, String> {
    service::update_record(&state, &id, patch).map_err(|e| e.to_string())
}

/// 设置待办状态（active/done/cancelled）。
#[tauri::command]
fn set_todo_status(
    id: String,
    status: Status,
    state: State<'_, SqliteStorage>,
) -> Result<Record, String> {
    service::set_todo_status(&state, &id, status).map_err(|e| e.to_string())
}

/// 软删记录（置墓碑，不出现在默认列表，保留于库）。
#[tauri::command]
fn delete_record(id: String, state: State<'_, SqliteStorage>) -> Result<(), String> {
    service::soft_delete(&state, &id).map_err(|e| e.to_string())
}

/// 读取天气城市配置；未配置（无设置或 `query` 为空）返回 `None`。
#[tauri::command]
fn get_weather_config(state: State<'_, SqliteStorage>) -> Result<Option<WeatherConfig>, String> {
    let json = state.get_setting("weather").map_err(|e| e.to_string())?;
    let cfg = json
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str::<WeatherConfig>)
        .transpose()
        .map_err(|e| e.to_string())?;
    Ok(cfg.filter(|c| !c.query.is_empty()))
}

/// 设置当前城市（`query` 为 geocode 查询串）。切换城市会清空已缓存坐标与内存天气，
/// 下次 `get_current_weather` 对新城重新 geocode。
#[tauri::command]
fn set_city(
    query: String,
    state: State<'_, SqliteStorage>,
    cache: State<'_, WeatherCache>,
) -> Result<(), String> {
    let cfg = WeatherConfig {
        query,
        lat: None,
        lng: None,
        tz: None,
    };
    let serialized = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    state
        .set_setting("weather", &serialized)
        .map_err(|e| e.to_string())?;
    // 清缓存：新城立即重新取数；旧城缓存作废。
    if let Ok(mut guard) = cache.0.lock() {
        *guard = None;
    }
    Ok(())
}

/// 取当前天气。`None` = 未配置城市；`Some` = 有数据（新取或同城市缓存回退）；
/// `Err` = 配置了但取不到且无可用缓存。
#[tauri::command]
async fn get_current_weather(
    state: State<'_, SqliteStorage>,
    client: State<'_, HttpClient>,
    cache: State<'_, WeatherCache>,
) -> Result<Option<CurrentWeather>, String> {
    // 1) 读配置；未配置城市 → None。
    let json = state.get_setting("weather").map_err(|e| e.to_string())?;
    let cfg: Option<WeatherConfig> = json
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())?;
    let Some(mut cfg) = cfg.filter(|c| !c.query.is_empty()) else {
        return Ok(None);
    };

    // 2) 内存缓存命中（同城市 + TTL 内）。
    if let Ok(guard) = cache.0.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.query == cfg.query && entry.fetched_at.elapsed() < WEATHER_TTL {
                return Ok(Some(entry.data.clone()));
            }
        }
    }

    // 3) 坐标未解析则 geocode 并持久化（之后含重启均复用，不再 geocode）。
    if !cfg.has_coords() {
        let (lat, lng, tz) = mosh_core::weather::geocode(&client, &cfg.query)
            .await
            .map_err(|e| e.to_string())?;
        cfg.lat = Some(lat);
        cfg.lng = Some(lng);
        cfg.tz = tz;
        let serialized = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
        state
            .set_setting("weather", &serialized)
            .map_err(|e| e.to_string())?;
    }

    // 4) 取天气：成功写缓存；失败则回退同城市缓存（过期亦可），否则 Err。
    match mosh_core::weather::forecast(
        &client,
        cfg.lat.unwrap(),
        cfg.lng.unwrap(),
        cfg.tz.as_deref(),
    )
    .await
    {
        Ok(data) => {
            if let Ok(mut guard) = cache.0.lock() {
                *guard = Some(WeatherCacheEntry {
                    query: cfg.query.clone(),
                    fetched_at: Instant::now(),
                    data: data.clone(),
                });
            }
            Ok(Some(data))
        }
        Err(e) => {
            if let Ok(guard) = cache.0.lock() {
                if let Some(entry) = guard.as_ref() {
                    if entry.query == cfg.query {
                        return Ok(Some(entry.data.clone()));
                    }
                }
            }
            Err(e.to_string())
        }
    }
}

// —— Agent（任务 08-15-agent-v1）——

/// 每会话运行态：abort 标志 + 在跑标记（同会话串行，防并发双写）。
struct AgentRun {
    abort: Arc<AtomicBool>,
    running: bool,
}

/// 全部会话运行态（setup 注入）：
/// - `runs`：会话占用与中止标志；
/// - `pending`：待审批工具调用的 oneshot 回传通道（call_id → sender），
///   `agent_approve` 命令弹出并投递用户决定。
#[derive(Default)]
struct AgentRuns {
    runs: Mutex<HashMap<String, AgentRun>>,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
}

/// 审批闸门（会话级）：注册 oneshot 等待前端决定；中止时轮询 abort 标志退出。
struct SessionGate {
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    abort: Arc<AtomicBool>,
}

impl agent::ApprovalGate for SessionGate {
    fn request(
        &self,
        call_id: &str,
        _tool: &str,
        _args: &serde_json::Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(call_id.to_string(), tx);
        }
        let pending = self.pending.clone();
        let abort = self.abort.clone();
        let key = call_id.to_string();
        Box::pin(async move {
            loop {
                tokio::select! {
                    res = &mut rx => return res.unwrap_or(false),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                        if abort.load(Ordering::Relaxed) {
                            if let Ok(mut map) = pending.lock() {
                                map.remove(&key);
                            }
                            return false;
                        }
                    }
                }
            }
        })
    }
}

/// 读 AI 模型配置；未配置返回可读错误（前端引导去设置页）。
fn load_ai_config(state: &SqliteStorage) -> Result<AiConfig, String> {
    let json = state.get_setting("ai_model").map_err(|e| e.to_string())?;
    let cfg: AiConfig = json
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if !cfg.is_complete() {
        return Err("尚未配置 AI 模型：请前往「设置 → AI 模型」填写".to_string());
    }
    Ok(cfg.normalized())
}

/// 发送一条用户消息并驱动一轮 Agent 循环；事件经 `agent://*` 回传。
/// `model` 为聊天界面所选模型（非空时覆盖配置里的默认模型）。
#[tauri::command]
async fn agent_send(
    app: tauri::AppHandle,
    state: State<'_, SqliteStorage>,
    runs: State<'_, AgentRuns>,
    session_id: String,
    message: String,
    model: String,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }
    let mut cfg = load_ai_config(&state)?;
    let model = model.trim();
    if !model.is_empty() {
        cfg.model = model.to_string();
    }

    // 登记/占用会话运行槽：同会话同时在跑 → 拒绝。
    let abort = {
        let mut map = runs.runs.lock().map_err(|e| e.to_string())?;
        match map.get_mut(&session_id) {
            Some(run) if run.running => {
                return Err("该会话正在回复中，请稍候或先停止".to_string());
            }
            Some(run) => {
                run.abort = Arc::new(AtomicBool::new(false));
                run.running = true;
                run.abort.clone()
            }
            None => {
                let abort = Arc::new(AtomicBool::new(false));
                map.insert(
                    session_id.clone(),
                    AgentRun {
                        abort: abort.clone(),
                        running: true,
                    },
                );
                abort
            }
        }
    };

    let turn_id = mosh_core::model::new_id();
    let client = agent::OpenAiClient::new(&cfg);

    // 装载本轮增强：启用技能 + 启用的 MCP 服务器工具（单台失败跳过不阻塞）+ 审批模式。
    let extras = {
        let skills = skills_inner(&state)
            .into_iter()
            .filter(|s| s.active)
            .map(|s| s.def)
            .collect::<Vec<_>>();
        let mut mcp = Vec::new();
        for srv in load_mcp_servers(&state).into_iter().filter(|s| s.enabled) {
            match agent::mcp::list_tools(&srv).await {
                Ok(raw) => {
                    let tools = agent::mcp::to_tool_infos(&srv, &raw);
                    eprintln!("[mcp] {} 装载 {} 个工具", srv.name, tools.len());
                    mcp.push((srv, tools));
                }
                Err(e) => eprintln!("[mcp] {} 装载失败（跳过）：{e}", srv.name),
            }
        }
        let permission = agent::PermissionMode::parse(
            &state
                .get_setting("ai_permission_mode")
                .ok()
                .flatten()
                .unwrap_or_default(),
        );
        TurnExtras {
            skills,
            mcp,
            permission,
        }
    };

    let app_for_events = app.clone();
    let on_event = move |e: AgentEvent| {
        let name = match &e {
            AgentEvent::Start { .. } => "agent://start",
            AgentEvent::Delta { .. } => "agent://delta",
            AgentEvent::Tool { .. } => "agent://tool",
            AgentEvent::ApprovalRequired { .. } => "agent://approval",
            AgentEvent::End { .. } => "agent://end",
        };
        let _ = app_for_events.emit(name, &e);
    };

    // 审批闸门：接前端 agent_approve；中止时轮询退出。
    let gate = SessionGate {
        pending: runs.pending.clone(),
        abort: abort.clone(),
    };

    // run_turn 内部已保证 End 事件恰好一次（含错误/中断），此处 Err 仅日志级。
    let result = agent::run_turn_with(
        &state,
        &client,
        &session_id,
        message.trim(),
        &turn_id,
        &on_event,
        &abort,
        &extras,
        &gate,
    )
    .await;

    if let Err(e) = &result {
        eprintln!("[agent] turn {turn_id} storage failure: {e}");
    }
    // 释放运行槽。
    if let Ok(mut map) = runs.runs.lock() {
        if let Some(run) = map.get_mut(&session_id) {
            run.running = false;
        }
    }
    result.map_err(|e| e.to_string())
}

/// 中止某会话的在迷轮（步/工具边界检查，已落库操作保留）。
#[tauri::command]
fn agent_abort(session_id: String, runs: State<'_, AgentRuns>) -> Result<(), String> {
    let map = runs.runs.lock().map_err(|e| e.to_string())?;
    if let Some(run) = map.get(&session_id) {
        run.abort.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 审批回传：用户对某待批准工具调用的决定（true=批准执行）。
#[tauri::command]
fn agent_approve(
    call_id: String,
    approved: bool,
    runs: State<'_, AgentRuns>,
) -> Result<(), String> {
    let mut pending = runs.pending.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = pending.remove(&call_id) {
        let _ = tx.send(approved);
        Ok(())
    } else {
        // 通道已失效（回合结束/中止）——静默即可，前端也会随 end 事件清理。
        Ok(())
    }
}

/// 读工具审批模式（settings `ai_permission_mode`；缺省 auto）。
#[tauri::command]
fn get_permission_mode(state: State<'_, SqliteStorage>) -> Result<String, String> {
    Ok(state
        .get_setting("ai_permission_mode")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "auto".to_string()))
}

/// 写工具审批模式（auto/write/all；非法值拒绝）。
#[tauri::command]
fn set_permission_mode(mode: String, state: State<'_, SqliteStorage>) -> Result<(), String> {
    let m = agent::PermissionMode::parse(&mode);
    if m.as_str() != mode.trim() {
        return Err("模式仅支持 auto / write / all".to_string());
    }
    state
        .set_setting("ai_permission_mode", m.as_str())
        .map_err(|e| e.to_string())
}

/// 读 AI 模型配置（未配置返回 null）。
#[tauri::command]
fn get_ai_config(state: State<'_, SqliteStorage>) -> Result<Option<AiConfig>, String> {
    let json = state.get_setting("ai_model").map_err(|e| e.to_string())?;
    json.as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())
}

/// 写 AI 模型配置（三项校验非空）。
#[tauri::command]
fn set_ai_config(state: State<'_, SqliteStorage>, config: AiConfig) -> Result<(), String> {
    let cfg = config.normalized();
    if !cfg.is_complete() {
        return Err("base_url 与 model 不能为空".to_string());
    }
    let serialized = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    state
        .set_setting("ai_model", &serialized)
        .map_err(|e| e.to_string())
}

/// 读提供商列表（settings key=`ai_providers`）。列表为空时回退到当前激活配置（若有）。
fn load_providers(state: &SqliteStorage) -> Result<Vec<AiConfig>, String> {
    let json = state
        .get_setting("ai_providers")
        .map_err(|e| e.to_string())?;
    let mut providers: Vec<AiConfig> = json
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if providers.is_empty() {
        if let Some(cfg) = get_ai_config_inner(state)? {
            let mut c = cfg.normalized();
            if c.name.is_empty() {
                c.name = "默认提供商".to_string();
            }
            providers.push(c);
        }
    }
    Ok(providers)
}

/// 读激活配置（不含回退逻辑）。
fn get_ai_config_inner(state: &SqliteStorage) -> Result<Option<AiConfig>, String> {
    let json = state.get_setting("ai_model").map_err(|e| e.to_string())?;
    json.as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())
}

fn save_providers(state: &SqliteStorage, providers: &[AiConfig]) -> Result<(), String> {
    let serialized = serde_json::to_string(providers).map_err(|e| e.to_string())?;
    state
        .set_setting("ai_providers", &serialized)
        .map_err(|e| e.to_string())
}

/// 提供商列表（设置页左侧菜单）。
#[tauri::command]
fn list_ai_providers(state: State<'_, SqliteStorage>) -> Result<Vec<AiConfig>, String> {
    load_providers(&state)
}

/// 保存单个提供商（按 name upsert），并设为激活配置（供聊天/Agent 使用）。
#[tauri::command]
fn save_ai_provider(state: State<'_, SqliteStorage>, config: AiConfig) -> Result<(), String> {
    let cfg = config.normalized();
    if cfg.name.is_empty() {
        return Err("提供商名称不能为空".to_string());
    }
    if !cfg.is_complete() {
        return Err("base_url 与 model 不能为空".to_string());
    }
    let mut providers = load_providers(&state)?;
    if let Some(p) = providers.iter_mut().find(|p| p.name == cfg.name) {
        *p = cfg.clone();
    } else {
        providers.push(cfg.clone());
    }
    save_providers(&state, &providers)?;
    // 设为激活。
    let serialized = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    state
        .set_setting("ai_model", &serialized)
        .map_err(|e| e.to_string())
}

/// 删除提供商（按 name）；若删的是激活项，自动激活第一个剩余项（无剩余则清空）。
#[tauri::command]
fn delete_ai_provider(state: State<'_, SqliteStorage>, name: String) -> Result<(), String> {
    let mut providers = load_providers(&state)?;
    providers.retain(|p| p.name != name);
    save_providers(&state, &providers)?;
    if let Some(active) = get_ai_config_inner(&state)? {
        if active.name == name {
            let next = providers.first().cloned();
            let serialized = next
                .as_ref()
                .map(|p| serde_json::to_string(p))
                .transpose()
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            state
                .set_setting("ai_model", &serialized)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 拉取模型列表（设置页「获取模型列表」）：用表单值直接请求 `/models`。
#[tauri::command]
async fn list_ai_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let cfg = AiConfig {
        name: String::new(),
        base_url,
        api_key,
        model: String::new(),
    }
    .normalized();
    if cfg.base_url.is_empty() {
        return Err("base_url 不能为空".to_string());
    }
    let client = agent::OpenAiClient::new(&cfg);
    client.list_models().await.map_err(|e| e.to_string())
}

/// 连通性测试：用表单值（含所选模型）发一条极小请求，返回模型回复片段。
#[tauri::command]
async fn test_ai_connection(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<String, String> {
    let cfg = AiConfig {
        name: String::new(),
        base_url,
        api_key,
        model,
    }
    .normalized();
    if !cfg.is_complete() {
        return Err("base_url 与 model 不能为空".to_string());
    }
    let client = agent::OpenAiClient::new(&cfg);
    client.test_connection().await.map_err(|e| e.to_string())
}

/// 会话摘要列表（最近活跃在前）。
#[tauri::command]
fn list_agent_sessions(
    state: State<'_, SqliteStorage>,
) -> Result<Vec<AgentSessionSummary>, String> {
    state.list_agent_sessions().map_err(|e| e.to_string())
}

/// 某会话的全部消息（历史回看）。
#[tauri::command]
fn list_agent_messages(
    state: State<'_, SqliteStorage>,
    session_id: String,
) -> Result<Vec<AgentMessage>, String> {
    state
        .list_agent_messages(&session_id)
        .map_err(|e| e.to_string())
}

/// 删除整个会话（含全部消息行）。
#[tauri::command]
fn delete_agent_session(state: State<'_, SqliteStorage>, session_id: String) -> Result<(), String> {
    state
        .delete_agent_session(&session_id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// —— Skills：内置 + 自定义（settings `ai_skills_custom`）+ 启用集（`ai_skills_active`）——

/// 技能 + 启用状态（聊天工具条/设置页共用）。
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct SkillInfo {
    #[serde(flatten)]
    def: SkillDef,
    active: bool,
}

fn load_setting_json<T: serde::de::DeserializeOwned>(
    state: &SqliteStorage,
    key: &str,
) -> Result<T, String> {
    let json = state.get_setting(key).map_err(|e| e.to_string())?;
    json.as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("setting {key} 未设置"))
}

fn save_setting_value<T: serde::Serialize>(
    state: &SqliteStorage,
    key: &str,
    value: &T,
) -> Result<(), String> {
    let serialized = serde_json::to_string(value).map_err(|e| e.to_string())?;
    state
        .set_setting(key, &serialized)
        .map_err(|e| e.to_string())
}

fn load_custom_skills(state: &SqliteStorage) -> Vec<SkillDef> {
    load_setting_json::<Vec<SkillDef>>(state, "ai_skills_custom").unwrap_or_default()
}

fn load_active_skill_ids(state: &SqliteStorage) -> Vec<String> {
    load_setting_json::<Vec<String>>(state, "ai_skills_active").unwrap_or_default()
}

/// 内置 + 自定义 + 启用状态（命令与 agent_send 共用）。
fn skills_inner(state: &SqliteStorage) -> Vec<SkillInfo> {
    let active = load_active_skill_ids(state);
    let mut defs = agent::skills::builtin_skills();
    defs.extend(load_custom_skills(state));
    defs.into_iter()
        .map(|def| {
            let active = active.contains(&def.id);
            SkillInfo { def, active }
        })
        .collect()
}

/// 全部技能（内置在前）+ 各自启用状态。
#[tauri::command]
fn list_skills(state: State<'_, SqliteStorage>) -> Result<Vec<SkillInfo>, String> {
    Ok(skills_inner(&state))
}

/// 新建/更新自定义技能（内置 id 拒绝，防覆盖）。
#[tauri::command]
fn save_skill(mut skill: SkillDef, state: State<'_, SqliteStorage>) -> Result<SkillDef, String> {
    skill.name = skill.name.trim().to_string();
    skill.prompt = skill.prompt.trim().to_string();
    if skill.name.is_empty() || skill.prompt.is_empty() {
        return Err("技能名称与提示词不能为空".to_string());
    }
    let builtin_ids: Vec<String> = agent::skills::builtin_skills()
        .into_iter()
        .map(|s| s.id)
        .collect();
    if skill.builtin || builtin_ids.contains(&skill.id) {
        return Err("内置技能不可编辑，请新建自定义技能".to_string());
    }
    if skill.id.is_empty() {
        skill.id = mosh_core::model::new_id();
    }
    let mut customs = load_custom_skills(&state);
    match customs.iter_mut().find(|s| s.id == skill.id) {
        Some(slot) => *slot = skill.clone(),
        None => customs.push(skill.clone()),
    }
    save_setting_value(&state, "ai_skills_custom", &customs)?;
    Ok(skill)
}

/// 删除自定义技能（内置拒绝；同步满理启用集）。
#[tauri::command]
fn delete_skill(id: String, state: State<'_, SqliteStorage>) -> Result<(), String> {
    let builtin_ids: Vec<String> = agent::skills::builtin_skills()
        .into_iter()
        .map(|s| s.id)
        .collect();
    if builtin_ids.contains(&id) {
        return Err("内置技能不可删除".to_string());
    }
    let mut customs = load_custom_skills(&state);
    let before = customs.len();
    customs.retain(|s| s.id != id);
    if customs.len() == before {
        return Err("技能不存在".to_string());
    }
    save_setting_value(&state, "ai_skills_custom", &customs)?;
    let mut active = load_active_skill_ids(&state);
    active.retain(|x| x != &id);
    save_setting_value(&state, "ai_skills_active", &active)?;
    Ok(())
}

/// 开/关技能（内置与自定义通用）。
#[tauri::command]
fn set_skill_active(
    id: String,
    active: bool,
    state: State<'_, SqliteStorage>,
) -> Result<(), String> {
    let mut ids = load_active_skill_ids(&state);
    if active {
        if !ids.contains(&id) {
            ids.push(id);
        }
    } else {
        ids.retain(|x| x != &id);
    }
    save_setting_value(&state, "ai_skills_active", &ids)
}

// —— MCP 服务器（settings `ai_mcp_servers`）——

fn load_mcp_servers(state: &SqliteStorage) -> Vec<McpServerConfig> {
    load_setting_json::<Vec<McpServerConfig>>(state, "ai_mcp_servers").unwrap_or_default()
}

#[tauri::command]
fn list_mcp_servers(state: State<'_, SqliteStorage>) -> Result<Vec<McpServerConfig>, String> {
    Ok(load_mcp_servers(&state))
}

/// 新建/更新服务器配置（按 id upsert）。
#[tauri::command]
fn save_mcp_server(
    mut server: McpServerConfig,
    state: State<'_, SqliteStorage>,
) -> Result<McpServerConfig, String> {
    server.name = server.name.trim().to_string();
    server.url = server.url.trim().trim_end_matches('/').to_string();
    if server.name.is_empty() {
        return Err("服务器名称不能为空".to_string());
    }
    if !server.url.starts_with("http://") && !server.url.starts_with("https://") {
        return Err("地址需为 http(s):// 开头的 MCP 端点".to_string());
    }
    if server.id.is_empty() {
        server.id = mosh_core::model::new_id();
    }
    let mut servers = load_mcp_servers(&state);
    match servers.iter_mut().find(|s| s.id == server.id) {
        Some(slot) => *slot = server.clone(),
        None => servers.push(server.clone()),
    }
    save_setting_value(&state, "ai_mcp_servers", &servers)?;
    Ok(server)
}

#[tauri::command]
fn delete_mcp_server(id: String, state: State<'_, SqliteStorage>) -> Result<(), String> {
    let mut servers = load_mcp_servers(&state);
    let before = servers.len();
    servers.retain(|s| s.id != id);
    if servers.len() == before {
        return Err("服务器不存在".to_string());
    }
    save_setting_value(&state, "ai_mcp_servers", &servers)
}

/// 总开关（聊天工具条快速启停）。
#[tauri::command]
fn set_mcp_enabled(
    id: String,
    enabled: bool,
    state: State<'_, SqliteStorage>,
) -> Result<(), String> {
    let mut servers = load_mcp_servers(&state);
    let slot = servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("服务器不存在")?;
    slot.enabled = enabled;
    save_setting_value(&state, "ai_mcp_servers", &servers)
}

/// 探测：连接并列出工具名（设置页“测试连接”用）。
#[tauri::command]
async fn mcp_list_tools(base_url: String, token: Option<String>) -> Result<Vec<String>, String> {
    let cfg = McpServerConfig {
        id: "probe".into(),
        name: "probe".into(),
        url: base_url,
        token,
        enabled: true,
    };
    let tools = agent::mcp::list_tools(&cfg).await?;
    Ok(tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect())
}

// —— 启动期配置文件（config.toml）：位于系统配置目录，不随数据目录移动 ——

/// 配置文件名（位于 `app_config_dir()`）。
const CONFIG_FILENAME: &str = "config.toml";

/// 首次启动写入的配置模板（注释即文档；修改后重启生效）。
const CONFIG_TEMPLATE: &str = r#"# MOSH 配置文件（修改后重启应用生效）
#
# data_dir：本地数据目录（数据库 mosh.sqlite 所在文件夹）。
#   - 支持绝对路径，或以 ~ 开头（家目录）
#   - 留空或删除该行 = 使用系统默认位置
#   - 切换目录不会自动迁移旧数据，如需保留请自行复制旧数据库文件
data_dir = ""
"#;

/// config.toml 可识别字段。缺文件/字段 → 默认行为。
#[derive(Debug, Default, serde::Deserialize)]
struct FileConfig {
    data_dir: Option<String>,
}

/// 解析结果：数据目录 + 配置文件路径 + 是否为用户自定义。
#[derive(Debug, Clone)]
struct StoragePaths {
    data_dir: PathBuf,
    config_path: PathBuf,
    customized: bool,
}

/// `~`/`~/...` 前缀展开为家目录（其余原样返回）。
fn expand_home(app: &tauri::AppHandle, s: &str) -> PathBuf {
    if s == "~" || s.starts_with("~/") {
        if let Ok(home) = app.path().home_dir() {
            let rest = s.trim_start_matches('~');
            return home.join(rest.trim_start_matches('/'));
        }
    }
    PathBuf::from(s)
}

/// 计算存储路径：环境变量 `MOSH_DATA_DIR` > config.toml `data_dir` > 系统默认。
/// 配置文件不存在时写入模板（便于用户发现）；解析失败告警并回退默认（不阻塞启动）。
fn resolve_storage_paths(app: &tauri::AppHandle) -> StoragePaths {
    let config_dir = app
        .path()
        .app_config_dir()
        .expect("no app_config_dir available");
    let config_path = config_dir.join(CONFIG_FILENAME);

    // 首次运行写模板（已存在不动，避免覆盖用户修改）。
    if !config_path.exists() {
        if let Err(e) = std::fs::create_dir_all(&config_dir)
            .and_then(|_| std::fs::write(&config_path, CONFIG_TEMPLATE))
        {
            eprintln!("[config] 写入模板失败（忽略）：{e}");
        }
    }

    let default_dir = app
        .path()
        .app_data_dir()
        .expect("no app_data_dir available");

    // 优先级 1：环境变量（供高级用法/便携模式）。
    let env_dir = std::env::var("MOSH_DATA_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // 优先级 2：config.toml（解析失败告警并回退默认，不阻塞启动）。
    let cfg_dir = if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(text) if !text.trim().is_empty() => match toml::from_str::<FileConfig>(&text) {
                Ok(cfg) => cfg.data_dir,
                Err(e) => {
                    eprintln!("[config] config.toml 解析失败（回退默认）：{e}");
                    None
                }
            },
            Ok(_) => None,
            Err(e) => {
                eprintln!("[config] config.toml 读取失败（回退默认）：{e}");
                None
            }
        }
    } else {
        None
    }
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());

    let custom = env_dir.or(cfg_dir);
    match custom {
        Some(s) => {
            let dir = expand_home(app, &s);
            if dir.is_absolute() {
                StoragePaths {
                    data_dir: dir,
                    config_path,
                    customized: true,
                }
            } else {
                eprintln!("[config] data_dir 需为绝对路径或 ~ 开头（当前值：{s}），回退默认");
                StoragePaths {
                    data_dir: default_dir,
                    config_path,
                    customized: false,
                }
            }
        }
        None => StoragePaths {
            data_dir: default_dir,
            config_path,
            customized: false,
        },
    }
}

/// 数据目录信息（设置页「关于」展示 + 打开目录）。
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct StorageInfo {
    data_dir: String,
    config_path: String,
    customized: bool,
}

#[tauri::command]
fn get_storage_info(app: tauri::AppHandle) -> StorageInfo {
    let p = resolve_storage_paths(&app);
    StorageInfo {
        data_dir: p.data_dir.to_string_lossy().into_owned(),
        config_path: p.config_path.to_string_lossy().into_owned(),
        customized: p.customized,
    }
}

// —— 个人资料（settings key=`profile`）：首页/今日问候展示用 ——

/// 用户资料：名称 + 头像。`avatar` 为图片 data URL 或 `emoji:` 前缀的表情；
/// `None`/缺省时前端用名称首字符圆标兑底。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct Profile {
    name: String,
    avatar: Option<String>,
}

/// 读个人资料；未配置返回 `None`（前端用默认展示）。
#[tauri::command]
fn get_profile(state: State<'_, SqliteStorage>) -> Result<Option<Profile>, String> {
    let json = state.get_setting("profile").map_err(|e| e.to_string())?;
    json.as_deref()
        .filter(|s| !s.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())
}

/// 保存个人资料（名称非空；头像 data URL 限制约 1.5MB 原图，防 settings 行膨胀）。
#[tauri::command]
fn set_profile(mut profile: Profile, state: State<'_, SqliteStorage>) -> Result<(), String> {
    profile.name = profile.name.trim().to_string();
    if profile.name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if let Some(a) = profile.avatar.as_deref() {
        if !a.starts_with("emoji:") && a.len() > 2_000_000 {
            return Err("头像图片过大，请换用小于 1.5MB 的图片".to_string());
        }
    }
    let serialized = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
    state
        .set_setting("profile", &serialized)
        .map_err(|e| e.to_string())
}

// —— 关闭行为 + 系统托盘（后台驻留模式）——

/// 托盘是否可用（Linux 无 AppIndicator 时创建失败 → background 模式退化为直接退出，
/// 避免窗口隐藏后无法找回）。
#[derive(Default)]
struct TrayState(std::sync::atomic::AtomicBool);

/// 恢复主窗口（托盘左键点击 / 菜单「显示主窗口」）。
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 读关闭行为（settings `close_behavior`；缺省 exit）。
fn close_behavior_of(app: &tauri::AppHandle) -> String {
    app.try_state::<SqliteStorage>()
        .and_then(|st| st.get_setting("close_behavior").ok().flatten())
        .unwrap_or_else(|| "exit".to_string())
}

/// 读关闭行为（前端展示用）。
#[tauri::command]
fn get_close_behavior(app: tauri::AppHandle) -> Result<String, String> {
    Ok(close_behavior_of(&app))
}

/// 写关闭行为（exit=直接退出；background=隐藏窗口驻留后台，需托盘可用）。
#[tauri::command]
fn set_close_behavior(behavior: String, state: State<'_, SqliteStorage>) -> Result<(), String> {
    if behavior != "exit" && behavior != "background" {
        return Err("关闭行为仅支持 exit / background".to_string());
    }
    state
        .set_setting("close_behavior", &behavior)
        .map_err(|e| e.to_string())
}

/// 建系统托盘（图标 + 菜单 + 左键点击恢复窗口）。失败时由调用方降级。
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出 MOSH", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "无默认窗口图标".to_string())?;

    let mut tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("MOSH")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    tray.set_visible(true).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 单实例锁：重复点击桌面图标时，新进程检测到已有实例后立即退出，
    // 并唤起旧实例的主窗口（配合「后台驻留」模式：驻留托盘的旧实例被顶到
    // 前台，而非再开一个进程堆在后台）。插件仅支持桌面端，且需最先注册。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main(app);
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        // 自动更新：endpoints/pubkey 在 tauri.conf.json plugins.updater 配置；
        // process 插件供前端 relaunch（安装完成后重启进入新版本）。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 系统通知：日程提醒/待办到期时经 OS 通知中心告知。
        .plugin(tauri_plugin_notification::init())
        // 系统托盘：后台驻留模式下窗口隐藏后经托盘找回（左键点击恢复；
        // 菜单提供「显示主窗口 / 退出」）。Linux 无 AppIndicator 时创建失败，
        // 自动退化为「直接退出」模式。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let tray_ok = app
                    .try_state::<TrayState>()
                    .map(|t| t.0.load(Ordering::Relaxed))
                    .unwrap_or(false);
                if close_behavior_of(app) == "background" && tray_ok {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // 否则：默认行为（真正关闭；最后一个窗口关闭后应用退出）。
            }
        })
        .setup(|app| {
            // 托盘可用性探测（失败仅降级不阻塞启动）。
            let tray_ok = match build_tray(app.handle()) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("[tray] 初始化失败（后台驻留将不可用，回退直接退出）：{e}");
                    false
                }
            };
            app.manage(TrayState(std::sync::atomic::AtomicBool::new(tray_ok)));
            // 解析数据目录（env MOSH_DATA_DIR > config.toml data_dir > 系统默认），
            // 创建目录，打开（或新建）数据库并跑迁移。自定义目录不可用时回退默认
            // 并系统通知告警（避免 GUI 下 panic 信息不可见）。启动期失败直接 panic
            // 带清晰信息（v1 可接受）。
            let handle = app.handle().clone();
            let mut paths = resolve_storage_paths(&handle);
            if paths.customized && std::fs::create_dir_all(&paths.data_dir).is_err() {
                use tauri_plugin_notification::NotificationExt;
                let bad = paths.data_dir.to_string_lossy().into_owned();
                eprintln!("[config] 无法创建自定义数据目录 {bad}，回退系统默认");
                let _ = app
                    .notification()
                    .builder()
                    .title("MOSH：自定义数据目录不可用")
                    .body(format!(
                        "无法创建 {bad}，已回退系统默认目录。请检查 config.toml。"
                    ))
                    .show();
                paths.data_dir = app
                    .path()
                    .app_data_dir()
                    .expect("no app_data_dir available");
                paths.customized = false;
            }
            std::fs::create_dir_all(&paths.data_dir)?;
            eprintln!(
                "[storage] data_dir={} ({}), config={}",
                paths.data_dir.display(),
                if paths.customized {
                    "自定义"
                } else {
                    "默认"
                },
                paths.config_path.display()
            );
            let db_path = paths.data_dir.join("mosh.sqlite");
            let storage = SqliteStorage::open(&db_path).unwrap_or_else(|e| {
                panic!("failed to open mosh database at {}: {e}", db_path.display())
            });
            app.manage(storage);
            // HTTP 客户端（复用连接池）+ 天气内存缓存，注入给 async 命令。
            let client = HttpClient::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("failed to build reqwest client");
            app.manage(client);
            app.manage(WeatherCache::default());
            app.manage(AgentRuns::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_record,
            list_records,
            create_todo,
            create_event,
            list_events,
            add_subtask,
            update_record,
            set_todo_status,
            delete_record,
            get_weather_config,
            set_city,
            get_current_weather,
            get_profile,
            set_profile,
            get_storage_info,
            get_close_behavior,
            set_close_behavior,
            agent_send,
            agent_abort,
            agent_approve,
            get_permission_mode,
            set_permission_mode,
            get_ai_config,
            set_ai_config,
            list_ai_providers,
            save_ai_provider,
            delete_ai_provider,
            list_ai_models,
            test_ai_connection,
            list_agent_sessions,
            list_agent_messages,
            delete_agent_session,
            list_skills,
            save_skill,
            delete_skill,
            set_skill_active,
            list_mcp_servers,
            save_mcp_server,
            delete_mcp_server,
            set_mcp_enabled,
            mcp_list_tools
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
