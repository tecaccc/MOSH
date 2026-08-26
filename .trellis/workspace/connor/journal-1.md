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


## Session 2: React 迁移：Svelte 全量重写为 React19+zustand+streamdown

**Date**: 2026-08-15
**Task**: React 迁移：Svelte 全量重写为 React19+zustand+streamdown
**Branch**: `react-migration`

### Summary

基线入库(agent+SSE修复+markdown)后建 react-migration 分支：Vite+React19 脚手架、5 个 zustand store、19 组件 CSS Modules 移植、ChatPanel 接 streamdown、spec 全面 React 化。tsc+build+cargo 60/60 全绿。

### Git Commits

| Hash | Message |
|------|---------|
| `c5f1078` | (see git log) |

### Status

[OK] **Completed**

## Session: AI 聊天图片上传 + 发送回复延迟修复

**Date**: 2026-08-26
**Task**: `08-26-chat-images-latency`
**Branch**: main（工作区直接实现）

### Summary

TODO 两项：① 聊天支持图片——前端选图/粘贴/拖拽 + 本地压缩（1600px/JPEG/≤1.5MB/≤4张），
`agent_send` 增 images 参数，`agent_messages` v7 加 images 列（同步随行携带，
新旧版本 serde 双向兼容），ChatMessage 带图时组装 OpenAI vision content 数组
（无图线格式不变），上下文仅回放最近 3 条带图消息防 token 膨胀。
② 延迟根因是 agent_send 每条消息都对每台启用 MCP 服务器同步串行
initialize+tools/list（单台最长 20s）拖住 LLM 首包——改为 McpToolCache 内存缓存：
启动预热/配置变更/同步落地设置即后台刷新，发送路径只读缓存零网络等待
（stale-while-revalidate；冷缓存本轮跳过）。前端补首包前三点「思考中」动画。
顺带清 4 个存量 clippy 警告恢复 -D warnings 门。

### 质量门

`cargo test -p mosh-core`(133) / clippy(mosh-core + src-tauri windows-gnu
`--all-targets -D warnings`) / `npm run check` / `npm run build` 全过。

### 待办

运行时 e2e（真机图片上传 + 慢 MCP 首包即时）需 glib≥2.70/Windows 平台跑
`cargo tauri dev`，本机 glib 2.68.4 不足，与其他 GUI 任务同样留待运行时验证。

### Status

[OK] **Completed**
