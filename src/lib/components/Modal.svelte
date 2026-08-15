<script lang="ts">
  /**
   * 通用模态弹窗：半透明遮罩 + 居中卡片。
   *
   * 关闭途径（均触发 `onClose`，由调用方决定关闭语义）：
   *   - 按 ESC；
   *   - 点击遮罩空白处（非卡片内冒泡）。
   * 卡片内的关闭按钮/取消由插槽内容自理。
   *
   * 卡片限宽限高（`max-height: 85vh`）且为纵向 flex：插槽内容给
   * `flex: 1; min-height: 0; overflow-y: auto` 即可超高自滚动。
   */
  import type { Snippet } from "svelte";

  const {
    onClose,
    width = "540px",
    children,
  }: { onClose: () => void; width?: string; children?: Snippet } = $props();

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }

  function onOverlayClick(e: MouseEvent): void {
    // 仅点遮罩本身（currentTarget）才关闭；卡片内点击冒泡上来不关。
    if (e.target === e.currentTarget) onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" onclick={onOverlayClick} role="presentation">
  <div class="card" role="dialog" aria-modal="true" style:width={width}>
    {@render children?.()}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 14, 12, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 100;
  }

  .card {
    max-width: 100%;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }
</style>
