import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import styles from "./TitleBar.module.css";

/**
 * 自定义窗口标题栏（decorations: false）：左段与 Sidebar 同宽同色，
 * 右为 Windows 风格窗口按钮。空白区域可拖动窗口。浏览器直开时按钮 no-op。
 */

const inTauri = "__TAURI_INTERNALS__" in window;

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

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
