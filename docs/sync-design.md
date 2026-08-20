# MOSH 多设备同步 — 设计共识（v1）

> 本文是 2026-08-18 与用户多轮 grilling 会话的共识固化。
> 状态：设计已确认，v1 待实现。任务：`.trellis/tasks/08-18-sync-v1/`。

## 1. 问题与场景

MOSH 是本地优先应用，数据落地本机 SQLite。用户在**家 / 公司两处交替使用**（未来扩展至手机等更多设备），
导致数据不同步、使用割裂。

使用形态的关键约束：**交替使用**——同一时刻基本只有一台设备在编辑。这决定了同步可以做
"每条记录最后写入赢（LWW）"，无需 CRDT / 字段级合并。

## 2. 已否决的路线（记录以防回流）

| 路线 | 否决原因 |
| --- | --- |
| Cloudflare D1 / 云数据库 | 无客户端推送机制（轮询延迟不优于对象存储 HEAD）；与端到端加密互斥（云端只见密文，服务端无法查询/合并，沦为哑 KV）；引入额外云商绑定 |
| 自建 sync server | 为一个 SQLite 文件维护常驻在线服务，性价比极差 |
| P2P / Syncthing | 公司防火墙下打洞大概率不可用；P2P 出站不保证 |
| CRDT | 交替使用场景下同秒并发编辑概率趋近于零，复杂度不值得 |
| 定时轮询（30s HEAD） | 用户裁决：公司环境不做周期性请求，改为事件触发 |

## 3. 总体方案

**传输层 = S3 兼容对象存储（主用腾讯云 COS）+ 端到端加密 + 每设备全量 dump + 客户端 LWW 合并。**

云端是哑管道：只存每台设备的一份加密压缩快照，不理解任何内容。所有合并逻辑在客户端。

### 3.1 对象布局

```
mosh-sync/                     ← bucket 内约定前缀
  <device-id>/dump.json.gz.enc  ← 每设备一份全量快照（密文）
```

- `device-id`：首次启用同步时本地生成的 UUID。
- dump 内容：`records` 全量（含软删墓碑）+ `settings` 全量 + `agent_messages` 全量，
  外层 JSON 带 `version` 字段（当前 `1`），为 v3 记录级增量留协议演进空间。
- 增量判断：对象存储端用 ETag/Last-Modified（HEAD 即可判断远端是否有变化）。

### 3.2 加密

- **端到端**：APP 本地生成 32 字节随机密钥（等价 `openssl rand -base64 32`），
  以文本串形式导出，新设备粘贴导入。密钥强度由 APP 保证，不支持用户自编弱口令。
- 加密方案：AES-256-GCM（或 ChaCha20-Poly1305），密钥派生直接用随机数，无需 KDF。
  随机 nonce 附在密文头。
- 云端（COS）只见密文。密钥丢失 = 云端数据永久不可解；本地数据完好，
  可用新密钥重新初始化覆盖云端。密钥建议用户存入密码管理器。
- 设置页可随时重新查看/导出密钥串（降低丢失概率）。

### 3.3 合并算法（客户端）

拉取所有设备的 dump → 解密 → 逐表合并 → 写本地 → 推自己那份 dump：

- **records**：按 `id` 对齐，LWW——`updated_at` 新者赢（`revision` 作 tie-breaker），
  旧的静默丢弃，无冲突 UI。
- **agent_messages**：按 `id` 并集合并（append-only，天然无冲突）。
- **settings**：按键覆盖，晚写赢（以 dump 时间戳为准）。
- **墓碑**：软删记录（`deleted_at` 非空）永久保留在同步流中，v1 不做 GC，
  天然保留“误删找回”余地。
- **会话墓碑**（2026-08-20 补）：`agent_messages` 的并集合并无法传播删除——
  一方删会话后，他机旧 dump 会把消息原样插回，会话复活。因此删除会话时在
  `agent_session_tombstones` 表记墓碑（只增不删，同样并集合并）；合并时清理
  本地该会话消息、且不再插入该会话的任何消息。会话 id 为每会话新生的 UUID，
  不会重用撞墓碑。dump 新增 `deleted_sessions` 字段（`serde(default)`，旧客户端
  双向兼容，协议版本仍为 1）。

### 3.4 同步范围

**全部同步**：records（待办+日程）、settings（AI 提供商+API key、技能、MCP、城市……）、agent_messages。

**唯一例外（逻辑必然，非偏好）**：同步模块自身的配置（COS endpoint/region/bucket/AK/SK + 加密密钥）
不可能通过同步到达——拉取云端数据之前就必须先有它们。每台设备手工配置一次。
注意 COS AK/SK 与加密密钥绝不能入云：它们是解密云端数据的东西，同步等于锁和钥匙放一起。

## 4. 触发时机（无任何轮询）

| 动作 | 触发 |
| --- | --- |
| 拉取 | APP 启动时一次 + 设置页「立即同步」手动 |
| 推送 | 本地任何变更后防抖 5 秒自动推（空闲时零请求）+ 退出时兜底补一发 |

公司合规：完全空闲时零网络请求；只在真的改了东西后发一次上传。

**验收场景**：公司改待办 → 5 秒后自动上云（密文）→ 回家开 MOSH 自动拉取 → 立刻可见。

## 5. UI（最小方案）

- 标题栏状态点：同步中 / 已同步 / 错误（+ 点开看详情）。
- 设置页：同步配置卡（endpoint/region/bucket/AK/SK/密钥导入导出）+ 上次成功同步时间 + 「立即同步」。
  高级选项：寻址方式（virtual-hosted `bucket.endpoint/key` 或 path-style `endpoint/bucket/key`，
  MinIO 等自建网关用后者）、单请求超时（默认 30s，5–600）、TLS 证书校验开关（自签代理可关，
  默认开）、连接测试（LIST 前缀验证端点/凭证/签名/权限全链路）。
  不设并发选项——协议为每设备单对象，无并发上传需求。
- 无冲突列表（与 LWW 静默决策自洽）。
- 同步功能默认关闭、可选开启（守住 README"本地优先、不依赖云端"承诺）。

## 6. 架构落点

```
mosh-core 新增 sync 模块
  sync/mod.rs      SyncEngine（拉→合并→写→推，全流程）
  sync/crypto.rs   密钥生成/导入导出 + AES-GCM 加解密
  sync/remote.rs   S3 兼容客户端（PUT/GET/HEAD/DELETE，COS 签名）
  sync/dump.rs     全量 dump 序列化/反序列化（version 字段）
  sync/merge.rs    LWW 合并器（records / settings / agent_messages）

src-tauri 薄壳
  sync_* 命令（configure / sync_now / export_key / import_key / get_status）
  退出兜底：窗口关闭事件挂一次尽力推送
  变更防抖：mosh-core 变更后标记 dirty，5s 后触发（Rust 侧定时器）

前端
  state/sync.ts    zustand store（状态点 + 设置页）
  设置页「同步」卡片 + 标题栏状态点
```

边界铁律不变：领域逻辑全部在 mosh-core；src-tauri 只做命令绑定/State/event 转发；
COS 凭证与密钥不进前端明文存储（密钥串导出走系统剪贴板/文件对话框）。

## 7. 里程碑

- **v1（本任务）**：COS + 全量 dump + E2E 加密 + 事件触发同步（上述全部）。
- **v2**：手机端（Tauri 2 mobile 复用 mosh-core）+ 二维码传密钥。
- **v3**：数据量增长后迁记录级增量（协议 version 字段已预留）。
