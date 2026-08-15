import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
// 浏览器直开（非 Tauri）时设置页「关于」的版本回退：npm 脚本会注入
// npm_package_version；Tauri 环境以 tauri.conf.json 的 getVersion() 为准。
// @ts-expect-error process is a nodejs global
const pkgVersion = process.env.npm_package_version ?? "dev";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
