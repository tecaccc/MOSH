import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../state/store";
import { useSyncStore } from "../state/sync";
import styles from "./TitleBar.module.css";

/**
 * 自定义窗口标题栏（decorations: false）：左段与 Sidebar 同宽同色，
 * 右为 Windows 风格窗口按钮。空白区域可拖动窗口。浏览器直开时按钮 no-op。
 * 助手视图时，最小化按钮左侧额外提供「会话历史」显隐开关（跨组件状态在
 * app store 的 chatSideVisible，由 ChatPanel 消费）。
 */

const inTauri = "__TAURI_INTERNALS__" in window;

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const currentView = useAppStore((s) => s.currentView);
  const chatSideVisible = useAppStore((s) => s.chatSideVisible);
  const toggleChatSide = useAppStore((s) => s.toggleChatSide);
  // 同步状态点（仅启用时展示；syncing=旋转、idle=绿、error=红，title 提示详情）。
  const syncEnabled = useSyncStore((s) => s.config?.enabled === true);
  const syncPhase = useSyncStore((s) => s.ui.phase);
  const syncError = useSyncStore((s) => s.ui.error);

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win.onResized(async () => {
      setMaximized(await win.isMaximized());
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const onMinimize = () => {
    if (inTauri) void getCurrentWindow().minimize();
  };
  const onToggleMaximize = async () => {
    if (!inTauri) return;
    await getCurrentWindow().toggleMaximize();
    setMaximized(await getCurrentWindow().isMaximized());
  };
  const onClose = () => {
    if (inTauri) void getCurrentWindow().close();
  };

  return (
    <header className={styles.titlebar}>
      <div className={styles["tb-left"]} data-tauri-drag-region />
      <div className={styles["tb-main"]} data-tauri-drag-region />
      <div className={styles.tbActions}>
        {syncEnabled ? (
          <span
            className={styles["tb-sync"]}
            data-phase={syncPhase}
            title={
              syncPhase === "syncing"
                ? "同步中…"
                : syncPhase === "error"
                  ? `同步失败：${syncError ?? "未知错误"}`
                  : "多设备同步已启用"
            }
            aria-label="同步状态"
          />
        ) : null}
        {currentView === "agent" ? (
          <button
            type="button"
            className={`${styles["tb-btn"]} ${styles["tb-chat"]}${chatSideVisible ? ` ${styles.on}` : ""}`}
            aria-label={chatSideVisible ? "隐藏会话历史" : "显示会话历史"}
            title={chatSideVisible ? "隐藏会话历史" : "显示会话历史"}
            onClick={toggleChatSide}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16" />
              <path d="M18.5 9.5h.01M18.5 12.5h.01" />
            </svg>
          </button>
        ) : null}
        <button type="button" className={styles["tb-btn"]} aria-label="最小化" onClick={onMinimize}>
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className={styles["tb-btn"]}
          aria-label={maximized ? "向下还原" : "最大化"}
          onClick={() => void onToggleMaximize()}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="2.5" width="7" height="7" />
              <polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button type="button" className={`${styles["tb-btn"]} ${styles["tb-close"]}`} aria-label="关闭" onClick={onClose}>
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}
