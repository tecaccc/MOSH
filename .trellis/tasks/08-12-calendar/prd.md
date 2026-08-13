# 子任务 B：Calendar 日程

> 父任务：`08-12-v1-todo-calendar`。在子任务 A（Todo + 共享地基）之上增加 `Event` 类型与日历视图，复用 A 的统一 Record 底座、`mosh-core`、SQLite、IPC、前端壳。

## Goal

在 MOSH 中实现日程（Event）管理：CRUD 事件（标题 / 描述 / 起止时间或全天 / 地点 / 标签），并提供**日 / 周 / 月 / 议程**四种视图。事件与待办共享同一 `records` 表（`kind = event`）。

## Background / 复用现状

子任务 A 已提前为 event 预留，大部分模型已就绪：
- `model.rs`：`Kind::Event`、`EventInput { title, description, start_at, end_at, location, tags }`、`location_of`/`set_location`、`RecordPatch`（含 start_at/end_at/location/status）均已存在。
- `storage.rs`：通用 `list(filter)` / `get` / `update` / `soft_delete` 可直接用于 event。
- `service.rs`：`update_record` / `soft_delete` 通用；`apply_patch` 已处理 start_at/end_at/location/status。
- IPC：`list_records` / `update_record` / `delete_record` 通用；缺 `create_event` / `list_events`。
- 前端：`Sidebar` 的「日历」项当前禁用占位；无日历视图与 EventEditor。

## Requirements

### Event 功能
- **E1** CRUD：创建 / 读取 / 更新 / 删除（软删，复用 `delete_record`）。
- **E2** 字段：标题（必填）、描述（markdown）、起止（start_at/end_at，必填）、**全天开关（all_day）**、地点（可选）、标签。
  - 定时事件：start_at/end_at 为含时间的 ISO8601（UTC），end > start。
  - 全天事件：start_at/end_at 为 date-only `YYYY-MM-DD`（end 含当天，可跨多日）；标记 `data.all_day=true`。
- **E3** 状态：`active` / `cancelled`（取消）；通过 `update_record` 设状态。cancelled 事件在视图中弱化显示（划线/置灰），不隐藏。
- **E4** 视图：**月**（6×7 网格，周一首）、**周**（7 天 × 时间轴 + 顶部全天带）、**日**（单日时间轴 + 全天带）、**议程**（未来 N 天按日分组列表）。视图内可切换；默认月视图。
- **E5** 区间查询正确性：事件与可视窗口**重叠**即应显示——多日事件、跨窗口边界事件必须正确；全天与定时事件**共用同一条区间查询**且边界判对（含窗口末日深夜的定时事件）。
- **E6** 持久化：落 SQLite，重启不丢。
- **E7** 导航：Sidebar「日历」启用，与「今日 / 任务」并列切换。

### 约束
- 无重复、无提醒/通知、无拖拽改时、无邀请人管理（v1 全局推迟）。
- 时区：定时事件存 UTC ISO8601，展示本地；全天事件为「本地日」概念，存 date-only，展示不涉时区换算。
- 多日全天事件在月视图按「逐日显示」呈现（v1 不做连续横条 spanning）。

## Acceptance Criteria

- [ ] 可创建带全部字段的**定时**事件与**全天**事件，并在月视图中可见。
- [ ] 全天事件可跨多日；在月/周/日视图中正确分布于各天。
- [ ] 周/日视图有顶部「全天带」，全天事件不挤进时间轴。
- [ ] 跨越多日 / 跨越可视窗口边界的事件（定时与全天）在月/周视图中正确呈现（不丢失，含窗口末日深夜定时事件）。
- [ ] 月视图可前后翻月；周/日可前后翻；议程列出未来事件。
- [ ] 可编辑事件（改时间/全天/地点/标题等），更新持久化；可在定时↔全天间切换。
- [ ] 可取消事件（status=cancelled），视图弱化显示。
- [ ] 可软删事件，不出现在视图但保留于库。
- [ ] 日/周/月/议程四种视图均可切换且渲染正确。
- [ ] Sidebar「日历」启用，与今日/任务并列。
- [ ] `mosh-core` 新增 event service/存储方法有单测覆盖（创建校验含全天、区间重叠查询含全天与边界）。
- [ ] 重启应用后事件数据完整。

## Out of Scope（本子任务不做）

- 重复事件、提醒/通知、邀请人/出席者管理、拖拽改时、ICS 导入导出、CalDAV/Google 集成。
- Todo 与 Event 联动（如把 todo 拖进日历变事件）。
- 多日全天事件的连续横条 spanning 渲染（v1 逐日显示即可）。
- 全天事件与时区的严格跨时区正确性（v1 全天为本地日概念，存 date-only）。

## Dependencies / Notes

- 强依赖子任务 A 的地基（已完成并验证编译/构建）。
- 关键设计点：storage 现有日期过滤仅按 `end_at`（见 `storage.rs` `build_list_query`），**不足以**做日历区间重叠查询，需新增方法（见 design §3）。
- 全天事件存储/查询规则见 design §2/§3。
- 数据模型 / IPC 契约 / 视图架构见 `design.md`；执行步骤见 `implement.md`。
