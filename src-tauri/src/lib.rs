//! Tauri 命令层：薄壳，仅做命令绑定 + DB 连接管理。
//!
//! 所有领域逻辑在 `mosh-core`；此处 `#[tauri::command]` 函数把前端 IPC
//! 参数转发到 `service` / `storage`，并用 `.map_err(|e| e.to_string())`
//! 把 `CoreError` 转成前端可读字符串。`State<SqliteStorage>` 在 `setup`
//! 中由 `app_data_dir/mosh.sqlite` 打开并注入。

use mosh_core::agent::{self, AgentEvent, AiConfig, LlmClient};
use mosh_core::model::{EventInput, Record, RecordFilter, RecordPatch, Status, TodoInput};
use mosh_core::service;
use mosh_core::storage::{AgentMessage, AgentSessionSummary, SqliteStorage};
use mosh_core::weather::{CurrentWeather, HttpClient, WeatherConfig};
use std::collections::HashMap;
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

/// 全部会话运行态（setup 注入）。
#[derive(Default)]
struct AgentRuns(Mutex<HashMap<String, AgentRun>>);

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
        let mut map = runs.0.lock().map_err(|e| e.to_string())?;
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
    let app_for_events = app.clone();
    let on_event = move |e: AgentEvent| {
        let name = match &e {
            AgentEvent::Start { .. } => "agent://start",
            AgentEvent::Delta { .. } => "agent://delta",
            AgentEvent::Tool { .. } => "agent://tool",
            AgentEvent::End { .. } => "agent://end",
        };
        let _ = app_for_events.emit(name, &e);
    };

    // run_turn 内部已保证 End 事件恰好一次（含错误/中断），此处 Err 仅日志级。
    let result = agent::run_turn(
        &state,
        &client,
        &session_id,
        message.trim(),
        &turn_id,
        &on_event,
        &abort,
    )
    .await;

    if let Err(e) = &result {
        eprintln!("[agent] turn {turn_id} storage failure: {e}");
    }
    // 释放运行槽。
    if let Ok(mut map) = runs.0.lock() {
        if let Some(run) = map.get_mut(&session_id) {
            run.running = false;
        }
    }
    result.map_err(|e| e.to_string())
}

/// 中止某会话的在迷轮（步/工具边界检查，已落库操作保留）。
#[tauri::command]
fn agent_abort(session_id: String, runs: State<'_, AgentRuns>) -> Result<(), String> {
    let map = runs.0.lock().map_err(|e| e.to_string())?;
    if let Some(run) = map.get(&session_id) {
        run.abort.store(true, Ordering::Relaxed);
    }
    Ok(())
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
    let json = state
        .get_setting("ai_model")
        .map_err(|e| e.to_string())?;
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
    state.list_agent_messages(&session_id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 解析 app_data_dir，创建目录，打开（或新建）数据库并跑迁移。
            // 启动期失败直接 panic 带清晰信息（v1 可接受）。
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("mosh.sqlite");
            let storage = SqliteStorage::open(&db_path)
                .expect("failed to open mosh database at app_data_dir/mosh.sqlite");
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
            agent_send,
            agent_abort,
            get_ai_config,
            set_ai_config,
            list_ai_providers,
            save_ai_provider,
            delete_ai_provider,
            list_ai_models,
            test_ai_connection,
            list_agent_sessions,
            list_agent_messages
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
