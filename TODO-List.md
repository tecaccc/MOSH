## 待实现

- [x] 支持AI修改已有日程
- [x] 支持事件周期提醒
- [x] 支持AI删除日程
- [x] 将首页“今日日程”改为“日程安排”，然后输出所有日程信息
- [x] 首页，在“今日日程”和“日历”之间加入一个新的卡片，叫“待办事项”；
- [x] 首页上，在天气和日期时间之间加上一个反斜杠，但是不要靠的太近；
- [x] AI能力增加SKILLS
- [x] AI增加MCP功能
- [x] AI聊天所需要使用的相关模型配置、技能、MCP等在聊天框下方可以进行配置，具体参考 cherry-studio项目（已经克隆到项目根目录了）
- [x] AI调天输入框现在太小了，是不是可以调整大小
- [x] AI聊天的历史记录的隐藏按钮集成到标题栏上面，放在最小化旁边；
- [x] AI聊天历史记录可以支持删除的
- [x] AI模型配置中，只是预置了Deepseek这样的平台，不意味着他的API等信息不可配置
- [x] AI模型配置中，添加自定义的按钮太丑了，美化一下
- [x] AI工具的配置中，请你也参照AI模型，增加一级菜单
- [x] 【BUG】AI助手页面，在下方的MCP和SKILLS的选择页面点击配置，跳转的不是对应的配置页面，而是跳转到了设置的默认页面天气
- [x] 【优化】所有的弹窗不要使用浏览器默认弹窗，我们自己设计一个，要求就是好看
- [x] 【优化】AI聊天助手所有调用的工具可以展开，可以查看AI输出了什么以及工具返回了什么
- [x] 【优化】增加一个权限管理，AI在操作工具的时候需要人工批准（多增加几个模式，可以免审批和需要审批等等）
- [x] 【优化】待办事项完成后似乎就不能在编辑和重新设置为待办事项了，请你修复这个问题
- [x] 【BUG】现在首页的最上方的图片怎么没有了，需要修复
- [x] 【新增】待办事项需要记录完成的时间点
- [x] 【新增】配置**GitHub Actions，当我们提交版本代码时，自动完成Release发布**
- [x] **【新增】增加自动更新检测，当检测到GitHub Release上存在新的版本后，可以提示版本更新，点击更新后程序可以自动下载并完成更新**
- [x] 【新增】Windows 分发改为编译安装包（NSIS），不再分发裸 exe 程序

## 归档

### 2026-08-16 待办完成时间点 + GitHub Actions 自动发布 + 应用内自动更新

| 事项 | 实现说明 |
| --- | --- |
| 待办记录完成时间点 | `model.rs` 新增 `completed_at_of`/`set_completed_at`（`data.completed_at` ISO8601）；`set_todo_status` 与 `apply_patch`（patch status 同步维护）：新完成→写入时间点，恢复进行中/取消→清除，重复置 done 不刷新原时间点；AI `list_todos` 回传 `completed_at`。前端：`formatCompletedAt`（今天 HH:mm / 同年 M月D日 HH:mm / 跨年带年份），今日视图已完成区绿色 pill「✓ 完成于 …」、任务列表行完成态显示完成时间、编辑器状态旁只读展示。含 3 项新单测。 |
| GitHub Actions 自动 Release | 新增 `.github/workflows/release.yml`：推 `v*` 标签（或手动）触发 → test 作业（tsc + mosh-core 单测）→ build 作业（macOS arm64/x64 双包、Ubuntu 22.04、Windows 并行，tauri-action 自动上传安装包 + `.sig` + `latest.json`）；发布流程与密钥配置见 `docs/release.md`。 |
| 应用内自动更新 | 后端接入 `tauri-plugin-updater` + `tauri-plugin-process`（relaunch），`tauri.conf.json` 配置 endpoints（GitHub Releases latest.json）+ minisign 公钥 + `createUpdaterArtifacts`，capabilities 授予 `updater:default`/`process:allow-restart`；已生成签名密钥对（公钥已入 conf，私钥在 `/tmp/mosh-updater.key` 待管理员保存并配 GitHub Secrets）。前端：`state/updater.ts`（check/downloadAndInstall/relaunch 全流程，静默检查失败不打扰）+ `UpdaterToast.tsx` 右下角通知卡（版本对比 + 更新说明 + 下载进度条），App 启动 8s 后静默检查；设置→关于新增「软件更新」手动检查。 |

