//! Tauri 命令层：薄壳，仅做命令绑定 + DB 连接管理。
//!
//! 所有领域逻辑在 `mosh-core`；此处 `#[tauri::command]` 函数把前端 IPC
//! 参数转发到 `service` / `storage`，并用 `.map_err(|e| e.to_string())`
//! 把 `CoreError` 转成前端可读字符串。`State<SqliteStorage>` 在 `setup`
//! 中由 `app_data_dir/mosh.sqlite` 打开并注入。

use mosh_core::agent::mcp::McpToolInfo;
use mosh_core::agent::models::{
    parse_unique_model_id, unique_model_id, AiModel, AiProvider, AiSyncResult,
};
use mosh_core::agent::{
    self, AgentEvent, AiConfig, LlmClient, McpServerConfig, SkillDef, TurnExtras,
};
use mosh_core::model::{EventInput, Record, RecordFilter, RecordPatch, Status, TodoInput};
use mosh_core::service;
use mosh_core::storage::{AgentMessage, AgentSessionSummary, MemoryAgentLog, SqliteStorage};
use mosh_core::weather::{CurrentWeather, HttpClient, WeatherConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

mod mail;

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

/// 设置当前城市（`query` 为 geocode 查询串）。可选携带坐标/时区（搜索候选直选时
/// 已解析，免二次 geocode；也规避重名词 count=1 解析到错误地点）。未携带则清空
/// 已缓存坐标与内存天气，下次 `get_current_weather` 对新城重新 geocode（旧设置兼容路径）。
#[tauri::command]
fn set_city(
    query: String,
    lat: Option<f64>,
    lng: Option<f64>,
    tz: Option<String>,
    state: State<'_, SqliteStorage>,
    cache: State<'_, WeatherCache>,
) -> Result<(), String> {
    let cfg = WeatherConfig { query, lat, lng, tz };
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

/// 城市搜索（多候选；中文名/拼音全拼均可）。设置页选城市用，数据源 GeoNames。
#[tauri::command]
async fn search_cities(
    query: String,
    client: State<'_, HttpClient>,
) -> Result<Vec<mosh_core::weather::CityCandidate>, String> {
    mosh_core::weather::search_cities(&client, &query)
        .await
        .map_err(|e| e.to_string())
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

// —— MCP 工具缓存：发送路径零网络等待 ——

/// 缓存有效期：过期后后台续期（stale-while-revalidate，期间继续用旧值）。
const MCP_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// 进程内 MCP 工具缓存条目（server id → 工具 + 拉取时刻）。
struct CachedMcpTools {
    tools: Vec<McpToolInfo>,
    fetched_at: Instant,
}

/// MCP 工具内存缓存（setup 注入）。背景：发送消息前曾对每台启用服务器同步串行
/// `initialize`+`tools/list`（各 10s 超时），慢/不可达的 MCP 直接拖住 LLM 首包
/// （用户症状：「发过去要等好一会才回」）。现在：启动预热 + 配置变更即刷新 +
/// 发送路径只读缓存——缺失/过期时后台拉取，本轮跳过或用旧值，绝不阻塞。
#[derive(Default)]
struct McpToolCache(Mutex<HashMap<String, CachedMcpTools>>);

/// 后台拉取一台服务器的工具列表并写缓存（失败仅日志，保留旧值）。
fn spawn_mcp_fetch(app: &tauri::AppHandle, srv: McpServerConfig) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match agent::mcp::list_tools(&srv).await {
            Ok(raw) => {
                let tools = agent::mcp::to_tool_infos(&srv, &raw);
                eprintln!("[mcp] {} 装载 {} 个工具", srv.name, tools.len());
                if let Some(cache) = app.try_state::<McpToolCache>() {
                    if let Ok(mut map) = cache.0.lock() {
                        map.insert(
                            srv.id.clone(),
                            CachedMcpTools {
                                tools,
                                fetched_at: Instant::now(),
                            },
                        );
                    }
                }
            }
            Err(e) => eprintln!("[mcp] {} 装载失败（跳过，保留旧缓存）：{e}", srv.name),
        }
    });
}

/// 预热：后台拉取全部启用服务器的工具（启动与同步落地设置后调用）。
fn refresh_mcp_cache(app: &tauri::AppHandle, state: &SqliteStorage) {
    for srv in load_mcp_servers(state).into_iter().filter(|s| s.enabled) {
        spawn_mcp_fetch(app, srv);
    }
}

/// 从缓存取启用服务器的工具（发送路径用）。命中即用（过期同时后台续期）；
/// 缺失则后台拉取且本轮跳过（下一轮自然可用）。**绝不等待网络**。
fn mcp_extras_cached(
    app: &tauri::AppHandle,
    state: &SqliteStorage,
) -> Vec<(McpServerConfig, Vec<McpToolInfo>)> {
    let cache = app.try_state::<McpToolCache>();
    let mut out = Vec::new();
    for srv in load_mcp_servers(state).into_iter().filter(|s| s.enabled) {
        let mut hit: Option<Vec<McpToolInfo>> = None;
        let mut stale = false;
        if let Some(cache) = cache.as_ref() {
            if let Ok(map) = cache.0.lock() {
                if let Some(entry) = map.get(&srv.id) {
                    hit = Some(entry.tools.clone());
                    stale = entry.fetched_at.elapsed() >= MCP_CACHE_TTL;
                }
            }
        }
        match hit {
            Some(tools) => {
                if stale {
                    spawn_mcp_fetch(app, srv.clone());
                }
                out.push((srv, tools));
            }
            None => {
                eprintln!("[mcp] {} 缓存未就绪（本轮跳过，后台拉取中）", srv.name);
                spawn_mcp_fetch(app, srv);
            }
        }
    }
    out
}

