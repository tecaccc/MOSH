# 实施计划:AI 模型配置与管理

按 design.md 拆为 6 步,每步独立可验证、可提交。步骤间有依赖(1→3→4/5;2 独立)。

## Step 1 — Rust 数据层与服务命令 ✅ (f45ab76)

- [x] `crates/mosh-core/src/agent/models.rs`:AiProvider/AiModel/AiDefaultModel/AiSyncResult 类型、`unique_model_id`/`parse_unique_model_id`(+3 单测)
- [x] `storage.rs`:v9 迁移建表(ai_provider/ai_model/ai_meta)、CRUD、级联删、默认模型清理、`sync_ai_models` diff(+5 单测,mosh-core 140 全绿)
- [x] 迁移 `migrate_legacy_ai_config()`:旧 settings JSON → 新表,ai_meta 标记幂等,旧 key 只读保留
- [x] `src-tauri/lib.rs`:9 个新命令注册;`resolve_default_model`/`load_ai_config`(支持 UniqueModelId 覆盖);setup 时执行迁移
- [x] 兼容层:旧命令(get/set_ai_config、list/save/delete_ai_provider)保留签名改读新表(前端已全部切新命令,兼容层可在下个版本移除)
- [x] `AgentEvent::Start` 与 assistant 消息携带 model_id;`agent_send` 模型参数双语义(uniqueId/旧模型 id)
- [ ] `cargo check -p mosh`(src-tauri)——**本环境 glib 2.68 < 2.70 无法编译,需在开发机/CI 验证**;已过 rustfmt 语法级检查

## Step 2 — 前端图标与预置 ✅ (并入 Step2+3 提交)

- [x] `src/lib/aiPresets.ts`:16 家预置(键即图标键/预置 provider id)
- [x] `src/lib/aiIcons.tsx`:三级回退解析 + `<AiEntityIcon>` 首字母兜底 + 能力推断 `inferCapabilities`
- [~] 单测:前端无测试框架(无 vitest/jest),tsc + vite build 为门禁;补测试列为后续任务

## Step 3 — zustand store 与选择器组件 ✅

- [x] `src/state/models.ts`:实体 store + selectedProviderId + selectChatModels/findModelWithProvider 派生器
- [x] `src/components/ModelSelector.tsx`:搜索/置顶/分组/能力点标/管理入口/外点关闭

## Step 4 — 设置页 AI 分区改造 ✅

- [x] `AiSettings.tsx` 双栏:提供商栏(已添加/预置网格/自定义草稿)+ 配置区(表单/测试/同步/默认模型/模型行内编辑/手动添加)
- [x] SettingsView 删除旧 BUILTIN_PROVIDERS/providerIconOf/单模型表单(-588 行)
- [x] 迁移路径:旧库升级后 provider/模型/默认模型自动可见

## Step 5 — 聊天集成 ✅ (bc9c8c9)

- [x] ChatPanel:顶栏默认模型(图标+名称)、工具条 AiModelSelector(向上弹层)
- [x] agent store:删字符串模型态,send 传默认模型 uniqueId
- [x] start 事件 model_id → 流式气泡标识;BubbleModelTag(模型删除后回退解析 id)
- [x] 空态/未配置引导保持(configured = defaultModel !== null)

## Step 6 — 收尾 ✅

- [x] sync 范围决策:新表暂不入同步(README/CHANGELOG 注明;仅 ai_default_model 随 settings LWW,远端缺失自动回退)
- [x] README 功能描述更新;CHANGELOG Unreleased 小节
- [x] `pnpm check`(tsc)+ `npm run build`(vite)全绿;`cargo test -p mosh-core` 140 通过
- [x] 包体积评估:基线 1344.79 kB → 1552.30 kB(+208 kB,26 家图标深路径;懒加载列后续)

## 回归红线(待开发机人工验证)

- [ ] 旧 `ai_providers`/`ai_model` JSON 用户升级后不丢配置、能聊天(**需真机验证迁移**)
- [ ] 非 Tauri 环境(纯 vite dev)不崩溃(agent/models store 失败静默置空)
- [ ] `cargo check -p mosh` + `cargo test` 在 glib ≥ 2.70 环境通过

## 后续任务候选(不在本期)

- 前端测试框架引入(vitest)+ aiIcons/选择器单测
- 旧命令兼容层移除(get/set_ai_config 等 6 个)
- aiIcons 懒加载(动态 import,削 ~200 kB 初始包)
- 新表纳入多设备同步(sync dump/merge 扩展)
- 模型价格字段与 token 用量展示
