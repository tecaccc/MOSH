import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { version } from "./package.json";

// Tauri 前端构建：dev 端口 1420 对齐 tauri.conf.json devUrl；
// build 输出 build/ 对齐 frontendDist（原 SvelteKit adapter-static 同路径）。
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // 静态资源在 static/（SvelteKit 时代惯例）：dev 直接 serve、build 拷入产物，
  // 否则 /home-banner.png 等根路径引用 404（Vite 默认只认 public/）。
  publicDir: "static",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "build", target: "es2022", emptyOutDir: true },
});
