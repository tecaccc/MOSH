import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { toolLabel, useAgentStore, type UiMessage } from "../state/agent";
import { useAppStore } from "../state/store";
import styles from "./ChatPanel.module.css";

/**
 * 助手聊天面板：模型选择 + 会话侧栏 + 消息区（用户纯文本气泡 /
 * 助手 streamdown 渲染 + 工具卡片）+ 输入区（Enter 发送 / Shift+Enter 换行）。
 */

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

function ToolCard({ m }: { m: UiMessage }) {
  const undoCreate = useAgentStore((s) => s.undoCreate);
  return (
    <div className={`${styles.toolcard}${m.ok === false ? ` ${styles.fail}` : ""}${m.undone ? ` ${styles.undone}` : ""}`}>
      <span className={styles["tc-name"]}>{toolLabel(m.tool ?? "")}</span>
      {argSummary(m) ? <span className={styles["tc-args"]}>{argSummary(m)}</span> : null}
      <span className={styles["tc-result"]}>{m.undone ? "已撤销" : resultLine(m)}</span>
      {undoable(m) && !m.undone ? (
        <button type="button" className={styles["tc-undo"]} onClick={() => void undoCreate(m)}>
          撤销
        </button>
      ) : null}
    </div>
  );
}

export default function ChatPanel() {
  const messages = useAgentStore((s) => s.messages);
  const streaming = useAgentStore((s) => s.streaming);
  const configured = useAgentStore((s) => s.configured);
  const error = useAgentStore((s) => s.error);
  const models = useAgentStore((s) => s.models);
  const selectedModel = useAgentStore((s) => s.selectedModel);
  const sessions = useAgentStore((s) => s.sessions);
  const currentSession = useAgentStore((s) => s.currentSession);
  const init = useAgentStore((s) => s.init);
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const newSession = useAgentStore((s) => s.newSession);
  const openSession = useAgentStore((s) => s.openSession);
  const selectModel = useAgentStore((s) => s.selectModel);
  const setView = useAppStore((s) => s.setView);

  const [input, setInput] = useState("");
  const [sideVisible, setSideVisible] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // 新消息/流式增量 → 滚到底部。
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, messages.at(-1)?.text.length]);

  function onKeydown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  }

  async function onSend() {
    const t = input;
    if (t.trim().length === 0 || useAgentStore.getState().streaming) return;
    setInput("");
    await send(t);
  }

  return (
    <section className={`${styles.chat}${!sideVisible ? ` ${styles["side-hidden"]}` : ""}`}>
      <div className={styles.main}>
        {/* 顶栏：模型选择 + 会话列表显隐 */}
        <div className={styles["chat-head"]}>
          {configured ? (
            <select
              className={styles["model-select"]}
              value={selectedModel}
              onChange={(e) => selectModel(e.currentTarget.value)}
              title="选择模型"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <span className={styles["chat-title"]}>AI 助手</span>
          )}

          <button
            type="button"
            className={`${styles["side-toggle"]}${sideVisible ? ` ${styles.active}` : ""}`}
            onClick={() => setSideVisible(!sideVisible)}
            title={sideVisible ? "隐藏会话列表" : "显示会话列表"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16" />
            </svg>
          </button>
        </div>

        {configured === false ? (
          <div className={styles.guide}>
            <div className={styles["guide-ico"]}>✨</div>
            <div className={styles["guide-title"]}>尚未配置 AI 模型</div>
            <div className={styles["guide-sub"]}>
              填写任意 OpenAI 兼容端点（DeepSeek / OpenAI / 通义…）即可开始；
              本地 Ollama 指向 http://localhost:11434/v1 亦可。
            </div>
            <button type="button" className={styles["guide-btn"]} onClick={() => setView("settings")}>
              前往设置
            </button>
          </div>
        ) : (
          <>
            <div className={styles.msgs} ref={listRef}>
              {messages.length === 0 ? (
                <div className={styles.empty}>
                  <div className={styles["empty-title"]}>有什么可以帮你安排？</div>
                  <div className={styles["empty-sub"]}>
                    试试：「明早十点开周会」「建个待办：交季度报告，下周五截止」「我今天有什么安排」
                  </div>
                </div>
              ) : null}
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.key} className={`${styles.row} ${styles["user-row"]}`}>
                    <div className={`${styles.bubble} ${styles.user}`}>{m.text}</div>
                  </div>
                ) : m.role === "assistant" ? (
                  <div key={m.key} className={`${styles.row} ${styles["bot-row"]}`}>
                    <div className={`${styles.bubble} ${styles.bot}`}>
                      <Streamdown
                        parseIncompleteMarkdown={m.streaming === true}
                        animated={false}
                      >
                        {m.text}
                      </Streamdown>
                    </div>
                  </div>
                ) : m.role === "tool" && m.tool ? (
                  <div key={m.key} className={`${styles.row} ${styles["bot-row"]}`}>
                    <ToolCard m={m} />
                  </div>
                ) : null,
              )}
            </div>

            {error ? <div className={styles.err}>{error}</div> : null}

            <div className={styles.inputbar}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeydown}
                placeholder={streaming ? "回复中…（可点右侧停止）" : "输入消息，Enter 发送，Shift+Enter 换行"}
                rows={1}
                disabled={configured !== true}
              />
              {streaming ? (
                <button type="button" className={styles.stop} onClick={() => void abort()}>停止</button>
              ) : (
                <button
                  type="button"
                  className={styles.send}
                  disabled={input.trim().length === 0}
                  onClick={() => void onSend()}
                >
                  发送
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* 会话侧栏（右侧，可隐藏） */}
      {sideVisible ? (
        <aside className={styles.side}>
          <button type="button" className={styles.new} onClick={newSession}>+ 新会话</button>
          <div className={styles["sess-label"]}>历史会话</div>
          <div className={styles["sess-list"]}>
            {sessions.map((s) => (
              <button
                key={s.session_id}
                type="button"
                className={`${styles.sess}${s.session_id === currentSession ? ` ${styles.active}` : ""}`}
                onClick={() => void openSession(s.session_id)}
                title={s.title}
              >
                <span className={styles["sess-title"]}>{s.title}</span>
                <span className={styles["sess-count"]}>{s.message_count}</span>
              </button>
            ))}
            {sessions.length === 0 ? (
              <div className={styles["sess-empty"]}>暂无历史会话</div>
            ) : null}
          </div>
        </aside>
      ) : null}
    </section>
  );
}