验证：`cargo test -p mosh-core --locked` 80 项全部通过；`cargo clippy` 0 警告；`npm run check` 与 `npm run build` 均通过；`Cargo.lock` 已刷新（含两个 updater 插件）。注：`cargo check -p mosh`（Tauri 壳）仍因本机 glib 2.68 < 2.70 无法编译（环境预置限制，与改动无关），壳层改动遵循既有模式。

### 2026-08-16 Windows 分发改为 NSIS 安装包

| 事项 | 实现说明 |
| --- | --- |
| Windows 安装包化 | `tauri.conf.json` 新增 `bundle.windows.nsis`：`installMode: both`（安装时可选仅当前用户/所有用户）、`SimpChinese`/`English` 双语（跟随系统语言）；Release CI 的 Windows 作业改 `--bundles nsis` 聚焦安装包（产物 `mosh_x.y.z_x64-setup.exe` + `.sig`，不再上传冗余 en-US MSI）。 |
| 交叉编译验证 | 本机实测 `tauri build --target x86_64-pc-windows-gnu`：Rust 侧全通（新配置校验 OK、updater 插件链接成功），仅 NSIS 打包需 wine + `makensis.exe`（CLI 标注实验性）——故安装包正式产出路径为 CI 原生 Windows runner（自动下载 NSIS 工具链，无此限制）。 |
| 文档同步 | README「交叉编译到 Windows」章节改写：交叉编译降级为开发验证/自用调试（裸 exe 不再对外分发），新增「Windows 安装包（正式分发）」小节；`docs/release.md` 产物描述更新并说明 Windows 自动更新即静默重跑安装包。 |

验证：交叉编译 Rust 侧全通（2m36s）；`npm run check`/`cargo test -p mosh-core`/`cargo clippy` 均无回归；YAML 语法校验通过。

### 2026-08-16 AI 删除日程 + 首页改版

| 事项              | 实现说明                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支持AI删除日程        | 后端新增 `delete_event` / `delete_events` 工具（软删，数据可恢复），拒绝误删待办 id；系统提示词加入删除守则（id 必须来自查询结果、删除前确认、删除后复述）；前端聊天工具卡片支持展示删除结果（已删 N 条 / 部分失败）。`cargo test -p mosh-core` 63 项全部通过。 |
| 首页“今日日程”→“日程安排” | `HomeView.tsx`：卡片更名为“日程安排”，加载今天起 30 天窗口内的全部日程，按日期分组展示（今天/明天/M月D日 + 星期，全天事件归开始日），时间轴样式保留，点击仍可打开事件编辑器；列表区域可滚动（max-height 440px）。                                        |
| 首页新增“待办事项”卡片    | 位于“日程安排”与“日历”（月历）之间：展示进行中的顶层待办，按截止时间/优先级排序（逾期自然置顶）；支持勾选完成、点击标题打开右侧编辑器、优先级色点、逾期截止日期红显；“查看全部”跳转「今日」视图。                                                                  |
| 附带修复            | `SettingsView.tsx`：`saveAiProvider` 返回 `void` 却被取 `saved.name` 的遗留类型错误，改为使用输入的提供商名称。                                                                                  |

验证：`npm run check`（tsc）与 `npm run build` 均通过；`cargo test -p mosh-core` 全部通过。

### 2026-08-16 首页 Banner 反斜杠分隔符

