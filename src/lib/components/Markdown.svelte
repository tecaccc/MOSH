<script lang="ts">
  /**
   * Markdown 隔离渲染组件（任务 08-15-chat-markdown）。
   *
   * 对外仅暴露 text/streaming 两个 props，是 markdown 渲染实现的唯一入口：
   * 将来更换渲染库（如 markstream-svelte）只改本文件，调用方不动。
   *
   * 注意：`{@html}` 注入的 DOM 不吃 Svelte 作用域样式，
   * 内容样式一律经 `.md :global(...)` 声明。
   */
  import { renderMarkdown } from "../markdown";

  let {
    text,
    streaming = false,
  }: { text: string; streaming?: boolean } = $props();

  // 流式光标：拼入纯文本光标符（ sanitize 天然放行，且在任何块内都紧跟
  // 文本末尾——比块级元素后的 <span class="cursor">（会掉到下一行）更自然）。
  const CURSOR = " ▍";
  const html = $derived(renderMarkdown(streaming ? text + CURSOR : text, streaming));
</script>

<div class="md">{@html html}</div>

<style>
  .md {
    font-size: inherit;
    line-height: inherit;
    word-break: break-word;
  }

  /* 块级元素间距：首个/末个不外扩，保持气泡内边距视觉一致 */
  .md :global(> :first-child) {
    margin-top: 0;
  }

  .md :global(> :last-child) {
    margin-bottom: 0;
  }

  .md :global(p) {
    margin: 0.5em 0;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 0.8em 0 0.4em;
    font-weight: 700;
    color: var(--text);
    line-height: 1.4;
  }

  .md :global(h1) {
    font-size: 1.25em;
  }

  .md :global(h2) {
    font-size: 1.15em;
  }

  .md :global(h3),
  .md :global(h4) {
    font-size: 1em;
  }

  .md :global(ul),
  .md :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.4em;
  }

  .md :global(li) {
    margin: 0.2em 0;
  }

  .md :global(li > ul),
  .md :global(li > ol) {
    margin: 0.2em 0;
  }

  /* 任务列表：GFM checkbox */
  .md :global(li:has(> input[type="checkbox"])) {
    list-style: none;
    margin-left: -1.2em;
  }

  .md :global(input[type="checkbox"]) {
    margin-right: 0.45em;
    accent-color: var(--accent);
    vertical-align: -1px;
  }

  .md :global(a) {
    color: var(--accent);
    text-decoration: none;
  }

  .md :global(a:hover) {
    text-decoration: underline;
  }

  .md :global(blockquote) {
    margin: 0.5em 0;
    padding: 0.1em 0.9em;
    border-left: 3px solid var(--border);
    color: var(--text-dim);
    background: var(--surface-1);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .md :global(blockquote > :first-child) {
    margin-top: 0.3em;
  }

  .md :global(blockquote > :last-child) {
    margin-bottom: 0.3em;
  }

  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--border-soft);
    margin: 0.8em 0;
  }

  /* 表格 */
  .md :global(table) {
    border-collapse: collapse;
    margin: 0.6em 0;
    max-width: 100%;
    display: block;
    overflow-x: auto;
    font-size: 0.95em;
  }

  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--border);
    padding: 4px 10px;
    text-align: left;
  }

  .md :global(th) {
    background: var(--surface-1);
    font-weight: 600;
  }

  .md :global(tr:nth-child(2n) td) {
    background: var(--surface-1);
  }

  /* 行内代码 */
  .md :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.9em;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    padding: 0.1em 0.35em;
  }

  /* 代码块（fenced）：pre 内 code 恢复为块级样式 */
  .md :global(pre) {
    margin: 0.6em 0;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    line-height: 1.5;
  }

  .md :global(pre code) {
    background: transparent;
    border: none;
    padding: 0;
    font-size: 0.88em;
    white-space: pre;
  }

  /* 强调 */
  .md :global(strong) {
    font-weight: 700;
    color: var(--text);
  }

  .md :global(del) {
    color: var(--text-muted);
  }

  .md :global(img) {
    max-width: 100%;
    border-radius: var(--radius-sm);
  }
</style>
