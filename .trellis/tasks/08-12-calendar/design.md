# Design — 子任务 B：Calendar 日程

## 1. 复用与新增边界

```
已就绪（子任务 A 预留）：              本任务新增：
 model: Kind::Event ✓                  model: EventInput.all_day / RecordPatch.all_day
 model: EventInput ✓                   model: is_all_day / set_all_day 助手
 model: RecordPatch(start/end/loc) ✓   service: build_event / create_event / list_events
 model: RecordFilter(kind/date) ✓      storage: list_events_in_range（区间重叠）
 storage: get/update/soft_delete ✓     ipc: create_event / list_events
 ipc: list_records/update/delete ✓     frontend: calendar store + 4 视图 + EventEditor
                                       Sidebar: 启用「日历」
```

## 2. 数据模型（无表结构变更）

复用 `records` 表，`kind='event'`。Event 专属：
- `start_at` / `end_at`：必填。两种形态：
  - **定时**：ISO8601 UTC（`...T09:00:00Z`）；`end > start`。
  - **全天**：date-only `YYYY-MM-DD`；`end >= start`（end 含当天，可跨多日）。
- `data.all_day`：bool（全天标记）；`data.location`：可选字符串。
- `status`：`active` | `cancelled`（复用 `Status`）。

模型新增（`model.rs`）：
- `EventInput` 加 `#[serde(default)] pub all_day: bool`。
- `RecordPatch` 加 `#[serde(default, skip_serializing_if="Option::is_none")] pub all_day: Option<bool>`。
- 助手 `is_all_day(record) -> bool`（读 `data.all_day`）、`set_all_day(data: &mut Value, bool)`（写/删 `data.all_day`），模式同 `set_location`。

`EventInput` 其余字段已定义（`model.rs:91-103`）。

## 3. 存储区间查询（关键新增）

**问题**：`build_list_query`（`storage.rs:265`）的 `date_from/date_to` 仅过滤 `end_at`，是「到期点过滤」，对日历不够——需区间重叠，否则跨边界/多日事件丢失。

**方案**：新增 `list_events_in_range`，**不改**现有 `list`（避免影响 todo）。

**重叠 + 双格式规则**（已逐边界验证）：前端传 **from = 窗口首日（date-only，含）、to = 窗口末日 + 1 天（date-only，排他）**。查询：
```sql
SELECT * FROM records
WHERE kind='event' AND deleted_at IS NULL
  AND start_at IS NOT NULL AND end_at IS NOT NULL
  AND start_at < ?to   -- 排他上界
  AND end_at   >= ?from -- 含下界
ORDER BY start_at ASC
```
字典序比较对两种格式同时成立：date-only 是当日任意 ISO8601 串的前缀；排他 `to`（次日）确保窗口末日深夜定时事件（`2026-08-31T23:..Z` < `2026-09-01`）被纳入；含 `from` 确保窗口首日全天事件（`2026-08-01` >= `2026-08-01`）被纳入。

```rust
impl SqliteStorage {
    pub fn list_events_in_range(&self, from: &str, to: &str) -> Result<Vec<Record>, CoreError>;
}
```

单测（:memory:）：① 定时事件窗口内 ② 全天单日 ③ 全天跨多日横跨窗口 ④ 定时事件落在窗口末日深夜 ⑤ 完全在窗口外（前/后）→ 前四种返回、第五种不返回。

## 4. mosh-core service 新增

```rust
fn build_event(input: EventInput) -> Result<Record, CoreError> {
    // title 非空校验。
    // if all_day: start/end 为 date-only，校验 end >= start（字符串比较即可）。
    // else       : start/end 为 ISO8601，校验 end > start（chrono 解析比较；无法解析→Validation）。
    // data 写入 location（若有）、all_day（若 true）。
}
pub fn create_event(db: &SqliteStorage, input: EventInput) -> Result<Record, CoreError>;
pub fn list_events(db: &SqliteStorage, from: &str, to: &str) -> Result<Vec<Record>, CoreError>;
```

`apply_patch` 增 `all_day` 分支（调 `set_all_day`）。**取消事件**复用 `update_record(id, RecordPatch{status: Some(Cancelled)})`，不新增命令。

校验注意：`start_at`/`end_at` 必填（`EventInput` 为 `String`）；定时事件用 `chrono::DateTime::parse_from_rfc3339`，全天用 date 字符串比较（`end >= start`）。