/// 从缓存中移除一台服务器（删除/停用时；防陈旧配置残留）。
fn drop_mcp_cache_entry(app: &tauri::AppHandle, id: &str) {
    if let Some(cache) = app.try_state::<McpToolCache>() {
        if let Ok(mut map) = cache.0.lock() {
            map.remove(id);
        }
    }
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

/// 默认模型解析结果：provider + model 实体（model.id 即 UniqueModelId）。
struct ResolvedModel {
    provider: AiProvider,
    model: AiModel,
}

/// 从某 provider+model 实体拼发送用 AiConfig。
fn ai_config_of(provider: &AiProvider, model: &AiModel) -> AiConfig {
    AiConfig {
        name: provider.name.clone(),
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
        model: model.model_id.clone(),
    }
    .normalized()
}

/// 解析默认模型：settings `ai_default_model` → 失效时回退首个可用（enabled
/// provider 的首个 enabled 且未 hidden 模型）。无任何可用 → None。
fn resolve_default_model(state: &SqliteStorage) -> Result<Option<ResolvedModel>, String> {
    let default_id = state
        .get_setting("ai_default_model")
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());
    if let Some(id) = default_id {
        if let Some(r) = try_resolve_usable(state, &id)? {
            return Ok(Some(r));
        }
        // 默认指向的模型不可用（被删/禁用）：回退而非报错。
    }
    let providers = state.list_ai_providers().map_err(|e| e.to_string())?;
    for p in providers.iter().filter(|p| p.enabled) {
        if let Some(m) = state
            .list_ai_models(Some(&p.id))
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|m| m.enabled && !m.hidden)
        {
            return Ok(Some(ResolvedModel {
                provider: p.clone(),
                model: m,
            }));
        }
    }
    Ok(None)
}

/// 按 UniqueModelId 解析且校验可用（provider 与 model 均 enabled）。
fn try_resolve_usable(state: &SqliteStorage, unique_id: &str) -> Result<Option<ResolvedModel>, String> {
    let Some((provider_id, _)) = parse_unique_model_id(unique_id) else {
        return Ok(None);
    };
    let model = state.get_ai_model(unique_id).map_err(|e| e.to_string())?;
    let provider = state.get_ai_provider(&provider_id).map_err(|e| e.to_string())?;
    match (provider, model) {
        (Some(p), Some(m)) if p.enabled && m.enabled => Ok(Some(ResolvedModel { provider: p, model: m })),
        _ => Ok(None),
    }
}

/// 聊天发送路径的配置解析。`model_override`：含 `::` 视为 UniqueModelId
/// （完整覆盖 provider+model）；非空纯模型 id 沿用旧语义（覆盖默认 provider 的模型）；
/// 空 = 用默认模型。返回（发送配置, 本轮 UniqueModelId 或 None）。
fn load_ai_config(
    state: &SqliteStorage,
    model_override: &str,
) -> Result<(AiConfig, Option<String>), String> {
    let ov = model_override.trim();
    if !ov.is_empty() && ov.contains("::") {
        let r = try_resolve_usable(state, ov)?
            .ok_or_else(|| format!("所选模型不可用：{ov}（可能已被删除或禁用）"))?;
        let uid = r.model.id.clone();
        return Ok((ai_config_of(&r.provider, &r.model), Some(uid)));
    }
    let r = resolve_default_model(state)?.ok_or(
        "尚未配置 AI 模型：请前往「设置 → AI 模型」添加提供商并选择模型".to_string(),
    )?;
    let uid = r.model.id.clone();
    let mut cfg = ai_config_of(&r.provider, &r.model);
    if !ov.is_empty() {
        // 旧语义：仅覆盖模型 id（同 provider 下临时换模型）。
        cfg.model = ov.to_string();
    }
    Ok((cfg, Some(uid)))
}

