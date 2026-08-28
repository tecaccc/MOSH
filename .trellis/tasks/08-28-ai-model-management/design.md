# 技术设计:AI 模型配置与管理

> 借鉴 Cherry Studio 的架构思想,在 MOSH 自有技术栈(Tauri 2 / Rust mosh-core / React 19 / zustand / CSS Modules / @lobehub/icons)中重新实现。

## 0. Cherry Studio → MOSH 概念映射

| Cherry Studio(Electron/Node) | MOSH(Tauri/Rust) | 说明 |
|---|---|---|
| `@cherrystudio/provider-registry` 包(JSON 目录) | `src/lib/aiPresets.ts` 前端预置常量 | 只做十几个常用预置,事实自写 |
| SQLite + drizzle(`user_provider`/`user_model`) | rusqlite 新表 `ai_provider`/`ai_model` | 同样的 delta 思想,但本期无预置库可继承,表更瘦 |
| DataApi over Electron IPC(SWR) | Tauri command + zustand | |
| `UniqueModelId = providerId::modelId` | 同名同义,Rust/TS 双侧 | 关键统一标识 |
| `models.json` 三层合并(用户 delta>provider 覆盖>基础) | 本期两层:预置默认 + 用户行(列 null=用默认) | 保留"非空列即覆盖"的语义,后续可加目录层 |
| `resolveIconRef` 三级回退 + 懒加载复合图标 | `resolveAiIcon` 三级回退 + @lobehub/icons 静态映射 | 规则自写 |
| Composer 内 ModelSelector(虚拟列表/Radix) | 简化版:普通列表 + 搜索 + 分组 + 置顶 | 首版不做虚拟滚动 |
| `ai.stream.open` + mentionedModelIds fan-out | 现有 `send(session, text, model, images)` 不变 | 仅模型来源改为新表 |

## 1. 数据层(mosh-core)

### 1.1 表结构(SQLite)

```sql
CREATE TABLE ai_provider (
  id          TEXT PRIMARY KEY,        -- 稳定 slug,如 'deepseek'、'custom-<uuid8>';预置用 preset_id 同值
  preset_id   TEXT,                    -- 来源预置键(可空=全自定义)
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  api_key     TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  REAL NOT NULL DEFAULT 0, -- 分数索引,支持拖拽
  created_at  TEXT NOT NULL
);

CREATE TABLE ai_model (
  id              TEXT PRIMARY KEY,    -- '{provider_id}::{model_id}' (UniqueModelId)
  provider_id     TEXT NOT NULL REFERENCES ai_provider(id) ON DELETE CASCADE,
  model_id        TEXT NOT NULL,       -- API 原始 id
  name            TEXT,                -- 显示名;NULL=用 model_id
  capabilities    TEXT NOT NULL DEFAULT '[]',  -- JSON: ["vision","reasoning","tools","embedding"]
  context_window  INTEGER,
  notes           TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  hidden          INTEGER NOT NULL DEFAULT 0,
  sort_order      REAL NOT NULL DEFAULT 0,
  UNIQUE(provider_id, model_id)
);
```

要点(学自 Cherry Studio):
- **主键即 UniqueModelId**,业务层不需要额外生成 id
- **null 列 = 继承默认**(如 name 为 null 显示 model_id),为将来"预置目录覆盖"留好语义
- ON DELETE CASCADE 级联;`set_model` 默认值校验放在服务层

### 1.2 类型(Rust)

`crates/mosh-core/src/agent/llm.rs` 旁新增 `crates/mosh-core/src/agent/models.rs`:

```rust
pub struct AiProvider { pub id, preset_id: Option<String>, pub name, pub base_url, pub api_key, pub enabled, pub sort_order }
pub struct AiModel { pub id, pub provider_id, pub model_id, name: Option<String>, capabilities: Vec<String>, context_window: Option<i64>, notes/pinned/enabled/hidden, sort_order }
pub const MODEL_ID_SEP: &str = "::";
pub fn unique_model_id(provider_id: &str, model_id: &str) -> String;
pub fn parse_unique_model_id(id: &str) -> Option<(String, String)>; // 首个 :: 分割
```

`AiConfig`(发送用)保持不变,由 `ai_provider + ai_model` 即时拼装:`resolve_ai_config(unique_model_id)`。

### 1.3 存储与迁移(storage.rs)

- `init()` 建表 + `PRAGMA table_info` 判断新装/升级
- 迁移函数 `migrate_ai_settings()`:读 settings 表 `ai_providers`(旧 JSON 数组)→ 逐条插入 `ai_provider`(id 取 preset 匹配名否则 `custom-<uuid8>`;每条带当时的 model 字符串插一行 `ai_model`)+ `ai_model`(激活配置)写入 settings 新 key `ai_default_model`
- 旧 key 不删,写一次性标记 `ai_settings_migrated=1`
- 同步设计兼容:新表纳入现有 sync 事件(同 todos/events 变更通道,`docs/sync-design.md` 的表清单加两张表;若 sync 框架按表枚举,需要扩展 `sync` 模块的数据源)

