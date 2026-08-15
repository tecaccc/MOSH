# Implement — 集成真实天气与设置页

> 执行方式：**内联实现**（本会话直接编码，不经子代理 dispatch），故跳过 implement.jsonl/check.jsonl 门；Phase 2 通过 `trellis-before-dev` 加载 spec。每道质量门用「验证命令」标出。

## 预检

- [ ] 运行 `trellis-before-dev` 加载 backend/frontend spec（编码规范、迁移写法、IPC 命名陷阱）。
- [ ] 确认当前在 `feat/08-12-calendar` 分支（继续用，不另开）。

## Phase A — 后端（mosh-core + src-tauri）

1. [ ] `crates/mosh-core/Cargo.toml` 加 `reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }`。
   - 门：`cargo build -p mosh-core`（验证 rustls 在本机编译；若失败查 features）。
2. [ ] `crates/mosh-core/src/error.rs`：加 `Weather(String)`、`Network(String)` 变体；`impl From<reqwest::Error> for CoreError`（→ Network）。
   - 补一条单测：reqwest 错误转 `Network`。
3. [ ] `crates/mosh-core/src/storage.rs`：
   - 迁移 `M::up("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")`（追加到现有 `Migrations::new` vec）。
   - `get_setting(&self,key)->Result<Option<String>>`、`set_setting(&self,key,value)->Result<()>`（INSERT OR REPLACE）。
   - 单测：open_in_memory → set/get 往返、默认 None、覆盖写入。
   - 门：`cargo test -p mosh-core storage`。
4. [ ] `crates/mosh-core/src/weather.rs`（新文件）：
   - `CurrentWeather`、`WeatherConfig`（serde，见 design §2.1）。
   - `pub async fn geocode(client, query) -> Result<(f64,f64,String)>`。
   - `pub async fn forecast(client, lat, lng, tz) -> Result<CurrentWeather>`。
   - 端点/参数对齐 design §2.2；无结果→`CoreError::Weather("未找到该城市")`。
   - 门：`cargo build -p mosh-core`；可加一个 `#[ignore]` 的真实联测（需网络，CI 默认跳过）。
5. [ ] `crates/mosh-core/src/lib.rs`：`pub mod weather;`（类型经 `mosh_core::weather::...` 导出）。
6. [ ] `src-tauri/src/lib.rs`：
   - `WeatherCache` 结构（`Mutex<Option<{query, fetched_at: Instant, data: CurrentWeather}>>`）+ `Default`。
   - `setup` 里 `app.manage(reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?)` 与 `app.manage(WeatherCache::default())`。
   - `async fn get_weather_config(state) -> Option<WeatherConfig>`：读 `settings` key `weather`，解析；query 空→None。
   - `async fn set_city(query, storage) -> ()`：写 `WeatherConfig{query,lat:None,…}`（覆盖，清坐标）。
   - `async fn get_current_weather(client, cache, storage) -> Result<Option<CurrentWeather>,String>`：实现 design §4 缓存/回退/按需 geocode（geocode 成功后 `set_setting` 回写坐标）。
   - 三个命令加入 `invoke_handler`。
   - 门：`cargo build`（src-tauri）；`cargo clippy` 无新 warning。

## Phase B — 前端

7. [ ] `src/lib/types.ts`：加 `CurrentWeather`、`WeatherConfig` 接口。
8. [ ] `src/lib/ipc.ts`：`getWeatherConfig()`、`setCity(query)`、`getCurrentWeather()`（注意 invoke 参数 key camelCase）。
9. [ ] `src/lib/cities.ts`（新）：`CITIES`（name+query，无坐标）+ `queryToName` 反查。
10. [ ] `src/lib/weather-code.ts`（新）：`weatherInfo(code)->{label,icon}`。
11. [ ] `src/lib/weather.svelte.ts`（新 store）：`_weather/_status/_cityName` 模块私有 `$state`；导出 `weather()`、`weatherStatus()`、`cityName()`、`loadWeather()`、`refreshWeather()`。
    - 门：`npm run check`。
12. [ ] `src/lib/store.svelte.ts`：`View` 加 `"settings"`。
13. [ ] `src/lib/components/SettingsView.svelte`（新）：`<select>` 渲染 CITIES，回显当前 config；onChange→`setCity`→`loadWeather`；预留扩展位。
14. [ ] `src/lib/components/Sidebar.svelte`：`items` 增 `{key:"settings",label:"设置"}` + 齿轮 svg 分支。
15. [ ] `src/routes/+page.svelte`：路由 `{:else if currentView()==="settings"}<SettingsView />`。
16. [ ] `src/lib/components/HomeView.svelte`：删静态 `WEATHER`；Banner 天气区接 weather store（unconfigured/loading/ok/error 四态 + 图标）；挂载调 `loadWeather()`，城市变更后刷新。
    - 门：`npm run check`（0 错 0 警）；`npm run build`。

## Phase C — 终检

- [ ] `cargo test -p mosh-core` 全绿。
- [ ] `cargo clippy -p mosh-core -- -D warnings`（按项目既有严格度）。
- [ ] `npm run check` 0/0；`npm run build` 通过。
- [ ] 本机 windows-gnu 交叉编译烟测（按 [[cross-compile-windows]]：`cargo build --target x86_64-pc-windows-gnu --no-bundle` 或项目既有命令），确认 rustls 不引入新坑。
- [ ] （可选）`cargo tauri dev` 手测：设置页选「杭州」→ 首页 Banner 显示真实天气；重启后城市/坐标保留；断网有错误占位不崩。

## 风险点 / 回滚锚

- **storage.rs 迁移**：追加式 `CREATE TABLE settings`；若已发版到带库环境，不可改历史迁移——本任务首次引入，可直接加。回滚：保留空表无害。
- **reqwest 依赖**：体积/编译时长增加；rustls 选型为交叉编译安全。若 rustls-tls feature 名变动，回退到 `rustls-tls-native-roots` 等。
- **src-tauri setup state 注入**：`Client`/`WeatherCache` 必须在 `invoke_handler` 注册前 `manage`；遗漏→命令拿不到 State 运行期 panic。
- **Svelte5 runes 导出限制**（见 store.svelte.ts 顶部注释）：weather store 同样只能导出函数，不得导出 `$state`/`$derived`。
- **Tauri 命令参数 key**：`set_city` 前端须用 `query` 作 key（snake 一致即可，单参数无 camelCase 陷阱；多参数时留意 [[ipc]] 注释）。

## task.py start 前确认

- [ ] prd.md 已过 convergence pass（无遗留 Open Question、无重复事实）。
- [ ] design.md / implement.md 齐备（复杂任务必需，✓）。
- [ ] 用户已显式批准下方最终规划摘要。
