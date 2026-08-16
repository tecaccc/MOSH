/**
 * 生成 MOSH 应用图标：SVG 源 → 1024 PNG（tauri icon 源）+ 64 favicon。
 *
 * 设计：品牌紫渐变圆角方块（accent #6d5dd3 同族）+ 几何白色 M +
 * 右下绿色对勾角标（呼应应用内待办完成态 --pri-low）。
 *
 * 用法：node scripts/make-icon.mjs
 * 产物：src-tauri/icons/app-icon.png（1024，喂 `npm run tauri icon`）
 *       static/favicon.png（64）
 * 源文件：src-tauri/icons/app-icon.svg（改设计后重跑本脚本）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8677F0"/>
      <stop offset="1" stop-color="#5A48C9"/>
    </linearGradient>
  </defs>

  <!-- 圆角底板（~22.7% 圆角，squircle 观感） -->
  <rect x="32" y="32" width="960" height="960" rx="218" fill="url(#bg)"/>

  <!-- 几何 M（白，圆头圆角连接） -->
  <path d="M 292 700 L 292 356 L 500 536 L 708 356 L 708 700"
        fill="none" stroke="#FFFFFF" stroke-width="92"
        stroke-linecap="round" stroke-linejoin="round"/>

  <!-- 待办对勾角标（完成态绿 + 白描边） -->
  <circle cx="760" cy="760" r="112" fill="#36AC74" stroke="#FFFFFF" stroke-width="20"/>
  <path d="M 712 762 L 748 798 L 814 722"
        fill="none" stroke="#FFFFFF" stroke-width="46"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const root = new URL("..", import.meta.url);
await writeFile(new URL("src-tauri/icons/app-icon.svg", root), SVG, "utf8");

const source = sharp(Buffer.from(SVG), { density: 96 }).resize(1024, 1024);
await mkdir(new URL("src-tauri/icons", root), { recursive: true });
await source.clone().png().toFile(new URL("src-tauri/icons/app-icon.png", root).pathname);
await mkdir(new URL("static", root), { recursive: true });
await source.clone().resize(64, 64).png().toFile(new URL("static/favicon.png", root).pathname);

console.log("✓ app-icon.png (1024) + favicon.png (64) 已生成");
