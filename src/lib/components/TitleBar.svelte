<script lang="ts">
  /**
   * 自定义窗口标题栏：替代系统原生标题栏（decorations: false），
   * 使顶栏颜色与应用设计系统一致（浅 #f7f6f2 / 深 #131210）。
   * 左段与 Sidebar 同宽同色无缝衔接，右段为主区颜色，最右为
   * Windows 风格窗口按钮（最小化 / 最大化还原 / 关闭，悬停红关闭）。
   * 空白区域 data-tauri-drag-region：可拖动窗口、双击切换最大化。
   * 浏览器直开（非 Tauri）时按钮 no-op，便于 `npm run dev` 联调。
   */
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  const inTauri = "__TAURI_INTERNALS__" in window;

  let maximized = $state(false);

  onMount(async () => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    maximized = await win.isMaximized();
    // 覆盖 Win+方向键、拖到屏幕边缘等系统途径触发的最大化变化。
    await win.onResized(async () => {
      maximized = await win.isMaximized();
    });
  });

  async function onMinimize(): Promise<void> {
    if (inTauri) await getCurrentWindow().minimize();
  }

  async function onToggleMaximize(): Promise<void> {
    if (!inTauri) return;
    await getCurrentWindow().toggleMaximize();
    maximized = await getCurrentWindow().isMaximized();
  }

  async function onClose(): Promise<void> {
    if (inTauri) await getCurrentWindow().close();
  }
</script>

<header class="titlebar">
  <div class="tb-left" data-tauri-drag-region></div>
  <div class="tb-main" data-tauri-drag-region></div>
  <div class="tb-actions">
    <button
      type="button"
      class="tb-btn"
      aria-label="最小化"
      onclick={onMinimize}
    >
      <svg viewBox="0 0 10 10" width="10" height="10">
        <path d="M0 5.5h10" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
    <button
      type="button"
      class="tb-btn"
      aria-label={maximized ? "向下还原" : "最大化"}
      onclick={onToggleMaximize}
    >
      {#if maximized}
        <svg
          viewBox="0 0 10 10" width="10" height="10" fill="none"
          stroke="currentColor" stroke-width="1"
        >
          <rect x="0.5" y="2.5" width="7" height="7" />
          <polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" />
        </svg>
      {:else}
        <svg
          viewBox="0 0 10 10" width="10" height="10" fill="none"
          stroke="currentColor" stroke-width="1"
        >
          <rect x="0.5" y="0.5" width="9" height="9" />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      class="tb-btn tb-close"
      aria-label="关闭"
      onclick={onClose}
    >
      <svg viewBox="0 0 10 10" width="10" height="10">
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
  </div>
</header>

<style>
  .titlebar {
    display: grid;
    grid-template-columns: 248px 1fr auto;
    height: 36px;
    flex: none;
    user-select: none;
  }

  /* 与 Sidebar 同宽同色、同一竖向边线，视觉上无缝衔接。 */
  .tb-left {
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
  }

  .tb-main {
    background: var(--bg);
  }

  .tb-actions {
    display: flex;
    background: var(--bg);
  }

  .tb-btn {
    width: 46px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-dim);
    cursor: default;
    outline: none;
  }

  .tb-btn:hover {
    background: rgba(0, 0, 0, 0.055);
    color: var(--text);
  }

  .tb-btn:active {
    background: rgba(0, 0, 0, 0.09);
  }

  .tb-btn:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  /* 关闭按钮：Windows 惯例红色悬停。 */
  .tb-close:hover,
  .tb-close:active {
    background: #e81123;
    color: #ffffff;
  }

  @media (prefers-color-scheme: dark) {
    .tb-btn:hover {
      background: rgba(255, 255, 255, 0.09);
    }

    .tb-btn:active {
      background: rgba(255, 255, 255, 0.13);
    }
  }

  /* 与 +page.svelte 的窄屏断点保持一致：Sidebar 折叠为图标栏。 */
  @media (max-width: 900px) {
    .titlebar {
      grid-template-columns: 64px 1fr auto;
    }
  }
</style>
