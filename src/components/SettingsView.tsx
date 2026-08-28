import { useEffect, useRef, useState } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { openPath } from "@tauri-apps/plugin-opener";
import { AiProviderColumn, AiSettingsPane } from "./AiSettings";
import { McpPane, SkillsPane } from "./AgentToolsSettings";
import Avatar from "./Avatar";
import CityPicker from "./CityPicker";
import NotifySettings from "./NotifySettings";
import SyncSettings from "./SyncSettings";
import {
  getCloseBehavior,
  getStorageInfo,
  setCloseBehavior as setCloseBehaviorIpc,
} from "../lib/ipc";
import { WEATHER_ICONS, weatherInfo, type WeatherIcon } from "../lib/weather-code";
import type { CloseBehavior, StorageInfo } from "../lib/types";
import { useAgentStore } from "../state/agent";
import { useAppStore, type SettingsSection } from "../state/store";
import { useProfileStore } from "../state/profile";
import { toast } from "../state/toast";
import { useUpdaterStore } from "../state/updater";
import { useWeatherStore } from "../state/weather";
import { CLOSE_BEHAVIORS } from "../lib/types";
import styles from "./SettingsView.module.css";

/**
 * 设置页：左 SectionNav（天气/AI 模型/关于）+ 右 ContentPanel。
 * AI 分区：提供商列表 + 配置表单（接口地址 → API Key → 模型列表 → 保存/测试）。
 */

type AgentToolsPane = "skills" | "mcp";

const inTauri = "__TAURI_INTERNALS__" in window;
const round = (n: number): number => Math.round(n);

function WeatherIcon({ name }: { name: WeatherIcon }) {
  return (
    <span className={styles["pv-ico"]} dangerouslySetInnerHTML={{ __html: WEATHER_ICONS[name] }} />
  );
}


/** 头像快捷表情预设。 */
const PROFILE_EMOJIS = ["🦊", "🐼", "🐱", "🚀", "⭐", "🌙", "🌸", "🧋"];

