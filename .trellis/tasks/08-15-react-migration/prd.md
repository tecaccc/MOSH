# PRD: 前端框架迁移 Svelte → React

## 背景与动机

项目将引入更多 AI 能力（Skills、MCP、聊天增强）。React 生态的现成 AI 渲染方案
（streamdown 19M 月下载、lobe-ui、cherry-studio 全家桶）全部 React 绑定；经评估
决定整体迁移至 React（业主决策，1A 2A 3A：CSS Modules 沿用现有 CSS 变量、
zustand 状态、分支全量重写）。

## 范围

**保留（零改动）**：Rust 后端（crates/mosh-core、src-tauri）、Tauri IPC 契约、
框架无关 TS 库（ipc.ts/types.ts/calendar-grid.ts/datetime.ts/lunar.ts/cities.ts/weather-code.ts）。

**移植**：
- 5 个 runes 状态模块（store/agent/weather/calendar/reminder，~830 行）→ zustand stores
- 19 个 Svelte 组件（~6.6k 行）→ React 函数组件 + CSS Modules（视觉零回归：沿用现有 CSS 变量）
- 聊天 markdown：streamdown（cherry-studio 同款管线）替换自研 marked 管线

**构建链**：SvelteKit → Vite + @vitejs/plugin-react；build.outDir 保持 `build/`
（tauri.conf.json frontendDist 不变）；dev 端口 1420 不变。

## 验收标准

1. `npx tsc --noEmit` 与 `npm run build` 全过。
2. 全部视图（Today/Tasks/Calendar 四视图/Chat/Settings/Home）视觉与交互对齐迁移前。
3. 聊天：流式 markdown 渲染（streamdown）、工具卡片、会话侧栏、模型选择可用。
4. 天气/农历/提醒 toast/事件编辑器/待办树（递归子任务）功能不变。
5. Rust 侧零改动、IPC payload 契约（snake_case）不变。

## 非目标

Tailwind/shadcn、视觉重设计、后端改动、双框架并存灰度。
