import { useAppStore, type View } from "../state/store";
import { useProfileStore } from "../state/profile";
import Avatar from "./Avatar";
import styles from "./Sidebar.module.css";

/** 左侧导航：用户头像/名称（未配置时回退 MOSH 标识）+ 图标导航 + ⌘K 提示。
 *  直接读写 store，无 props。 */

const items: { key: View; label: string }[] = [
  { key: "home", label: "首页" },
  { key: "today", label: "今日" },
  { key: "tasks", label: "待办" },
  { key: "calendar", label: "日历" },
  { key: "agent", label: "助手" },
  { key: "settings", label: "设置" },
];

const icons: Record<View, React.ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.8V20h13V9.8" />
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
      <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </svg>
  ),
  today: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v4M16 3v4" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <path d="M4 6l2 2 3.5-3.5" />
      <path d="M4 12.5l2 2 3.5-3.5" />
      <path d="M4 19l2 2 3.5-3.5" />
      <path d="M13 6.5h7M13 13h7M13 19.5h7" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v4M16 3v4" />
      <path d="M7.5 14h.01M12 14h.01M16.5 14h.01M7.5 17.5h.01M12 17.5h.01" />
    </svg>
  ),
};

export default function Sidebar() {
  const currentView = useAppStore((s) => s.currentView);
  const setView = useAppStore((s) => s.setView);
  const openSettings = useAppStore((s) => s.openSettings);
  const profileName = useProfileStore((s) => s.name);
  const profileAvatar = useProfileStore((s) => s.avatar);
  const profileLoaded = useProfileStore((s) => s.loaded);
  // 已配置个人资料 → 头像 + 名称；未配置/未加载 → 回退 MOSH 标识。点击可编辑资料。
  const personalized = profileLoaded && profileName.trim().length > 0;

  return (
    <aside className={styles.sidebar}>
      <button
        type="button"
        className={styles.brand}
        title={personalized ? "编辑个人资料" : "设置个人资料"}
        onClick={() => openSettings("profile")}
      >
        {personalized ? (
          <>
            <Avatar name={profileName} avatar={profileAvatar} size={28} />
            <span className={styles.wordmark}>{profileName}</span>
          </>
        ) : (
          <>
            <span className={styles.mark}>M</span>
            <span className={styles.wordmark}>MOSH</span>
          </>
        )}
      </button>

      <nav className={styles.nav}>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`${styles["nav-item"]}${currentView === it.key ? ` ${styles.active}` : ""}`}
            onClick={() => setView(it.key)}
          >
            <span className={styles.ico}>{icons[it.key]}</span>
            <span className={styles.label}>{it.label}</span>
          </button>
        ))}
      </nav>

      <div className={styles["kbd-hint"]}>⌘K</div>
    </aside>
  );
}
