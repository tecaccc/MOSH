# Journal - connor (Part 1)

> AI development session journal
> Started: 2026-08-12

---

## 2026-08-13 — 子任务 B（Calendar）前端完成

后端（model/storage/service/ipc）已先于本日提交（`bd00267`）。本日完成
implement.md 步骤 5–10 的全部前端工作并合入步骤 11 质量门：

- 抽 `lib/datetime.ts`（双时间格式：定时 ISO↔datetime-local、全天 date-only 不换算），
  TodoEditor 迁移复用。
- `lib/calendar-grid.ts`：纯网格运算。关键约定——周一首；`eventOnDay` 用
  `toDateOnly` 归一后闭区间重叠（全天 end_at 含当天）；`timedBlockOnDay` 把跨日
  定时事件截断到当日 `[0,1440]`；`layoutTimedDay` 簇内贪婪分道使重叠事件并排。
- `calendar.svelte.ts` store 严格遵循函数导出模式（私有 _events/_mode/_cursor/
  _editingId）；`loadRange` 按 mode+cursor 算 `from`含/`to`排他 窗口调 `listEvents`。
- 四视图：Month（6×7 全天置顶）、Week/Day（共用 TimeGrid：全天带 + 24h 时间轴）、
  Agenda（30 天按日分组，全天归 start 日）。
- EventEditor 全天复选框即时切换 date↔datetime-local；+page 右栏统一挂
  EventEditor/TodoEditor。

质量门全过：`cargo test -p mosh-core`(34) / clippy(mosh-core + windows-gnu
`--all-targets -D warnings`) / `npm run check`(0) / `npm run build`。
提交：`11c6d8f`。新增 spec `frontend/calendar.md`。

**待办**：运行时 e2e（建事件→月/周/日/议程→跨边界→切换全天↔定时→编辑→软删→
重启持久化）需在 glib≥2.70 平台跑 `cargo tauri dev`，本机 glib 2.68.4 不足。
与 08-12-todo 同样留 in_progress 待运行时验证。

---


## Session 1: Agent v1 实现：聊天面板+工具循环

**Date**: 2026-08-15
**Task**: Agent v1 实现：聊天面板+工具循环
**Branch**: `feat/08-12-calendar`

### Summary

完成 08-15-agent-v1 主体：agent_messages 迁移、mosh-core agent 模块（OpenAI 兼容 SSE 客户端/6 工具注册/循环+abort/事件协议）、src-tauri 10 命令、前端 ChatPanel+设置卡片+侧栏入口。55 测试全绿，质量门全过。

### Git Commits

| Hash | Message |
|------|---------|
| `wip` | (see git log) |

### Status

[OK] **Completed**