### 1.4 服务层命令(src-tauri/lib.rs)

```
list_providers() -> Vec<AiProvider>
upsert_provider(AiProvider) -> ()                    # 按 id upsert
delete_provider(id) -> ()                             # 级联删模型;若默认模型被删→清默认
list_models(provider_id: Option<String>) -> Vec<AiModel>   # None=全部(含禁用,由前端过滤)
upsert_model(AiModel) -> ()
delete_model(unique_id) -> ()
sync_models(provider_id) -> SyncResult { added: Vec<String>, removed_ids: Vec<String> }
    # GET {base}/models → diff 库内 model_id:新增插行(enabled=1),库内多余标记 hidden=1(不物理删,用户手删)
set_default_model(unique_id) -> ()                    # settings key: ai_default_model
get_default_model() -> Option<AiConfig>               # 解析失败(模型被删)回退:首个 enabled provider 的首个 enabled 模型
```

兼容层:`get_ai_config` 改为 `get_default_model` 的别名实现,`save_ai_provider` 在迁移后只做"转发到新表"(避免聊天链路回归)。

## 2. 前端

### 2.1 预置 `src/lib/aiPresets.ts`

```ts
export interface ProviderPreset { key: string; name: string; baseUrl: string; iconKey: string; defaultModels?: string[] }
export const PROVIDER_PRESETS: ProviderPreset[] = [ /* DeepSeek/通义/Kimi/OpenAI/Groq/Ollama…十余条,事实自写 */ ]
```

(现在 SettingsView 里的 BUILTIN_PROVIDERS 迁到这里并扩充;`providerIconOf` 删除,统一走 §2.3。)

### 2.2 状态 `src/state/models.ts`(zustand)

```ts
interface ModelsState {
  providers: AiProvider[]; models: AiModel[]; defaultModelId: string | null;
  load(): Promise<void>;                       // 三命令并行
  upsertProvider / deleteProvider / upsertModel / deleteModel
  syncModels(providerId): Promise<SyncResult>
  setDefaultModel(uniqueId): Promise<void>
}
// 派生选择器(独立函数,不放 state):
selectChatModels(s): AiModel[]                 // enabled && !hidden && provider.enabled,按 provider 分组排序
selectModelWithProvider(s, uniqueId): { model, provider } | undefined
```

数据变更后调 `refreshData()` 通知 sync(遵循现有 state-management 规范)。

### 2.3 图标解析 `src/lib/aiIcons.tsx` ⭐

单一入口组件 + 解析函数(全部自写,规则参考 Cherry Studio 的思想):

```tsx
// 解析链(每级命中即返回):
resolveAiIcon(modelId, providerId):
  1. 规范化 baseName = lowerBaseName(raw): 去大小写、'vendor/' 前缀、':free'/':cloud' 后缀
  2. 模型专属表 MODEL_ICON_RULES: [regex, lobehubModelIconKey][]
     例: /claude/→Claude, /deepseek/→DeepSeek, /^gpt|^o[13]|^chatgpt/→OpenAI, /glm/→Zhipu, /qwen|qwq/→Qwen, /kimi|moonshot/→Moonshot, /gemini/→Gemini, /llama/→Meta, /grok/→GrokAI, /mistral|codestral/→Mistral, /doubao/→Doubao, /ernie/→Baidu, /hunyuan/→Hunyuan, /yi-/→LinYi …
  3. 模型名→厂商表 MODEL_TO_PROVIDER_RULES(同上但映射到厂商图标,覆盖面更宽)
  4. 厂商键:providerId/preset_id 精确表 PROVIDER_ICON_KEYS + 别名表(dashscope→Qwen、moonshot→Moonshot…)
  5. undefined → 兜底

export function AiEntityIcon({ modelId?, providerId?, size }: …) {
  const hit = resolveAiIcon(...)
  if (hit) return <hit.Component size={size}/>          // @lobehub/icons 深路径按需 import
  return <span className={fallback}>{首字母大写}</span>   // CSS 圆角底 + 首字母
}
```

实现细节:
- **按需引入**:沿用 SettingsView 现有做法(`@lobehub/icons/es/XXX` 深路径),把用到的图标集中在 `aiIcons.tsx` 顶部一张静态 map;规则表只存 map 的 key,避免 barrel 拉全量(现有注释已警示 4MB 问题)
- @lobehub 图标组件自带 `.Color`/mono 与 Avatar 变体,直接用 `<X.Color size>`(或 `Combine`),无需自建明暗双主题
- 规则数组**顺序敏感:特异在前**(gpt-4o-mini 先于 gpt-4o 先于 gpt)
- 纯函数 + 单测(`aiIcons.test.tsx`):断言若干代表 id 的命中与兜底

