# Implement — 子任务 B：Calendar 日程

## 前置
- 子任务 A 地基已交付并验证（`cargo test -p mosh-core`、`clippy`、`npm check/build`、windows-gnu 命令层编译均过）。
- 干净 git；为本子任务建分支：`task.py set-branch 08-12-calendar <branch>`（从含子任务 A 的分支起）。

## 执行清单（有序）

1. **model：全天字段**
   - `EventInput` 加 `all_day: bool`（serde default false）；`RecordPatch` 加 `all_day: Option<bool>`。
   - 助手 `is_all_day` / `set_all_day`（模式同 `set_location`）。
   - 单测：set_all_day 写/读/删。
   - 验证：`cargo test -p mosh-core`。
2. **storage：区间重叠查询**
   - `SqliteStorage::list_events_in_range(from, to)`（design §3）：`start_at < to AND end_at >= from`，NULL 防御。
   - 单测：① 定时窗口内 ② 全天单日 ③ 全天跨多日横跨窗口 ④ 窗口末日深夜定时 ⑤ 窗外（前/后）→ 前四返回、第五不返回。
   - 验证：`cargo test -p mosh-core`。
3. **service：event 创建 + 列出**
   - `build_event`（校验 title；全天 `end>=start` 字符串比较，定时 `end>start` via chrono）、`create_event`、`list_events`（转 storage）；`apply_patch` 加 `all_day` 分支。
   - 单测：定时创建写 location/all_day=false、全天创建写 data.all_day、拒绝空标题、拒绝定时 end<=start、list_events 走重叠查询。
   - 验证：`cargo test -p mosh-core` + `cargo clippy -p mosh-core -- -D warnings`。
4. **IPC 命令**
   - `commands`：`create_event(input)`、`list_events(from, to)`；注册进 `invoke_handler`。
   - 验证：`cargo check --target x86_64-pc-windows-gnu -p mosh` + `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`（本机 glib 不足，用 windows-gnu 验证命令层；见 backend spec）。
5. **前端：类型 + ipc + datetime 工具**
   - `types.ts` 加 `EventInput`（含 `all_day?`）、`RecordData.all_day?`、`RecordPatch.all_day?`；`ipc.ts` 加 `createEvent` / `listEvents`。
   - 抽 `lib/datetime.ts`：`toLocalInput`/`fromLocalInput`/`formatDateTime`/`toDateOnly`/`formatDate`（TodoEditor 迁移复用——先抽再让 TodoEditor 接入）。
   - 验证：`npm run check`。
6. **前端：calendar store**
   - `calendar.svelte.ts`：私有 `_events/_mode/_cursor/_editingId` + 导出函数（`events()/mode()/cursor()/editingEvent()`）+ mutator + `loadRange`（from=首日含、to=末日+1 排他，调 `listEvents`）。**严格遵循 `frontend/state-management` spec 函数导出模式**。
   - 验证：`npm run check && npm run build`（**必须 build**，不只 check）。
7. **前端：EventEditor**
   - 表单：标题/描述/全天复选框/起止（全天→`date`，否则 `datetime-local`）/地点/标签；新建（createEvent）vs 编辑（updateRecord patch，支持切换全天↔定时）；取消（closeEditor）。
   - 验证：`npm run check && npm run build`。
8. **前端：MonthView**
   - 6×7 网格、周一首、翻月；每格全天事件置顶 + 定时随后；全天跨多日逐日显示；点格新建。
   - 验证：`npm run build`。
9. **前端：WeekView + DayView**
   - 顶部全天带 + 24h 时间轴（CSS top/height 定位）；翻页；点空白新建；定时跨日事件截断到当日末显示并注明。
   - 验证：`npm run build`。
10. **前端：AgendaView + CalendarPane + 路由接入**
    - 议程（未来 30 天按日分组，全天事件归 start 日）；CalendarPane（模式切换 + 翻页 + 当前视图 + 挂 EventEditor）；Sidebar 启用「日历」；`+page.svelte` 加 calendar 分支；`View` 类型扩展。
    - 验证：`npm run check && npm run build`。
11. **联调与质量门**
    - 全流程：建定时/全天事件 → 月/周/日/议程查看 → 跨边界事件 → 切换全天↔定时 → 编辑 → 取消 → 软删 → 重启持久化（需可运行平台）。
    - 质量门：`cargo test -p mosh-core`、`cargo clippy -p mosh-core -- -D warnings`、`cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`、`npm run check`、`npm run build` 全过。
    - 回填 spec（如 datetime 工具规范、全天/区间查询约定）。

## 验证命令
- `cargo test -p mosh-core`
- `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`
- `npm run check` / `npm run build`
- `cargo tauri dev`（需 glib≥2.70 平台 / macOS / Windows）

## 风险 / 回滚点
- **区间重叠 SQL 边界**：from 含 / to 排他；NULL 防御；单测覆盖五种情形（含双格式边界）。
- **全天与定时混排**：date-only 与 ISO8601 在同查询比较——依赖排他 `to` 与字典序；单测固化。
- **时区 / 本地日边界**：定时用 UTC 存+本地展；全天 date-only 不换算；窗口边界用本地日。
- **时间轴溢出**：定时跨日事件在周/日视图截断到当日末显示并注明。
- **Svelte 5 store 导出规则**：`calendar.svelte.ts` 必须函数导出（见 frontend spec），勿重蹈 `store.svelte.ts` 覆辙。
- 单步单 commit，便于回滚。
