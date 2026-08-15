# Implement: 执行清单

- [ ] 脚手架：deps（react/react-dom/zustand/streamdown；dev: plugin-react/types），
      根 index.html、vite.config、tsconfig、package.json scripts
- [ ] global.css（:root 变量 + 全局 reset，自 +page.svelte 迁出）
- [ ] zustand stores：store/agent/weather/calendar/reminder
- [ ] 壳：TitleBar、Sidebar、App（view 路由）
- [ ] TodayView、TasksView、TodoItem(递归)、TodoEditor、Modal
- [ ] CalendarPane、TimeGrid、MonthView、WeekView、DayView、AgendaView、EventEditor
- [ ] ChatPanel（streamdown 渲染）+ 会话侧栏
- [ ] HomeView、SettingsView、ReminderToast
- [ ] 删除 Svelte：*.svelte、*.svelte.ts、svelte.config.js、app.html、routes/、
      svelte 相关 devDeps、marked/dompurify
- [ ] 质量门：tsc --noEmit + npm run build；cargo test -p mosh-core 复跑
- [ ] spec 更新：frontend/state-management.md 重写为 zustand 规则