/// 发送一条用户消息（可附图片）并驱动一轮 Agent 循环；事件经 `agent://*` 回传。
/// `model`：UniqueModelId（含 `::`）或模型 id（旧语义，覆盖默认 provider）；空 = 默认。
/// `images` 为图片 data URL（vision 多模态，前端已压缩）。
#[allow(clippy::too_many_arguments)] // State 注入多属环境参数，业务实参仅 4 个
#[tauri::command]
async fn agent_send(
    app: tauri::AppHandle,
    state: State<'_, SqliteStorage>,
    runs: State<'_, AgentRuns>,
    log: State<'_, MemoryAgentLog>,
    session_id: String,
    message: String,
    model: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    // 图片附件校验：≤4 张、data:image/ 前缀、单张约 ≤1.8MB（前端已压缩，兼容兑底）。
    let images = images.unwrap_or_default();
    if images.len() > 4 {
        return Err("单条消息最多附带 4 张图片".to_string());
    }
    for url in &images {
        if !url.starts_with("data:image/") {
            return Err("仅支持图片类型的附件".to_string());
        }
        if url.len() > 2_500_000 {
            return Err("图片过大，请换用更小的图片".to_string());
        }
    }
    if message.trim().is_empty() && images.is_empty() {
        return Err("消息不能为空".to_string());
    }
    let (cfg, turn_model_id) = load_ai_config(&state, &model)?;

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

    // 装载本轮增强：启用技能 + 启用的 MCP 服务器工具（**读缓存，零网络等待**；
    // 缓存由启动预热/配置变更/过期后台续期维护，见 McpToolCache）+ 审批模式。
    let extras = {
        let skills = skills_inner(&state)
            .into_iter()
            .filter(|s| s.active)
            .map(|s| s.def)
            .collect::<Vec<_>>();
        let mcp = mcp_extras_cached(&app, &state);
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
            model_id: turn_model_id,
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
        &log,
        &client,
        &session_id,
        message.trim(),
        &images,
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

// ── AI 配置命令（新实体表 + 旧命令兼容层）──
// 新命令：ai_list_providers / ai_upsert_provider / ai_delete_provider / ai_list_models /
// ai_upsert_model / ai_delete_model / ai_sync_models / ai_get_default_model / ai_set_default_model。
// 旧命令（get/set_ai_config、list/save/delete_ai_provider）保留签名、内部改读新表，
// 供旧设置页过渡使用；前端全部切换后可移除。

/// 读 AI 模型配置（未配置返回 null）。旧命令：改为默认模型解析。
#[tauri::command]
fn get_ai_config(state: State<'_, SqliteStorage>) -> Result<Option<AiConfig>, String> {
    Ok(resolve_default_model(&state)?.map(|r| ai_config_of(&r.provider, &r.model)))
}

/// 写 AI 模型配置（旧命令，等价 save_ai_provider）。
#[tauri::command]
fn set_ai_config(state: State<'_, SqliteStorage>, config: AiConfig) -> Result<(), String> {
    save_ai_provider(state, config)
}

/// 短 id（custom-<8位>，新 Provider 生成用）。
fn short_custom_id() -> String {
    mosh_core::model::new_id()
        .replace('-', "")
        .chars()
        .take(8)
        .collect()
}

/// 旧语义 Provider upsert：按 name 找到则沿用 id，否则建 custom-<id>；
/// 带上 model 字符串插一行模型，并设为默认（「保存即激活」旧语义）。
#[tauri::command]
fn save_ai_provider(state: State<'_, SqliteStorage>, config: AiConfig) -> Result<(), String> {
    let cfg = config.normalized();
    if cfg.name.is_empty() {
        return Err("提供商名称不能为空".to_string());
    }
    if !cfg.is_complete() {
        return Err("base_url 与 model 不能为空".to_string());
    }
    let existing = state.find_ai_provider_by_name(&cfg.name).map_err(|e| e.to_string())?;
    let (id, sort_order) = match &existing {
        Some(p) => (p.id.clone(), p.sort_order),
        None => (format!("custom-{}", short_custom_id()), 999.0),
    };
    state
        .upsert_ai_provider(&AiProvider {
            id: id.clone(),
            preset_id: existing.as_ref().and_then(|p| p.preset_id.clone()),
            name: cfg.name.clone(),
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            enabled: true,
            sort_order,
            created_at: String::new(),
        })
        .map_err(|e| e.to_string())?;
    let uid = unique_model_id(&id, &cfg.model)
        .ok_or_else(|| format!("非法模型 id：{}", cfg.model))?;
    if state.get_ai_model(&uid).map_err(|e| e.to_string())?.is_none() {
        state
            .upsert_ai_model(&AiModel {
                id: uid.clone(),
                provider_id: id,
                model_id: cfg.model.clone(),
                name: None,
                capabilities: Vec::new(),
                context_window: None,
                notes: None,
                pinned: false,
                enabled: true,
                hidden: false,
                sort_order: 1.0,
            })
            .map_err(|e| e.to_string())?;
    }
    state
        .set_setting("ai_default_model", &uid)
        .map_err(|e| e.to_string())
}

/// 删除提供商（旧命令，按 name）。
#[tauri::command]
fn delete_ai_provider(state: State<'_, SqliteStorage>, name: String) -> Result<(), String> {
    if let Some(p) = state.find_ai_provider_by_name(&name).map_err(|e| e.to_string())? {
        state.delete_ai_provider(&p.id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 提供商列表（旧命令：映射回 AiConfig 形状；model 取该 provider 的
/// 默认/首个可用模型 id）。
#[tauri::command]
fn list_ai_providers(state: State<'_, SqliteStorage>) -> Result<Vec<AiConfig>, String> {
    let providers = state.list_ai_providers().map_err(|e| e.to_string())?;
    let default_uid = state
        .get_setting("ai_default_model")
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());
    let default_provider = default_uid
        .as_deref()
        .and_then(parse_unique_model_id)
        .map(|(pid, _)| pid);
    let mut out = Vec::with_capacity(providers.len());
    for p in providers {
        let models = state
            .list_ai_models(Some(&p.id))
            .map_err(|e| e.to_string())?;
        let model = if default_provider.as_deref() == Some(p.id.as_str()) {
            default_uid
                .as_deref()
                .and_then(parse_unique_model_id)
                .map(|(_, mid)| mid)
                .unwrap_or_default()
        } else {
            models
                .iter()
                .find(|m| m.enabled && !m.hidden)
                .map(|m| m.model_id.clone())
                .unwrap_or_default()
        };
        out.push(
            AiConfig {
                name: p.name,
                base_url: p.base_url,
                api_key: p.api_key,
                model,
            }
            .normalized(),
        );
    }
    Ok(out)
}

// ── 新命令：Provider/Model 实体 CRUD ──

/// Provider 全量（sort_order 升序）。
#[tauri::command]
fn ai_list_providers(state: State<'_, SqliteStorage>) -> Result<Vec<AiProvider>, String> {
    state.list_ai_providers().map_err(|e| e.to_string())
}

/// upsert Provider；id 为空时生成 custom-<id>。返回落库后的实体。
#[tauri::command]
fn ai_upsert_provider(
    state: State<'_, SqliteStorage>,
    mut provider: AiProvider,
) -> Result<AiProvider, String> {
    provider.name = provider.name.trim().to_string();
    provider.base_url = provider.base_url.trim().trim_end_matches('/').to_string();
    provider.api_key = provider.api_key.trim().to_string();
    if provider.name.is_empty() {
        return Err("提供商名称不能为空".to_string());
    }
    if provider.base_url.is_empty() {
        return Err("base_url 不能为空".to_string());
    }
    if provider.id.is_empty() {
        provider.id = format!("custom-{}", short_custom_id());
        provider.created_at = String::new();
    }
    state
        .upsert_ai_provider(&provider)
        .map_err(|e| e.to_string())?;
    Ok(provider)
}

/// 删 Provider（级联删模型；默认模型属于它时顺带清空默认）。
#[tauri::command]
fn ai_delete_provider(state: State<'_, SqliteStorage>, provider_id: String) -> Result<(), String> {
    state.delete_ai_provider(&provider_id).map_err(|e| e.to_string())
}

/// 模型列表；provider_id None = 全部。
#[tauri::command]
fn ai_list_models(
    state: State<'_, SqliteStorage>,
    provider_id: Option<String>,
) -> Result<Vec<AiModel>, String> {
    state
        .list_ai_models(provider_id.as_deref())
        .map_err(|e| e.to_string())
}

/// upsert 模型（provider 必须已存在；能力标签限白名单）。
#[tauri::command]
fn ai_upsert_model(state: State<'_, SqliteStorage>, mut model: AiModel) -> Result<(), String> {
    const KNOWN_CAPS: [&str; 4] = ["vision", "reasoning", "tools", "embedding"];
    if state
        .get_ai_provider(&model.provider_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("提供商不存在：{}", model.provider_id));
    }
    model.model_id = model.model_id.trim().to_string();
    if model.model_id.is_empty() {
        return Err("模型 id 不能为空".to_string());
    }
    let id = unique_model_id(&model.provider_id, &model.model_id)
        .ok_or_else(|| format!("非法模型 id：{}", model.model_id))?;
    model.id = id;
    model.capabilities.retain(|c| KNOWN_CAPS.contains(&c.as_str()));
    state.upsert_ai_model(&model).map_err(|e| e.to_string())
}

/// 删模型（是默认模型时顺带清空默认）。
#[tauri::command]
fn ai_delete_model(state: State<'_, SqliteStorage>, unique_id: String) -> Result<(), String> {
    state.delete_ai_model(&unique_id).map_err(|e| e.to_string())
}

/// 同步远端模型：GET /models → diff 入库（新增插入、缺失标 hidden、曾隐藏恢复）。
#[tauri::command]
async fn ai_sync_models(
    state: State<'_, SqliteStorage>,
    provider_id: String,
) -> Result<AiSyncResult, String> {
    let provider = state
        .get_ai_provider(&provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("提供商不存在：{provider_id}"))?;
    if provider.base_url.is_empty() {
        return Err("base_url 不能为空".to_string());
    }
    let cfg = AiConfig {
        name: String::new(),
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
        model: String::new(),
    }
    .normalized();
    let client = agent::OpenAiClient::new(&cfg);
    let remote = client.list_models().await.map_err(|e| e.to_string())?;
    state
        .sync_ai_models(&provider_id, &remote)
        .map_err(|e| e.to_string())
}

/// 当前默认模型（含 provider/model 实体，前端展示用）；无可用 → None。
#[tauri::command]
fn ai_get_default_model(
    state: State<'_, SqliteStorage>,
) -> Result<Option<mosh_core::agent::models::AiDefaultModel>, String> {
    Ok(resolve_default_model(&state)?.map(|r| mosh_core::agent::models::AiDefaultModel {
        provider: r.provider,
        model: r.model,
    }))
}

/// 设默认模型（校验存在且可用）。
#[tauri::command]
fn ai_set_default_model(state: State<'_, SqliteStorage>, unique_id: String) -> Result<(), String> {
    let uid = unique_id.trim().to_string();
    if try_resolve_usable(&state, &uid)?.is_none() {
        return Err(format!("模型不可用：{uid}（不存在、被禁用或所属提供商已禁用）"));
    }
    state
        .set_setting("ai_default_model", &uid)
        .map_err(|e| e.to_string())
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

/// 会话摘要列表（内存态，最近活跃在前；重启即空）。
#[tauri::command]
fn list_agent_sessions(
    log: State<'_, MemoryAgentLog>,
) -> Result<Vec<AgentSessionSummary>, String> {
    log.list_sessions().map_err(|e| e.to_string())
}

/// 某会话的全部消息（内存重放；重启后空）。
#[tauri::command]
fn list_agent_messages(
    log: State<'_, MemoryAgentLog>,
    session_id: String,
) -> Result<Vec<AgentMessage>, String> {
    log.list(&session_id).map_err(|e| e.to_string())
}

/// 删除整个会话（内存删除 + 墓碑拒写在途滞后写入；重启自然清空）。
#[tauri::command]
fn delete_agent_session(
    log: State<'_, MemoryAgentLog>,
    session_id: String,
) -> Result<(), String> {
    log.delete_session(&session_id)
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

/// 新建/更新服务器配置（按 id upsert）；启用状态下立即后台刷新工具缓存。
#[tauri::command]
fn save_mcp_server(
    app: tauri::AppHandle,
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
    if server.enabled {
        spawn_mcp_fetch(&app, server.clone());
    }
    Ok(server)
}

#[tauri::command]
fn delete_mcp_server(
    app: tauri::AppHandle,
    id: String,
    state: State<'_, SqliteStorage>,
) -> Result<(), String> {
    let mut servers = load_mcp_servers(&state);
    let before = servers.len();
    servers.retain(|s| s.id != id);
    if servers.len() == before {
        return Err("服务器不存在".to_string());
    }
    save_setting_value(&state, "ai_mcp_servers", &servers)?;
    drop_mcp_cache_entry(&app, &id);
    Ok(())
}

/// 总开关（聊天工具条快速启停）：启用即预热工具缓存，停用即作废。
#[tauri::command]
fn set_mcp_enabled(
    app: tauri::AppHandle,
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
    let srv = slot.clone();
    save_setting_value(&state, "ai_mcp_servers", &servers)?;
    if enabled {
        spawn_mcp_fetch(&app, srv);
    } else {
        drop_mcp_cache_entry(&app, &id);
    }
    Ok(())
}

/// 测试连接展示的工具详情（name / description / 入参 schema）。
#[derive(serde::Serialize)]
struct McpToolDetail {
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

/// 探测：连接并列出工具详情（设置页“测试连接”用）。
#[tauri::command]
async fn mcp_list_tools(
    base_url: String,
    token: Option<String>,
) -> Result<Vec<McpToolDetail>, String> {
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
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(McpToolDetail {
                name,
                description: t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or_default()
                    .to_string(),
                input_schema: t
                    .get("inputSchema")
                    .cloned()
                    .filter(|s| s.is_object())
                    .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}})),
            })
        })
        .collect())
}

