/**
 * 自动更新（zustand）：基于 tauri-plugin-updater 检测 GitHub Release 新版本，
 * 确认后下载安装并重启（tauri-plugin-process relaunch）。
 *
 * 生命周期：check（silent=启动期静默检查，无更新不打扰）→ available（弹
 * UpdaterToast 提示）→ startUpdate（下载进度 → 安装 → relaunch）。
 * 仅在 Tauri 环境生效（vite dev 浏览器直开时静默跳过）。
 */

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

/** 更新流程阶段。 */
export type UpdaterPhase =
  | "idle" // 未开始/已关闭提示
  | "checking" // 检测中
  | "available" // 发现新版本（等待用户确认）
  | "upToDate" // 已是最新（手动检查后的终态，供设置页反馈）
  | "downloading" // 下载中
  | "installing" // 安装中（即将重启）
  | "error"; // 检查或下载失败

/** 新版本信息（Update 实例的展示投影；实例本体存模块级变量）。 */
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  /** Release notes（Markdown 原文，Toast 截断展示）。 */
  body: string | null;
  date: string | null;
}

/** 下载进度（字节）。total 可能为 0（服务端未返回长度）。 */
export interface DownloadProgress {
  downloaded: number;
  total: number;
}

interface UpdaterState {
  phase: UpdaterPhase;
  info: UpdateInfo | null;
  progress: DownloadProgress | null;
  error: string | null;
  /** 检查更新（silent=true 时无更新/失败均静默，用于启动期自动检查）。 */
  check(opts?: { silent?: boolean }): Promise<void>;
  /** 关闭提示（回到 idle；下载中不可关）。 */
  dismiss(): void;
  /** 确认更新：下载 → 安装 → 重启。 */
  startUpdate(): Promise<void>;
}

/** check() 返回的 Update 实例（持 downloadAndInstall；不进 store 状态）。 */
let pendingUpdate: Update | null = null;

const fmtErr = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useUpdaterStore = create<UpdaterState>()((set) => ({
  phase: "idle",
  info: null,
  progress: null,
  error: null,

  check: async ({ silent = false } = {}) => {
    if (!("__TAURI_INTERNALS__" in window)) return; // 非 Tauri 环境（浏览器 dev）
    set({ phase: "checking", error: null });
    try {
      const [currentVersion, update] = await Promise.all([getVersion(), check()]);
      if (update) {
        pendingUpdate = update;
        set({
          phase: "available",
          info: {
            currentVersion,
            version: update.version,
            body: update.body ?? null,
            date: update.date ?? null,
          },
          progress: null,
        });
      } else {
        pendingUpdate = null;
        set({ phase: silent ? "idle" : "upToDate", info: null });
      }
    } catch (e) {
      // 网络失败等：静默检查不打扰，手动检查反馈到设置页。
      set({ phase: silent ? "idle" : "error", error: fmtErr(e) });
    }
  },

  dismiss: () => {
    set((s) => (s.phase === "downloading" || s.phase === "installing" ? s : { phase: "idle" }));
  },

  startUpdate: async () => {
    const update = pendingUpdate;
    if (!update) {
      set({ phase: "error", error: "更新信息已失效，请重新检查" });
      return;
    }
    set({ phase: "downloading", progress: { downloaded: 0, total: 0 }, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          total = event.data.contentLength;
        } else if (event.event === "Progress" && event.data.chunkLength) {
          downloaded += event.data.chunkLength;
        }
        set({ progress: { downloaded, total } });
      });
      set({ phase: "installing" });
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: fmtErr(e) });
    }
  },
}));
