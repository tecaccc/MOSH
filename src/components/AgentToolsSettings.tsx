import { useEffect, useState } from "react";
import { useAgentStore } from "../state/agent";
import { useDialogStore } from "../state/dialog";
import {
  deleteSkill as ipcDeleteSkill,
  deleteMcpServer as ipcDeleteMcp,
  listSkills,
  mcpListTools,
  saveMcpServer as ipcSaveMcp,
  saveSkill as ipcSaveSkill,
  setMcpEnabled,
  setSkillActive,
} from "../lib/ipc";
import type { McpServerConfig, SkillDef, SkillInfo } from "../lib/types";
import styles from "./AgentToolsSettings.module.css";

/**
 * 设置 → AI 工具 的两个子面板（左侧一级子菜单切换）：
 * - SkillsPane：技能（追加到系统提示词的行为指引；内置只读可开关，自定义可增删改）；
 * - McpPane：MCP 外部工具服务器（增删改、启停、测试连接）。
 * 开关状态与聊天输入区工具条实时同步（agent store 持有同一份列表）。
 */

/** 空白自定义技能草稿。 */
function emptySkill(): SkillDef {
  return { id: "", name: "", description: "", prompt: "", builtin: false };
}

/** 空白服务器草稿。 */
function emptyServer(): McpServerConfig {
  return { id: "", name: "", url: "", token: null, enabled: true };
}

function field(label: string, node: React.ReactNode, hint?: string) {
  return (
    <label className={styles.field}>
      <span className={styles["field-label"]}>{label}</span>
      {node}
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </label>
  );
}

async function reloadSkillsList(): Promise<SkillInfo[]> {
  try {
    return await listSkills();
  } catch {
    return [];
  }
}