| 事项           | 实现说明                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 天气与日期时间间加反斜杠 | `HomeView.tsx`：在 Banner 顶行的天气区与日期时间区之间插入 `banner-sep` 分隔符（`aria-hidden` 装饰字符）；`HomeView.module.css` 新增 `.banner-sep`（44px 细字重、`--border` 浅色、跟随暗色主题）。间距由容器既有 `gap: 32px` 提供，两侧各留 32px，满足「不要靠的太近」。 |

验证：`npm run check`（tsc）与 `npm run build` 均通过。

### 2026-08-16 补录归档：AI 修改日程与周期提醒（此前已实现，本次验证补记）

| 事项         | 实现说明                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支持AI修改已有日程 | 后端 `crates/mosh-core/src/agent/tools.rs` 内置 `update_event` 工具：按 id 部分更新（仅需传要改的字段：标题/起止时间/全天/地点/备注/周期/提醒），拒绝非日程 id 与 end≤start 非法区间；系统提示词（`runner.rs` 规则 5）要求 id 来自 list_events 查询结果；前端聊天工具卡片展示修改结果。含 `dispatch_update_event_changes_fields` 等单测。                                                   |
| 支持事件周期提醒   | `create_event` / `update_event` 均支持 `recurrence`（daily/weekly/monthly/yearly）与 `reminder_minutes`（提前分钟数）；前端 `calendar-grid.ts` 的 `expandRecurring` 把周期事件按窗口展开为逐次发生（id 带 `::` 后缀可反解父事件）；`state/reminder.ts` + `ReminderToast.tsx` 提前弹窗提醒。含 `dispatch_create_event_with_recurrence_and_reminder` 单测。 |

验证（本次复跑）：`cargo test -p mosh-core` 63 项全部通过；`npm run check`（tsc）无错误。

### 2026-08-16 AI 能力增强：Skills + MCP + 聊天输入区改版 + 会话管理

| 事项                         | 实现说明                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI 能力增加 SKILLS             | 新模块 `crates/mosh-core/src/agent/skills.rs`：技能 = 追加到系统提示词的行为指引（`SkillDef {id,name,description,prompt,builtin}`）；内置 3 个技能（日程规划师/待办整理/周报助手），自定义技能持久化于 settings（`ai_skills_custom`），启用集存 `ai_skills_active`；`skills_prompt()` 拼装注入 `run_turn_with` 系统提示词。                                                                                                                    |
| AI 增加 MCP 功能               | 新模块 `crates/mosh-core/src/agent/mcp.rs`：Streamable HTTP JSON-RPC 客户端（`initialize` / `notifications/initialized` / `tools/list` / `tools/call`，SSE 单帧回退、Bearer Token、10s/60s 超时）；工具注册名 `mcp__{server_id}__{原名}`；`runner.rs` 新增 `run_turn_with` + `TurnExtras`：MCP 规格并入 LLM 工具列表，`mcp__` 前缀在 `exec_tool`（异步化）中路由到对应服务器调用，失败转 `ok:false` 回填不中断回合；前端工具卡片标题显示 `MCP·{server}`。 |
| 聊天框下方配置栏（参考 cherry-studio） | `ChatPanel.tsx` 输入区重构为 composer 容器：textarea + 底部工具条（模型选择、技能弹层开关、MCP 弹层开关、发送/停止）；弹层含遮罩点击关闭、启用计数徽标、快捷开关与「前往设置管理」；顶栏常驻当前模型名与技能/MCP 启用数徽标。                                                                                                                                                                                                                                   |
| 输入框调整大小                    | textarea 自动增高（76px–220px，随内容重算），默认 3 行起步，Shift+Enter 换行、Enter 发送保持不变。                                                                                                                                                                                                                                                                                                    |
| 历史记录按钮集成到标题栏               | `chatSideVisible`/`toggleChatSide` 提升到 app store；`TitleBar.tsx` 在助手视图的最小化按钮左侧渲染会话面板开关（细线分隔、激活高亮），ChatPanel 消费同一状态，原顶栏内开关移除。                                                                                                                                                                                                                                              |
| 历史记录支持删除                   | 存储层 `delete_agent_session`（按会话删全部消息行，含单测）+ `delete_agent_session` 命令 + 前端 `deleteSession`（confirm 确认、刷新列表、删当前会话自动切换到最近会话）；侧栏条目 hover 显示删除按钮。                                                                                                                                                                                                                             |
| 设置页「AI 工具」                 | 新组件 `AgentToolsSettings.tsx`：技能管理（内置/自定义标签、开关、新建/编辑/删除、查看提示词）与 MCP 服务器管理（增删改、启停、测试连接显示工具清单或错误）；与聊天工具条经 agent store 实时同步。新增 IPC：`list_skills`/`save_skill`/`delete_skill`/`set_skill_active`/`list_mcp_servers`/`save_mcp_server`/`delete_mcp_server`/`set_mcp_enabled`/`mcp_list_tools`/`delete_agent_session`。                                                          |