### 2.4 ModelSelector 组件 `src/components/ModelSelector.tsx`

结构(简化版 Cherry Studio 交互):

```
<AiModelSelector>           // 触发按钮: <AiEntityIcon/> + 模型名 | provider名 + ▾
  ├ 搜索输入(模型名/model_id/provider 名包含匹配,不分大小写)
  ├ 置顶区(pinned=1,无则不渲染)
  ├ 按 Provider 分组标题(点击标题→直达该 provider 设置)
  │   └ 行: 图标 + 名称(+ model_id 次行) + 能力点标(👁视觉/🧠推理/🔧工具,来自 capabilities)
  └ 底部:「管理模型…」→ openSettings({section:'ai'})
```

- 受控组件 `{ value: uniqueId | null, onChange }`,同时用于 ChatPanel 头部与设置页默认模型
- 点击行:onChange + 关闭;置顶星标:upsertModel(pinned 翻转)
- 无虚拟列表(模型量级 <300);分组用 `<details>` 或平铺均可,首版平铺+粘性组头
- 键盘:↑↓ 高亮、Enter 选择、Esc 关闭(可选,首版可只做鼠标)

### 2.5 设置页改造(SettingsView AI 分区)

```
左栏(AI 模型)                 右栏
┌────────────────────┐  ┌─────────────────────────────┐
│ ● DeepSeek      ⚡  │  │ 名称 / Base URL / API Key     │
│ ● 通义千问          │  │ [测试连接]                    │
│ ● 自定义-xx         │  │ ──────────────────────────── │
│ + 添加自定义…        │  │ 默认模型: <AiModelSelector/>  │
└────────────────────┘  │ 模型(12) [同步模型] [+手动添加] │
                        │  ☑ deepseek-chat   👁🧠  📌 ✏ 🗑 │
                        │  ☐ deepseek-reasoner …        │
                        └─────────────────────────────┘
```

- 添加流程:选预置(带图标网格)或空白自定义 → 预填 base_url/默认模型 → 保存后自动 `sync_models`
- 现有表单逻辑大部分复用,把「单一 model 字段」改为模型行列表;`BUILTIN_PROVIDERS`/`providerIconOf` 删除

### 2.6 聊天集成(ChatPanel + agent store)

- `head-model` 的 `<select>` 替换为 `<AiModelSelector value={defaultModelId} onChange={setDefaultModel}/>`
- store 改造:`models/selectedModel: string[]` 两个旧字段删除,改 `defaultModelId`;`init()` 不再每次拉 `/models`(库内已有);`send()` 调 `get_default_model` 的解析结果传 `ipcSend`(Rust 侧 `send_agent` 从参数收模型,行为不变,但可改为只传 uniqueId 由 Rust 解析——**选后者**,前端不再拼 base_url)
- 助手消息:AgentEvent 的 message metadata 增加 `model_id`,气泡头部渲染小号 `<AiEntityIcon>` + 模型名(历史消息因内存态重启即清,无存量迁移问题)
- 未配置/无默认模型:保持现有「未配置」引导

## 3. 边界与错误处理

- 同步失败(网络/key 错):toast 报错,不动库
- `get_default_model` 解析失败 → 回退首个可用;全无可用 → 聊天框显示「选择模型」空态
- 迁移幂等:标记位防重入;重复执行无副作用
- API key 仍以明文存本地 SQLite(与现状一致,README 已声明本地优先;加密不在本期)

## 4. 实施拆步(详见 implement.md)

1. Rust:类型 + 表 + 迁移 + 命令(含单测)
2. TS:aiPresets / aiIcons(+测试)
3. zustand store + AiModelSelector 组件
4. 设置页改造
5. 聊天集成 + 旧命令兼容层
6. 收尾:sync 数据源接入、文档(README 功能描述更新)

## 5. 风险

| 风险 | 缓解 |
|---|---|
| @lobehub/icons 缺某模型图标 | 兜底链保证永远有首字母;规则表可增量补 |
| 模型 id 含 `::` 罕见冲突 | 约定按首个 `::` 分割(与 Cherry Studio 同语义);`upsert_model` 时校验 provider_id 前缀一致 |
| 旧用户升级数据丢失观感 | 迁移保留旧 key 只读 + 手动「重新导入」不做(超范围) |
| sync 模块需扩展两张表 | 若 sync 框架耦合紧,可列为后续任务,首版新表不参与同步并在 README 注明 |
