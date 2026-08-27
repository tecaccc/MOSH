import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { toolLabel, useAgentStore, type UiMessage } from "../state/agent";
import { useAppStore } from "../state/store";
import { toast } from "../state/toast";
import { filesToAttachments, MAX_ATTACHMENTS } from "../lib/image";
import { PERMISSION_MODES, type PermissionMode } from "../lib/types";
import styles from "./ChatPanel.module.css";

/**
 * 助手聊天面板：消息区（用户纯文本气泡 / 助手 streamdown 渲染 + 工具卡片）
 * + 输入区（composer：自动增高 textarea + 底部工具条——模型选择、技能、MCP，
 * 参考 cherry-studio）。会话仅存内存（重启清空），顶栏「+ 新会话」随时重开对话。
 */

/** 工具卡片参数摘要（一行）。 */
function argSummary(m: UiMessage): string {
  const a = m.args as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return "";
  if (typeof a.title === "string") return String(a.title);
  if (typeof a.from === "string" && typeof a.to === "string") return `${a.from} ~ ${a.to}`;
  if (typeof a.status === "string") return `→ ${a.status}`;
  if (Array.isArray(a.ids)) return `${a.ids.length} 个`;
  if (typeof a.q === "string" || typeof a.query === "string") {
    return String(a.q ?? a.query);
  }
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
  // 删除类：优先展示删除数/标题（单删带标题、批量部分失败带失败数）。
  if (typeof r.deleted === "number") {
    const failed = Array.isArray(r.failed) ? r.failed.length : 0;
    if (failed > 0) return `已删 ${r.deleted} 条 · ${failed} 条失败`;
    if (r.deleted === 1 && typeof r.title === "string") return `已删「${r.title}」`;
    return `已删 ${r.deleted} 条`;
  }
  if (m.ok === false && typeof r.error === "string") return r.error;
  if (typeof r.count === "number") return `${r.count} 条`;
  if (m.ok === true) return "完成";
  return "";
}

