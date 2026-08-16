import { useEffect, useState, type ComponentType } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
// 深路径引入单个图标（仅 12 家；barrel 的 ProviderIcon/ModelIcon 会拉全量 4MB+）。
import Anthropic from "@lobehub/icons/es/Anthropic";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Gemini from "@lobehub/icons/es/Gemini";
import Groq from "@lobehub/icons/es/Groq";
import Mistral from "@lobehub/icons/es/Mistral";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Ollama from "@lobehub/icons/es/Ollama";
import OpenAI from "@lobehub/icons/es/OpenAI";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Qwen from "@lobehub/icons/es/Qwen";
import XAI from "@lobehub/icons/es/XAI";
import Zhipu from "@lobehub/icons/es/Zhipu";
import { CITIES } from "../lib/cities";
import { McpPane, SkillsPane } from "./AgentToolsSettings";
import {
  deleteAiProvider,
  listAiModels,
  listAiProviders,
  saveAiProvider,
  testAiConnection,
} from "../lib/ipc";
import { WEATHER_ICONS, weatherInfo, type WeatherIcon } from "../lib/weather-code";
import type { AiConfig } from "../lib/types";
import { useAgentStore } from "../state/agent";
import { useAppStore, type SettingsSection } from "../state/store";
import { useUpdaterStore } from "../state/updater";
import { useWeatherStore } from "../state/weather";
import styles from "./SettingsView.module.css";

/**
 * 设置页：左 SectionNav（天气/AI 模型/关于）+ 右 ContentPanel。
 * AI 分区：提供商列表 + 配置表单（接口地址 → API Key → 模型列表 → 保存/测试）。
 */

type AgentToolsPane = "skills" | "mcp";

const inTauri = "__TAURI_INTERNALS__" in window;
const round = (n: number): number => Math.round(n);

/** 常用提供商名称 → 图标组件（lobe-icons 彩色版；未知 → undefined 用圆点兑底）。 */
type IconComp = ComponentType<{ size?: number }>;
const PROVIDER_ICON_RULES: [RegExp, IconComp][] = [
  [/deepseek/i, DeepSeek.Color as IconComp],
  // 无 Color 变体的用 mono 本尊（OpenAI/Groq 等品牌本身就是单色标志）。
  [/openai|gpt/i, OpenAI as IconComp],
  [/anthropic|claude/i, Anthropic as IconComp],
  [/gemini|google/i, Gemini.Color as IconComp],
  [/qwen|通义|alibaba|阿里/i, Qwen.Color as IconComp],
  [/kimi|moonshot/i, Moonshot as IconComp],
  [/zhipu|智谱|glm/i, Zhipu.Color as IconComp],
  [/ollama/i, Ollama as IconComp],
  [/openrouter/i, OpenRouter.Color as IconComp],
  [/groq/i, Groq as IconComp],
  [/mistral/i, Mistral.Color as IconComp],
  [/xai|grok/i, XAI as IconComp],
];

function providerIconOf(name: string): IconComp | undefined {
  for (const [re, Icon] of PROVIDER_ICON_RULES) {
    if (re.test(name)) return Icon;
  }
  return undefined;
}

/** 官方预置提供商（固定区）：名称/接口地址有默认值，仅需填 API Key。 */
interface BuiltinProvider {
  /** 列表项显示名（亦为存储名）。 */
  name: string;
  base_url: string;
  /** 预置默认模型（拉取列表失败/未拉取时的兑底）。 */
  defaultModel: string;
  icon: IconComp;
}

const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  {
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    icon: DeepSeek.Color as IconComp,
  },
];

function builtinOf(name: string): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.name === name);
}

function WeatherIcon({ name }: { name: WeatherIcon }) {
  return (
    <span className={styles["pv-ico"]} dangerouslySetInnerHTML={{ __html: WEATHER_ICONS[name] }} />
  );
}

