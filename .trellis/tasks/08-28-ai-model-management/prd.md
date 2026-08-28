# AI 模型配置与管理(借鉴 Cherry Studio 设计)

## Goal

将 MOSH 现有的「单 Provider 单模型字符串」AI 配置,升级为「Provider 实体 + 模型实体管理」体系:
支持多 Provider、每 Provider 多模型、模型元数据(能力/上下文/备注)、默认模型与聊天框内快捷切换。

**设计借鉴 Cherry Studio(cherry-studio/,AGPL-3.0),但代码全部在本项目框架(Tauri 2 + Rust + zustand + CSS Modules)中重新实现,不复制其任何代码。**

## Background / 现状差距

| 能力 | 现状 | 目标 |
|---|---|---|
| 数据模型 | `AiConfig{name, base_url, api_key, model}` 一个模型字符串 | Provider 表 + Model 表(UniqueModelId) |
| 存储 | settings 表两个 JSON key(`ai_providers`/`ai_model`) | 独立表 `ai_provider` / `ai_model`,JSON 列存元数据 |
| 模型列表 | 前端拉一次 `/models` 全量字符串 | 同步入库存为实体,带能力标签/启用/隐藏 |
| 图标 | 12 家预置手工映射 @lobehub/icons | 三级回退解析链(模型名→模型→厂商),覆盖所有 provider/model |
| 聊天选模型 | 聊天头部一个 `<select>` 下拉 | Composer 内嵌 ModelSelector(搜索/分组/标签/置顶) |
| 默认模型 | 「保存 provider 即激活」隐式 | 显式 `default_model_id` 偏好 |

## Requirements

### R1 数据层(Rust / mosh-core)
- 新表 `ai_provider`(id、preset_id、name、base_url、api_key、enabled、sort_order、created_at)
- 新表 `ai_model`(id=`providerId::modelId`、provider_id FK、model_id、name、capabilities、context_window、enabled、hidden、notes、sort_order)
- 迁移:旧的 `ai_providers`/`ai_model` settings JSON 自动导入新表,导入后旧 key 保留只读(回滚安全)
- UniqueModelId 类型与 parse/create 辅助(Rust + TS 双侧)

### R2 服务与命令(src-tauri)
- Provider CRUD:`list_providers` / `upsert_provider` / `delete_provider`
- Model CRUD:`list_models(providerId?)` / `upsert_model` / `delete_model` / `set_model_enabled`
- 模型同步:`sync_models(providerId)` 拉取 `/models` 与库内 diff(新增/弃用),返回预览
- 默认模型:`get_default_model` / `set_default_model`(存 settings)
- 兼容:保留 `get_ai_config` 等旧命令的等价行为(聊天发送链路改读新表)

### R3 前端状态(src/state/models.ts)
- zustand store:providers、models、defaultModelId;选择器派生(按 provider 分组、可聊天模型过滤)

### R4 图标解析(src/lib/aiIcons.tsx)
- 基于 @lobehub/icons(MIT)实现三级回退:① 模型名正则→模型图标 ② 模型名正则→厂商图标 ③ providerId/名称→厂商图标 ④ 首字母兜底
- 名称规范化:小写、去 `vendor/` 命名空间、去 `:free`/`:cloud` 等后缀
- 单一入口 `<AiEntityIcon modelId providerId>` 组件,全项目(设置页/聊天/选择器)共用

### R5 设置页(SettingsView AI 分区改造)
- 左栏:Provider 列表(图标+名称+启用电位),底部「添加自定义」
- 右栏:连接配置(base_url/key/测试)+ 模型列表(启用开关/隐藏/删除/手动添加)
- 「同步模型」按钮:拉远端列表,增量合并
- 默认模型设置(全局一个,聊天可临时覆盖)

### R6 聊天集成(ChatPanel)
- 输入框上方(现 head-model 位置)改为 ModelSelector 触发按钮:图标 + 模型名
- 弹层:搜索框 + 按 Provider 分组 + 能力标签 + 置顶区 + 「管理模型」直达设置
- 选择即存 default_model_id(会话级覆盖暂不做,见 Non-goals)
- 助手消息头部显示所用模型小图标(从消息 metadata 读取,不随切换变)

### R7 预置目录(src/lib/aiPresets.ts)
- 内置常见 Provider 预设(DeepSeek/通义/Kimi/OpenAI 兼容/Ollama 等,含 baseUrl、默认模型、@lobehub 图标键),数据参考公开事实自写,不复制 Cherry Studio 的 JSON
- 添加 provider 时选预置则预填;也可全自定义

## Non-goals(本期不做)

- 多模型 @ 并发对比(Cherry Studio 的 siblingsGroup 分支树,复杂度高、与现有内存会话模型冲突)
- 每助手(Assistant)独立模型配置——MOSH 尚无助手实体
- 模型价格/token 用量统计、endpoint 多类型(anthropic/google 原生协议)——仍只支持 OpenAI 兼容
- 远端模型目录更新(注册表快照)

## Acceptance Criteria

- [ ] 旧配置(settings JSON)升级后自动可见,聊天不回归
- [ ] 可添加自定义 Provider 并同步出模型列表入库
- [ ] 聊天框可搜索切换任意已启用模型,切换后下一轮生效
- [ ] 图标:任一模型/Provider 均有图标或首字母兜底,无 broken 图
- [ ] 删除 Provider 级联删除其模型;默认模型被删时回退到首个可用模型
- [ ] `pnpm check`(tsc)与 `cargo test` 通过

## Notes

- 技术设计见 design.md;实施拆步见 implement.md
- 许可合规:不复制 cherry-studio 任何源码/JSON/注释,仅借鉴架构思想(UniqueModelId、delta 合并、三级图标回退、ModelSelector 交互)