// —— 通知方式（系统/邮件；settings `notify_settings`）——

/// 读通知设置回显（不含授权码；无设置回退默认：系统开、邮件关）。
#[tauri::command]
fn get_notify_settings(
    state: State<'_, SqliteStorage>,
) -> Result<mosh_core::notify::NotifySettingsInfo, String> {
    Ok(mosh_core::notify::info_of(&load_notify_settings(&state)))
}

/// 保存通知设置（空授权码 = 保留原值；开启邮件需配置完整）。
#[tauri::command]
fn save_notify_settings(
    settings: mosh_core::notify::NotifySettings,
    state: State<'_, SqliteStorage>,
) -> Result<mosh_core::notify::NotifySettingsInfo, String> {
    let merged =
        mosh_core::notify::merge_for_save(settings, &load_notify_settings(&state))?;
    save_setting_value(&state, mosh_core::notify::KEY_NOTIFY, &merged)?;
    Ok(mosh_core::notify::info_of(&merged))
}

/// 发送测试邮件（表单当前值；授权码留空时用已存值）。
#[tauri::command]
async fn test_email(
    config: mosh_core::notify::EmailConfig,
    state: State<'_, SqliteStorage>,
) -> Result<(), String> {
    let saved = load_notify_settings(&state);
    let config = mosh_core::notify::merge_for_save(
        mosh_core::notify::NotifySettings {
            email: Some(config),
            email_enabled: true,
            ..Default::default()
        },
        &saved,
    )?
    .email
    .expect("merge_for_save 校验通过时 email 必在");
    mail::send_email(
        &config,
        "MOSH 测试邮件",
        "这是一封来自 MOSH 的测试邮件——邮件通知配置正确，收件正常。",
    )
    .await
}