/** 选择状态：固定预置 `builtin:名称` / 自定义 `custom:名称` / null=新增自定义。 */
type Selection = `builtin:${string}` | `custom:${string}` | null;

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
  const cityQuery = useWeatherStore((s) => s.cityQuery);
  const weatherError = useWeatherStore((s) => s.error);
  const loadWeather = useWeatherStore((s) => s.loadWeather);
  const selectCity = useWeatherStore((s) => s.selectCity);
  const refreshWeather = useWeatherStore((s) => s.refreshWeather);
  const info = weather ? weatherInfo(weather.weather_code) : null;

  // —— AI 模型配置（固定预置 + 自定义多提供商）——
  const [providers, setProviders] = useState<AiConfig[]>([]);
  /** 当前选中：{builtin:固定名} | {custom:自定义名} | null=新增自定义。 */
  const [selection, setSelection] = useState<Selection>("builtin:DeepSeek");
  const [aiName, setAiName] = useState("");
  const [aiBase, setAiBase] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiLoaded, setAiLoaded] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiFetchingModels, setAiFetchingModels] = useState(false);
  const [aiModels, setAiModels] = useState<string[]>([]);

  /** 当前选中的固定预置定义（未选中固定项时为 undefined）。 */
  const curBuiltin = (() => {
    if (!selection?.startsWith("builtin:")) return undefined;
    return builtinOf(selection.slice("builtin:".length));
  })();
  /** 固定预置的已保存配置（未配置过 = undefined）。 */
  const builtinCfg = curBuiltin
    ? providers.find((p) => p.name === curBuiltin.name)
    : undefined;
  /** 自定义提供商 = 已保存列表中不属于官方预置的。 */
  const customProviders = providers.filter(
    (p) => !BUILTIN_PROVIDERS.some((b) => b.name === p.name),
  );

  // —— AI 工具子菜单计数（技能启用数 / MCP 启用数）——
  const agentSkills = useAgentStore((s) => s.skills);
  const agentMcpServers = useAgentStore((s) => s.mcpServers);
  const activeSkillCount = agentSkills.filter((s) => s.active).length;
  const enabledMcpCount = agentMcpServers.filter((s) => s.enabled).length;

  // —— toast ——
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  function showToast(ok: boolean, text: string) {
    setToast({ ok, text });
  }

  /** 把固定预置载入表单：预置默认值 + 已保存的覆盖（地址/模型均可改）。 */
  async function loadBuiltin(b: BuiltinProvider, list: AiConfig[]) {
    const saved = list.find((p) => p.name === b.name);
    setAiName(b.name);
    // 地址/模型：优先已保存的（可能被改过），否则用官方默认。
    setAiBase(saved?.base_url || b.base_url);
    setAiKey(saved?.api_key ?? "");
    const model = saved?.model || b.defaultModel;
    setAiModel(model);
    // 模型列表：已保存模型置顶；其余异步拉取失败静默。
    setAiModels(model ? [model] : []);
    try {
      const fetched = await listAiModels(saved?.base_url || b.base_url, saved?.api_key ?? "");
      setAiModels(fetched.length > 0 ? fetched : model ? [model] : []);
    } catch {
      /* 未填 Key 或网络失败 → 只留默认模型 */
    }
  }

  /** 把自定义提供商载入表单。 */
  function loadCustom(cfg: AiConfig | undefined) {
    if (!cfg) {
      setAiName("");
      setAiBase("");
      setAiKey("");
      setAiModel("");
      setAiModels([]);
      return;
    }
    setAiName(cfg.name);
    setAiBase(cfg.base_url);
    setAiKey(cfg.api_key);
    setAiModel(cfg.model);
    setAiModels(cfg.model ? [cfg.model] : []);
  }

  async function loadAi() {
    let list: AiConfig[] = [];
    try {
      list = await listAiProviders();
    } catch {
      list = [];
    }
    setProviders(list);
    // 默认选中固定区第一项（DeepSeek）。
    setSelection("builtin:DeepSeek");
    await loadBuiltin(BUILTIN_PROVIDERS[0], list);
    setAiLoaded(true);
  }

  useEffect(() => {
    void loadWeather();
    void loadAbout();
    void loadAi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectBuiltin(name: string) {
    const b = builtinOf(name);
    if (!b) return;
    setSelection(`builtin:${name}`);
    await loadBuiltin(b, providers);
  }

  function selectCustom(name: string) {
    setSelection(`custom:${name}`);
    loadCustom(providers.find((p) => p.name === name));
  }

  function addProvider() {
    setSelection(null);
    loadCustom(undefined);
  }

  /** 保存：固定预置预填官方默认值（地址/模型可改）；自定义项全部必填。 */
  async function onSaveAi() {
    if (curBuiltin) {
      // 固定预置：仅校验 API Key；地址/模型用表单值（预填过默认，可改）。
      if (!aiKey.trim()) {
        showToast(false, "请先填写 API Key");
        return;
      }
      const base = aiBase.trim() || curBuiltin.base_url;
      const model = aiModel.trim() || curBuiltin.defaultModel;
      setAiSaving(true);
      try {
        await saveAiProvider({
          name: curBuiltin.name,
          base_url: base,
          api_key: aiKey.trim(),
          model,
        });
        showToast(true, `已保存 ${curBuiltin.name}`);
        await loadAi();
      } catch (e) {
        showToast(false, e instanceof Error ? e.message : String(e));
      } finally {
        setAiSaving(false);
      }
      return;
    }

    // 自定义（新增或编辑）：全部必填。
    if (!aiName.trim() || !aiBase.trim() || !aiKey.trim() || !aiModel.trim()) {
      showToast(false, "自定义提供商需完整填写：名称、接口地址、API Key 与模型");
      return;
    }
    setAiSaving(true);
    try {
      await saveAiProvider({
        name: aiName.trim(),
        base_url: aiBase.trim(),
        api_key: aiKey.trim(),
        model: aiModel.trim(),
      });
      showToast(true, "已保存");
      await loadAi();
      setSelection(`custom:${aiName.trim()}`);
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      setAiSaving(false);
    }
  }

  /** 删除：固定项删除后回到待配置态（列表中仍保留，图标不消失）；自定义项彻底移除。 */
  async function onDeleteAi() {
    const name = curBuiltin ? curBuiltin.name : (selection?.startsWith("custom:") ? selection.slice("custom:".length) : undefined);
    if (!name) return;
    setAiSaving(true);
    try {
      await deleteAiProvider(name);
      showToast(true, "已删除");
      await loadAi();
      if (curBuiltin) {
        // 固定项：留在该项，表单回到待配置态。
        await loadBuiltin(curBuiltin, []);
      } else {
        setSelection("builtin:DeepSeek");
        await loadBuiltin(BUILTIN_PROVIDERS[0], []);
      }
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      setAiSaving(false);
    }
  }

  async function onFetchModels() {
    // 统一用表单值（固定预置已预填官方地址，可改为中转）。
    const base = aiBase;
    if (!base.trim()) {
      showToast(false, "请先填写接口地址");
      return;
    }
    setAiFetchingModels(true);
    try {
      const models = await listAiModels(base, aiKey);
      setAiModels(models);
      if (models.length === 0) {
        showToast(false, "未获取到模型，请检查接口地址与 API Key");
      } else {
        if (!aiModel.trim() || !models.includes(aiModel)) setAiModel(models[0]);
        showToast(true, `已获取 ${models.length} 个模型`);
      }
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      setAiFetchingModels(false);
    }
  }

  async function onTestAi() {
    const base = aiBase;
    const model = aiModel.trim() || curBuiltin?.defaultModel || "";
    if (!base.trim()) {
      showToast(false, "请先填写接口地址");
      return;
    }
    if (curBuiltin && !aiKey.trim()) {
      showToast(false, "请先填写 API Key");
      return;
    }
    if (!model.trim()) {
      showToast(false, "请先选择模型");
      return;
    }
    setAiTesting(true);
    try {
      const reply = await testAiConnection(base, aiKey, model);
      showToast(true, `连接成功：${model}${reply ? ` · ${reply}` : ""}`);
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      setAiTesting(false);
    }
  }

  // —— 关于 ——
  const [appName, setAppName] = useState("MOSH");
  const [appVersion, setAppVersion] = useState("");
  const [tauriVersion, setTauriVersion] = useState("");
  const [platform, setPlatform] = useState("");
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
    try {
      const [n, v, t] = await Promise.all([getName(), getVersion(), getTauriVersion()]);
      setAppName(n);
      setAppVersion(v);
      setTauriVersion(t);
    } catch {
      setAppVersion(__APP_VERSION__);
    }
  }

  // 手动检查更新：结果仅 toast 反馈（有新版本时另弹右下角 UpdaterToast）。
  async function onCheckUpdate() {
    await useUpdaterStore.getState().check();
    const { phase, info } = useUpdaterStore.getState();
    if (phase === "upToDate") showToast(true, "已是最新版本 ✨");
    else if (phase === "error") showToast(false, "检查更新失败，请稍后重试");
    else if (phase === "available" && info)
      showToast(true, `发现新版本 v${info.version}，可在右下角通知中更新`);
  }

  // 当前表单名称对应的提供商图标（输入 DeepSeek 即时亮起）；模型列表同用。
  const AiNameIcon = providerIconOf(aiName);

  return (
    <section
      className={`${styles.settings}${activeSection === "ai" || activeSection === "aitools" ? ` ${styles[activeSection]}` : ""}`}
    >
      <nav className={styles["section-nav"]}>
        <div className={styles["nav-header"]}>设置</div>

        <div className={styles["nav-group"]}>
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
          <div className={styles["pl-label"]}>官方预置</div>
          <div className={styles["pl-items"]}>
            {BUILTIN_PROVIDERS.map((b) => {
              const configured = providers.some((p) => p.name === b.name);
              const active = selection === `builtin:${b.name}`;
              return (
                <button
                  key={b.name}
                  type="button"
                  className={`${styles["pl-item"]}${active ? ` ${styles.active}` : ""}`}
                  onClick={() => void selectBuiltin(b.name)}
                >
                  <span className={styles["pl-icon"]}>
                    <b.icon size={18} />
                  </span>
                  <span className={styles["pl-name"]}>{b.name}</span>
                  {configured ? (
                    <span className={styles["pl-done"]} title="已配置">✓</span>
                  ) : (
                    <span className={styles["pl-pending"]}>待配置</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className={styles["pl-label"]}>
            自定义
            <span className={styles["pl-label-sub"]}>任意 OpenAI 兼容端点</span>
          </div>
          <div className={styles["pl-items"]}>
            {customProviders.map((p) => {
              const Icon = providerIconOf(p.name);
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`${styles["pl-item"]}${selection === `custom:${p.name}` ? ` ${styles.active}` : ""}`}
                  onClick={() => selectCustom(p.name)}
                >
                  {Icon ? (
                    <span className={styles["pl-icon"]}>
                      <Icon size={18} />
                    </span>
                  ) : (
                    <span className={styles["pl-dot"]} />
                  )}
                  <span className={styles["pl-name"]}>{p.name}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={`${styles["pl-add"]}${selection === null ? ` ${styles.active}` : ""}`}
              onClick={addProvider}
              title="添加自定义 OpenAI 兼容提供商"
            >
              <span className={styles["pl-add-ico"]}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <span className={styles["pl-name"]}>添加自定义提供商</span>
            </button>
            {customProviders.length === 0 && selection === null ? (
              <div className={styles["pl-empty"]}>新提供商需完整填写名称、地址、Key 与模型</div>
            ) : null}
          </div>
        </aside>
      ) : null}

      <div className={styles["content-panel"]}>
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
                    <span className={styles["srow-hint"]}>用于首页天气展示。坐标首次取数时解析并复用。</span>
                  </div>
                  <select
                    className={styles["srow-select"]}
                    value={cityQuery}
                    onChange={(e) => {
                      const q = e.currentTarget.value;
                      if (q) void selectCity(q);
                    }}
                  >
                    <option value="">选择城市…</option>
                    {CITIES.map((c) => (
                      <option key={c.query} value={c.query}>{c.name}</option>
                    ))}
                  </select>
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
                <div className={styles["content-desc"]}>配置模型提供商，支持任意 OpenAI 兼容接口。</div>
              </div>

              <div className={styles.sgroup}>
                {curBuiltin ? (
                  /* —— 固定预置：预填官方默认值，地址/模型/Key 均可修改（如走中转）—— */
                  <>
                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>
                          <span className={styles["pl-icon"]}>
                            <curBuiltin.icon size={18} />
                          </span>
                          {curBuiltin.name}
                        </span>
                        <span className={styles["srow-hint"]}>
                          官方预置已填默认值；接口地址、模型与 Key 均可按需修改（如兼容中转）
                          {builtinCfg ? " · 已配置" : " · 待配置"}
                        </span>
                      </div>
                    </div>

                    <div className={styles.sdivider} />

                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>API Key *</span>
                        <span className={styles["srow-hint"]}>
                          前往 platform.deepseek.com 创建；仅存本地数据库
                        </span>
                      </div>
                      <input
                        className={styles["srow-input"]}
                        type="password"
                        value={aiKey}
                        onChange={(e) => setAiKey(e.target.value)}
                        placeholder={builtinCfg?.api_key ? "已保存（可覆盖）" : "sk-…"}
                        autoComplete="off"
                      />
                    </div>

                    <div className={styles.sdivider} />

                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>接口地址</span>
                        <span className={styles["srow-hint"]}>
                          预填官方地址，可改为兼容中转端点
                        </span>
                      </div>
                      <input
                        className={styles["srow-input"]}
                        value={aiBase}
                        onChange={(e) => setAiBase(e.target.value)}
                        placeholder={curBuiltin.base_url}
                      />
                    </div>

                    <div className={styles.sdivider} />

                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>模型</span>
                        <span className={styles["srow-hint"]}>
                          预填默认模型，可拉取列表选择或手动填写
                        </span>
                      </div>
                      <div className={styles["srow-control"]}>
                        <input
                          className={styles["srow-input"]}
                          value={aiModel}
                          onChange={(e) => setAiModel(e.target.value)}
                          placeholder={curBuiltin.defaultModel}
                        />
                        <button
                          type="button"
                          className={styles["fetch-btn"]}
                          onClick={() => void onFetchModels()}
                          disabled={aiFetchingModels || !aiBase.trim()}
                          title={!aiBase.trim() ? "先填写接口地址" : undefined}
                        >
                          {aiFetchingModels ? "获取中…" : "获取模型列表"}
                        </button>
                      </div>
                    </div>

                    {aiModels.length > 0 ? (
                      <div className={styles["model-list"]}>
                        {aiModels.map((m) => (
                          <button
                            key={m}
                            type="button"
                            className={`${styles["model-item"]}${aiModel === m ? ` ${styles.active}` : ""}`}
                            onClick={() => setAiModel(m)}
                          >
                            <span className={styles["pl-icon"]}>
                              <curBuiltin.icon size={16} />
                            </span>
                            <span className={styles["model-item-name"]}>{m}</span>
                            {aiModel === m ? <span className={styles["model-check"]}>✓</span> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  /* —— 自定义提供商：名称/地址/Key/模型全部必填 —— */
                  <>
                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>提供商名称 *</span>
                        <span className={styles["srow-hint"]}>
                          自定义显示名，如「我的中转」；命中已知品牌会显示对应图标
                        </span>
                      </div>
                      <div className={styles["srow-control"]}>
                        {AiNameIcon ? (
                          <span className={styles["pl-icon"]}>
                            <AiNameIcon size={18} />
                          </span>
                        ) : null}
                        <input
                          className={styles["srow-input"]}
                          value={aiName}
                          onChange={(e) => setAiName(e.target.value)}
                          placeholder="My Provider"
                        />
                      </div>
                    </div>

                    <div className={styles.sdivider} />

                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>接口地址 *</span>
                        <span className={styles["srow-hint"]}>
                          OpenAI 兼容端点，如 https://api.example.com/v1
                        </span>
                      </div>
                      <input
                        className={styles["srow-input"]}
                        value={aiBase}
                        onChange={(e) => setAiBase(e.target.value)}
                        placeholder="https://api.example.com/v1"
                      />
                    </div>

                    <div className={styles.sdivider} />

                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>API Key *</span>
                        <span className={styles["srow-hint"]}>仅存本地数据库，不上传；密文显示</span>
                      </div>
                      <input
                        className={styles["srow-input"]}
                        type="password"
                        value={aiKey}
                        onChange={(e) => setAiKey(e.target.value)}
                        placeholder="sk-…"
                        autoComplete="off"
                      />
                    </div>

                    <div className={styles.sdivider} />

                    <div className={styles.srow}>
                      <div className={styles["srow-label"]}>
                        <span className={styles["srow-name"]}>模型 *</span>
                        <span className={styles["srow-hint"]}>
                          拉取列表后选择，或手动填入模型 id
                        </span>
                      </div>
                      <div className={styles["srow-control"]}>
                        {aiModels.length > 0 ? (
                          <select
                            className={styles["srow-select"]}
                            value={aiModels.includes(aiModel) ? aiModel : ""}
                            onChange={(e) => setAiModel(e.target.value)}
                          >
                            <option value="" disabled>
                              选择模型…
                            </option>
                            {aiModels.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            className={styles["fetch-btn"]}
                            onClick={() => void onFetchModels()}
                            disabled={aiFetchingModels}
                          >
                            {aiFetchingModels ? "获取中…" : "获取模型列表"}
                          </button>
                        )}
                      </div>
                    </div>
                    {aiModel && !aiModels.includes(aiModel) ? (
                      <div className={styles["model-current"]}>当前：{aiModel}</div>
                    ) : null}
                  </>
                )}

                <div className={styles.sdivider} />

                  <div className={styles["ai-actions"]}>
                    {/* 删除：固定项仅已配置时显示（删后回到待配置态，条目仍在）；自定义项已选中时显示。 */}
                    {(curBuiltin && builtinCfg) || selection?.startsWith("custom:") ? (
                      <button
                        type="button"
                        className={`${styles["ai-btn"]} ${styles.danger}`}
                        onClick={() => void onDeleteAi()}
                        disabled={aiSaving}
                      >
                        {curBuiltin ? "清除配置" : "删除"}
                      </button>
                    ) : null}
                    <button type="button" className={styles["ai-btn"]} onClick={() => void onSaveAi()} disabled={aiSaving || !aiLoaded}>
                      {aiSaving ? "保存中…" : "保存"}
                    </button>
                    <button type="button" className={`${styles["ai-btn"]} ${styles.primary}`} onClick={() => void onTestAi()} disabled={aiTesting || !aiLoaded}>
                      {aiTesting ? "测试中…" : "测试连接"}
                    </button>
                  </div>
                </div>
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

      {toast ? (
        <div
          className={`${styles.toast}${toast.ok ? ` ${styles.ok}` : ` ${styles.fail}`}`}
          role="status"
        >
          <span className={styles["toast-ico"]}>{toast.ok ? "✓" : "!"}</span>
          <span className={styles["toast-text"]}>{toast.text}</span>
        </div>
      ) : null}
    </section>
  );
}
