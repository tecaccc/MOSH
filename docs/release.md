# 发布与自动更新指南

本仓库通过 **GitHub Actions + tauri-action** 自动构建并发布 Release；桌面端内置
**tauri-plugin-updater**，启动后自动检测新版本，确认后下载安装并重启。

## 一、发布新版本

发布前需同步三处版本号（保持一致）：

| 位置                              | 字段      |
| --------------------------------- | --------- |
| `package.json`                    | `version` |
| `Cargo.toml`（workspace 根）      | `version` |
| `src-tauri/tauri.conf.json`       | `version` |

并把 `CHANGELOG.md` 中 `[Unreleased]` 小节的变更整理为对应版本小节（日期当日），
新建空的 `[Unreleased]`。Release 页说明会引导用户查看 CHANGELOG。

然后打标签推送：

```bash
git tag v0.2.0
git push origin v0.2.0
```

推送 `v*` 标签后自动触发 `.github/workflows/release.yml`：

1. **test**：`npm run check`（tsc）+ `cargo test -p mosh-core`；
2. **build**：macOS（arm64 + x64 双包）、Linux（AppImage/deb）、Windows（**NSIS 安装包**
   `mosh_x.y.z_x64-setup.exe`，简中/英文、可选仅当前用户/所有用户安装）并行构建，
   产物与 `.sig` 签名自动上传到对应 Release，并生成 `latest.json`（updater 清单）。

> Windows 正式分发形态即此安装包（不再分发裸 `mosh.exe` + DLL 的便携版）；
> 应用内自动更新在 Windows 上也是静默重跑该安装包完成的。

也可在 GitHub 仓库 **Actions → Release → Run workflow** 手动触发。

## 二、更新签名密钥（Secrets 配置）

自动更新的安装包必须经 minisign 密钥签名（`tauri.conf.json → plugins.updater.pubkey`
校验）。本项目已生成密钥对：

- **公钥**：已写入 `src-tauri/tauri.conf.json`（可公开）。
- **私钥**：生成于本机 `/tmp/mosh-updater.key`（**密码为空**）。
  ⚠️ `/tmp` 重启即失，请立即转移到密码管理器等安全位置并从机器上删除；
  **私钥丢失后将无法再发布可自动更新的版本**。

如需重新生成（会作废已有客户端的更新能力）：

```bash
npm run tauri signer generate -w ~/.mosh-updater.key -p "你的密码"
# 把输出的公钥替换 tauri.conf.json 的 plugins.updater.pubkey
```

在仓库 **Settings → Secrets and variables → Actions** 配置：

| Secret 名                          | 值                                  |
| ---------------------------------- | ----------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`        | 私钥文件全文（`cat ~/.mosh-updater.key`） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（本项目为空则填空串或跳过） |

## 三、应用内自动更新行为

- 启动 8 秒后静默检查一次（无更新/网络失败不打扰）；
- 发现新版本弹出右下角通知卡（当前版本 → 新版本 + 更新说明）；
- 「立即更新」显示下载进度，安装完成自动重启进入新版本；
- 设置 → 关于 → 「软件更新」可手动检查。

更新端点：`https://github.com/tecaccc/MOSH/releases/latest/download/latest.json`
（由 CI 自动生成上传，无需手工维护）。

## 四、常见问题

- **Release 里没有 latest.json**：确认 `tauri.conf.json` 的
  `bundle.createUpdaterArtifacts: true` 且构建时提供了签名 Secrets。
- **客户端提示签名校验失败**：Release 是用旧密钥签的，或 `pubkey` 被改动；
  用当前私钥重新发一版。
- **检测不到新版本**：确认三处版本号都已提升（updater 按 semver 比较
  `latest.json` 与客户端版本）。
