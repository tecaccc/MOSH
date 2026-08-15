# Design: Svelte → React 迁移

## 目录映射

| 旧 | 新 |
|---|---|
| src/routes/+page.svelte（:root 变量+布局） | src/main.tsx / src/App.tsx / src/styles/global.css |
| src/lib/*.svelte.ts（runes 状态） | src/state/*.ts（zustand，每模块一 store） |
| src/lib/components/**.svelte | src/components/**.tsx + 同名 .module.css |
| src/lib 框架无关库 | 原地保留 |
| ChatPanel + Markdown.svelte | ChatPanel.tsx + streamdown |
| index.html=SvelteKit app.html | 根 index.html（#root + main.tsx） |

## 关键决策

1. **状态**：zustand create() 每域一 store；组件用 selector 订阅；派生数据
   在 selector/useMemo 计算（替代 $derived）。Svelte「导出函数读私有 $state」
   模式 → 直接 useStore(s => s.x)。
2. **样式**：Svelte scoped style → CSS Modules；:global() → 全局 stylesheet
   （markdown.css 等）；CSS 变量全部进 global.css（浅/深双主题原样）。
3. **Tauri 事件**：listen() 注册在 store 模块导出的 initAgentEvents()，由
   App useEffect 调一次（幂等守卫），替代 Svelte onMount 模式。
4. **聊天渲染**：streamdown <Streamdown parseIncompleteMarkdown>（流式半成品
   修补、rehype-sanitize 内置安全），替代自研 marked+dompurify+fence 补全；
   删除 markdown.ts（隔离层价值在此兑现：只换渲染层）。
5. **构建**：vite.config 用 react() 插件 + server.port=1420 + build.outDir=build；
   tsconfig 去 svelte-kit 继承，jsx: react-jsx；check 脚本改 tsc --noEmit。

## 移植顺序（每步可编译）

脚手架 → global.css → zustand stores（5）→ 壳（TitleBar/Sidebar/App 路由）→
Today/Tasks(+TodoItem 递归/TodoEditor) → Calendar(CalendarPane/TimeGrid/四视图/
EventEditor) → Chat(ChatPanel/streamdown) → Home/Settings/Modal/ReminderToast →
删 Svelte（组件/配置/依赖）→ 全量质量门。
