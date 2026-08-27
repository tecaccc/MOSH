import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../state/store";
import { useSyncStore } from "../state/sync";
import styles from "./TitleBar.module.css";

/**
 * 自定义窗口标题栏（decorations: false）：最左侧固定侧栏折叠开关，
 * 左段与 Sidebar 同宽同色，右为 Windows 风格窗口按钮。空白区域可拖动窗口。
 * 浏览器直开时按钮 no-op。最小化左侧附加功能按钮：同步触发（启用时展示，
 * 图标即状态——syncing=强调色旋转、error=红、idle=常色，点击手动触发立即同步）。
 */

const inTauri = "__TAURI_INTERNALS__" in window;

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  // 同步按钮（仅启用时展示）：点击手动触发立即同步（syncNow）；
  // busy 覆盖设置页保存配置等操作进行中，此时同样禁用防并发。
  const syncEnabled = useSyncStore((s) => s.config?.enabled === true);
  const syncPhase = useSyncStore((s) => s.ui.phase);
  const syncError = useSyncStore((s) => s.ui.error);
  const syncLastSuccess = useSyncStore((s) => s.ui.last_success_at);
  const syncBusy = useSyncStore((s) => s.busy);
  const syncNow = useSyncStore((s) => s.syncNow);
  // 侧栏折叠开关：固定在标题栏最左侧（收起/展开同一位置）；
  // 折叠时左段同步收起（与 Sidebar 同一状态、同一动画节奏）。
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const syncRunning = syncBusy || syncPhase === "syncing";
  const syncTitle =
    syncPhase === "syncing"
      ? "同步中…"
      : syncPhase === "error"
        ? `上次同步失败：${syncError ?? "未知错误"}（点击重试）`
        : syncLastSuccess
          ? `立即同步（上次成功：${syncLastSuccess.replace("T", " ").slice(0, 16)}）`
          : "立即同步";

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
      {/* 侧栏开关：绝对定位钉在标题栏最左（不占网格列，不挤压 tb-left，
          竖线全程与下方侧栏对齐）；展开时图标左侧小块淡填充示意挂载状态 */}
      <button
        type="button"
        className={`${styles["tb-toggle"]}${sidebarCollapsed ? ` ${styles.collapsed}` : ""}`}
        aria-label={sidebarCollapsed ? "展开边栏" : "隐藏边栏"}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? "展开边栏（Ctrl/⌘+B）" : "隐藏边栏（Ctrl/⌘+B）"}
        onClick={toggleSidebar}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          {/* 矩形轮廓（与描边风格按钮一致） */}
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          {/* 竖分隔线：分出侧栏区（左侧 1/4） */}
          <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          {/* 填充块：仅展开态显示（淡填充示意侧栏已挂载），由 CSS 控制透明度 */}
          <rect className={styles["tb-toggle-fill"]} x="5" y="7" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <div
        className={`${styles["tb-left"]}${sidebarCollapsed ? ` ${styles.collapsed}` : ""}`}
        data-tauri-drag-region
      />
      <div className={styles["tb-main"]} data-tauri-drag-region />
      <div className={styles.tbActions}>
        {syncEnabled ? (
          <button
            type="button"
            className={`${styles["tb-btn"]} ${styles["tb-sync"]}`}
            data-phase={syncPhase}
            aria-label={syncTitle}
            title={syncTitle}
            disabled={syncRunning}
            onClick={() => void syncNow()}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
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
