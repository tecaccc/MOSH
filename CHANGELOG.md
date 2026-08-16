# 更新日志

本文件记录 MOSH 面向用户的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

发布流程见 `docs/release.md`：每次发版（推 `v*` 标签）前，在对应版本小节补充变更。

## [Unreleased]

## [0.1.1] - 2026-08-16

### 新增

- 应用标识图标：紫渐变方块 + 白色 M + 绿色对勾角标，覆盖 Windows / macOS / Linux 安装包与浏览器 favicon；源图与重生成脚本入库（`npm run icon`）。
- 本更新日志（CHANGELOG.md）。

## [0.1.0] - 2026-08-16

首个发布版本。

### 新增

- **待办**：创建 / 编辑 / 软删（数据保留于库）、子任务（一层嵌套）、优先级、截止时间、完成状态；完成时自动记录完成时间点，恢复为进行中自动清除。
- **日程（日历）**：月 / 周 / 日 / 议程四视图；定时与全天事件；周期重复（daily / weekly / monthly / yearly）；提前提醒（toast 通知）；农历与节气显示。
- **首页仪表盘**：天气 + 时钟 + 问候 Banner、今日统计卡、日程安排（30 天按日分组）、待办事项卡、迷你月历。
- **天气**：Open-Meteo 按城市配置，坐标解析后持久复用。
- **AI 助手**：
  - OpenAI 兼容端点多提供商（DeepSeek / 通义 / Kimi / Ollama…），官方预置可改地址与模型，支持自定义；
  - 自然语言操作待办与日程（创建 / 查询 / 修改 / 删除），流式输出，工具调用卡片可展开查看输入与返回；
  - **Skills**：内置 + 自定义技能，启用后注入系统提示词；
  - **MCP**：接入 Streamable HTTP 外部工具服务器；
  - **权限管理**：工具审批三模式（免审批 / 写操作审批 / 全部审批）；
  - 会话管理：历史会话、删除、标题栏开关。
- **软件更新**：GitHub Actions 自动发布 Release（macOS 双架构 / Linux AppImage+deb / Windows NSIS 安装包）；应用内自动检测新版本、下载安装并重启（设置 → 关于 亦可手动检查）。

### 说明

- Windows 自本版本起分发 **NSIS 安装包**（`mosh_x.y.z_x64-setup.exe`，简中/英文向导，可选仅当前用户 / 所有用户安装），不再分发裸 `mosh.exe + DLL` 便携版。
- 数据落地本地 SQLite（`app_data_dir/mosh.sqlite`），不依赖任何云端服务。
