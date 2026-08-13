<script lang="ts">
  /**
   * 左侧导航：Today / Tasks 切换，Calendar 占位禁用（子任务 B 解锁）。
   * 直接读写 store，无 props。
   */
  import { currentView, setView, startCreate } from "../store.svelte";

  function nav(view: "today" | "tasks"): void {
    setView(view);
  }
</script>

<aside class="sidebar">
  <div class="brand">MOSH</div>

  <nav class="nav">
    <button
      type="button"
      class="nav-item"
      class:active={currentView() === "today"}
      onclick={() => nav("today")}
    >
      今日
    </button>
    <button
      type="button"
      class="nav-item"
      class:active={currentView() === "tasks"}
      onclick={() => nav("tasks")}
    >
      任务
    </button>
    <button type="button" class="nav-item" disabled title="即将推出（子任务 B）">
      日历
    </button>
  </nav>

  <button type="button" class="new-btn" onclick={startCreate}>+ 新建待办</button>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1rem;
    border-right: 1px solid var(--border);
    background: var(--surface-1);
    min-width: 180px;
  }

  .brand {
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 0.25rem 0.5rem;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .nav-item {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    color: inherit;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: background 0.12s;
  }

  .nav-item:hover:not(:disabled) {
    background: var(--surface-2);
  }

  .nav-item.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .nav-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .new-btn {
    margin-top: auto;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .new-btn:hover {
    filter: brightness(1.05);
  }
</style>
