import { useEffect, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import CalendarPane from "./components/calendar/CalendarPane";
import EventEditor from "./components/calendar/EventEditor";
import HomeView from "./components/HomeView";
import Modal from "./components/Modal";
import ReminderToast from "./components/ReminderToast";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import TodoEditor from "./components/TodoEditor";
import TodayView from "./components/TodayView";
import { editingEventOf, useCalendarStore } from "./state/calendar";
import { selectedRecordOf, useAppStore } from "./state/store";
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
  }, [loadTodos]);

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

      <ReminderToast />
    </div>
  );
}