## 5. IPC 契约（新增 2 条，其余复用）

- `create_event(input: EventInput) -> Record`（新）
- `list_events(from: String, to: String) -> Vec<Record>`（新；from 含 / to 排他）
- 复用：`get_record` / `update_record`（改时间/全天/地点/标题/状态）/ `delete_record`（软删）

注册到 `invoke_handler`。

## 6. 前端结构

新增 `src/lib/calendar.svelte.ts`（独立 store，遵循 `frontend/state-management` spec 的**函数导出**模式——不导出被重赋值的 `$state`/`$derived`）：
- 私有状态：`_events`、`_mode`（`month|week|day|agenda`）、`_cursor`（聚焦日期）、`_editingId`（`string|null|undefined`）。
- 导出函数（响应式读取）：`events()` / `mode()` / `cursor()` / `editingEvent()`。
- mutator：`setMode` / `moveCursor(delta)` / `loadRange()`（按视图算窗口：from=首日、to=末日+1，调 `listEvents`）/ `createEvent` / `updateEvent` / `cancelEvent` / `deleteEvent` / `startCreateEvent(date?)` / `startEditEvent(id)` / `closeEditor`。

视图组件（`src/lib/components/calendar/`）：
- `CalendarPane.svelte`：模式切换 + 翻页 + 当前视图 + EventEditor 挂载。
- `MonthView.svelte`：6×7 网格（周一首）；每格列当日事件（全天置顶，定时随后）；翻月；点格 → 当日新建。
- `WeekView.svelte`：顶部「全天带」（7 列各列当日全天事件）+ 下方 7 列 × 24h 时间轴（定时事件 CSS top/height 定位）。
- `DayView.svelte`：全天带 + 单日时间轴。
- `AgendaView.svelte`：未来 30 天事件按日分组列表（全天事件归其 start 日）。
- `EventEditor.svelte`：标题/描述/**全天复选框**/起止/地点/标签；全天时起止用 `<input type="date">`（值 date-only），否则 `datetime-local`；新建 vs 编辑；切换全天↔定时。

路由：`View` 类型扩 `"today" | "tasks" | "calendar"`；`+page.svelte` 加 calendar 分支（渲染 `CalendarPane`）；Sidebar 启用「日历」并 `setView("calendar")`。

`types.ts`：加 `EventInput`（含 `all_day?: boolean`）；`RecordData` 加 `all_day?: boolean`；`RecordPatch` 加 `all_day?: boolean`。`ipc.ts`：加 `createEvent` / `listEvents`。

## 7. 日期 / 时区

- 定时事件：存 UTC ISO8601；输入 `datetime-local`（本地）→ `new Date(x).toISOString()`；展示 ISO→本地 `Date`→格式化。
- 全天事件：存 date-only；输入 `<input type="date">`（值即 `YYYY-MM-DD`）；展示直接用 date，**不做时区换算**。
- 窗口边界（`loadRange`）：本地日 → from=`YYYY-MM-DD`（首日，含）、to=`YYYY-MM-DD`（末日+1，排他）。
- 月网格首格：当前月首日所在周的**周一**。

## 8. 权衡

| 决策 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 全天存储 | date-only + `data.all_day` | 本地日概念，免时区换算；与 ISO8601 共用一条区间查询 | 全天也存完整 ISO（涉跨时区，复杂） |
| 区间查询 | 新增 `list_events_in_range`（from 含 / to 排他） | 现有 end_at 过滤丢跨边界事件；排他 to 解决双格式边界 | 客户端拉全集过滤 |
| 取消事件 | 复用 `update_record(status)` | 避免冗余命令 | 新增 `set_event_status` |
| 多日全天渲染 | 月/周逐日显示 | v1 简单正确 | 连续横条 spanning（后续） |
| store 分离 | 新建 `calendar.svelte.ts` | 关注点分离；遵循函数导出规范 | 并入 `store.svelte.ts` |
| 时间轴实现 | 纯 CSS 定位（top/height） | v1 够用，无重依赖 | 引入日历库（后续） |
| 周首日 | 周一 | 用户确认 | — |

## 9. 兼容 / 回滚

- 无表结构变更（仅新 Rust 方法/字段 + 前端组件），完全向后兼容；`all_day` 字段 `#[serde(default)]`，旧数据无影响。
- 单步单 commit（见 `implement.md`），出错 `git checkout` 对应提交回滚。
- 质量门同子任务 A。