export default function SettingsView() {
  // 惰性初始化：深链目标直接作为初始分区/面板，避免先闪一帧默认页。
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    () => useAppStore.getState().settingsTarget?.section ?? "weather",
  );
  /** AI 工具子菜单（技能 / MCP 服务器），与 AI 模型的提供商栏同构。 */
  const [aitoolsPane, setAitoolsPane] = useState<AgentToolsPane>(
    () => useAppStore.getState().settingsTarget?.pane ?? "skills",
  );

  // 深链：openSettings 写入目标（分区+子面板），挂载后消费一次。
  const settingsTarget = useAppStore((s) => s.settingsTarget);
  const consumeSettingsTarget = useAppStore((s) => s.consumeSettingsTarget);
  useEffect(() => {
    if (!settingsTarget) return;
    setActiveSection(settingsTarget.section);
    if (settingsTarget.pane) setAitoolsPane(settingsTarget.pane);
    consumeSettingsTarget();
  }, [settingsTarget, consumeSettingsTarget]);

  // —— 天气 ——
  const wStatus = useWeatherStore((s) => s.status);
  const weather = useWeatherStore((s) => s.weather);
  const cityName = useWeatherStore((s) => s.cityName);
  const weatherError = useWeatherStore((s) => s.error);
  const loadWeather = useWeatherStore((s) => s.loadWeather);
  const refreshWeather = useWeatherStore((s) => s.refreshWeather);
  const info = weather ? weatherInfo(weather.weather_code) : null;

  // —— AI 工具子菜单计数（技能启用数 / MCP 启用数）——
  const agentSkills = useAgentStore((s) => s.skills);
  const agentMcpServers = useAgentStore((s) => s.mcpServers);
  const activeSkillCount = agentSkills.filter((s) => s.active).length;
  const enabledMcpCount = agentMcpServers.filter((s) => s.enabled).length;

  // —— toast ——
  // 操作反馈统一走全局 toast（state/toast，App 顶部图层向下弹出）；
  // showToast 包装保留原调用点签名。
  function showToast(ok: boolean, text: string) {
    if (ok) toast.success(text);
    else toast.error(text);
  }

  // —— 个人资料（名称/头像；首页与今日问候展示）——
  const profileStoreName = useProfileStore((s) => s.name);
  const profileStoreAvatar = useProfileStore((s) => s.avatar);
  const profileLoaded = useProfileStore((s) => s.loaded);
  const [pfName, setPfName] = useState("");
  const [pfAvatar, setPfAvatar] = useState<string | null>(null);
  // store 载入完成后同步表单初值（仅一次；后续编辑不受 store 更新影响）。
  useEffect(() => {
    if (profileLoaded) {
      setPfName(profileStoreName);
      setPfAvatar(profileStoreAvatar);
    }
  }, [profileLoaded]);

  /** 选图转 data URL（限 1.5MB，与后端校验一致）。 */
  function onPickAvatar(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_500_000) {
      showToast(false, "图片过大，请选择小于 1.5MB 的图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPfAvatar(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  }

  async function onProfileSave() {
    const name = pfName.trim();
    if (!name) {
      showToast(false, "名称不能为空");
      return;
    }
    try {
      await useProfileStore.getState().save(name, pfAvatar);
      showToast(true, "个人资料已保存");
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void loadWeather();
    void loadAbout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 通用（关闭行为等） ——
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>("exit");
  useEffect(() => {
    void getCloseBehavior().then(setCloseBehavior);
  }, []);

  async function onCloseBehaviorChange(b: CloseBehavior) {
    setCloseBehavior(b);
    try {
      await setCloseBehaviorIpc(b);
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
      setCloseBehavior(b === "exit" ? "background" : "exit");
    }
  }

  // —— 关于 ——
  const [appName, setAppName] = useState("MOSH");
  const [appVersion, setAppVersion] = useState("");
  const [tauriVersion, setTauriVersion] = useState("");
  const [platform, setPlatform] = useState("");
  /** 数据目录与配置文件位置（打开目录/展示用）。 */
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const updaterPhase = useUpdaterStore((s) => s.phase);

  async function loadAbout() {
    setPlatform(
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ??
        navigator.platform ??
        "",
    );
    if (!inTauri) {
      setAppVersion(__APP_VERSION__);
      return;
    }
    void getStorageInfo().then(setStorage);
    try {
      const [n, v, t] = await Promise.all([getName(), getVersion(), getTauriVersion()]);
      setAppName(n);
      setAppVersion(v);
      setTauriVersion(t);
    } catch {
      setAppVersion(__APP_VERSION__);
    }
  }

  // 手动检查更新：结果仅 toast 反馈（有新版本时另弹 UpdaterToast 卡片）。
  async function onCheckUpdate() {
    await useUpdaterStore.getState().check();
    const { phase, info } = useUpdaterStore.getState();
    if (phase === "upToDate") showToast(true, "已是最新版本 ✨");
    else if (phase === "error") showToast(false, "检查更新失败，请稍后重试");
    else if (phase === "available" && info)
      showToast(true, `发现新版本 v${info.version}，可在顶部通知中更新`);
  }

  // 当前表单名称对应的提供商图标（输入 DeepSeek 即时亮起）；模型列表同用。

  return (
    <section
      className={`${styles.settings}${activeSection === "ai" || activeSection === "aitools" ? ` ${styles[activeSection]}` : ""}`}
    >
      <nav className={styles["section-nav"]}>
        <div className={styles["nav-header"]}>设置</div>

        <div className={styles["nav-group"]}>
          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "general" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("general")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M4 6h16M4 12h16M4 18h16" />
                <circle cx="9" cy="6" r="2" fill="var(--surface)" />
                <circle cx="15" cy="12" r="2" fill="var(--surface)" />
                <circle cx="8" cy="18" r="2" fill="var(--surface)" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>通用</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "profile" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("profile")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>个人资料</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "notify" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("notify")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>通知</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "sync" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("sync")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5" />
                <path d="M4 4v4.5H8.5" />
                <path d="M4 12.5A8 8 0 0 0 17.7 17.7L20 15.5" />
                <path d="M20 20v-4.5H15.5" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>同步</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "weather" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("weather")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>天气</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "ai" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("ai")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
                <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>AI 模型</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "aitools" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("aitools")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>AI 工具</span>
          </button>

          <button
            type="button"
            className={`${styles["nav-item"]}${activeSection === "about" ? ` ${styles.active}` : ""}`}
            onClick={() => setActiveSection("about")}
          >
            <span className={styles["nav-ico"]}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </span>
            <span className={styles["nav-label"]}>关于</span>
          </button>
        </div>

        <div className={styles["nav-spacer"]} />

        <div className={styles["nav-footer"]}>
          <span className={styles["nav-version"]}>v{appVersion || "…"}</span>
        </div>
      </nav>

      {/* AI 工具分区：与 AI 模型同构的一级子菜单（技能 / MCP 服务器）。*/}
      {activeSection === "aitools" ? (
        <aside className={styles["provider-col"]}>
          <div className={styles["pl-label"]}>AI 工具</div>
          <div className={styles["pl-items"]}>
            <button
              type="button"
              className={`${styles["pl-item"]}${aitoolsPane === "skills" ? ` ${styles.active}` : ""}`}
              onClick={() => setAitoolsPane("skills")}
            >
              <span className={styles["pl-icon-sm"]}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
                </svg>
              </span>
              <span className={styles["pl-name"]}>技能</span>
              {activeSkillCount > 0 ? (
                <span className={styles["pl-count"]}>{activeSkillCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`${styles["pl-item"]}${aitoolsPane === "mcp" ? ` ${styles.active}` : ""}`}
              onClick={() => setAitoolsPane("mcp")}
            >
              <span className={styles["pl-icon-sm"]}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <rect x="3" y="8" width="5" height="8" rx="1.5" />
                  <rect x="16" y="8" width="5" height="8" rx="1.5" />
                  <path d="M8 12h8" />
                </svg>
              </span>
              <span className={styles["pl-name"]}>MCP 服务器</span>
              {enabledMcpCount > 0 ? (
                <span className={styles["pl-count"]}>{enabledMcpCount}</span>
              ) : null}
            </button>
          </div>

          <div className={styles["nav-spacer"]} />

          <div className={styles["pl-tip"]}>
            也可在聊天输入区下方工具条快速开关；修改后新消息生效。
          </div>
        </aside>
      ) : null}
      {/* AI 分区：提供商栏紧贴设置栏（菜单栏-设置栏-提供商栏-配置区）。*/}
      {activeSection === "ai" ? (
        <aside className={styles["provider-col"]}>
          <AiProviderColumn />
        </aside>
      ) : null}

      <div className={styles["content-panel"]}>
        {activeSection === "general" ? (
          <div className={styles["content-scroll"]}>
            <div className={styles["content-body"]}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>通用</div>
                <div className={styles["content-desc"]}>窗口与行为偏好。</div>
              </div>

              <div className={styles.sgroup}>
                <div className={styles.stitle}>关闭按钮行为</div>
                <div className={styles.sdivider} />
                {CLOSE_BEHAVIORS.map((it) => (
                  <button
                    key={it.value}
                    type="button"
                    className={`${styles["cb-item"]}${closeBehavior === it.value ? ` ${styles.active}` : ""}`}
                    onClick={() => void onCloseBehaviorChange(it.value)}
                  >
                    <span className={styles["cb-radio"]} aria-hidden="true" />
                    <span className={styles["cb-text"]}>
                      <span className={styles["cb-label"]}>{it.label}</span>
                      <span className={styles["cb-desc"]}>{it.desc}</span>
                    </span>
                  </button>
                ))}
                <div className={styles.sdivider} />
              </div>
            </div>
          </div>
        ) : null}

        {activeSection === "profile" ? (
          <div className={styles["content-scroll"]}>
            <div className={styles["content-body"]}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>个人资料</div>
                <div className={styles["content-desc"]}>
                  名称与头像用于首页与今日页的问候展示；仅存本地，不上传。
                </div>
              </div>

              <div className={styles.sgroup}>
                <div className={styles.stitle}>头像</div>
                <div className={styles.sdivider} />
                <div className={styles["pf-row"]}>
                  <Avatar name={pfName} avatar={pfAvatar} size={64} />
                  <div className={styles["pf-actions"]}>
                    <label className={`${styles["ai-btn"]}`}>
                      上传图片
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          onPickAvatar(e.currentTarget.files?.[0]);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                    {pfAvatar ? (
                      <button
                        type="button"
                        className={`${styles["ai-btn"]} ${styles.danger}`}
                        onClick={() => setPfAvatar(null)}
                      >
                        恢复默认
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className={styles["pf-emoji"]}>
                  {PROFILE_EMOJIS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      className={`${styles["pf-emoji-btn"]}${pfAvatar === `emoji:${em}` ? ` ${styles.active}` : ""}`}
                      onClick={() => setPfAvatar(`emoji:${em}`)}
                      aria-label={`使用表情 ${em} 作为头像`}
                    >
                      {em}
                    </button>
                  ))}
                </div>
                <div className={styles.sdivider} />

                <div className={styles.stitle}>名称</div>
                <div className={styles.sdivider} />
                <div className={styles.srow}>
                  <div className={styles["srow-label"]}>
                    <span className={styles["srow-name"]}>展示名称</span>
                    <span className={styles["srow-hint"]}>
                      问候语展示用；未设置时问候不带称呼。
                    </span>
                  </div>
                  <input
                    className={styles["srow-input"]}
                    value={pfName}
                    placeholder="如：Connor"
                    maxLength={24}
                    onChange={(e) => setPfName(e.currentTarget.value)}
                  />
                </div>
                <div className={styles.sdivider} />

                <div className={styles["pf-save"]}>
                  <button
                    type="button"
                    className={`${styles["ai-btn"]} ${styles.primary}`}
                    onClick={() => void onProfileSave()}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeSection === "sync" ? <SyncSettings /> : null}

        {activeSection === "notify" ? <NotifySettings /> : null}

        {activeSection === "weather" ? (
          <div className={styles["content-scroll"]}>
            <div className={styles["content-body"]}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>天气</div>
                <div className={styles["content-desc"]}>配置天气展示城市，数据来自 Open-Meteo。</div>
              </div>

              <div className={styles.sgroup}>
                <div className={styles.stitle}>城市选择</div>
                <div className={styles.sdivider} />
                <div className={styles.srow}>
                  <div className={styles["srow-label"]}>
                    <span className={styles["srow-name"]}>城市</span>
                    <span className={styles["srow-hint"]}>支持中文或拼音搜索，全国及全球城市可选；同名城市靠省份区分。</span>
                  </div>
                  <CityPicker />
                </div>
                <div className={styles.sdivider} />

                {wStatus === "loading" ? (
                  <div className={`${styles.preview} ${styles.dim}`}>加载中…</div>
                ) : wStatus === "ok" && weather && info ? (
                  <div className={styles.preview}>
                    <WeatherIcon name={info.icon} />
                    <span className={styles["pv-text"]}>
                      {cityName} · {round(weather.temperature)}° {info.label}
                      · 体感 {round(weather.apparent_temperature)}°
                      · 湿度 {round(weather.humidity)}%
                    </span>
                  </div>
                ) : wStatus === "error" ? (
                  <div className={`${styles.preview} ${styles.error}`}>
                    <span className={styles["pv-text"]}>获取失败：{weatherError}</span>
                    <button type="button" className={styles.retry} onClick={() => void refreshWeather()}>
                      重试
                    </button>
                  </div>
                ) : (
                  <div className={`${styles.preview} ${styles.dim}`}>未选择城市。</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {activeSection === "ai" ? (
          <div className={styles["content-scroll"]}>
            <div className={styles["content-body"]}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>AI 模型</div>
                <div className={styles["content-desc"]}>
                  提供商与模型实体管理：预置一键添加、任意 OpenAI 兼容端点、同步模型列表、设置默认模型。
                </div>
              </div>
              <AiSettingsPane />
            </div>
          </div>
        ) : null}

        {activeSection === "aitools" ? (
          <div className={styles["content-scroll"]}>
            <div className={styles["content-body"]}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>
                  {aitoolsPane === "skills" ? "技能" : "MCP 服务器"}
                </div>
                <div className={styles["content-desc"]}>
                  {aitoolsPane === "skills"
                    ? "启用后追加到助手系统提示词的领域能力；也可在聊天输入区工具条快速开关。"
                    : "MCP 外部工具服务器；启用后其工具自动注入助手。"}
                </div>
              </div>
              {aitoolsPane === "skills" ? <SkillsPane /> : <McpPane />}
            </div>
          </div>
        ) : null}

        {activeSection === "about" ? (
          <div className={styles["content-scroll"]}>
            <div className={styles["content-body"]}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>关于</div>
                <div className={styles["content-desc"]}>应用版本与运行环境信息。</div>
              </div>

              <div className={styles.sgroup}>
                <div className={styles["about-brand"]}>
                  <span className={styles["about-mark"]}>M</span>
                  <div className={styles["about-brand-text"]}>
                    <span className={styles["about-name"]}>{appName}</span>
                    <span className={styles["about-slogan"]}>本地优先个人信息管理 · 待办与日程</span>
                  </div>
                  <span className={styles["about-ver"]}>v{appVersion || "…"}</span>
                </div>
              </div>

              <div className={styles.sgroup}>
                <div className={styles["about-grid"]}>
                  <div className={styles["about-item"]}>
                    <span className={styles["about-k"]}>版本</span>
                    <span className={styles["about-v"]}>{appVersion || "—"}</span>
                  </div>
                  <div className={styles["about-item"]}>
                    <span className={styles["about-k"]}>应用标识</span>
                    <span className={`${styles["about-v"]} ${styles.mono}`}>com.mosh.app</span>
                  </div>
                  <div className={styles["about-item"]}>
                    <span className={styles["about-k"]}>Tauri 框架</span>
                    <span className={styles["about-v"]}>{tauriVersion || "—"}</span>
                  </div>
                  <div className={styles["about-item"]}>
                    <span className={styles["about-k"]}>运行平台</span>
                    <span className={styles["about-v"]}>{platform || "—"}</span>
                  </div>
                </div>
              </div>

              {/* 数据与配置：数据库位置 + config.toml（自定义 data_dir 重启生效） */}
              {storage ? (
                <div className={styles.sgroup}>
                  <div className={styles.stitle}>数据与配置</div>
                  <div className={styles.sdivider} />
                  <div className={styles.srow}>
                    <div className={styles["srow-label"]}>
                      <span className={styles["srow-name"]}>
                        数据目录
                        <span
                          className={`${styles["pf-badge"]}${storage.customized ? ` ${styles["pf-badge-on"]}` : ""}`}
                        >
                          {storage.customized ? "自定义" : "默认"}
                        </span>
                      </span>
                      <span className={styles["srow-hint"]}>数据库 mosh.sqlite 所在文件夹。</span>
                    </div>
                    <div className={styles["store-actions"]}>
                      <span className={`${styles["store-path"]} ${styles.mono}`} title={storage.data_dir}>
                        {storage.data_dir}
                      </span>
                      <button
                        type="button"
                        className={styles["ai-btn"]}
                        onClick={() => {
                          if (inTauri) void openPath(storage.data_dir).catch(() => {});
                        }}
                      >
                        打开
                      </button>
                    </div>
                  </div>
                  <div className={styles.sdivider} />
                  <div className={styles.srow}>
                    <div className={styles["srow-label"]}>
                      <span className={styles["srow-name"]}>配置文件</span>
                      <span className={styles["srow-hint"]}>
                        编辑其中 data_dir 可自定义数据目录（支持 ~ 开头），修改后重启生效。
                      </span>
                    </div>
                    <div className={styles["store-actions"]}>
                      <span className={`${styles["store-path"]} ${styles.mono}`} title={storage.config_path}>
                        {storage.config_path}
                      </span>
                      <button
                        type="button"
                        className={styles["ai-btn"]}
                        onClick={() => {
                          if (inTauri) void openPath(storage.config_path).catch(() => {});
                        }}
                      >
                        打开
                      </button>
                    </div>
                  </div>
                  <div className={styles.sdivider} />
                </div>
              ) : null}

              {/* 软件更新：手动检查（启动后也会自动静默检查一次） */}
              <div className={styles.sgroup}>
                <div className={styles["update-row"]}>
                  <div>
                    <div className={styles["update-title"]}>软件更新</div>
                    <div className={styles["update-desc"]}>
                      检测 GitHub Release 新版本，确认后自动下载安装并重启。
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`${styles["ai-btn"]} ${styles.primary}`}
                    onClick={() => void onCheckUpdate()}
                    disabled={updaterPhase === "checking"}
                  >
                    {updaterPhase === "checking" ? "检查中…" : "检查更新"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