/// 提醒到点发邮件通知（前端 reminder 轮询触发；未启用时静默成功）。
#[tauri::command]
async fn notify_send_email(
    subject: String,
    body: String,
    state: State<'_, SqliteStorage>,
) -> Result<(), String> {
    let settings = load_notify_settings(&state);
    if !settings.email_enabled {
        return Ok(());
    }
    let config = settings
        .email
        .as_ref()
        .ok_or("邮件通知已开启但未配置 SMTP")?;
    mail::send_email(config, &subject, &body).await
}

/// 读通知设置（缺省/损坏回退默认：系统通知开、邮件关）。
fn load_notify_settings(state: &SqliteStorage) -> mosh_core::notify::NotifySettings {
    load_setting_json::<mosh_core::notify::NotifySettings>(
        state,
        mosh_core::notify::KEY_NOTIFY,
    )
    .unwrap_or_default()
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

// —— 多设备同步（docs/sync-design.md）：命令 + 启动拉/防抖推/退出兑底 ——

use mosh_core::sync::engine::Remote;
use mosh_core::sync::remote::{RemoteConfig, S3Client};

/// 同步 UI 状态（标题栏状态点 + 设置页展示；事件 `sync://status` 同 payload）。
#[derive(Debug, Clone, Default, serde::Serialize)]
struct SyncUi {
    /// idle | syncing | error
    phase: String,
    last_success_at: Option<String>,
    error: Option<String>,
    /// 本次同步合并落地的记录/设置变更数（records+settings）。
    /// > 0 时前端刷新数据视图——纯推送（无远端变更）不触发重载，避免防抖推
    /// > 每次都 dataVersion++ 引发事件视图无谓重载。
    applied: u32,
}

/// 进程内同步状态（命令可查 + 事件可推）。
#[derive(Default)]
struct SyncUiState(Mutex<SyncUi>);

/// 串行化 full_sync（启动拉 / 防抖推 / 手动同时到达时不并发）。
/// async 锁：guard 需跨 `.await` 持有且 future 须 `Send`。
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn sync_ui_of(app: &tauri::AppHandle) -> SyncUi {
    app.try_state::<SyncUiState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

fn set_sync_ui(app: &tauri::AppHandle, ui: SyncUi) {
    if let Some(state) = app.try_state::<SyncUiState>() {
        if let Ok(mut g) = state.0.lock() {
            *g = ui.clone();
        }
    }
    let _ = app.emit("sync://status", &ui);
}

/// 从 settings 读远端配置构造 S3 客户端。
fn sync_remote_of(state: &SqliteStorage) -> Result<S3Client, String> {
    use mosh_core::sync::engine as eng;
    let get = |k: &str| {
        state
            .get_setting(k)
            .map_err(|e| e.to_string())
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
    };
    let cfg = RemoteConfig {
        endpoint: get(eng::KEY_ENDPOINT).ok_or("未配置 endpoint")?,
        region: get(eng::KEY_REGION).unwrap_or_default(),
        bucket: get(eng::KEY_BUCKET).ok_or("未配置 bucket")?,
        access_key: get(eng::KEY_ACCESS_KEY).ok_or("未配置 access_key")?,
        secret_key: get(eng::KEY_SECRET_KEY).ok_or("未配置 secret_key")?,
        addressing: get(eng::KEY_ADDRESSING).unwrap_or_default(),
        timeout_secs: get(eng::KEY_TIMEOUT)
            .and_then(|s| s.parse().ok())
            .unwrap_or(30),
        tls_verify: get(eng::KEY_TLS_VERIFY)
            .map(|s| s != "false")
            .unwrap_or(true),
    };
    S3Client::new(cfg).map_err(|e| e.to_string())
}

/// 一次完整同步（拉→合→推）并更新 UI 状态。未就绪时静默返回。
async fn run_sync(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<SqliteStorage>() else {
        return;
    };
    if !mosh_core::sync::is_ready(&state) {
        return;
    }
    let _guard = SYNC_LOCK.lock().await;
    let mut ui = sync_ui_of(&app);
    ui.phase = "syncing".into();
    ui.error = None;
    ui.applied = 0;
    set_sync_ui(&app, ui.clone());
    let result = match sync_remote_of(&state) {
        Ok(client) => mosh_core::sync::full_sync(&state, &client)
            .await
            .map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let mut ui = sync_ui_of(&app);
    match result {
        Ok(out) => {
            ui.phase = "idle".into();
            ui.last_success_at = mosh_core::model::now_iso().into();
            ui.error = None;
            ui.applied =
                (out.stats.records_applied + out.stats.settings_applied) as u32;
            // 设置落地可能更新 MCP 服务器配置：后台刷新工具缓存（不阻塞）。
            if out.stats.settings_applied > 0 {
                if let Some(state) = app.try_state::<SqliteStorage>() {
                    refresh_mcp_cache(&app, &state);
                }
            }
        }
        Err(e) => {
            ui.phase = "error".into();
            ui.applied = 0;
            ui.error = Some(e);
        }
    }
    set_sync_ui(&app, ui);
}

/// 启动拉 + 变更防抖推（设计：无轮询，空闲零请求）。
fn spawn_sync_lifecycle(app: tauri::AppHandle) {
    // 启动拉一次。
    tauri::async_runtime::spawn(run_sync(app.clone()));
    // 防抖推：脏标记置位后等 5s（窗口期内连续变更只推一次）。
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if mosh_core::sync::engine::take_dirty() {
                tokio::time::sleep(Duration::from_secs(5)).await;
                run_sync(app.clone()).await;
            }
        }
    });
}

