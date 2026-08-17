import { useEffect, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import CalendarPane from "./components/calendar/CalendarPane";
import DialogHost from "./components/DialogHost";
import EventEditor from "./components/calendar/EventEditor";
import HomeView from "./components/HomeView";
import Modal from "./components/Modal";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import TodoEditor from "./components/TodoEditor";
import TodayView from "./components/TodayView";
import UpdaterToast from "./components/UpdaterToast";
import { editingEventOf, useCalendarStore } from "./state/calendar";
import { useProfileStore } from "./state/profile";
import { startReminders } from "./state/reminder";
import { selectedRecordOf, useAppStore } from "./state/store";
import { useUpdaterStore } from "./state/updater";
import styles from "./App.module.css";

/**
 * 应用根：TitleBar + 左 Sidebar + 中主视图（按 currentView 切换）+ 编辑器。
 * 编辑器与视图解耦：事件走居中模态（Modal）；待办走右栏侧边。
 */
export default function App() {
  const currentView = useAppStore((s) => s.currentView);
  const loadTodos = useAppStore((s) => s.loadTodos);
  const records = useAppStore((s) => s.records);
  const selectedId = useAppStore((s) => s.selectedId);
  const calEvents = useCalendarStore((s) => s.events);
  const editingId = useCalendarStore((s) => s.editingId);
  const closeEventEditor = useCalendarStore((s) => s.closeEditor);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void loadTodos().catch((e) => {
      // 非 Tauri 环境（如 vite dev 直开浏览器）会 invoke 失败；给出可读提示。
      setLoadError(e instanceof Error ? e.message : String(e));
    });
    // 个人资料（问候语/头像展示用；失败静默用默认值）。
    void useProfileStore.getState().load().catch(() => {});
  }, [loadTodos]);

  // 滚动条按需显示：任意可滚元素滚动时加 .is-scrolling，停约 0.7s 后移除
  // （配合 global.css：轨道透明、滑块仅滚动中可见）。
  useEffect(() => {
    const timers = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      el.classList.add("is-scrolling");
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove("is-scrolling"), 700),
      );
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // 启动提醒轮询（系统通知；应用内 Toast 已移除）。
  useEffect(() => {
    startReminders();
  }, []);

  // 启动后静默检查一次更新（延迟 8s 避免抢占启动资源；无更新/失败不打扰）。
  useEffect(() => {
    const timer = setTimeout(() => {
      void useUpdaterStore.getState().check({ silent: true });
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  const calEditing = editingEventOf(calEvents, editingId) !== undefined;
  const editingEvent = editingEventOf(calEvents, editingId) ?? null;
  const todoEditing = selectedRecordOf(records, selectedId) !== undefined;
  const selectedRecord = selectedRecordOf(records, selectedId) ?? null;

  return (
    <div className={styles.shell}>
      <TitleBar />
      <main className={styles.app} data-view={currentView}>
        <Sidebar />

        <section className={styles["main-view"]}>
          {loadError ? (
            <div className={styles.banner}>
              无法加载数据：{loadError}
              <br />
              <span className={styles.dim}>（请通过 `cargo tauri dev` 启动，而非浏览器直开 vite）</span>
            </div>
          ) : null}

          {currentView === "home" ? (
            <HomeView />
          ) : currentView === "today" ? (
            <TodayView />
          ) : currentView === "calendar" ? (
            <CalendarPane />
          ) : currentView === "agent" ? (
            <ChatPanel />
          ) : (
            <SettingsView />
          )}
        </section>

        {/* 待办编辑器：右栏侧边 */}
        {todoEditing ? (
          <aside className={styles["editor-pane"]}>
            <TodoEditor record={selectedRecord} />
          </aside>
        ) : null}
      </main>

      {/* 事件编辑器：居中模态弹窗 */}
      {calEditing ? (
        <Modal onClose={closeEventEditor}>
          <EventEditor event={editingEvent} />
        </Modal>
      ) : null}

      {/* 全局对话框（confirm/prompt 的自绘替代，任意视图可调用） */}
      <DialogHost />

      {/* 顶部提示图层：更新等 Toast 从顶部向下弹出堆叠（日程/待办提醒已改为仅系统通知） */}
      <div className={styles["toast-layer"]}>
        <UpdaterToast />
      </div>
    </div>
  );
}
