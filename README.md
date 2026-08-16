# MOSH

本地优先（local-first）的桌面个人信息管理应用：待办、日程（日历）、天气与 AI 助手。数据落地本地 SQLite，不依赖云端服务。前端 React 19，桌面壳 Tauri 2（Rust）。

## 功能

- **待办**：创建 / 编辑 / 软删、子任务（一层嵌套）、优先级、截止时间、完成状态
- **日程（日历）**：月 / 周 / 日 / 议程四视图；定时与全天事件；周期重复（daily / weekly / monthly / yearly）；提前提醒（`reminder_minutes`）；农历与节气显示
- **首页仪表盘**：天气 + 时钟 + 问候 Banner、统计卡、日程安排（30 天按日分组）、待办事项卡、迷你月历
- **天气**：首页展示（Open-Meteo，按城市配置）
- **AI 助手**：
  - OpenAI 兼容端点（DeepSeek / 通义 / Kimi / Ollama…），官方预置可改地址与模型，亦支持自定义多提供商
  - 自然语言操作待办与日程（创建 / 查询 / 修改 / 删除），流式输出
  - **Skills**：内置 + 自定义技能，启用后注入系统提示词
  - **MCP**：接入 Streamable HTTP 外部工具服务器，工具注入模型
  - **权限管理**：工具审批三模式（免审批 / 写操作审批 / 全部审批），调用前人工批准
  - 会话管理：历史会话、删除、标题栏开关

## 技术栈

- **前端**：React 19 + TypeScript + Vite + zustand + CSS Modules；Markdown 渲染用 `streamdown`，农历用 `lunar-typescript`，提供商图标用 `@lobehub/icons`
- **桌面壳**：Tauri 2（Rust），命令层为薄壳，领域逻辑在 `mosh-core`
- **核心域**：Cargo workspace —— `crates/mosh-core`（model / storage / service / weather / agent），`src-tauri`（`#[tauri::command]` 适配）
- **存储**：SQLite（rusqlite bundled），`app_data_dir/mosh.sqlite`；AI 配置与技能/MCP 等存 `settings` 表

## 目录结构

```
src/                        React 前端（Vite）
  components/               UI 组件（calendar/ 下为日历四视图）
  state/                    zustand 全局状态（store / calendar / weather / agent / reminder / dialog）
  lib/                      纯工具与类型（calendar-grid / datetime / lunar / ipc / types / weather-code …）
  styles/                   全局样式（global.css / markdown-chat.css）
  App.tsx                   根组件（视图切换 + 编辑器 + 全局宿主）
src-tauri/                  Tauri 壳（命令 → mosh-core）
crates/mosh-core/           领域核心
  src/model.rs              统一记录模型（todo / event 共用 records 表）
  src/storage.rs            SQLite 存取与迁移
  src/service.rs            领域服务（创建/更新/软删/状态机）
  src/weather.rs            天气（Open-Meteo）
  src/agent/                AI 助手（llm / runner / tools / skills / mcp / events）
```

## 环境要求

- Node.js（见 `package.json`）
- Rust（stable）+ cargo
- 交叉编译到 Windows 另需 `x86_64-pc-windows-gnu` target 与 MinGW（见下）

## 开发

```bash
npm install
npm run tauri dev          # 启动桌面应用（热更新）；仅前端用 npm run dev
```

> **Linux 原生运行注意**：Tauri 在 Linux 依赖 GTK，其底层 `gobject-1.0` 需 ≥ 2.70。部分发行版或容器（如本开发机仅 2.68.4）会在 `cargo tauri dev` / 原生 build 处失败。此情形请用下文「交叉编译到 Windows」验证编译，或升级系统 glib。

## 质量门

```bash
cargo test -p mosh-core                       # 核心单测
cargo clippy -p mosh-core -- -D warnings      # 核心 lint
npm run check                                 # 前端类型检查（tsc --noEmit）
npm run build                                 # 前端构建（Vite，产物到 build/）
```

> 前端改动以 `npm run check`（类型）+ `npm run build`（构建）共同为准；Rust 改动以 `cargo test` + `cargo clippy` 为准。

## 构建（原生）

```bash
npm run tauri build        # 产物：target/release/mosh
```

---

## 交叉编译到 Windows（从 Linux）

用 `x86_64-pc-windows-gnu` + MinGW，**无需 cargo-xwin / Windows SDK 下载**。验证于 2026-08-13。

### 一次性准备

```bash
# 1) 安装 Rust target
rustup target add x86_64-pc-windows-gnu

# 2) 安装 MinGW 工具链（Fedora 示例；Debian/Ubuntu 为 mingw-w64 包）
sudo dnf install mingw64-gcc     # 提供 x86_64-w64-mingw32-{gcc,windres,ar,ld}
```

确认工具在场：

```bash
x86_64-w64-mingw32-gcc --version
```

### 编译

仓库根目录执行：

```bash
npm run tauri build -- --no-bundle --target x86_64-pc-windows-gnu
# 等价写法：node_modules/.bin/tauri build --no-bundle --target x86_64-pc-windows-gnu
```

说明：

- `tauri build` 会先自动跑 `beforeBuildCommand`（即 `npm run build`）出前端到 `build/`，再做交叉编译；无需手动先 build。
- `--no-bundle`：跳过 `.msi` / `.nsis` 安装包（需 WiX / NSIS，本机一般没有），只出裸 `.exe` + 伴生 DLL。
- 首次 release 全量交叉编译约 5 分钟，之后增量很快。

### 产物

```
target/x86_64-pc-windows-gnu/release/
  mosh.exe               PE32+ GUI x86-64，前端已嵌入（~22 MB）
  WebView2Loader.dll     ~160 KB，webview2-com-sys vendored 加载器
```

### ⚠️ 分发必读

`mosh.exe` 静态依赖**同目录**的 `WebView2Loader.dll`。注意：这是 WebView2 的**加载器**（loader），**不是** WebView2 运行时本体——后者 Win10 1809+ / Win11 已预装。由于 `--no-bundle` 不打安装包，**分发时必须把 `mosh.exe` 与 `WebView2Loader.dll` 放在同一目录**，否则 Windows 启动时报「找不到 WebView2Loader.dll」。

约定分发暂存目录（`dist/` 已在 `.gitignore`）：

```bash
mkdir -p dist/windows
cp target/x86_64-pc-windows-gnu/release/mosh.exe            dist/windows/
cp target/x86_64-pc-windows-gnu/release/WebView2Loader.dll  dist/windows/
```

> 长期面向终端用户分发，需用 WiX / NSIS 打 `.msi` / `.exe` 安装包（把 exe + DLL 装进安装目录）。

### 仅验证命令层能否编译（不出 .exe）

若只关心 Rust 改动是否破坏 Windows 目标（例如本机 glib 不足、无法原生 build），跑这条即可，无需完整 `tauri build`：

```bash
cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings
```

## IDE

[VS Code](https://code.visualstudio.com/) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)（前端为 React + TS，VS Code 内置支持即可）
