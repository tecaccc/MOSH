# PRD — AI 聊天图片上传 + 发送回复延迟优化

> 任务：`08-26-chat-images-latency`。来源：TODO-List 待实现两项。

## 1. AI 聊天助手支持上传图片

- 输入区新增图片按钮：文件选择 + 粘贴 + 拖拽图片到输入区；附件预览缩略图可删除。
- 前端本地压缩（长边 ≤1600px、JPEG 重编码、≤1.5MB、单条消息 ≤4 张）后转 data URL 发送。
- 后端 `agent_send` 新增 `images` 参数；`agent_messages` 表 v7 迁移加 `images` 列（JSON 数组，
  同步 dump/merge 随 AgentMessage serde 自然携带，旧版本忽略未知字段兼容）。
- LLM 协议：user 消息带图时 content 序列化为 OpenAI vision 数组
  （`[{type:text},{type:image_url}]`）；无图保持纯字符串（全兼容）。
- 上下文重建：历史 user 行带图回放；仅取最近 3 条带图 user 消息进上下文（防 token 膨胀）。
- UI 回放：openSession 重放历史消息时展示图片。

## 2. 发送后回复延迟（要等好一会）

**根因**：`agent_send` 在驱动 LLM 前对每台启用的 MCP 服务器**同步串行**执行
`initialize` + `tools/list`（各 10s 超时），每条消息都重新走网络，慢/不可达的
MCP 服务器直接拖住 LLM 首包。

**修复**：
- src-tauri 新增 MCP 工具内存缓存（server id → tools）：启动预热、配置变更
  （保存/启停/删除）即刷新；发送路径只读缓存，缺失/过期时**后台**拉取不阻塞
  本轮（本轮跳过该服务器的工具，下一轮自然可用）。
- 前端补「思考中」指示（首包前显示三点动画气泡），改善主观等待。

## 验收

- 发送图片后助手能看图回答（vision 模型）；历史会话回看图片仍在。
- 配置慢 MCP 服务器后发消息：回复立即开始流式（不再被 MCP 握手阻塞）。
- `cargo test` 全绿；`tsc --noEmit` 通过。
