<script lang="ts">
  /**
   * MOSH 应用根：左 Sidebar + 中主视图（按 currentView 切换）+ 编辑器。
   * 编辑器与视图解耦，按各自 store 状态独立显示：
   *   - 事件（EventEditor）：居中模态弹窗（Modal），新建/编辑均就地弹出；
   *   - 待办（TodoEditor）：右栏侧边（editor-pane，展开时三栏布局）。
   */
  import { onMount } from "svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TodayView from "$lib/components/TodayView.svelte";
  import HomeView from "$lib/components/HomeView.svelte";
  import SettingsView from "$lib/components/SettingsView.svelte";
  import ChatPanel from "$lib/components/ChatPanel.svelte";
  import TodoEditor from "$lib/components/TodoEditor.svelte";
  import Modal from "$lib/components/Modal.svelte";
  import ReminderToast from "$lib/components/ReminderToast.svelte";
  import CalendarPane from "$lib/components/calendar/CalendarPane.svelte";
  import EventEditor from "$lib/components/calendar/EventEditor.svelte";
  import {
    currentView,
    loadTodos,
    selectedRecord,
  } from "$lib/store.svelte";
  import { closeEditor, editingEvent } from "$lib/calendar.svelte";

  let loadError = $state<string | null>(null);

  onMount(async () => {
    try {
      await loadTodos();
    } catch (e) {
      // 非 Tauri 环境（如 vite dev 直开浏览器）会 invoke 失败；给出可读提示。
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  // 编辑器呈现（与当前视图解耦）：事件走模态弹窗、待办走右栏侧边。
  const calEditing = $derived(editingEvent() !== undefined);
  const todoEditing = $derived(selectedRecord() !== undefined);
</script>

<div class="shell">
  <TitleBar />
  <main class="app" data-view={currentView()}>
  <Sidebar />

  <section class="main-view">
    {#if loadError}
      <div class="banner">
        无法加载数据：{loadError}
        <br />
        <span class="dim">（请通过 `cargo tauri dev` 启动，而非浏览器直开 vite）</span>
      </div>
    {/if}

    {#if currentView() === "home"}
      <HomeView />
    {:else if currentView() === "today"}
      <TodayView />
    {:else if currentView() === "calendar"}
      <CalendarPane />
    {:else if currentView() === "agent"}
      <ChatPanel />
    {:else if currentView() === "settings"}
      <SettingsView />
    {/if}
  </section>

  <!-- 待办编辑器：右栏侧边 -->
  {#if todoEditing}
    <aside class="editor-pane">
      <TodoEditor record={selectedRecord() ?? null} />
    </aside>
  {/if}
  </main>
</div>

<!-- 事件编辑器：居中模态弹窗（ESC / 点遮罩关闭，见 Modal） -->
{#if calEditing}
  <Modal onClose={closeEditor}>
    <EventEditor event={editingEvent() ?? null} />
  </Modal>
{/if}

<!-- 事件提醒：顶部弹出式通知（见 ReminderToast） -->
<ReminderToast />

<style>
  /* Pencil 设计系统 token（docs/pencil-new.pen · Aot2d Home 首页），浅/深双主题。 */
  :global(:root) {
    --bg: #f7f6f2;
    --surface: #ffffff;
    --surface-1: #f1ede6;
    --surface-2: #f0ede5;
    --sidebar-bg: #f1ede6;
    --border: #e6e2d9;
    --border-soft: #efebe3;
    --text: #1c1b19;
    --text-dim: #6c685f;
    --text-muted: #a29c91;
    --accent: #6d5dd3;
    --accent-soft: #eeeefa;
    --accent-fg: #ffffff;
    --danger: #dd5456;
    --danger-soft: #f7e2e2;
    --pri-high: #dd5456;
    --pri-med: #de8e2a;
    --pri-low: #36ac74;
    --cal-1: #6d5dd3;
    --cal-2: #2ba6b5;
    --cal-3: #de8e2a;
    --cal-4: #d64a8b;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #131210;
      --surface: #1b1a19;
      --surface-1: #161514;
      --surface-2: #23211f;
      --sidebar-bg: #161514;
      --border: #2d2b29;
      --border-soft: #23211f;
      --text: #ece9e3;
      --text-dim: #9b9589;
      --text-muted: #6c675e;
      --accent: #8c7fea;
      --accent-soft: #2a2740;
      --accent-fg: #ffffff;
      --danger: #f06d6e;
      --danger-soft: #3a2222;
      --pri-high: #f06d6e;
      --pri-med: #eca84c;
      --pri-low: #52c490;
      --cal-1: #8c7fea;
      --cal-2: #45c2d0;
      --cal-3: #eca84c;
      --cal-4: #e66fa3;
    }
  }

  :global(html, body) {
    height: 100%;
    margin: 0;
  }

  :global(body) {
    background: var(--bg);
    color: var(--text);
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }

  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .app {
    display: grid;
    grid-template-columns: 248px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .app:has(.editor-pane) {
    grid-template-columns: 248px 1fr 340px;
  }

  .main-view {
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border-right: 1px solid var(--border);
  }

  .editor-pane {
    overflow: hidden;
    background: var(--surface);
  }

  .banner {
    margin: 1rem 1.25rem;
    padding: 0.75rem 1rem;
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: 8px;
    font-size: 0.9rem;
  }

  .banner .dim {
    color: var(--text-dim);
    font-size: 0.82rem;
  }

  @media (max-width: 900px) {
    .app,
    .app:has(.editor-pane) {
      grid-template-columns: 64px 1fr;
    }

    .app:has(.editor-pane) {
      grid-template-rows: 1fr auto;
    }

    .editor-pane {
      grid-column: 1 / -1;
      max-height: 50vh;
    }
  }
</style>
