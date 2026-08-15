# 集成真实天气与设置页

## Goal

把首页 Banner 的天气区从静态占位换成真实天气（Open-Meteo），并新增一个**设置页**作为本应用所有可配置项的统一入口，首个可配置项是「城市」。用户改城市后，首页天气随之刷新。

## Background / Confirmed Facts

- **数据源**：Open-Meteo，无需 API key，CORS 友好（但我们不在前端直连）。
- **两步调用**：① `geocoding-api.open-meteo.com/v1/search?name=<city>&count=1&language=zh` 取 `latitude/longitude/timezone`（及中文名）；② `api.open-meteo.com/v1/forecast?latitude=&longitude=&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code&timezone=auto` 取当前天气。
- **已确认决策（不再变动）**：
  1. HTTP 走 **Rust 后端 IPC**：`mosh-core` 新增 reqwest，暴露 `#[tauri::command]`（同步契约，内部异步 + 缓存）。
  2. **MVP 数据范围 = 仅当前天气**：`temperature_2m`、`weather_code`、`apparent_temperature`、`relative_humidity_2m`。
  3. **新增设置页**，承载所有可配置项；首个是「城市」。
- **现有架构（已调研，作为技术约束）**：
  - 后端：`src-tauri/src/lib.rs` 是 Tauri 薄壳（命令绑定 + `State<SqliteStorage>`）；领域逻辑在 `crates/mosh-core`（`model/service/storage/error`）。`storage.rs` 用 `rusqlite` + `rusqlite_migration`，单条 `records` 表迁移。`CoreError` 是 thiserror 枚举。当前命令全同步、无 HTTP 依赖。workspace deps：serde/serde_json/chrono/uuid/thiserror。
  - 前端：`src/lib/ipc.ts`（invoke 强类型封装）、`src/lib/store.svelte.ts`（Svelte5 runes 全局状态）。`src/routes/+page.svelte` 用 `currentView` 切 `home/today/calendar` 三视图；侧栏 `Sidebar.svelte` 的 `items` 数组驱动导航。`HomeView.svelte` Banner 顶部有静态 `WEATHER` 常量占位（`28°C  晴 / 深圳 · 体感温度 30°C · 湿度 65%`）。

## Requirements

### R1 后端天气模块（mosh-core）
- 新增 `weather` 模块：geocoding（城市查询串→经纬度/timezone）+ forecast（经纬度→当前天气），返回结构化结果（含原始 `weather_code: u8`）。
- **坐标按需解析、持久复用**：不内置任何城市坐标。首次为某城市取天气时调 geocoding 解析 lat/lng/timezone 并写入配置；后续调用（含重启）直接复用已存坐标，不再 geocode。切换城市时清空旧坐标、对新城市首次解析。
- geocoding 无结果时返回明确错误（「未找到该城市」）。
- 网络异常时：回退上次成功结果（若有缓存），否则返回错误。

### R2 配置持久化
- 持久化「城市」配置（城市展示名 + 解析得到的经纬度 + timezone），应用重启后保留。
- 技术选型见 design.md（倾向 SQLite 新增 `settings` kv 表，复用迁移模式）。

### R3 IPC 命令
- 暴露命令：获取当前天气（按已配置城市）、读取/写入城市配置。前端经 `ipc.ts` 强类型封装调用。

### R4 前端：设置页
- 新增设置视图，作为可配置项统一入口；MVP 含「城市」一项。
- **入口**：侧栏新增第四项「设置」（齿轮图标），与 首页/今日/日历 并列；移动端窄栏同样收成图标。
- **城市选择 UX**：预置常用城市下拉（北京/上海/广州/深圳/杭州/成都/武汉/西安/南京/重庆 等约 10–12 个）。选中即作为当前城市（保存配置 → 触发首页天气刷新）。不做自由文本输入与校验。
- 设置页结构留出扩展位（后续主题/关于等）。

### R5 前端：首页接入
- 用真实天气替换 `HomeView` 的静态 `WEATHER` 占位：温度（取整 °C）、天气文案、体感温度、湿度。
- `weather_code` → 中文文案（与图标）的映射。
- 加载中 / 失败 / 未配置城市 三种状态有可读呈现。

## Acceptance Criteria

- [ ] 首次进入：未配置城市时，Banner 天气区显示引导态（如「点此设置城市」或占位），不崩溃。
- [ ] 在设置页输入一个真实城市（如「杭州」）并保存 → 首页 Banner 显示该城市当前温度、天气文案、体感、湿度，与 Open-Meteo 实际返回一致。
- [ ] 重启应用后，城市配置与上次天气仍可用（配置持久化 + 缓存回退）。
- [ ] 输入不存在的城市名 → 得到「未找到该城市」类提示，不写入无效配置。
- [ ] 断网/接口异常 → 不崩；优先显示上次缓存天气，否则显示错误占位。
- [ ] `npm run check` 0 错误 0 警告；Rust `cargo test`/`cargo clippy` 通过；`npm run build` 通过。

## Out of Scope

- 多日/逐小时预报（仅 current）。
- 自动定位（GPS/IP 定位）——MVP 仅手动设置城市。
- 天气定时后台刷新/推送。
- 设置页其它配置项（主题、关于等）——仅留入口结构，本次只实现「城市」。
- 国际化（i18n）框架——仅硬编码中文文案。

## Open Questions

- 无（用户决策已全部收敛：后端 IPC / 仅当前天气 / 侧栏「设置」+预设下拉 / 坐标按需 geocode 并持久复用）。剩余为技术实现细节，见 design.md。

## Technical Notes（待 design.md 细化）

- 配置持久化：倾向 SQLite `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` kv 表 + 新迁移；与 `SqliteStorage` 一致、原子、可扩展。
- 缓存：后端内存缓存 + TTL（约 30min）节流；失败回退上次成功结果。
- `weather_code` 映射：后端返回原始 `u8` code，中文文案/图标映射放前端（贴近 UI、易调整、避免重编译 Rust）。
- 错误：`CoreError` 新增 `Network`/`Weather` 变体。