/// 同步配置回显(领域逻辑在 mosh_core::sync::config;含 secret 明文供
/// 前端密文框 + 小眼睛查看——本地单机场景与 access_key 同级凭据)。
/// generated_key 仅在 configure 首次生成加密密钥时由调用方注入一次。
type SyncConfigInfo = mosh_core::sync::config::SyncConfigView;

fn sync_config_info(state: &SqliteStorage) -> SyncConfigInfo {
    mosh_core::sync::config::config_view(state)
}

/// 同步配置输入（secret 可为空 = 保留原值，便于改其他项）。
#[derive(Debug, Clone, serde::Deserialize)]
struct SyncConfigInput {
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    #[serde(default)]
    secret_key: Option<String>,
    /// virtual（默认）| path；缺省 = 保留已存值或默认。
    #[serde(default)]
    addressing: Option<String>,
    #[serde(default)]
    timeout_secs: Option<u64>,
    #[serde(default)]
    tls_verify: Option<bool>,
}

/// 表单输入 → S3 客户端：endpoint 容错（协议前缀 / 完整桶域名前缀）+
/// secret 留空回退已存值（编辑已有配置时）。测试连接与保存配置的
/// 远端探测共用（须先经入参校验）。
fn s3_client_from_input(
    input: &SyncConfigInput,
    state: &SqliteStorage,
) -> Result<S3Client, String> {
    use mosh_core::sync::engine as eng;
    let mut endpoint = normalized_endpoint_of(input);
    let bucket = input.bucket.trim();
    if let Some(rest) = endpoint.strip_prefix(&format!("{}.", bucket)) {
        endpoint = rest.to_string();
    }
    let secret = match input
        .secret_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => s.to_string(),
        None => state
            .get_setting(eng::KEY_SECRET_KEY)
            .map_err(|e| e.to_string())?
            .filter(|s| !s.is_empty())
            .ok_or("SecretKey 未填写且无已保存值")?,
    };
    S3Client::new(RemoteConfig {
        endpoint,
        region: input.region.trim().to_string(),
        bucket: bucket.to_string(),
        access_key: input.access_key.trim().to_string(),
        secret_key: secret,
        addressing: match input.addressing.as_deref() {
            Some("path") => "path".to_string(),
            _ => "virtual".to_string(),
        },
        timeout_secs: input.timeout_secs.unwrap_or(30).clamp(5, 600),
        tls_verify: input.tls_verify.unwrap_or(true),
    })
    .map_err(|e| e.to_string())
}

