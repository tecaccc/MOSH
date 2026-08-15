import { useEffect, useState } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { CITIES } from "../lib/cities";
import {
  deleteAiProvider,
  listAiModels,
  listAiProviders,
  saveAiProvider,
  testAiConnection,
} from "../lib/ipc";
import { WEATHER_ICONS, weatherInfo, type WeatherIcon } from "../lib/weather-code";
import type { AiConfig } from "../lib/types";
import { useWeatherStore } from "../state/weather";
import styles from "./SettingsView.module.css";

/**
 * 设置页：左 SectionNav（天气/AI 模型/关于）+ 右 ContentPanel。
 * AI 分区：提供商列表 + 配置表单（接口地址 → API Key → 模型列表 → 保存/测试）。
 */

type SettingsSection = "weather" | "ai" | "about";

const inTauri = "__TAURI_INTERNALS__" in window;
const round = (n: number): number => Math.round(n);

function WeatherIcon({ name }: { name: WeatherIcon }) {
  return (
    <span className={styles["pv-ico"]} dangerouslySetInnerHTML={{ __html: WEATHER_ICONS[name] }} />
  );
}

export default function SettingsView() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("weather");

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

  // —— AI 模型配置（多提供商）——
  const [providers, setProviders] = useState<AiConfig[]>([]);
  const [activeName, setActiveName] = useState("");
  const [aiName, setAiName] = useState("");
  const [aiBase, setAiBase] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiLoaded, setAiLoaded] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiFetchingModels, setAiFetchingModels] = useState(false);
  const [aiModels, setAiModels] = useState<string[]>([]);

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

  /** 把某提供商配置载入表单（含模型列表拉取）。 */
  async function loadProvider(cfg: AiConfig | undefined) {
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
    setAiModels([]);
    if (cfg.base_url.trim()) {
      try {
        const models = await listAiModels(cfg.base_url, cfg.api_key);
        setAiModels(models.length === 0 && cfg.model.trim() ? [cfg.model] : models);
      } catch {
        /* 拉取失败静默 */
      }
    }
  }

  async function loadAi() {
    let list: AiConfig[] = [];
    try {
      list = await listAiProviders();
    } catch {
      list = [];
    }
    setProviders(list);
    const first = list[0];
    setActiveName(first?.name ?? "");
    await loadProvider(first);
    setAiLoaded(true);
  }

  useEffect(() => {
    void loadWeather();
    void loadAbout();
    void loadAi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectProvider(name: string) {
    setActiveName(name);
    await loadProvider(providers.find((p) => p.name === name));
  }

  function addProvider() {
    setActiveName("");
    void loadProvider(undefined);
  }

  async function onSaveAi() {
    if (!aiName.trim()) {
      showToast(false, "请先填写提供商名称");
      return;
    }
    setAiSaving(true);
    try {
      await saveAiProvider({ name: aiName.trim(), base_url: aiBase, api_key: aiKey, model: aiModel });
      showToast(true, "已保存");
      await loadAi();
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      setAiSaving(false);
    }
  }

  async function onDeleteAi() {
    if (!activeName) return;
    setAiSaving(true);
    try {
      await deleteAiProvider(activeName);
      showToast(true, "已删除");
      await loadAi();
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      setAiSaving(false);
    }
  }

  async function onFetchModels() {
    if (!aiBase.trim()) {
      showToast(false, "请先填写接口地址");
      return;
    }
    setAiFetchingModels(true);
    try {
      const models = await listAiModels(aiBase, aiKey);
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
    if (!aiBase.trim()) {
      showToast(false, "请先填写接口地址");
      return;
    }
    if (!aiModel.trim()) {
      showToast(false, "请先在模型列表中选择一个模型");
      return;
    }
    setAiTesting(true);
    try {
      const reply = await testAiConnection(aiBase, aiKey, aiModel);
      showToast(true, `连接成功：${aiModel}${reply ? ` · ${reply}` : ""}`);
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

  return (
    <section className={styles.settings}>
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
            <div className={`${styles["content-body"]} ${styles["ai-body"]}`}>
              <div className={styles["content-header"]}>
                <div className={styles["content-title"]}>AI 模型</div>
                <div className={styles["content-desc"]}>配置模型提供商，支持任意 OpenAI 兼容接口。</div>
              </div>

              <div className={styles["ai-layout"]}>
                <aside className={styles["provider-list"]}>
                  <div className={styles["pl-label"]}>模型提供商</div>
                  <div className={styles["pl-items"]}>
                    {providers.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        className={`${styles["pl-item"]}${p.name === activeName ? ` ${styles.active}` : ""}`}
                        onClick={() => void selectProvider(p.name)}
                      >
                        <span className={styles["pl-dot"]} />
                        <span className={styles["pl-name"]}>{p.name}</span>
                      </button>
                    ))}
                    {providers.length === 0 ? (
                      <div className={styles["pl-empty"]}>暂无提供商</div>
                    ) : null}
                  </div>
                  <button type="button" className={styles["pl-add"]} onClick={addProvider}>+ 添加提供商</button>
                </aside>

                <div className={`${styles.sgroup} ${styles["provider-config"]}`}>
                  <div className={styles.srow}>
                    <div className={styles["srow-label"]}>
                      <span className={styles["srow-name"]}>提供商名称</span>
                      <span className={styles["srow-hint"]}>显示在左侧列表中的名称，如 DeepSeek</span>
                    </div>
                    <input className={styles["srow-input"]} value={aiName} onChange={(e) => setAiName(e.target.value)} placeholder="DeepSeek" />
                  </div>

                  <div className={styles.sdivider} />

                  <div className={styles.srow}>
                    <div className={styles["srow-label"]}>
                      <span className={styles["srow-name"]}>接口地址</span>
                      <span className={styles["srow-hint"]}>OpenAI 兼容端点，如 https://api.deepseek.com/v1</span>
                    </div>
                    <input className={styles["srow-input"]} value={aiBase} onChange={(e) => setAiBase(e.target.value)} placeholder="https://api.deepseek.com/v1" />
                  </div>

                  <div className={styles.sdivider} />

                  <div className={styles.srow}>
                    <div className={styles["srow-label"]}>
                      <span className={styles["srow-name"]}>API Key</span>
                      <span className={styles["srow-hint"]}>仅存本地数据库，不上传；密文显示</span>
                    </div>
                    <input className={styles["srow-input"]} type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
                  </div>

                  <div className={styles.sdivider} />

                  <div className={styles.srow}>
                    <div className={styles["srow-label"]}>
                      <span className={styles["srow-name"]}>模型</span>
                      <span className={styles["srow-hint"]}>点击「获取模型列表」自动拉取，再选择默认模型</span>
                    </div>
                    <button
                      type="button"
                      className={styles["fetch-btn"]}
                      onClick={() => void onFetchModels()}
                      disabled={aiFetchingModels}
                    >
                      {aiFetchingModels ? "获取中…" : "获取模型列表"}
                    </button>
                  </div>

                  <div className={styles.sdivider} />

                  {aiModels.length > 0 ? (
                    <div className={styles["model-list"]}>
                      {aiModels.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`${styles["model-item"]}${aiModel === m ? ` ${styles.active}` : ""}`}
                          onClick={() => setAiModel(m)}
                        >
                          <span className={styles["model-dot"]} />
                          <span className={styles["model-item-name"]}>{m}</span>
                          {aiModel === m ? <span className={styles["model-check"]}>✓</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className={styles["model-empty"]}>
                      尚未获取模型列表。点击「获取模型列表」自动拉取当前接口支持的模型。
                    </div>
                  )}

                  <div className={styles.sdivider} />

                  <div className={styles["ai-actions"]}>
                    {activeName ? (
                      <button
                        type="button"
                        className={`${styles["ai-btn"]} ${styles.danger}`}
                        onClick={() => void onDeleteAi()}
                        disabled={aiSaving}
                      >
                        删除
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
