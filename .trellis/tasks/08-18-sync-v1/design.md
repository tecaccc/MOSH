# Design — 多设备同步 v1

> 共识 PRD 见 `prd.md`；完整设计共识见 `docs/sync-design.md`。本文是实现级设计。

## 1. 架构

```
┌──────────────────────── Tauri 桌面应用 ────────────────────────┐
│ 前端 React 19                                                    │
│  标题栏状态点（同步中/已同步/错误）   设置页「同步」卡片            │
│        │ invoke("sync_*")          ▲ listen("sync://status")    │
│ ───────┼───────────────────────────┼───────────────────────── │
│ src-tauri 薄壳（命令绑定 + event 转发 + 退出兜底挂钩）           │
│        │ 直调                                                     │
│ mosh-core::sync（新模块）                                        │
│  mod.rs      SyncEngine：pull → merge → write → push 全流程      │
│  crypto.rs   密钥生成/导出导入 + AES-256-GCM                     │
│  remote.rs   S3 兼容客户端（SigV4 签名，PUT/GET/HEAD/DELETE/LIST）│
│  dump.rs     全量快照序列化（version=1）                         │
│  merge.rs    LWW 合并器（records / settings / agent_messages）  │
└─────────────────────────────────────────────────────────────────┘
```

边界铁律：领域逻辑全在 mosh-core；src-tauri 只做命令/事件/生命周期挂钩；
COS AK/SK 与密钥不通过前端明文落盘（走 OS keychain 不可行则存 settings `sync.*` 键，标 device_local）。

## 2. 前置迁移（SQLite migration v3）— 两个合并硬伤

grilling 共识假设"agent_messages 按 id 并集、settings 晚写赢"，但现有 schema 支持不了：

1. **`agent_messages.id` 是 INTEGER AUTOINCREMENT**：两台设备各自从 1 自增，
   跨设备按 id 并集会撞号串消息。迁移：id 改 TEXT（UUID），新建表搬数据（旧 id 加
   `legacy-` 前缀防撞），写入侧改用 `Uuid::new_v4()`。
2. **`settings` 无 `updated_at`**：按键 LWW 没有时间戳。迁移：加
   `updated_at TEXT NOT NULL DEFAULT ''` 列；`set_setting` 自动写入 now。

## 3. 数据布局与格式

### 远端对象

```
mosh-sync/<device-id>/dump.bin     ← 单对象，密文
```

- 拉取 = LIST `mosh-sync/` 前缀下所有对象 → 逐个 GET → 跳过自己的。
- ETag/Last-Modified 缓存本地，未变跳过（v1 优化项，可先全量 GET）。

### dump 明文格式（version=1）

```json
{
  "version": 1,
  "device_id": "uuid",
  "dumped_at": "ISO8601",
  "records": [ /* 全量，含墓碑 */ ],
  "settings": [ /* 全量键值对，含 updated_at；排除 sync.* 配置键 */ ],
  "agent_messages": [ /* 全量 */ ]
}
```

### 加密

- 密钥：32 字节随机（`getrandom`/`rand`），导出 base64 文本串（44 字符）。
- AES-256-GCM（RustCrypto `aes-gcm` crate，纯 Rust，规避 windows-gnu 交叉编译 OpenSSL）。
  文件格式：`magic "MOSHSYNC1" || 12B nonce || ciphertext||tag`。gzip 在加密**前**（先压后密）。
- 排除键：`sync.endpoint / sync.region / sync.bucket / sync.access_key / sync.secret_key /
  sync.device_id / sync.enabled` 永不入 dump。

## 4. 合并算法（merge.rs，纯函数，核心单测区）

```
merge(local: Db, remote_dumps: Vec<Dump>) -> MergeResult
```

- **records**：按 id 对齐；`updated_at` 字符串比较新者赢（ISO8601 可字典序比较）；
  相同则 `revision` 大者赢；再相同取本地（幂等）。墓碑是普通 record（deleted_at 非空）走同一规则。
- **agent_messages**：按 id（UUID）并集，只增不改不删；`delete_agent_session`
  的删除 v1 不同步（会话删除是本机行为，注释说明，v2 再议墓碑）。
- **settings**：按 key，`updated_at` 新者赢；`sync.*` 排除键直接忽略。
- 合并结果一次性写入本地事务，然后生成自己 dump 推送。

## 5. S3 兼容客户端

- COS 兼容 AWS SigV4（`sha2` + `hmac` 手写签名，不引 S3 SDK——依赖最小化，函数不到百行）。
- 通用配置：endpoint（如 `https://cos.ap-guangzhou.myqcloud.com`）/ region / bucket / AK / SK，
  同样适用于 OSS / R2 / B2（SigV4 兼容端点）。
- 操作：LIST（XML 解析仅取 Key/ETag/LastModified）、GET、PUT。
- 全部 `reqwest`（rustls-tls，已在依赖树）。

## 6. 触发与生命周期

| 触发 | 实现 |
| --- | --- |
| 启动拉 | src-tauri setup 钩子，若 `sync.enabled` 且已配置 → spawn sync |
| 变更防抖推 | storage 写操作后 `mark_dirty()`；SyncEngine 后台任务 5s 防抖触发 push |
| 退出兜底 | `RunEvent::ExitRequested` 挂一次性尽力 push（超时 3s 放弃） |
| 手动 | `sync_now` 命令 |

状态事件：`sync://status` → `{ state: "idle"|"syncing"|"error", last_success_at, error? }`。
失败静默重试：下次触发点自然重试，不做退避队列（v1 从简）。

## 7. 命令面（src-tauri）

```
sync_configure(config)      // 存 settings（排除键），首次生成 device_id + 密钥
sync_get_config()           // 脱敏返回（secret_key 掩码）
sync_generate_key() -> String  // 生成并存储，返回导出串
sync_import_key(String)     // 校验长度后存储
sync_export_key() -> String
sync_now()                  // 全流程 pull+merge+push
sync_set_enabled(bool)
```

## 8. 前端

- `state/sync.ts`（zustand）：状态点轮询由 `sync://status` 事件驱动。
- 设置页「同步」卡片：配置表单 + 密钥生成/导出/导入 + 启用开关 + 立即同步 + 上次成功时间。
- 标题栏状态点复用现有 reminder/更新器的指示器模式。

## 9. 测试

- merge.rs：LWW 三态（updated_at 胜 / revision 胜 / 幂等）、墓碑传播、settings 键覆盖、
  排除键不入 dump、agent_messages 并集。
- crypto.rs：roundtrip、错误密钥解密失败、nonce 唯一性。
- dump.rs：版本字段前向校验（version > 1 报错）。
- remote.rs：SigV4 签名快照测试（固定时间戳比对 Authorization 头）。
- 集成：内存库 × 2 模拟双设备交替推拉（验收场景自动化）。

## 10. 实施顺序

1. 迁移 v3（agent_messages UUID id + settings.updated_at）+ storage 适配
2. crypto.rs + dump.rs + 单测
3. merge.rs + 单测
4. remote.rs（SigV4）+ 签名快照测试
5. SyncEngine（mod.rs）+ 命令面 + 事件
6. 防抖/退出兜底/启动拉挂钩
7. 前端状态点 + 设置卡片
8. 双设备集成测试 + 真机 COS 验收