/// endpoint 规范化：去协议前缀与尾部斜杠。
fn normalized_endpoint_of(input: &SyncConfigInput) -> String {
    input
        .endpoint
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

/// 保存远端配置。endpoint 若填了完整桶域名（含桶名），去掉冗余前缀后存储。
/// 首次保存生成 device_id；密钥策略：
/// - 本机已有密钥 → 保持不变；
/// - 本机没有且远端为空 → 生成新钥（首个设备；返回一次供抄录）；
/// - 本机没有但远端已有同步数据 → **不生成**（自动生成会导致各设备密钥
///   不一致、互相解不开对方备份甚至分叉覆盖远端数据），置
///   `needs_key_import` 要求用户从旧设备导入密钥后才能启用同步。
/// 探测失败（网络/凭证错）时整个保存报错——盲存无法确认远端状态，
/// 正是危险路径；请先「测试连接」排除问题后重试。
#[tauri::command]
async fn sync_configure(
    input: SyncConfigInput,
    state: State<'_, SqliteStorage>,
) -> Result<SyncConfigInfo, String> {
    use mosh_core::sync::engine as eng;
    let mut endpoint = normalized_endpoint_of(&input);
    if endpoint.is_empty() {
        return Err("endpoint 不能为空".into());
    }
    let bucket = input.bucket.trim();
    if bucket.is_empty() {
        return Err("bucket 不能为空".into());
    }
    if input.access_key.trim().is_empty() {
        return Err("access_key 不能为空".into());
    }
    // 用户把控制台的完整桶域名填进 endpoint：去掉 `<bucket>.` 前缀。
    if let Some(rest) = endpoint.strip_prefix(&format!("{}.", bucket)) {
        endpoint = rest.to_string();
    }
    // 寻址风格校验（其余高级项缺省 = 默认值）。
    let addressing = match input.addressing.as_deref() {
        None | Some("") => "virtual",
        Some("virtual") | Some("path") => input.addressing.as_deref().unwrap(),
        Some(other) => return Err(format!("寻址风格仅支持 virtual / path，收到 {other}")),
    };
    let secret = input
        .secret_key
        .as_ref()
        .and_then(|s| if s.trim().is_empty() { None } else { Some(s.clone()) });

    // —— 保存前探测：本机无密钥时必须先弄清远端是否已有同步数据 ——
    let local_key = state
        .get_setting(eng::KEY_SYNC_KEY)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());
    let mut needs_key_import = false;
    let mut generated_key = None;
    if local_key.is_none() {
        let client = s3_client_from_input(&input, &state)?;
        let objects = client.list(eng::KEY_PREFIX).await.map_err(|e| {
            format!("无法确认远端存储状态（{e}）——为避免密钥不一致，本次未保存；请先「测试连接」排除问题后重试")
        })?;
        if objects.is_empty() {
            // 远端为空：本机是首个设备，生成新钥（返回一次供抄录）。
            let export =
                mosh_core::sync::crypto::encode_key(&mosh_core::sync::crypto::generate_key());
            generated_key = Some(export);
        } else {
            needs_key_import = true;
        }
    }

    state
        .set_setting(eng::KEY_ENDPOINT, &endpoint)
        .map_err(|e| e.to_string())?;
    state
        .set_setting(eng::KEY_REGION, input.region.trim())
        .map_err(|e| e.to_string())?;
    state
        .set_setting(eng::KEY_BUCKET, bucket)
        .map_err(|e| e.to_string())?;
    state
        .set_setting(eng::KEY_ACCESS_KEY, input.access_key.trim())
        .map_err(|e| e.to_string())?;
    state
        .set_setting(eng::KEY_ADDRESSING, addressing)
        .map_err(|e| e.to_string())?;
    let timeout = input.timeout_secs.unwrap_or(30).clamp(5, 600);
    state
        .set_setting(eng::KEY_TIMEOUT, &timeout.to_string())
        .map_err(|e| e.to_string())?;
    state
        .set_setting(
            eng::KEY_TLS_VERIFY,
            if input.tls_verify.unwrap_or(true) {
                "true"
            } else {
                "false"
            },
        )
        .map_err(|e| e.to_string())?;
    if let Some(s) = secret {
        state
            .set_setting(eng::KEY_SECRET_KEY, s.trim())
            .map_err(|e| e.to_string())?;
    }
    if state
        .get_setting(eng::KEY_DEVICE_ID)
        .ok()
        .flatten()
        .is_none()
    {
        state
            .set_setting(eng::KEY_DEVICE_ID, &mosh_core::model::new_id())
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref export) = generated_key {
        state
            .set_setting(eng::KEY_SYNC_KEY, export)
            .map_err(|e| e.to_string())?;
    }
    // 导入需求标记随本次保存刷新（已有密钥 = 无需导入）。
    state
        .set_setting(
            eng::KEY_NEEDS_KEY_IMPORT,
            if needs_key_import { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())?;
    let mut info = sync_config_info(&state);
    info.generated_key = generated_key;
    Ok(info)
}

/// 测试连接：用表单当前值（secret 留空 = 用已保存值）LIST 前缀，验证
/// 端点/凭证/签名/权限全链路。返回前缀下已有对象数。
#[tauri::command]
async fn sync_test_connection(
    input: SyncConfigInput,
    state: State<'_, SqliteStorage>,
) -> Result<usize, String> {
    if input.endpoint.trim().is_empty() || input.bucket.trim().is_empty() {
        return Err("请先填写 endpoint 与 bucket".into());
    }
    let client = s3_client_from_input(&input, &state)?;
    let objects = client
        .list(mosh_core::sync::engine::KEY_PREFIX)
        .await
        .map_err(|e| e.to_string())?;
    Ok(objects.len())
}

/// 导出加密密钥（base64 串，粘贴到新设备导入）。
#[tauri::command]
fn sync_export_key(state: State<'_, SqliteStorage>) -> Result<String, String> {
    state
        .get_setting(mosh_core::sync::engine::KEY_SYNC_KEY)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "尚未生成密钥，先保存同步配置".to_string())
}