验证：`cargo test -p mosh-core` 76 项全部通过（新增 13 项：skills 5、mcp 5、runner 2、storage 1）；`cargo clippy -p mosh-core` 0 警告；`npm run check`（tsc）与 `npm run build` 均通过。注：`cargo check -p mosh`（Tauri 壳）因本机 glib 2.68 < 2.70 无法编译（环境预置限制，与改动无关），命令层改动遵循既有模式并已通过前端类型镜像校验。

### 2026-08-16 设置页优化：预置可编辑 + 按钮美化 + AI 工具子菜单

| 事项               | 实现说明                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预置提供商 API 等信息可配置 | `SettingsView.tsx`：官方预置（DeepSeek）的接口地址与模型从只读展示改为可编辑输入框（预填官方默认值，可改为兼容中转端点/手动填模型 id，placeholder 提示默认值）；`loadBuiltin` 优先回填已保存的地址/模型（改动过的不丢）；保存/获取模型列表/测试连接统一改用表单值（不再硬编码 `curBuiltin.base_url`）。                                                               |
| 「添加自定义」按钮美化      | 原「+ 添加自定义」虚线框按钮重设计：细实线胶囊按钮（`.pl-add`）+ 圆形底 SVG 加号图标，hover/选中时 accent 色柔和高亮（图标反白），文案改为「添加自定义提供商」。                                                                                                                                                           |
| AI 工具增加一级子菜单     | 参照 AI 模型分区结构：`AgentToolsSettings.tsx` 拆为 `SkillsPane`（技能）与 `McpPane`（MCP 服务器）两个导出面板；`SettingsView.tsx` 新增 `aitoolsPane` 状态与同构 `provider-col` 子菜单栏（技能 / MCP 服务器 + 启用计数徽标 + 底部提示），`.settings.aitools` 三列 grid 与 `.settings.ai` 一致（含 700px 响应式折叠）；标题与描述随面板切换。 |

验证：`npm run check`（tsc）与 `npm run build` 均通过。

### 2026-08-16 弹层深链修复 + 自绘全局对话框

