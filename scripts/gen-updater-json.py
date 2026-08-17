#!/usr/bin/env python3
"""从 GitHub Release 的资产（安装包 + .sig）生成 tauri-plugin-updater 的 latest.json。

用途：
  1. CI（.github/workflows/release.yml 的 updater 作业）：所有平台构建完成后，
     以“单一写入者”方式统一生成并上传 latest.json，消除矩阵并行时
     tauri-action 各自对 latest.json 读-改-写造成的丢失更新竞态
     （v0.1.1 曾因此丢失 windows-x86_64-nsis 条目，Windows 端检查更新报
     "None of the fallback platforms ... were found"）。
  2. 修复存量 Release：对已发布但 latest.json 缺平台的 Release 重跑并 --upload。

用法：
  # 本地检查（不写不传，打印将生成的平台条目）：
  python3 scripts/gen-updater-json.py --repo tecaccc/MOSH --tag v0.1.1 \
      --conf src-tauri/tauri.conf.json --out /tmp/latest.json

  # CI / 修复（需 GITHUB_TOKEN，替换 Release 上的 latest.json）：
  GITHUB_TOKEN=... python3 scripts/gen-updater-json.py \
      --repo "$GITHUB_REPOSITORY" --conf src-tauri/tauri.conf.json --upload

仅使用 Python 标准库；签名取自 Release 资产中的 `.sig` 文本。
缺资产或缺签名的平台条目会被跳过并在 stderr 告警（其余平台不受影响）。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import List, Optional, Tuple


def api_base() -> str:
    """GitHub API 根（GitHub Actions 会注入 GITHUB_API_URL，本地默认公网）。"""
    return os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")


def uploads_base() -> str:
    """上传端点根：api.github.com → uploads.github.com。"""
    host = api_base().split("//", 1)[-1]
    if host.startswith("api."):
        host = host[len("api."):]
    return "https://uploads." + host


def request_json(url: str, token: Optional[str], method: str = "GET", payload: Optional[bytes] = None,
                 content_type: str = "application/json", accept: str = "application/vnd.github+json") -> object:
    req = urllib.request.Request(url, data=payload, method=method)
    req.add_header("Accept", accept)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if payload is not None:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req) as resp:
        body = resp.read()
    return json.loads(body) if body else None


def request_text(url: str) -> str:
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8").strip()


def platform_map(product: str, version: str) -> List[Tuple[str, List[str]]]:
    """资产名 → updater platforms 键（与 tauri-action 生成的键保持一致）。"""
    return [
        (f"{product}_{version}_x64-setup.exe", ["windows-x86_64-nsis", "windows-x86_64"]),
        (f"{product}_x64.app.tar.gz", ["darwin-x86_64", "darwin-x86_64-app"]),
        (f"{product}_aarch64.app.tar.gz", ["darwin-aarch64", "darwin-aarch64-app"]),
        (f"{product}_{version}_amd64.AppImage", ["linux-x86_64", "linux-x86_64-appimage"]),
        (f"{product}_{version}_amd64.deb", ["linux-x86_64-deb"]),
        (f"{product}-{version}-1.x86_64.rpm", ["linux-x86_64-rpm"]),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True, help="owner/name，如 tecaccc/MOSH")
    ap.add_argument("--conf", default="src-tauri/tauri.conf.json", help="tauri.conf.json 路径（取版本与产品名）")
    ap.add_argument("--tag", help="Release 标签，默认 v{version}")
    ap.add_argument("--out", default="latest.json", help="输出文件路径")
    ap.add_argument("--upload", action="store_true", help="上传到 Release（替换现有 latest.json）")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    if args.upload and not token:
        print("错误：--upload 需要 GITHUB_TOKEN 环境变量", file=sys.stderr)
        return 2

    with open(args.conf, encoding="utf-8") as f:
        conf = json.load(f)
    product = conf.get("productName", "app")
    version = conf["version"]
    tag = args.tag or f"v{version}"
    if tag != f"v{version}":
        print(f"警告：tag {tag} 与 tauri.conf.json 版号 {version} 不一致，"
              "资产名匹配将基于 conf 版号（可能大面积跳过）", file=sys.stderr)

    try:
        release = request_json(f"{api_base()}/repos/{args.repo}/releases/tags/{tag}", token)
    except urllib.error.HTTPError as e:
        print(f"错误：获取 Release {tag} 失败：{e.code} {e.reason}", file=sys.stderr)
        return 1
    assets = {a["name"]: a for a in release["assets"]}

    platforms: dict = {}
    for asset_name, keys in platform_map(product, version):
        asset = assets.get(asset_name)
        sig = assets.get(asset_name + ".sig")
        if asset is None or sig is None:
            missing = "安装包" if asset is None else ".sig 签名"
            print(f"警告：跳过 {keys}（Release 缺 {missing}：{asset_name}）", file=sys.stderr)
            continue
        signature = request_text(sig["browser_download_url"])
        entry = {"signature": signature, "url": asset["browser_download_url"]}
        for key in keys:
            platforms[key] = entry

    if not platforms:
        print("错误：没有任何可用平台条目，拒绝生成空 latest.json", file=sys.stderr)
        return 1

    doc = {
        "version": version,
        "notes": release.get("body") or "",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "platforms": dict(sorted(platforms.items())),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"latest.json → {args.out}（{tag}，版本 {version}）")
    for key in doc["platforms"]:
        print(f"  平台：{key}")

    if args.upload:
        for name, a in assets.items():
            if name == "latest.json":
                request_json(f"{api_base()}/repos/{args.repo}/releases/assets/{a['id']}", token,
                             method="DELETE")
                print(f"已删除旧 latest.json（asset {a['id']}）")
                break
        payload = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        request_json(f"{uploads_base()}/repos/{args.repo}/releases/{release['id']}/assets?name=latest.json",
                     token, method="POST", payload=payload, content_type="application/octet-stream")
        print("已上传 latest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
