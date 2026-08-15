# Design — 集成真实天气与设置页

## 1. 架构与边界

```
HomeView (Banner 天气区)  ──read── weather.svelte.ts (store)
        │                            │ getCurrentWeather() / refresh
        │                            ▼
SettingsView (城市下拉)  ────── ipc.ts (强类型封装) ──► Tauri IPC
                                                             │
                          mosh-core::weather (geocode + forecast, reqwest+rustls)
                                                             │
                          mosh-core::storage (settings kv 表 + records 表)
```

- **HTTP 全在后端**：前端永不直连 Open-Meteo，故 **无需改动 `tauri.conf.json` 的 CSP**（Rust 侧请求不受 webview CSP 约束）。
- **城市列表归前端**：预设下拉是纯展示数据 `{ name(中文), query(geocode 串) }`，**不含任何坐标**。后端对 `query` 串通用 geocode，不持有城市表。
- **坐标按需解析并持久化**：首次取天气时 geocode → 存坐标；之后复用。切换城市清空旧坐标。
- **weather_code 文案/图标映射在前端**：后端只回传原始 `u8`。

## 2. 后端：mosh-core::weather

新增模块 `crates/mosh-core/src/weather.rs`，`lib.rs` 加 `pub mod weather;`。

### 2.1 数据结构（serde 导出给前端）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentWeather {
    pub temperature: f64,         // temperature_2m, °C
    pub apparent_temperature: f64,// 体感, °C
    pub humidity: f64,            // relative_humidity_2m, %
    pub weather_code: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeatherConfig {
    pub query: String,                 // geocode 查询串（城市标识）
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub tz: Option<String>,
    // query 非空但 lat 为 None ⇒ 已选城市、尚未解析坐标
}
```

### 2.2 网络函数（async，reqwest + rustls）

- `geocode(client, query) -> Result<(lat,lng,tz)>`：`GET https://geocoding-api.open-meteo.com/v1/search?name=<query>&count=1&language=zh`，取 `results[0]`。无 `results`/空 ⇒ `CoreError::Weather("未找到该城市")`。
- `forecast(client, lat, lng, tz) -> Result<CurrentWeather>`：`GET https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code&timezone=<tz|auto>`，解析 `current.*`。

`reqwest::Client` 在 Tauri `setup` 中构造一次、作为 `State` 注入（复用连接池；配 `timeout` ~10s）。rustls 规避 windows-gnu 交叉编译的 OpenSSL 依赖（见 [[cross-compile-windows]]）。

### 2.3 错误

`CoreError` 新增：
```rust
#[error("weather error: {0}")]
Weather(String),
#[error("network error: {0}")]
Network(String),
```
并为 `reqwest::Error` 实现 `From → CoreError::Network`。

## 3. 持久化：settings kv 表

`storage.rs` 新增第二条迁移 + kv 方法（复用 `rusqlite_migration`）：

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

```rust
fn get_setting(&self, key: &str) -> Result<Option<String>, CoreError>;
fn set_setting(&self, key: &str, value: &str) -> Result<(), CoreError>;
```

- 城市配置存于 key `weather`，value = `serde_json::to_string(&WeatherConfig)`。
- 读写经 `SqliteStorage`（与 records 同库、同 `Mutex`），原子且随现有 DB 一同迁移/备份。

## 4. 缓存与刷新策略

- **坐标缓存 = 持久**：写入 `settings.weather`，重启复用，直到切换城市清空。无 TTL（城市坐标不变）。
- **天气缓存 = 内存 + TTL**：Tauri 注入 `State<WeatherCache>`（`Mutex<Option<WeatherCacheInner>>`），`WeatherCacheInner { query, fetched_at: Instant, data: CurrentWeather }`。
  - 命中条件：`query` 相同且 `fetched_at` 在 ~30min 内 ⇒ 直接返回。
  - 未命中 ⇒ geocode（若需）+ forecast ⇒ 更新缓存。
  - **失败回退**：fetch 失败时若内存缓存存在 ⇒ 返回缓存（视为过期但可用）；否则 `Err`。
- `Instant` 仅进程内（重启即失效），可接受——重启首取会重新 forecast（坐标仍走持久缓存，不重 geocode）。

## 5. IPC 契约（src-tauri/src/lib.rs）

新增命令（`async fn`，与现有同步命令并存）：

| 命令 | 入参 | 返回 | 语义 |
|------|------|------|------|
| `get_weather_config` | — | `Option<WeatherConfig>` | 当前是否已选城市（query 空串⇒None） |
| `set_city` | `{ query: String }` | `()` | 写 `WeatherConfig{query, lat:None,…}`（触发下次 geocode） |
| `get_current_weather` | — | `Result<Option<CurrentWeather>, String>` | None=未配置；Some=有数据(新/缓存)；Err=配置了但取不到且无缓存 |

