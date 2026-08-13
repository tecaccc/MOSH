<script lang="ts">
  /**
   * MOSH 应用根：三栏布局。
   *   左：Sidebar（导航 + 新建入口）
   *   中：主视图（Today / Tasks，按 currentView 切换）
   *   右：TodoEditor（selectedId 对应 record；null=新建；undefined=关闭隐藏）
   */
  import { onMount } from "svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TasksView from "$lib/components/TasksView.svelte";
  import TodayView from "$lib/components/TodayView.svelte";
  import TodoEditor from "$lib/components/TodoEditor.svelte";
  import {
    currentView,
    loadTodos,
    selectedRecord,
  } from "$lib/store.svelte";

  let loadError = $state<string | null>(null);

  onMount(async () => {
    try {
      await loadTodos();
    } catch (e) {
      // 非 Tauri 环境（如 vite dev 直开浏览器）会 invoke 失败；给出可读提示。
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  // 编辑器是否可见（关闭/未选择新建时隐藏右栏）。
  const editorOpen = $derived(selectedRecord !== undefined);
</script>

<main class="app" data-view={currentView}>
  <Sidebar />

  <section class="main-view">
    {#if loadError}
      <div class="banner">
        无法加载数据：{loadError}
        <br />
        <span class="dim">（请通过 `cargo tauri dev` 启动，而非浏览器直开 vite）</span>
      </div>
    {/if}

    {#if currentView === "today"}
      <TodayView />
    {:else if currentView === "tasks"}
      <TasksView />
    {/if}
  </section>

  {#if editorOpen}
    <aside class="editor-pane">
      <TodoEditor record={selectedRecord ?? null} />
    </aside>
  {/if}
</main>

<style>
  :global(:root) {
    --bg: #f7f7f8;
    --surface: #ffffff;
    --surface-1: #f0f0f2;
    --surface-2: #e6e6ea;
    --border: #d8d8de;
    --text: #1c1c20;
    --text-dim: #6b6b76;
    --accent: #4f6df5;
    --accent-soft: #e8edff;
    --danger: #dc2626;
    --danger-soft: #fee2e2;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #1a1a1d;
      --surface: #242428;
      --surface-1: #1f1f23;
      --surface-2: #2e2e34;
      --border: #35353c;
      --text: #e8e8ec;
      --text-dim: #9a9aa6;
      --accent: #6b86ff;
      --accent-soft: #2a3160;
      --danger: #f87171;
      --danger-soft: #3a1d1d;
    }
  }

  :global(html, body) {
    height: 100%;
    margin: 0;
  }

  :global(body) {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }

  .app {
    display: grid;
    grid-template-columns: 200px 1fr;
    height: 100vh;
  }

  .app:has(.editor-pane) {
    grid-template-columns: 200px 1fr 340px;
  }

  .main-view {
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
