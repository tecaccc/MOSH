# PRD — Agent 能力 v1：聊天面板 + 工具循环

> 任务：`08-15-agent-v1`。父需求：为 MOSH 增加 Agent 能力（自然语言 → 自动创建日程/待办）。
> 本文是 2026-08-15 与用户多轮 grilling 会话的共识固化。

## 背景与动机

MOSH 已有完整的待办/日程领域层（`service.rs` CRUD）与设置体系。用户希望以自然语言驱动数据操作
（"帮我把明早十点的周会加到日历"），由 Agent 通过 function-calling 自动完成。

前期已否决/搁置的路线（记录以防回流）：

- **企微日程同步**：因自建应用"企业可信IP"硬约束（桌面端出口 IP 不固定，60020）整体搁置；
- **lobe-editor 复用**：它是 React 19 + antd + Lexical 的富文本编辑器，无聊天窗口组件，与 Svelte 5 技术栈错配；
- **Pi-agent sidecar**（GrenAgent 模式）：为 6 个领域工具引入整个编码 Agent 运行时（Node 二进制
  sidecar + 进程管理 + 双重 IPC），主从颠倒。仅借鉴其**事件协议**与工具卡片交互形态。

## v1 目标（用户已裁决）

1. **能力边界 = 操作助手（b 档）**：自然语言 → 工具调用 → 自动创建/查询/完成待办与日程。
   不做多步自主规划、定时任务、主动摘要。
2. **模型接入 = 云端 API，OpenAI 兼容协议**：`base_url + api_key + model` 三项配置
   （存 settings 表，同天气模式）。默认面向云 API；Ollama 用户把 base_url 指到
   `http://localhost:11434/v1` 即可（设置页 hint 说明）。
3. **Agent 循环在 Rust 侧**（mosh-core 新增 `agent` 模块）：符合"领域逻辑在 mosh-core"铁律；
   工具 handler 直接调 `service::*`，无 IPC 跳变；api_key 不进前端。
4. **写操作 = 安全工具集自动执行**：v1 工具仅
   `create_todo / create_event / list_todos / list_events / set_todo_status / add_subtask`
   ——**不含 update/delete**。误操作靠工具卡片上的"撤销"（= 软删）回滚，零破坏性。
5. **入口 = 侧栏新「助手」视图**（聊天面板）。⌘K 快捷入口为后续演进，不占 v1。
6. **会话历史持久化**：v1 即建 `agent_messages` 表（多会话 + 历史回看），后补存储要迁数据，
   一步到位。
7. **未配置模型**：聊天面板显示"前往设置配置 AI 模型"引导卡（同天气未配置模式）。

## 验收标准

- [ ] 设置页「AI 模型」卡片：base_url / api_key（密文显示）/ model 三项 + 「测试连接」
      （真实发一次极短 completion，成功显示模型名，失败显示原文错误）。
- [ ] 侧栏「助手」视图：消息列表（用户/助手气泡）、流式文本、工具调用卡片（参数摘要 + 结果 + 撤销）。
- [ ] 自然语言样例全通：
      "明早十点开周会" → create_event 落库 → 日历可见；
      "建个待办：交季度报告，下周五截止，高优先级" → create_todo（priority=high）；
      "我今天有什么安排" → list_events + list_todos → 自然语言汇总；
      "把交季度报告标记完成" → set_todo_status(done)。
- [ ] 系统提示注入当前日期/星期/时区（"明早"可正确解析为具体日期）。
- [ ] 工具循环步数上限 8，防发散。
- [ ] 流式中断（用户关面板/切会话）不产生孤儿请求/僵尸写入。
- [ ] 会话历史落库，重启应用可回看。
- [ ] `cargo test -p mosh-core`（agent 模块单测：mock LlmClient，不碰网络）+
      `cargo clippy -p mosh-core -- -D warnings` + `npm run build` 全绿。

## Out of Scope（用户已裁决推迟）

- **Skills（.agents/skills 提示词包）→ v2**
- **MCP client（外部工具桥 + 按 сервер 授权闸）→ v2**（权限闸形态到 v2 再讨论）
- 多步自主规划、定时摘要、主动提醒、⌘K 面板、消息 markdown 富渲染。
- 工具 update/delete（破坏性操作，若 v2 引入需配确认门）。

## 依赖与风险

| 风险 | 缓解 |
| --- | --- |
| 模型工具调用质量参差（JSON 参数错误） | 参数校验 + 失败回填模型重试一次 |
| 用户 api_key 泄露面 | 仅存本地 SQLite、不进前端、设置页密文显示 |
| 长会话 token 膨胀 | v1 简单截断（最近 N 条），压缩策略后置 |
| 循环发散 | 步数硬上限 8 + 每步超时 |