/** —— 技能面板 —— */
export function SkillsPane() {
  const loadChatTools = useAgentStore((s) => s.loadChatTools);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [editingSkill, setEditingSkill] = useState<SkillDef | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillMsg, setSkillMsg] = useState<string | null>(null);
  const [skillErr, setSkillErr] = useState<string | null>(null);

  useEffect(() => {
    void reloadSkillsList().then(setSkills);
  }, []);

  async function onToggleSkill(sk: SkillInfo, active: boolean) {
    try {
      await setSkillActive(sk.id, active);
      setSkills((list) => list.map((x) => (x.id === sk.id ? { ...x, active } : x)));
      await loadChatTools();
    } catch (e) {
      setSkillErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSaveSkill() {
    const s = editingSkill;
    if (!s) return;
    setSkillBusy(true);
    setSkillErr(null);
    setSkillMsg(null);
    try {
      await ipcSaveSkill(s);
      setEditingSkill(null);
      setSkillMsg("技能已保存");
      setSkills(await reloadSkillsList());
      await loadChatTools();
    } catch (e) {
      setSkillErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSkillBusy(false);
    }
  }

  async function onDeleteSkill(sk: SkillInfo) {
    const ok = await useDialogStore.getState().confirm({
      title: "删除技能",
      message: `将删除自定义技能「${sk.name}」；已启用时会自动停用。`,
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await ipcDeleteSkill(sk.id);
      setSkills(await reloadSkillsList());
      await loadChatTools();
    } catch (e) {
      setSkillErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.group}>
        <div className={styles["group-head"]}>
          <div>
            <div className={styles["group-title"]}>技能（Skills）</div>
            <div className={styles["group-desc"]}>
              启用后其指引追加到助手系统提示词，赋予领域能力；内置技能只读，自定义可编辑。
            </div>
          </div>
          <button type="button" className={styles.add} onClick={() => setEditingSkill(emptySkill())}>
            + 新建技能
          </button>
        </div>

        {skillMsg ? <div className={styles.ok}>{skillMsg}</div> : null}
        {skillErr ? <div className={styles.err}>{skillErr}</div> : null}

        {editingSkill ? (
          <div className={styles.editor}>
            <div className={styles["editor-title"]}>
              {editingSkill.id ? "编辑技能" : "新建技能"}
            </div>
            {field(
              "名称",
              <input
                className={styles.input}
                value={editingSkill.name}
                onChange={(e) => setEditingSkill({ ...editingSkill, name: e.target.value })}
                placeholder="如：旅行规划"
              />,
            )}
            {field(
              "描述",
              <input
                className={styles.input}
                value={editingSkill.description}
                onChange={(e) => setEditingSkill({ ...editingSkill, description: e.target.value })}
                placeholder="一句话说明用途（列表展示）"
              />,
            )}
            {field(
              "提示词",
              <textarea
                className={styles.textarea}
                value={editingSkill.prompt}
                onChange={(e) => setEditingSkill({ ...editingSkill, prompt: e.target.value })}
                placeholder="启用该技能时追加到系统提示词的行为指引，如：面对旅行请求时先确认预算与天数，再分日程给出方案并创建日程事件。"
                rows={5}
              />,
              "支持多行；建议写清触发场景与期望行为。"
            )}
            <div className={styles["editor-actions"]}>
              <button type="button" className={styles.primary} disabled={skillBusy} onClick={() => void onSaveSkill()}>
                保存
              </button>
              <button type="button" className={styles.ghost} disabled={skillBusy} onClick={() => setEditingSkill(null)}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.list}>
          {skills.map((sk) => (
            <div key={sk.id} className={styles.item}>
              <input
                type="checkbox"
                checked={sk.active}
                onChange={(e) => void onToggleSkill(sk, e.currentTarget.checked)}
                aria-label={`启用 ${sk.name}`}
              />
              <div className={styles["item-main"]}>
                <div className={styles["item-name"]}>
                  {sk.name}
                  <span className={styles.tag}>{sk.builtin ? "内置" : "自定义"}</span>
                </div>
                <div className={styles["item-desc"]}>{sk.description}</div>
              </div>
              <div className={styles["item-actions"]}>
                {!sk.builtin ? (
                  <>
                    <button type="button" className={styles.mini} onClick={() => setEditingSkill({ ...sk })}>
                      编辑
                    </button>
                    <button type="button" className={`${styles.mini} ${styles.danger}`} onClick={() => void onDeleteSkill(sk)}>
                      删除
                    </button>
                  </>
                ) : (
                  <button type="button" className={styles.mini} onClick={() => setSkillMsg(sk.prompt)}>
                    查看提示词
                  </button>
                )}
              </div>
            </div>
          ))}
          {skills.length === 0 ? (
            <div className={styles.empty}>暂无技能；点击右上「新建技能」创建。</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** —— MCP 面板 —— */
export function McpPane() {
  const mcpServers = useAgentStore((s) => s.mcpServers);
  const loadChatTools = useAgentStore((s) => s.loadChatTools);
  const servers = mcpServers;

  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  /** 测试连接结果：serverId → { tools?: string[]; error?: string; loading?: boolean }。 */
  const [probe, setProbe] = useState<
    Record<string, { tools?: string[]; error?: string; loading?: boolean }>
  >({});

  async function onToggleServer(srv: McpServerConfig, enabled: boolean) {
    try {
      await setMcpEnabled(srv.id, enabled);
      await loadChatTools();
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSaveServer() {
    const srv = editingServer;
    if (!srv) return;
    setServerBusy(true);
    setServerErr(null);
    try {
      await ipcSaveMcp(srv);
      setEditingServer(null);
      await loadChatTools();
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : String(e));
    } finally {
      setServerBusy(false);
    }
  }

  async function onDeleteServer(srv: McpServerConfig) {
    const ok = await useDialogStore.getState().confirm({
      title: "删除 MCP 服务器",
      message: `将删除服务器「${srv.name}」（${srv.url}）；助手将不再提供其工具。`,
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await ipcDeleteMcp(srv.id);
      await loadChatTools();
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function onProbe(srv: McpServerConfig) {
    setProbe((p) => ({ ...p, [srv.id]: { loading: true } }));
    try {
      const tools = await mcpListTools(srv.url, srv.token);
      setProbe((p) => ({ ...p, [srv.id]: { tools } }));
    } catch (e) {
      setProbe((p) => ({
        ...p,
        [srv.id]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.group}>
        <div className={styles["group-head"]}>
          <div>
            <div className={styles["group-title"]}>MCP 服务器</div>
            <div className={styles["group-desc"]}>
              连接 Model Context Protocol 外部工具服务器（Streamable HTTP 端点）；
              启用后其工具自动注入助手，调用以「服务器/工具」卡片展示。
            </div>
          </div>
          <button type="button" className={styles.add} onClick={() => setEditingServer(emptyServer())}>
            + 添加服务器
          </button>
        </div>

        {serverErr ? <div className={styles.err}>{serverErr}</div> : null}

        {editingServer ? (
          <div className={styles.editor}>
            <div className={styles["editor-title"]}>
              {editingServer.id ? "编辑服务器" : "添加服务器"}
            </div>
            {field(
              "名称",
              <input
                className={styles.input}
                value={editingServer.name}
                onChange={(e) => setEditingServer({ ...editingServer, name: e.target.value })}
                placeholder="如：高德地图"
              />,
            )}
            {field(
              "端点地址",
              <input
                className={styles.input}
                value={editingServer.url}
                onChange={(e) => setEditingServer({ ...editingServer, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
              />,
              "MCP Streamable HTTP JSON-RPC 端点。"
            )}
            {field(
              "Bearer Token（可选）",
              <input
                className={styles.input}
                type="password"
                value={editingServer.token ?? ""}
                onChange={(e) =>
                  setEditingServer({
                    ...editingServer,
                    token: e.target.value.trim() === "" ? null : e.target.value,
                  })
                }
                placeholder="无需鉴权可留空"
              />,
            )}
            <div className={styles["editor-actions"]}>
              <button type="button" className={styles.primary} disabled={serverBusy} onClick={() => void onSaveServer()}>
                保存
              </button>
              <button type="button" className={styles.ghost} disabled={serverBusy} onClick={() => setEditingServer(null)}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.list}>
          {servers.map((srv) => {
            const p = probe[srv.id];
            return (
              <div key={srv.id} className={styles.item}>
                <input
                  type="checkbox"
                  checked={srv.enabled}
                  onChange={(e) => void onToggleServer(srv, e.currentTarget.checked)}
                  aria-label={`启用 ${srv.name}`}
                />
                <div className={styles["item-main"]}>
                  <div className={styles["item-name"]}>{srv.name}</div>
                  <div className={styles["item-desc"]}>{srv.url}</div>
                  {p?.loading ? (
                    <div className={styles["probe-line"]}>连接中…</div>
                  ) : p?.tools ? (
                    <div className={styles["probe-line ok"]}>
                      连接成功 · {p.tools.length} 个工具：{p.tools.slice(0, 6).join("、")}
                      {p.tools.length > 6 ? " 等" : ""}
                    </div>
                  ) : p?.error ? (
                    <div className={styles["probe-line err"]}>连接失败：{p.error}</div>
                  ) : null}
                </div>
                <div className={styles["item-actions"]}>
                  <button type="button" className={styles.mini} onClick={() => void onProbe(srv)}>
                    测试连接
                  </button>
                  <button type="button" className={styles.mini} onClick={() => setEditingServer({ ...srv })}>
                    编辑
                  </button>
                  <button type="button" className={`${styles.mini} ${styles.danger}`} onClick={() => void onDeleteServer(srv)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
          {servers.length === 0 ? (
            <div className={styles.empty}>
              尚未添加 MCP 服务器；支持任何 Streamable HTTP 端点（如 mcp.so / cloudflare 托管服务）。
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
