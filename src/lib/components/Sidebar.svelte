<script lang="ts">
  /**
   * 左侧导航：首页 / 今日 / 日历（按 docs/pencil-new.pen · Aot2d / z0EdN Sidebar 还原）。
   * 紫色「M」标识 + 图标导航 + ⌘K 提示。直接读写 store，无 props。
   */
  import { currentView, setView, type View } from "../store.svelte";

  function nav(view: View): void {
    setView(view);
  }

  const items: { key: View; label: string }[] = [
    { key: "home", label: "首页" },
    { key: "today", label: "今日" },
    { key: "calendar", label: "日历" },
    { key: "agent", label: "助手" },
    { key: "settings", label: "设置" },
  ];
</script>

<aside class="sidebar">
  <div class="brand">
    <div class="mark">M</div>
    <span class="wordmark">MOSH</span>
  </div>

  <nav class="nav">
    {#each items as it (it.key)}
      <button
        type="button"
        class="nav-item"
        class:active={currentView() === it.key}
        onclick={() => nav(it.key)}
      >
        <span class="ico">
          {#if it.key === "home"}
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" width="17" height="17"
            ><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.8V20h13V9.8" /></svg>
          {:else if it.key === "agent"}
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" width="17" height="17"
            ><path
                d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path
                d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" /></svg>
          {:else if it.key === "today"}
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" width="17" height="17"
            ><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path
                d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" /></svg>
          {:else if it.key === "settings"}
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" width="17" height="17"
            ><circle cx="12" cy="12" r="3" /><path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          {:else}
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" width="17" height="17"
            ><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path
                d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" /><path
                d="M7.5 14h.01M12 14h.01M16.5 14h.01M7.5 17.5h.01M12 17.5h.01" /></svg>
          {/if}
        </span>
        <span class="label">{it.label}</span>
      </button>
    {/each}
  </nav>

  <div class="kbd-hint">⌘K</div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 14px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    height: 100%;
    overflow: hidden;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 6px;
  }

  .mark {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-fg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
  }

  .wordmark {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text);
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 10px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    transition:
      background 0.12s,
      color 0.12s;
  }

  .nav-item .ico {
    display: flex;
    width: 17px;
    height: 17px;
    flex-shrink: 0;
  }

  .nav-item:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .nav-item.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }

  .kbd-hint {
    margin-top: auto;
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    padding: 6px 0;
  }

  @media (max-width: 900px) {
    .wordmark,
    .label,
    .kbd-hint {
      display: none;
    }

    .nav-item {
      justify-content: center;
      padding: 0;
    }

    .brand {
      justify-content: center;
      padding: 4px 0;
    }
  }
</style>