/** 任意值 → 美化 JSON 文本（字符串先尝试再解析；失败回退原文）。 */
function prettyJson(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolCard({ m }: { m: UiMessage }) {
  const undoCreate = useAgentStore((s) => s.undoCreate);
  const [open, setOpen] = useState(false);
  const argsText = prettyJson(m.args);
  const resultText = prettyJson(m.result);

  return (
    <div className={`${styles.toolcard}${m.ok === false ? ` ${styles.fail}` : ""}${m.undone ? ` ${styles.undone}` : ""}${open ? ` ${styles.open}` : ""}`}>
      <div className={styles["tc-row"]}>
        <button
          type="button"
          className={styles["tc-toggle"]}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? "收起详情" : "展开查看参数与返回"}
        >
          <span
            className={`${styles["tc-chevron"]}${open ? ` ${styles.up}` : ""}`}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
          <span className={styles["tc-name"]}>{toolLabel(m.tool ?? "")}</span>
          {argSummary(m) ? <span className={styles["tc-args"]}>{argSummary(m)}</span> : null}
          <span className={styles["tc-result"]}>{m.undone ? "已撤销" : resultLine(m)}</span>
        </button>
        {undoable(m) && !m.undone ? (
          <button type="button" className={styles["tc-undo"]} onClick={() => void undoCreate(m)}>
            撤销
          </button>
        ) : null}
      </div>
      {open ? (
        <div className={styles["tc-detail"]}>
          {argsText ? (
            <div className={styles["tc-block"]}>
              <div className={styles["tc-block-label"]}>输入参数</div>
              <pre className={styles["tc-pre"]}>{argsText}</pre>
            </div>
          ) : null}
          {resultText ? (
            <div className={styles["tc-block"]}>
              <div className={styles["tc-block-label"]}>返回结果</div>
              <pre className={styles["tc-pre"]}>{resultText}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 技能弹层：全部技能开关 + 前往设置管理（深链到 AI 工具→技能）。 */
function SkillsPopover({ onClose }: { onClose: () => void }) {
  const skills = useAgentStore((s) => s.skills);
  const toggleSkill = useAgentStore((s) => s.toggleSkill);
  const openSettings = useAppStore((s) => s.openSettings);
  const activeCount = skills.filter((s) => s.active).length;

  return (
    <>
      <button type="button" className={styles["pop-mask"]} aria-label="关闭弹层" onClick={onClose} />
      <div className={styles.popover}>
        <div className={styles["pop-head"]}>
          <span className={styles["pop-title"]}>技能</span>
          <span className={styles["pop-sub"]}>{activeCount > 0 ? `已启用 ${activeCount}` : "未启用"}</span>
        </div>
        <div className={styles["pop-body"]}>
          {skills.length === 0 ? (
            <div className={styles["pop-empty"]}>暂无技能</div>
          ) : (
            skills.map((sk) => (
              <label key={sk.id} className={styles["pop-item"]} title={sk.prompt}>
                <input
                  type="checkbox"
                  checked={sk.active}
                  onChange={(e) => void toggleSkill(sk.id, e.currentTarget.checked)}
                />
                <span className={styles["pop-item-main"]}>
                  <span className={styles["pop-item-name"]}>
                    {sk.name}
                    {sk.builtin ? <span className={styles["pop-tag"]}>内置</span> : null}
                  </span>
                  <span className={styles["pop-item-desc"]}>{sk.description}</span>
                </span>
              </label>
            ))
          )}
        </div>
        <button
          type="button"
          className={styles["pop-foot"]}
          onClick={() => {
            onClose();
            openSettings("aitools", "skills");
          }}
        >
          管理技能（新建/编辑）→
        </button>
      </div>
    </>
  );
}

/** MCP 弹层：服务器开关 + 状态徽标 + 前往设置管理（深链到 AI 工具→MCP）。 */
function McpPopover({ onClose }: { onClose: () => void }) {
  const servers = useAgentStore((s) => s.mcpServers);
  const toggleMcpServer = useAgentStore((s) => s.toggleMcpServer);
  const openSettings = useAppStore((s) => s.openSettings);
  const enabledCount = servers.filter((s) => s.enabled).length;

  return (
    <>
      <button type="button" className={styles["pop-mask"]} aria-label="关闭弹层" onClick={onClose} />
      <div className={styles.popover}>
        <div className={styles["pop-head"]}>
          <span className={styles["pop-title"]}>MCP 服务器</span>
          <span className={styles["pop-sub"]}>
            {servers.length === 0 ? "未配置" : enabledCount > 0 ? `已启用 ${enabledCount}/${servers.length}` : "全部停用"}
          </span>
        </div>
        <div className={styles["pop-body"]}>
          {servers.length === 0 ? (
            <div className={styles["pop-empty"]}>尚未添加 MCP 服务器</div>
          ) : (
            servers.map((srv) => (
              <label key={srv.id} className={styles["pop-item"]} title={srv.url}>
                <input
                  type="checkbox"
                  checked={srv.enabled}
                  onChange={(e) => void toggleMcpServer(srv.id, e.currentTarget.checked)}
                />
                <span className={styles["pop-item-main"]}>
                  <span className={styles["pop-item-name"]}>{srv.name}</span>
                  <span className={styles["pop-item-desc"]}>{srv.url}</span>
                </span>
              </label>
            ))
          )}
        </div>
        <button
          type="button"
          className={styles["pop-foot"]}
          onClick={() => {
            onClose();
            openSettings("aitools", "mcp");
          }}
        >
          管理 MCP 服务器（添加/测试）→
        </button>
      </div>
    </>
  );
}

export default function ChatPanel() {
  const messages = useAgentStore((s) => s.messages);
  const streaming = useAgentStore((s) => s.streaming);
  const configured = useAgentStore((s) => s.configured);
  const error = useAgentStore((s) => s.error);
  const models = useAgentStore((s) => s.models);
  const selectedModel = useAgentStore((s) => s.selectedModel);
  const init = useAgentStore((s) => s.init);
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const newSession = useAgentStore((s) => s.newSession);
  const selectModel = useAgentStore((s) => s.selectModel);
  const skills = useAgentStore((s) => s.skills);
  const mcpServers = useAgentStore((s) => s.mcpServers);
  const permissionMode = useAgentStore((s) => s.permissionMode);
  const selectPermissionMode = useAgentStore((s) => s.selectPermissionMode);
  const pendingApproval = useAgentStore((s) => s.pendingApproval);
  const decideApproval = useAgentStore((s) => s.decideApproval);
  const openSettings = useAppStore((s) => s.openSettings);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pop, setPop] = useState<"none" | "skills" | "mcp">("none");
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // 新消息/流式增量 → 滚到底部。
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, messages.at(-1)?.text.length]);

  // hero→对话态切换时 msgs 的 flex-grow/padding 有 0.45s 过渡，首条消息
  // 加入瞬间容器尚在展开中，直接设 scrollTop 会落在中间态上；
  // 监听过渡结束补一次滚动，确保最终停在底部。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const scrollToEnd = () => {
      el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("transitionend", scrollToEnd);
    return () => el.removeEventListener("transitionend", scrollToEnd);
  }, []);

  // 全局拖拽兑底：拖到输入区之外时不让 WebView 导航到该文件（仅拦截默认行为，
  // 输入区内的 onDrop 正常接管）。
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  // 输入框自动增高：内容变化时重算高度（76px ~ 220px）。
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 76), 220)}px`;
  }, [input]);

  function onKeydown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  }

  /** 选图/粘贴/拖拽共用：压缩 + 数量把关（超限 toast 提示）。 */
  async function addFiles(files: File[]) {
    setAttachments(await filesToAttachments(files, attachments, (m) => toast.error(m)));
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault(); // 粘贴图片文件时不把文件名写进输入框
      void addFiles(files);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }

  async function onSend() {
    const t = input;
    const imgs = attachments;
    if ((t.trim().length === 0 && imgs.length === 0) || useAgentStore.getState().streaming) return;
    setInput("");
    setAttachments([]);
    setPop("none");
    await send(t, imgs);
  }

  const activeSkills = skills.filter((s) => s.active).length;
  const enabledMcp = mcpServers.filter((s) => s.enabled).length;
  // 首包等待：流式中但还没有任何流式文本气泡（LLM 首字前 / 工具执行间隙）。
  const waitingFirst =
    streaming && !messages.some((m) => m.streaming) && !pendingApproval;

  return (
    <section className={styles.chat}>
      <div className={styles.main}>
        {/* 顶栏：标题 + 当前模型 */}
        <div className={styles["chat-head"]}>
          <span className={styles["chat-title"]}>AI 助手</span>
          {configured && selectedModel ? (
            <span className={styles["head-model"]}>{selectedModel}</span>
          ) : null}
          {activeSkills > 0 ? <span className={styles["head-chip"]}>技能 {activeSkills}</span> : null}
          {enabledMcp > 0 ? <span className={styles["head-chip"]}>MCP {enabledMcp}</span> : null}
          <button
            type="button"
            className={styles["head-new"]}
            onClick={newSession}
            title="开始新会话（对话仅存内存，重启后清空）"
          >
            + 新会话
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
            <button type="button" className={styles["guide-btn"]} onClick={() => openSettings("ai")}>
              前往设置
            </button>
          </div>
        ) : (
          <>
            {/* 舞台：空会话 hero（问候+输入框整组垂直居中，Codex 式）；
                发首条消息后 spacers flex-grow 1→0、消息区 0→1 同步插值，
                输入框组丝滑滑落到底部 */}
            <div className={styles.stage} data-hero={messages.length === 0}>
              <div className={styles.msgs} ref={listRef}>
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.key} className={`${styles.row} ${styles["user-row"]}`}>
                    <div className={`${styles.bubble} ${styles.user}`}>
                      {m.images && m.images.length > 0 ? (
                        <div className={styles["bubble-imgs"]}>
                          {m.images.map((src, i) => (
                            <img key={i} src={src} alt="附件图片" className={styles["bubble-img"]} />
                          ))}
                        </div>
                      ) : null}
                      {m.text}
                    </div>
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
              {waitingFirst ? (
                <div className={`${styles.row} ${styles["bot-row"]}`}>
                  <div className={`${styles.bubble} ${styles.bot} ${styles.thinking}`}>
                    <span className={styles.dots} aria-label="思考中">
                      <span /><span /><span />
                    </span>
                  </div>
                </div>
              ) : null}
              </div>

              {/* 下组：spacer → hero/错误/审批/输入框 → spacer。
                hero 态时整组被两侧 spacer 夹在垂直居中（输入框跟着居中）；
                发送后 spacers 收 0，整组自然滑落到舞台底部。 */}
              <div className={styles.spacer} aria-hidden="true" />

            {error ? <div className={styles.err}>{error}</div> : null}

            {/* 待审批工具调用（审批模式下）：展示工具与参数，等待用户决定 */}
            {pendingApproval ? (
              <div className={styles.approval}>
                <div className={styles["ap-head"]}>
                  <span className={styles["ap-ico"]}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l7 3v5c0 4.4-2.9 8.1-7 9.5-4.1-1.4-7-5.1-7-9.5V6z" />
                    </svg>
                  </span>
                  <div className={styles["ap-title"]}>
                    待批准的工具调用
                    <span className={styles["ap-tool"]}>{toolLabel(pendingApproval.tool)}</span>
                  </div>
                </div>
                <pre className={styles["ap-args"]}>{prettyJson(pendingApproval.args) || "（无参数）"}</pre>
                <div className={styles["ap-actions"]}>
                  <button type="button" className={styles["ap-deny"]} onClick={() => void decideApproval(false)}>
                    拒绝
                  </button>
                  <button type="button" className={styles["ap-ok"]} onClick={() => void decideApproval(true)}>
                    批准执行
                  </button>
                </div>
              </div>
            ) : null}

            {/* hero：空会话问候（紧贴输入框上方，与之同组被夹在垂直居中） */}
            <div className={styles.hero} aria-hidden={messages.length > 0}>
              <div className={styles["hero-title"]}>有什么可以帮你安排？</div>
              <div className={styles["hero-sub"]}>
                试试：「明早十点开周会」「建个待办：交季度报告，下周五截止」「我今天有什么安排」；
                也可粘贴/上传图片提问（需视觉模型）
              </div>
            </div>

            {/* 输入区（composer）：附件预览 + 自动增高 textarea + 底部工具条 */}
            <div className={styles.composer} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
              {attachments.length > 0 ? (
                <div className={styles["attach-row"]}>
                  {attachments.map((src, i) => (
                    <div key={i} className={styles["attach-chip"]}>
                      <img src={src} alt="待发送图片" />
                      <button
                        type="button"
                        className={styles["attach-x"]}
                        aria-label="移除图片"
                        title="移除"
                        onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                      >
                        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeydown}
                onPaste={onPaste}
                placeholder={streaming ? "回复中…（可点右侧停止）" : "输入消息，Enter 发送，Shift+Enter 换行；可粘贴/拖入图片"}
                rows={3}
                disabled={configured !== true}
              />
              <div className={styles["toolbar"]}>
                <div className={styles["tool-left"]}>
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
                  ) : null}

                  <select
                    className={`${styles["model-select"]} ${styles["perm-select"]}`}
                    value={permissionMode}
                    onChange={(e) => void selectPermissionMode(e.currentTarget.value as PermissionMode)}
                    title={PERMISSION_MODES.find((p) => p.value === permissionMode)?.desc}
                  >
                    {PERMISSION_MODES.map((p) => (
                      <option key={p.value} value={p.value}>
                        🛡 {p.label}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className={`${styles["tool-btn"]}${attachments.length > 0 ? ` ${styles.on}` : ""}`}
                    onClick={() => fileRef.current?.click()}
                    title={`上传图片（最多 ${MAX_ATTACHMENTS} 张，需视觉模型）`}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="14" rx="2.5" />
                      <circle cx="8.5" cy="10" r="1.6" />
                      <path d="M4 17.5l5-5 4 4 3.5-3.5L20 16.5" />
                    </svg>
                    <span>图片</span>
                    {attachments.length > 0 ? (
                      <span className={styles["tool-badge"]}>{attachments.length}</span>
                    ) : null}
                  </button>

                  <button
                    type="button"
                    className={`${styles["tool-btn"]}${activeSkills > 0 ? ` ${styles.on}` : ""}`}
                    onClick={() => setPop(pop === "skills" ? "none" : "skills")}
                    title="技能（Skills）：为助手启用领域行为指引"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
                      <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
                    </svg>
                    <span>技能</span>
                    {activeSkills > 0 ? <span className={styles["tool-badge"]}>{activeSkills}</span> : null}
                  </button>

                  <button
                    type="button"
                    className={`${styles["tool-btn"]}${enabledMcp > 0 ? ` ${styles.on}` : ""}`}
                    onClick={() => setPop(pop === "mcp" ? "none" : "mcp")}
                    title="MCP：外部工具服务器"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="8" width="5" height="8" rx="1.5" />
                      <rect x="16" y="8" width="5" height="8" rx="1.5" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>MCP</span>
                    {enabledMcp > 0 ? <span className={styles["tool-badge"]}>{enabledMcp}</span> : null}
                  </button>
                </div>

                {streaming ? (
                  <button type="button" className={styles.stop} onClick={() => void abort()}>停止</button>
                ) : (
                  <button
                    type="button"
                    className={styles.send}
                    disabled={input.trim().length === 0 && attachments.length === 0}
                    onClick={() => void onSend()}
                  >
                    发送
                  </button>
                )}
              </div>

              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = ""; // 允许连续选同一文件
                  if (files.length > 0) void addFiles(files);
                }}
              />

              {pop === "skills" ? <SkillsPopover onClose={() => setPop("none")} /> : null}
              {pop === "mcp" ? <McpPopover onClose={() => setPop("none")} /> : null}
            </div>

              <div className={styles.spacer} aria-hidden="true" />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