/// 导入加密密钥（新设备粘贴）。除格式校验外，远端已有数据时尝试解密一份
/// 备份验证匹配——密钥不匹配的远端 dump 会被静默跳过，若不拦截会直接
/// 造成分叉（各推各的、互相看不见），故不匹配时拒绝导入。
/// 远端为空（首个设备换机重设）或探测不可达（离线导入）时不拦截。
#[tauri::command]
async fn sync_import_key(key: String, state: State<'_, SqliteStorage>) -> Result<(), String> {
    use mosh_core::sync::engine as eng;
    let key = key.trim().to_string();
    let decoded = mosh_core::sync::crypto::decode_key(&key).map_err(|e| e.to_string())?; // 先校验格式
    if let Ok(client) = sync_remote_of(&state) {
        if let Ok(objects) = client.list(eng::KEY_PREFIX).await {
            for obj in &objects {
                if !obj.key.ends_with("/dump.bin") {
                    continue;
                }
                match client.get(&obj.key).await {
                    Ok(Some(bytes)) => {
                        if mosh_core::sync::crypto::open(&bytes, &decoded).is_err() {
                            return Err(
                                "导入的密钥无法解密远端已有备份——请确认它复制自同一同步组的设备".into(),
                            );
                        }
                        break; // 一份能解即可
                    }
                    _ => continue, // 取不到（404 等）：试下一份
                }
            }
        }
    }
    state
        .set_setting(eng::KEY_SYNC_KEY, &key)
        .map_err(|e| e.to_string())?;
    // 导入成功即解除「待导入」状态。
    state
        .set_setting(eng::KEY_NEEDS_KEY_IMPORT, "false")
        .map_err(|e| e.to_string())
}

/// 启用/停用同步（停用即不再拉推；数据与密钥保留）。
#[tauri::command]
fn sync_set_enabled(enabled: bool, state: State<'_, SqliteStorage>) -> Result<(), String> {
    state
        .set_setting(
            mosh_core::sync::engine::KEY_ENABLED,
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
}

/// 手动立即同步（设置页「立即同步」/ 标题栏按钮）。与后台 run_sync 一致地
/// 广播 syncing → idle 两阶段，且 applied/messages_applied 取自本次真实
/// 统计——此前沿用上次残留值，会让前端误判「有落地变更」而频繁无谓刷新。
#[tauri::command]
async fn sync_now(app: tauri::AppHandle) -> Result<mosh_core::sync::SyncOutcome, String> {
    let Some(state) = app.try_state::<SqliteStorage>() else {
        return Err("存储不可用".into());
    };
    if !mosh_core::sync::is_ready(&state) {
        return Err("同步未就绪：请先完成配置（含导入密钥）并启用".into());
    }
    let _guard = SYNC_LOCK.lock().await;
    let mut ui = sync_ui_of(&app);
    ui.phase = "syncing".into();
    ui.error = None;
    ui.applied = 0;
    set_sync_ui(&app, ui);
    let client = sync_remote_of(&state)?;
    let outcome = mosh_core::sync::full_sync(&state, &client)
        .await
        .map_err(|e| e.to_string())?;
    let mut ui = sync_ui_of(&app);
    ui.phase = "idle".into();
    ui.last_success_at = mosh_core::model::now_iso().into();
    ui.error = None;
    ui.applied = (outcome.stats.records_applied + outcome.stats.settings_applied) as u32;
    set_sync_ui(&app, ui);
    Ok(outcome)
}

/// 读同步 UI 状态（启动时拉不到事件的补充轮询入口）。
#[tauri::command]
fn sync_get_status(app: tauri::AppHandle) -> Result<SyncUi, String> {
    Ok(sync_ui_of(&app))
}

/// 读同步配置回显。
#[tauri::command]
fn sync_get_config(state: State<'_, SqliteStorage>) -> Result<SyncConfigInfo, String> {
    Ok(sync_config_info(&state))
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

    let tray = TrayIconBuilder::with_id("main")
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
            // 旧版 AI 配置（settings JSON）一次性导入新实体表；幂等。
            if let Err(e) = storage.migrate_legacy_ai_config() {
                eprintln!("[storage] legacy ai config migration failed: {e}");
            }
            app.manage(storage);
            // 同步生命周期：启动拉 + 变更防抖推（未就绪时内部静默跳过）。
            spawn_sync_lifecycle(app.handle().clone());
            // HTTP 客户端（复用连接池）+ 天气内存缓存，注入给 async 命令。
            let client = HttpClient::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("failed to build reqwest client");
            app.manage(client);
            app.manage(WeatherCache::default());
            app.manage(AgentRuns::default());
            app.manage(MemoryAgentLog::default());
            app.manage(McpToolCache::default());
            // MCP 工具缓存预热：启动即后台拉取（发送路径只读缓存，零网络等待）。
            {
                let state = app.state::<SqliteStorage>();
                refresh_mcp_cache(app.handle(), &state);
            }
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
            search_cities,
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
            ai_list_providers,
            ai_upsert_provider,
            ai_delete_provider,
            ai_list_models,
            ai_upsert_model,
            ai_delete_model,
            ai_sync_models,
            ai_get_default_model,
            ai_set_default_model,
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
            mcp_list_tools,
            get_notify_settings,
            save_notify_settings,
            test_email,
            notify_send_email,
            sync_get_config,
            sync_configure,
            sync_test_connection,
            sync_export_key,
            sync_import_key,
            sync_set_enabled,
            sync_now,
            sync_get_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出兑底：未推送的本地变更尽力推一发（≤3s，阻塞可接受；失败静默——
            // 下次启动拉取时 LWW 自然收敛）。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let Some(state) = app.try_state::<SqliteStorage>() else {
                    return;
                };
                if mosh_core::sync::is_ready(&state) {
                    tauri::async_runtime::block_on(async {
                        if let Ok(client) = sync_remote_of(&state) {
                            let _ = tokio::time::timeout(
                                Duration::from_secs(3),
                                mosh_core::sync::full_sync(&state, &client),
                            )
                            .await;
                        }
                    });
                }
            }
        });
}
