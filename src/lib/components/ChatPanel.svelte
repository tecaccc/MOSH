<script lang="ts">
  /**
   * 助手聊天面板（任务 08-15-agent-v1）：
   *   - 顶部：模型选择（下拉，来自设置页拉取的模型列表）+ 会话列表显隐开关
   *   - 会话侧栏（右侧，可隐藏）：历史列表 + 新会话
   *   - 消息区：用户气泡纯文本；助手气泡经 Markdown 组件渲染
   *     （流式期间拼入文本光标符 ▍，见 Markdown.svelte）；工具卡片（创建类带「撤销」）
   *   - 输入区：textarea 自适应高度；Enter 发送 / Shift+Enter 换行；在途可「停止」
   *   - 未配置模型 → 引导卡（跳设置），同天气未配置模式
   *
   * 事件流与持久化由 `agent.svelte.ts` store 负责；本组件纯渲染 + 输入。
   */
  import { onMount } from "svelte";
  import {
    abort,
    configured,
    currentSession,
    error,
    init,
    messages,
    models,
    newSession,
    openSession,
    selectedModel,
    selectModel,
    send,
    sessions,
    streaming,
    toolLabel,
    undoCreate,
    type UiMessage,
  } from "../agent.svelte";
  import { setView } from "../store.svelte";
  import Markdown from "./Markdown.svelte";

  let input = $state("");
  let listEl = $state<HTMLDivElement | null>(null);
  let sideVisible = $state(true);

  onMount(() => {
    void init();
  });

  // 新消息/流式增量 → 滚到底部。
  $effect(() => {
    void messages().length;
    void messages().at(-1)?.text.length;
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onModelChange(e: Event): void {
    selectModel((e.currentTarget as HTMLSelectElement).value);
  }

  async function onSend(): Promise<void> {
    const t = input;
    if (t.trim().length === 0 || streaming()) return;
    input = "";
    await send(t);
  }

  /** 工具卡片参数摘要（一行）。 */
  function argSummary(m: UiMessage): string {
    const a = m.args as Record<string, unknown> | undefined;
    if (!a || typeof a !== "object") return "";
    if (typeof a.title === "string") return String(a.title);
    if (typeof a.from === "string" && typeof a.to === "string") return `${a.from} ~ ${a.to}`;
    if (typeof a.status === "string") return `→ ${a.status}`;
    return "";
  }

  /** 创建类工具可撤销（结果含 id）。 */
  function undoable(m: UiMessage): boolean {
    return (
      m.ok === true &&
      (m.tool === "create_todo" || m.tool === "create_event") &&
      typeof (m.result as { id?: string } | undefined)?.id === "string"
    );
  }

  function resultLine(m: UiMessage): string {
    const r = m.result as Record<string, unknown> | undefined;
    if (!r) return "";
    if (m.ok === false && typeof r.error === "string") return r.error;
    if (typeof r.count === "number") return `${r.count} 条`;
    if (m.ok === true) return "完成";
    return "";
  }
</script>

<section class="chat" class:side-hidden={!sideVisible}>
  <div class="main">
    <!-- 顶栏：模型选择 + 会话列表显隐 -->
    <div class="chat-head">
      {#if configured()}
        <select
          class="model-select"
          value={selectedModel()}
          onchange={onModelChange}
          title="选择模型"
        >
          {#each models() as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
      {:else}
        <span class="chat-title">AI 助手</span>
      {/if}

      <button
        type="button"
        class="side-toggle"
        class:active={sideVisible}
        onclick={() => (sideVisible = !sideVisible)}
        title={sideVisible ? "隐藏会话列表" : "显示会话列表"}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M15 4v16" />
        </svg>
      </button>
    </div>

    {#if configured() === false}
      <div class="guide">
        <div class="guide-ico">✨</div>
        <div class="guide-title">尚未配置 AI 模型</div>
        <div class="guide-sub">
          填写任意 OpenAI 兼容端点（DeepSeek / OpenAI / 通义…）即可开始；
          本地 Ollama 指向 http://localhost:11434/v1 亦可。
        </div>
        <button type="button" class="guide-btn" onclick={() => setView("settings")}>
          前往设置
        </button>
      </div>
    {:else}
      <div class="msgs" bind:this={listEl}>
        {#if messages().length === 0}
          <div class="empty">
            <div class="empty-title">有什么可以帮你安排？</div>
            <div class="empty-sub">
              试试：「明早十点开周会」「建个待办：交季度报告，下周五截止」「我今天有什么安排」
            </div>
          </div>
        {/if}
        {#each messages() as m (m.key)}
          {#if m.role === "user"}
            <div class="row user-row"><div class="bubble user">{m.text}</div></div>
          {:else if m.role === "assistant"}
            <div class="row bot-row">
              <div class="bubble bot">
                <Markdown text={m.text} streaming={m.streaming ?? false} />
              </div>
            </div>
          {:else if m.role === "tool" && m.tool}
            <div class="row bot-row">
              <div class="toolcard" class:fail={m.ok === false} class:undone={m.undone}>
                <span class="tc-name">{toolLabel(m.tool)}</span>
                {#if argSummary(m)}<span class="tc-args">{argSummary(m)}</span>{/if}
                <span class="tc-result">{m.undone ? "已撤销" : resultLine(m)}</span>
                {#if undoable(m) && !m.undone}
                  <button type="button" class="tc-undo" onclick={() => void undoCreate(m)}>
                    撤销
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      </div>

      {#if error()}
        <div class="err">{error()}</div>
      {/if}

      <div class="inputbar">
        <textarea
          bind:value={input}
          onkeydown={onKeydown}
          placeholder={streaming() ? "回复中…（可点右侧停止）" : "输入消息，Enter 发送，Shift+Enter 换行"}
          rows="1"
          disabled={configured() === false}
        ></textarea>
        {#if streaming()}
          <button type="button" class="stop" onclick={() => void abort()}>停止</button>
        {:else}
          <button
            type="button"
            class="send"
            disabled={input.trim().length === 0}
            onclick={() => void onSend()}
          >发送</button>
        {/if}
      </div>
    {/if}
  </div>

  <!-- 会话侧栏（右侧，可隐藏） -->
  {#if sideVisible}
    <aside class="side">
      <button type="button" class="new" onclick={newSession}>+ 新会话</button>
      <div class="sess-label">历史会话</div>
      <div class="sess-list">
        {#each sessions() as s (s.session_id)}
          <button
            type="button"
            class="sess"
            class:active={s.session_id === currentSession()}
            onclick={() => void openSession(s.session_id)}
            title={s.title}
          >
            <span class="sess-title">{s.title}</span>
            <span class="sess-count">{s.message_count}</span>
          </button>
        {/each}
        {#if sessions().length === 0}
          <div class="sess-empty">暂无历史会话</div>
        {/if}
      </div>
    </aside>
  {/if}
</section>

<style>
  .chat {
    display: grid;
    grid-template-columns: 1fr 220px;
    height: 100%;
    min-height: 0;
  }

  .chat.side-hidden {
    grid-template-columns: 1fr;
  }

  /* 主区 */
  .main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
    min-width: 0;
  }

  /* 顶栏：模型选择 + 会话显隐 */
  .chat-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
    flex-shrink: 0;
  }

  .chat-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
  }

  .model-select {
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    max-width: 280px;
    min-width: 140px;
  }

  .model-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .side-toggle {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
    border-radius: var(--radius-sm);
    cursor: pointer;
    flex-shrink: 0;
  }

  .side-toggle:hover {
    color: var(--text);
    background: var(--surface-2);
  }

  .side-toggle.active {
    color: var(--accent);
    border-color: var(--accent);
  }

  .msgs {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .empty {
    margin: auto;
    text-align: center;
    max-width: 420px;
    padding: 24px;
  }

  .empty-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--text);
  }

  .empty-sub {
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.7;
  }

  .row {
    display: flex;
  }

  .user-row {
    justify-content: flex-end;
  }

  .bot-row {
    justify-content: flex-start;
  }

  .bubble {
    max-width: 72%;
    padding: 9px 14px;
    border-radius: var(--radius-lg);
    font-size: 14px;
    line-height: 1.65;
    word-break: break-word;
  }

  .bubble.user {
    background: var(--accent);
    color: var(--accent-fg);
    border-bottom-right-radius: 4px;
    /* 用户气泡保持纯文本：pre-wrap 保留手动换行 */
    white-space: pre-wrap;
  }

  .bubble.bot {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-bottom-left-radius: 4px;
  }

  /* 工具卡片 */
  .toolcard {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-left: 3px solid var(--pri-low);
    border-radius: var(--radius-md);
    font-size: 12.5px;
    max-width: 100%;
  }

  .toolcard.fail {
    border-left-color: var(--danger);
  }

  .toolcard.undone {
    opacity: 0.55;
  }

  .tc-name {
    font-weight: 600;
    color: var(--text);
    flex-shrink: 0;
  }

  .tc-args {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tc-result {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .tc-undo {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }

  .tc-undo:hover {
    text-decoration: underline;
  }

  /* 错误行 */
  .err {
    margin: 0 24px 8px;
    padding: 8px 12px;
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: var(--radius-md);
    font-size: 12.5px;
  }

  /* 输入区 */
  .inputbar {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    padding: 12px 24px 16px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg);
  }

  .inputbar textarea {
    flex: 1;
    min-height: 42px;
    max-height: 140px;
    resize: none;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
  }

  .inputbar textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .inputbar textarea:disabled {
    opacity: 0.6;
  }

  .send,
  .stop {
    height: 42px;
    padding: 0 20px;
    border-radius: var(--radius-md);
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }

  .send {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
  }

  .send:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .stop {
    border: 1px solid var(--danger);
    background: transparent;
    color: var(--danger);
  }

  /* 会话侧栏（右侧） */
  .side {
    border-left: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 10px;
    min-height: 0;
    min-width: 0;
  }

  .new {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
    border-radius: var(--radius-md);
    padding: 8px 0;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .new:hover {
    filter: brightness(1.05);
  }

  .sess-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    padding: 2px 4px;
  }

  .sess-list {
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sess {
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    border-radius: var(--radius-md);
    padding: 7px 8px;
    cursor: pointer;
    text-align: left;
    font-size: 13px;
  }

  .sess:hover {
    background: var(--surface-2);
  }

  .sess.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .sess-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sess-count {
    font-size: 10px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .sess-empty {
    font-size: 12px;
    color: var(--text-muted);
    padding: 6px 8px;
  }

  /* 引导卡 */
  .guide {
    margin: auto;
    text-align: center;
    max-width: 400px;
    padding: 32px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
  }

  .guide-ico {
    font-size: 30px;
  }

  .guide-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text);
  }

  .guide-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.7;
  }

  .guide-btn {
    margin-top: 6px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
    border-radius: var(--radius-md);
    padding: 8px 24px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  @media (max-width: 900px) {
    .chat {
      grid-template-columns: 1fr;
    }
    .side {
      display: none;
    }
  }
</style>