| 事项                 | 实现说明                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 【BUG】弹层「前往设置管理」跳错页 | 根因：弹层按钮只调 `setView("settings")`，而 SettingsView 每次挂载都重置到默认「天气」分区。修复：app store 新增设置深链（`settingsTarget` + `openSettings(section, pane?)` + `consumeSettingsTarget()`）；SettingsView 惰性初始化分区/子面板（避免闪帧）并在挂载后消费目标；聊天弹层「管理技能」→ `openSettings("aitools", "skills")`、「管理 MCP 服务器」→ `openSettings("aitools", "mcp")`；顺带把未配置引导「前往设置」改为直达 `openSettings("ai")`。 |
| 【美化】自绘弹窗替换浏览器默认    | 新增 `state/dialog.ts`（zustand：Promise 化 `confirm(opts)→Promise<boolean>` / `prompt(opts)→Promise<string                                                                                                                                                                                                                                             |

验证：`npm run check`（tsc）与 `npm run build` 均通过。

### 2026-08-16 工具卡片可展开 + 工具审批权限管理

| 事项         | 实现说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具卡片可展开    | `ChatPanel.tsx` ToolCard 重构：卡片头部整行可点击切换展开（左侧 chevron 旋转指示），展开区显示「输入参数」与「返回结果」两块美化 JSON（等宽字体、220px 内滚动、自动换行）；`prettyJson` 兼容字符串载荷（DB 回放时先 parse 再美化）；撤销按钮保持行尾独立可点。流式与历史会话回放均可用（args/result 本就随消息持久化）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 权限管理（人工批准） | 后端：`tools.rs` 新增 `PermissionMode{Auto,Write,All}` 与 `requires_approval()`（Auto=全免；Write=仅 list_todos/list_events 只读放行，写/删与全部 MCP 工具需批；All=全部需批）；`events.rs` 新增 `ApprovalRequired{turn_id,call_id,tool,args}` 事件；`runner.rs` 新增 `ApprovalGate` trait（`AutoApprove` 默认放行）——循环内在执行前判定，需批则发事件并 await 闸门，拒绝时经 `rejected_tool` 回填 `{"ok":false,"error":"用户拒绝了本次工具调用"}`（模型可见、回合继续、卡片照常落库）。src-tauri：`AgentRuns` 增 pending oneshot 通道表，`SessionGate`（200ms 轮询 abort，中止自动拒绝），新命令 `agent_approve`（回传决定）、`get/set_permission_mode`（settings `ai_permission_mode` 持久化）；`agent_send` 装载模式并接入闸门与 `agent://approval` 事件。前端：agent store 增 `permissionMode`/`pendingApproval` 状态与监听（end 时自动清理）；聊天输入区工具条新增 🛡 审批模式下拉（免审批/写操作审批/全部审批，title 提示语义）；消息区下方待审批栏（盾牌图标 + 工具名 + 参数 JSON + 批准/拒绝按钮，琥珀色警示风格）。 |

验证：`cargo test -p mosh-core` 78 项全部通过（新增：审批拒绝全流程、三模式判定）；`cargo clippy -p mosh-core` 0 警告；`npm run check`（tsc）与 `npm run build` 均通过。

### 2026-08-16 待办完成态可编辑恢复 + 首页 Banner 图修复

| 事项            | 实现说明                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 待办完成后可编辑/恢复   | 根因：TodayView「已完成」区块只渲染了标题头，`doneToday` 列表从未输出——完成的待办从「今日到期 & 已逾期」消失后无处可寻（侧栏亦无任务列表入口），既不能点开编辑也不能取消勾选恢复（编辑器与后端本就支持 done 记录改状态）。修复：区块改为可折叠按钮（chev 旋转、计数徽标），展开渲染已完成条目（与今日任务同构行）：Check 点击取消勾选即恢复 active 回到任务列表；点击行打开右栏编辑器（状态可改）；整行 75% 透明度弱化、hover 恢复。新增 `doneItems` 派生与 `doneOpen` 状态。 |
| 首页 Banner 图丢失 | 根因：静态资源在 `static/`（SvelteKit 时代惯例），但 `vite.config.js` 未配置 `publicDir`——纯 Vite 默认只 serve/copy `public/`，产物 `build/` 中根本没有 `home-banner.png`，根路径引用 404。修复：`vite.config.js` 增加 `publicDir: "static"`，dev 与 build 均生效（验证 build/home-banner.png 已随产物输出）。                                |

验证：`npm run check`（tsc）与 `npm run build` 均通过，构建产物已含 home-banner.png。