`get_current_weather` 内部：读 config →（lat 为 None 则 geocode 并回写）→ 内存缓存判定 → forecast/回退。

注册到 `invoke_handler`。

## 6. 前端

### 6.1 ipc.ts（追加强类型封装）
`getWeatherConfig()`、`setCity(query)`、`getCurrentWeather()`，类型放 `types.ts`（`CurrentWeather`、`WeatherConfig`）。

### 6.2 预设城市表（前端常量，无坐标）
`src/lib/cities.ts`：
```ts
export const CITIES = [
  { name: "北京", query: "Beijing" }, { name: "上海", query: "Shanghai" },
  { name: "广州", query: "Guangzhou" }, { name: "深圳", query: "Shenzhen" },
  { name: "杭州", query: "Hangzhou" }, { name: "成都", query: "Chengdu" },
  { name: "武汉", query: "Wuhan" }, { name: "西安", query: "Xian" },
  { name: "南京", query: "Nanjing" }, { name: "重庆", query: "Chongqing" },
  { name: "天津", query: "Tianjin" }, { name: "长沙", query: "Changsha" },
];
// query→name 反查（Banner 显示当前城市名用）
```

### 6.3 weather store：`src/lib/weather.svelte.ts`
模块级 runes：`let _weather = $state<CurrentWeather|null>(null)`、`_status = $state<'idle'|'loading'|'ok'|'error'|'unconfigured'>('idle')`、`_cityName`。导出只读函数 + `loadWeather()`/`refreshWeather()`。HomeView 挂载与城市变更后调用。

### 6.4 设置视图
- `store.svelte.ts`：`View` 加 `"settings"`；`Sidebar.svelte` 的 `items` 增 `{key:"settings", label:"设置"}`（齿轮 svg）；`+page.svelte` 路由增 `{:else if currentView()==="settings"}<SettingsView/>`。
- `src/lib/components/SettingsView.svelte`：`<select>` 渲染 `CITIES`，当前选中回显 `getWeatherConfig().query` 反查；onChange → `setCity(query)` → `loadWeather()`（设置页内即可预览，首页随之响应）。「城市」之外预留扩展位（空 section 占位）。

### 6.5 HomeView 接入
- 删除静态 `WEATHER` 常量；Banner 天气区改为读 weather store：
  - `unconfigured` →「前往设置选择城市」(点击 `setView('settings')`)。
  - `loading` → 占位/上次值。
  - `ok` → `{round(temp)}°  {label}` / `{cityName} · 体感 {round(apparent)}° · 湿度 {humidity}%`。
  - `error` → 错误占位 + 重试。
- 天气图标按 `weather_code` 选 inline svg（晴/多云/阴/雾/雨/雪/雷暴），复用现有 stroke 风格。

### 6.6 weather_code 映射（前端）
`src/lib/weather-code.ts`：`weatherInfo(code): {label, icon}`，覆盖 0,1-3,45,48,61,63,65,71,73,75,77,80,81,82,85,86,95,96,99（对齐用户给的表）。

## 7. 状态矩阵（验收对照）

| 配置 | 网络 | 行为 |
|------|------|------|
| 未选城市 | — | `None`→首页「前往设置」 |
| 已选、无坐标 | geocode 成功 | 解析→存→forecast |
| 已选、无坐标 | geocode 失败 | `Err`→首页错误占位 |
| 已选、有坐标 | forecast 成功 | `Some`（新） |
| 已选、有坐标 | forecast 失败、有缓存 | `Some`（缓存） |
| 已选、有坐标 | forecast 失败、无缓存 | `Err` |

## 8. 关键决策与权衡

- **坐标不内置、按需 geocode 并持久化**（用户定）：兼顾「无硬编码坐标」与「不复读 geocode」。代价：每新城首次多一次调用 + geocode 偶发失败需错误态（已覆盖）。
- **城市表归前端、后端通用 geocode**：后端无需城市表，契约最小；前端 `{name,query}` 是名字串非坐标，符合约束。
- **weather_code 映射在前端**：贴近 UI、改图标免重编 Rust。
- **reqwest+rustls**：windows-gnu 交叉编译友好（无 OpenSSL）。
- **天气缓存内存级**：简单；重启重取（坐标持久，成本仅一次 forecast）。

## 9. 回滚

- 后端：移除 `weather` 模块/命令/迁移方法/reqwest 依赖；settings 表保留无害（或加 down 迁移）。
- 前端：`View` 去 `settings`、还原 Sidebar、删 SettingsView/weather store/cities/weather-code；HomeView 还原静态 `WEATHER`。
- 均为增量文件 + 小改 3 处（lib.rs / storage.rs / model 无改），git revert 干净。
