import { useUpdaterStore } from "../state/updater";
import styles from "./UpdaterToast.module.css";

/**
 * 版本更新通知卡（右下角）：检测到新版本时提示，确认后展示下载进度，
 * 安装完成自动重启进入新版本。检查动作由 App 启动钩子/设置页触发。
 */

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function UpdaterToast() {
  const phase = useUpdaterStore((s) => s.phase);
  const info = useUpdaterStore((s) => s.info);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const dismiss = useUpdaterStore((s) => s.dismiss);
  const startUpdate = useUpdaterStore((s) => s.startUpdate);

  if (phase === "idle" || phase === "checking" || phase === "upToDate") return null;

  if (phase === "error") {
    return (
      <div className={`${styles.updater} ${styles.err}`} role="alert">
        <div className={styles.head}>
          <span className={styles.ico}>⚠️</span>
          <span className={styles.title}>更新失败</span>
          <button type="button" className={styles.btn} onClick={dismiss}>
            关闭
          </button>
        </div>
        <div className={styles.notes}>{error || "未知错误，可稍后重试。"}</div>
      </div>
    );
  }

  const pct =
    progress && progress.total > 0 ? Math.min(100, (progress.downloaded / progress.total) * 100) : null;

  return (
    <div className={styles.updater} role="status">
      <div className={styles.head}>
        <span className={styles.ico}>🚀</span>
        <span className={styles.title}>
          {phase === "downloading" ? "正在下载新版本" : phase === "installing" ? "安装中，即将重启…" : "发现新版本"}
        </span>
        {info ? <span className={styles.ver}>v{info.version}</span> : null}
      </div>

      {phase === "available" && info ? (
        <>
          <div className={styles.dim}>
            当前 v{info.currentVersion} → 新版 v{info.version}
          </div>
          {info.body ? <div className={styles.notes}>{info.body.slice(0, 400)}</div> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={dismiss}>
              稍后再说
            </button>
            <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => void startUpdate()}>
              立即更新
            </button>
          </div>
        </>
      ) : null}

      {phase === "downloading" ? (
        <>
          <div className={styles.track}>
            <div className={styles.fill} style={{ width: pct != null ? `${pct}%` : "100%" }} />
          </div>
          <div className={styles.dim}>
            {pct != null
              ? `${mb(progress!.downloaded)} / ${mb(progress!.total)}（${Math.round(pct)}%）`
              : `已下载 ${mb(progress?.downloaded ?? 0)}`}
          </div>
        </>
      ) : null}
    </div>
  );
}
