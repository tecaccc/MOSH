# MOSH

本地优先（local-first）的桌面个人信息管理应用：待办、日程（日历），未来扩展笔记与外部集成。数据落地本地 SQLite，可自托管同步。前端 SvelteKit + Svelte 5，桌面壳 Tauri 2（Rust）。

## 技术栈

- **前端**：SvelteKit（SPA）+ Svelte 5 runes + TypeScript + Vite
- **桌面壳**：Tauri 2（Rust），命令层为薄壳，领域逻辑在 `mosh-core`
- **核心域**：Cargo workspace —— `crates/mosh-core`（model / storage / service），`src-tauri`（`#[tauri::command]` 适配）
- **存储**：SQLite（rusqlite bundled），`app_data_dir/mosh.sqlite`

## 目录结构

```
src/                        SvelteKit 前端
  lib/
    components/             UI 组件（calendar/ 下为日历四视图）
    store.svelte.ts         待办全局状态（runes）
    calendar.svelte.ts      日历全局状态
    datetime.ts             日期/时间工具
    calendar-grid.ts        纯日历网格运算（周一首）
    ipc.ts / types.ts       Tauri IPC 封装 + 后端类型镜像
src-tauri/                  Tauri 壳（命令 → mosh-core）
crates/mosh-core/           领域核心（model / storage / service）
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
npm run check                                 # 前端类型检查
npm run build                                 # 前端构建（权威门，见下）
```

> `npm run check`（类型级）查不出 Svelte 5 模块导出的运行时规则（`state_invalid_export` / `derived_invalid_export`）。**凡改动 `*.svelte.ts`，务必以 `npm run build` 为准。**

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

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
