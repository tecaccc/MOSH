<script lang="ts">
  /**
   * 设置页：参考 Cherry Studio 左导航 + 右内容分栏布局。
   *
   * 左侧 SectionNav（180px）：天气 / AI 模型 / 关于，高亮当前分区。
   * 右侧 ContentPanel（flex-1）：滚动区，max-width 居中；内容按 SettingGroup /
   * SettingRow / SettingDivider 模式组织（借鉴 Cherry Studio SettingsPrimitives）。
   *
   * AI 模型分区：
   *   - 「模型提供商」可折叠区：接口地址 → API Key → 模型（+ 获取模型列表）
   *   - 保存 / 测试连接：测试时弹窗选择模型，结果以底部 toast 通知。
   */
  import { onMount } from "svelte";
  import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
  import { CITIES } from "../cities";
  import { deleteAiProvider, listAiModels, listAiProviders, saveAiProvider, testAiConnection } from "../ipc";
  import { weatherInfo, WEATHER_ICONS } from "../weather-code";
  import type { AiConfig } from "../types";
  import {
    cityName,
    cityQuery,
    loadWeather,
    refreshWeather,
    selectCity,
    weather,
    weatherError,
    weatherStatus,
  } from "../weather.svelte";

  type SettingsSection = "weather" | "ai" | "about";

  let activeSection = $state<SettingsSection>("weather");

  function activate(sec: SettingsSection): void {
    activeSection = sec;
  }

  onMount(() => {
    void loadWeather();
    void loadAbout();
    void loadAi();
  });

  // —— 天气 ——
  async function onSelect(e: Event): Promise<void> {
    const q = (e.currentTarget as HTMLSelectElement).value;
    if (!q) return;
    await selectCity(q);
  }

  const info = $derived(weather() ? weatherInfo(weather()!.weather_code) : null);
  const round = (n: number): number => Math.round(n);

  // —— AI 模型配置（任务 08-15-agent-v1；多提供商）——
  let providers = $state<AiConfig[]>([]);
  let activeName = $state("");
  let aiName = $state("");
  let aiBase = $state("");
  let aiKey = $state("");
  let aiModel = $state("");
  let aiLoaded = $state(false);
  let aiSaving = $state(false);
  let aiTesting = $state(false);
  let aiFetchingModels = $state(false);
  let aiModels = $state<string[]>([]);

  // —— toast（底部弹出式通知）——
  let toast = $state<{ ok: boolean; text: string } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showToast(ok: boolean, text: string): void {
    toast = { ok, text };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
    }, 3500);
  }

  /** 把某提供商配置载入表单（含模型列表拉取）。 */
  async function loadProvider(cfg: AiConfig | undefined): Promise<void> {
    if (!cfg) {
      aiName = "";
      aiBase = "";
      aiKey = "";
      aiModel = "";
      aiModels = [];
      return;
    }
    aiName = cfg.name;
    aiBase = cfg.base_url;
    aiKey = cfg.api_key;
    aiModel = cfg.model;
    aiModels = [];
    if (cfg.base_url.trim()) {
      try {
        aiModels = await listAiModels(cfg.base_url, cfg.api_key);
        if (aiModels.length === 0 && cfg.model.trim()) aiModels = [cfg.model];
      } catch {
        /* 拉取失败静默 */
      }
    }
  }

  async function loadAi(): Promise<void> {
    try {
      providers = await listAiProviders();
    } catch {
      providers = [];
    }
    const first = providers[0];
    activeName = first?.name ?? "";
    await loadProvider(first);
    aiLoaded = true;
  }

  /** 点左侧提供商名称 → 载入其配置。 */
  async function selectProvider(name: string): Promise<void> {
    const cfg = providers.find((p) => p.name === name);
    activeName = name;
    await loadProvider(cfg);
  }

  /** 新增提供商：清空表单。 */
  function addProvider(): void {
    activeName = "";
    void loadProvider(undefined);
  }

  async function onSaveAi(): Promise<void> {
    if (!aiName.trim()) {
      showToast(false, "请先填写提供商名称");
      return;
    }
    aiSaving = true;
    try {
      await saveAiProvider({ name: aiName.trim(), base_url: aiBase, api_key: aiKey, model: aiModel });
      showToast(true, "已保存");
      await loadAi();
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      aiSaving = false;
    }
  }

  async function onDeleteAi(): Promise<void> {
    if (!activeName) return;
    aiSaving = true;
    try {
      await deleteAiProvider(activeName);
      showToast(true, "已删除");
      await loadAi();
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      aiSaving = false;
    }
  }

  /** 获取模型列表：用当前表单的 base_url / api_key 直接请求 /models。 */
  async function onFetchModels(): Promise<void> {
    if (!aiBase.trim()) {
      showToast(false, "请先填写接口地址");
      return;
    }
    aiFetchingModels = true;
    try {
      aiModels = await listAiModels(aiBase, aiKey);
      if (aiModels.length === 0) {
        showToast(false, "未获取到模型，请检查接口地址与 API Key");
      } else {
        if (!aiModel.trim() || !aiModels.includes(aiModel)) aiModel = aiModels[0];
        showToast(true, `已获取 ${aiModels.length} 个模型`);
      }
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      aiFetchingModels = false;
    }
  }

  /** 测试连接：直接用模型列表里选中的模型，不再弹窗。 */
  async function onTestAi(): Promise<void> {
    if (!aiBase.trim()) {
      showToast(false, "请先填写接口地址");
      return;
    }
    if (!aiModel.trim()) {
      showToast(false, "请先在模型列表中选择一个模型");
      return;
    }
    aiTesting = true;
    try {
      const reply = await testAiConnection(aiBase, aiKey, aiModel);
      showToast(true, `连接成功：${aiModel}${reply ? ` · ${reply}` : ""}`);
    } catch (e) {
      showToast(false, e instanceof Error ? e.message : String(e));
    } finally {
      aiTesting = false;
    }
  }

  // —— 关于 ——
  const inTauri = "__TAURI_INTERNALS__" in window;
  let appName = $state("MOSH");
  let appVersion = $state("");
  let tauriVersion = $state("");
  let platform = $state("");

  async function loadAbout(): Promise<void> {
    platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ??
      navigator.platform ??
      "";
    if (!inTauri) {
      appVersion = __APP_VERSION__;
      return;
    }
    try {
      [appName, appVersion, tauriVersion] = await Promise.all([
        getName(),
        getVersion(),
        getTauriVersion(),
      ]);
    } catch {
      appVersion = __APP_VERSION__;
    }
  }
</script>

<section class="settings">
  <!-- 左侧分区导航（参考 Cherry Studio SettingsPage 左栏） -->
  <nav class="section-nav">
    <div class="nav-header">设置</div>

    <div class="nav-group">
      <button
        type="button"
        class="nav-item"
        class:active={activeSection === "weather"}
        onclick={() => activate("weather")}
      >
        <span class="nav-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
            <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </svg>
        </span>
        <span class="nav-label">天气</span>
      </button>

      <button
        type="button"
        class="nav-item"
        class:active={activeSection === "ai"}
        onclick={() => activate("ai")}
      >
        <span class="nav-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
            <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
          </svg>
        </span>
        <span class="nav-label">AI 模型</span>
      </button>

      <button
        type="button"
        class="nav-item"
        class:active={activeSection === "about"}
        onclick={() => activate("about")}
      >
        <span class="nav-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        <span class="nav-label">关于</span>
      </button>
    </div>

    <div class="nav-spacer"></div>

    <div class="nav-footer">
      <span class="nav-version">v{appVersion || "…"}</span>
    </div>
  </nav>

  <!-- 右侧内容区（参考 Cherry Studio SettingsContentColumn） -->
  <div class="content-panel">
    <!-- ===== 天气 ===== -->
    {#if activeSection === "weather"}
      <div class="content-scroll">
        <div class="content-body">
          <div class="content-header">
            <div class="content-title">天气</div>
            <div class="content-desc">配置天气展示城市，数据来自 Open-Meteo。</div>
          </div>

          <div class="sgroup">
            <div class="stitle">城市选择</div>
            <div class="sdivider"></div>
            <div class="srow">
              <div class="srow-label">
                <span class="srow-name">城市</span>
                <span class="srow-hint">用于首页天气展示。坐标首次取数时解析并复用。</span>
              </div>
              <select class="srow-select" value={cityQuery()} onchange={onSelect}>
                <option value="">选择城市…</option>
                {#each CITIES as c (c.query)}
                  <option value={c.query}>{c.name}</option>
                {/each}
              </select>
            </div>
            <div class="sdivider"></div>

            {#if weatherStatus() === "loading"}
              <div class="preview dim">加载中…</div>
            {:else if weatherStatus() === "ok" && weather() && info}
              <div class="preview">
                <span class="pv-ico">{@html WEATHER_ICONS[info.icon]}</span>
                <span class="pv-text">
                  {cityName()} · {round(weather()!.temperature)}° {info.label}
                  · 体感 {round(weather()!.apparent_temperature)}°
                  · 湿度 {round(weather()!.humidity)}%
                </span>
              </div>
            {:else if weatherStatus() === "error"}
              <div class="preview error">
                <span class="pv-text">获取失败：{weatherError()}</span>
                <button type="button" class="retry" onclick={() => void refreshWeather()}>
                  重试
                </button>
              </div>
            {:else}
              <div class="preview dim">未选择城市。</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- ===== AI 模型 ===== -->
    {#if activeSection === "ai"}
      <div class="content-scroll">
        <div class="content-body ai-body">
          <div class="content-header">
            <div class="content-title">AI 模型</div>
            <div class="content-desc">配置模型提供商，支持任意 OpenAI 兼容接口。</div>
          </div>

          <div class="ai-layout">
            <!-- 左侧：提供商列表 -->
            <aside class="provider-list">
              <div class="pl-label">模型提供商</div>
              <div class="pl-items">
                {#each providers as p (p.name)}
                  <button
                    type="button"
                    class="pl-item"
                    class:active={p.name === activeName}
                    onclick={() => void selectProvider(p.name)}
                  >
                    <span class="pl-dot"></span>
                    <span class="pl-name">{p.name}</span>
                  </button>
                {/each}
                {#if providers.length === 0}
                  <div class="pl-empty">暂无提供商</div>
                {/if}
              </div>
              <button type="button" class="pl-add" onclick={addProvider}>+ 添加提供商</button>
            </aside>

            <!-- 右侧：提供商配置 -->
            <div class="sgroup provider-config">
              <div class="srow">
                <div class="srow-label">
                  <span class="srow-name">提供商名称</span>
                  <span class="srow-hint">显示在左侧列表中的名称，如 DeepSeek</span>
                </div>
                <input class="srow-input" bind:value={aiName} placeholder="DeepSeek" />
              </div>

              <div class="sdivider"></div>

              <div class="srow">
                <div class="srow-label">
                  <span class="srow-name">接口地址</span>
                  <span class="srow-hint">OpenAI 兼容端点，如 https://api.deepseek.com/v1</span>
                </div>
                <input class="srow-input" bind:value={aiBase} placeholder="https://api.deepseek.com/v1" />
              </div>

              <div class="sdivider"></div>

              <div class="srow">
                <div class="srow-label">
                  <span class="srow-name">API Key</span>
                  <span class="srow-hint">仅存本地数据库，不上传；密文显示</span>
                </div>
                <input class="srow-input" type="password" bind:value={aiKey} placeholder="sk-…" autocomplete="off" />
              </div>

              <div class="sdivider"></div>

              <div class="srow">
                <div class="srow-label">
                  <span class="srow-name">模型</span>
                  <span class="srow-hint">点击「获取模型列表」自动拉取，再选择默认模型</span>
                </div>
                <button
                  type="button"
                  class="fetch-btn"
                  onclick={() => void onFetchModels()}
                  disabled={aiFetchingModels}
                >
                  {aiFetchingModels ? "获取中…" : "获取模型列表"}
                </button>
              </div>

              <div class="sdivider"></div>

              {#if aiModels.length > 0}
                <div class="model-list">
                  {#each aiModels as m (m)}
                    <button
                      type="button"
                      class="model-item"
                      class:active={aiModel === m}
                      onclick={() => (aiModel = m)}
                    >
                      <span class="model-dot"></span>
                      <span class="model-item-name">{m}</span>
                      {#if aiModel === m}<span class="model-check">✓</span>{/if}
                    </button>
                  {/each}
                </div>
              {:else}
                <div class="model-empty">
                  尚未获取模型列表。点击「获取模型列表」自动拉取当前接口支持的模型。
                </div>
              {/if}

              <div class="sdivider"></div>

              <div class="ai-actions">
                {#if activeName}
                  <button
                    type="button"
                    class="ai-btn danger"
                    onclick={() => void onDeleteAi()}
                    disabled={aiSaving}
                  >删除</button>
                {/if}
                <button type="button" class="ai-btn" onclick={() => void onSaveAi()} disabled={aiSaving || !aiLoaded}>
                  {aiSaving ? "保存中…" : "保存"}
                </button>
                <button type="button" class="ai-btn primary" onclick={() => void onTestAi()} disabled={aiTesting || !aiLoaded}>
                  {aiTesting ? "测试中…" : "测试连接"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- ===== 关于 ===== -->
    {#if activeSection === "about"}
      <div class="content-scroll">
        <div class="content-body">
          <div class="content-header">
            <div class="content-title">关于</div>
            <div class="content-desc">应用版本与运行环境信息。</div>
          </div>

          <div class="sgroup">
            <div class="about-brand">
              <span class="about-mark">M</span>
              <div class="about-brand-text">
                <span class="about-name">{appName}</span>
                <span class="about-slogan">本地优先个人信息管理 · 待办与日程</span>
              </div>
              <span class="about-ver">v{appVersion || "…"}</span>
            </div>
          </div>

          <div class="sgroup">
            <div class="about-grid">
              <div class="about-item">
                <span class="about-k">版本</span>
                <span class="about-v">{appVersion || "—"}</span>
              </div>
              <div class="about-item">
                <span class="about-k">应用标识</span>
                <span class="about-v mono">com.mosh.app</span>
              </div>
              <div class="about-item">
                <span class="about-k">Tauri 框架</span>
                <span class="about-v">{tauriVersion || "—"}</span>
              </div>
              <div class="about-item">
                <span class="about-k">运行平台</span>
                <span class="about-v">{platform || "—"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</section>

<!-- 底部弹出式通知 -->
{#if toast}
  <div class="toast" class:ok={toast.ok} class:fail={!toast.ok} role="status">
    <span class="toast-ico">{toast.ok ? "✓" : "!"}</span>
    <span class="toast-text">{toast.text}</span>
  </div>
{/if}

<style>
  /**
   * 设置页布局（参考 Cherry Studio SettingsPage）：
   *   左 SectionNav 180px + 右 ContentPanel flex-1。
   *   内容区遵循 SettingGroup / SettingRow / SettingDivider 三层结构。
   */
  .settings {
    display: grid;
    grid-template-columns: 180px 1fr;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }

  /* ====== 左侧分区导航 ====== */
  .section-nav {
    border-right: 1px solid var(--border-soft);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 20px 10px 12px;
  }

  .nav-header {
    font-size: 15px;
    font-weight: 700;
    color: var(--text);
    padding: 0 8px;
    margin-bottom: 16px;
  }

  .nav-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 8px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    transition: background 0.12s, color 0.12s;
  }

  .nav-item:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .nav-item.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
  }

  .nav-ico {
    display: flex;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .nav-spacer {
    flex: 1;
  }

  .nav-footer {
    padding: 8px;
  }

  .nav-version {
    font-size: 11px;
    color: var(--text-muted);
  }

  /* ====== 右侧内容区 ====== */
  .content-panel {
    min-height: 0;
    overflow: hidden;
  }

  .content-scroll {
    height: 100%;
    overflow-y: auto;
    padding: 32px 40px 48px;
  }

  .content-body {
    max-width: 760px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  /* AI 模型分区：更宽的居中两栏布局（提供商列表 + 配置）。 */
  .content-body.ai-body {
    max-width: 880px;
  }

  .content-header {
    margin-bottom: 8px;
  }

  .content-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--text);
  }

  .content-desc {
    margin-top: 5px;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* ====== SettingGroup ====== */
  .sgroup {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    padding: 18px 24px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .stitle {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    padding: 2px 0;
  }

  .sdivider {
    height: 1px;
    background: var(--border-soft);
    margin: 14px 0;
  }

  /* ====== SettingRow ====== */
  .srow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }

  .srow-label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .srow-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .srow-hint {
    font-size: 12px;
    color: var(--text-muted);
  }

  .srow-select {
    min-width: 180px;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .srow-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .srow-input {
    min-width: 280px;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    flex-shrink: 0;
  }

  .srow-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* ====== 提供商两栏布局 ====== */
  .ai-layout {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 20px;
    align-items: start;
  }

  .provider-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    padding: 14px 10px;
  }

  .pl-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    padding: 0 6px;
  }

  .pl-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .pl-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }

  .pl-item:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .pl-item.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .pl-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .pl-item.active .pl-dot {
    background: var(--accent);
  }

  .pl-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pl-empty {
    font-size: 12px;
    color: var(--text-muted);
    padding: 6px 8px;
  }

  .pl-add {
    border: 1px dashed var(--border);
    background: transparent;
    color: var(--text-dim);
    border-radius: var(--radius-md);
    padding: 7px 0;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .pl-add:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .provider-config {
    min-width: 0;
  }

  /* ====== 模型列表 ====== */
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .model-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border: none;
    background: transparent;
    color: var(--text);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }

  .model-item:hover {
    background: var(--surface-2);
  }

  .model-item.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .model-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .model-item.active .model-dot {
    background: var(--accent);
  }

  .model-item-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-check {
    flex-shrink: 0;
    font-weight: 700;
  }

  .model-empty {
    font-size: 12.5px;
    color: var(--text-muted);
    padding: 6px 2px;
  }

  .fetch-btn {
    height: 36px;
    padding: 0 14px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .fetch-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .fetch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ====== 天气预览 ====== */
  .preview {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--accent-soft);
    border-radius: var(--radius-md);
    font-size: 13px;
    color: var(--text);
  }

  .preview.error {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .preview.dim {
    color: var(--text-muted);
    background: var(--surface-2);
  }

  .pv-ico {
    display: flex;
    color: var(--cal-3);
  }

  .pv-ico :global(svg) {
    width: 22px;
    height: 22px;
  }

  .preview.error .pv-text {
    flex: 1;
  }

  .retry {
    border: none;
    background: var(--danger);
    color: #fff;
    border-radius: var(--radius-sm);
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .retry:hover {
    opacity: 0.9;
  }

  /* ====== AI 操作按钮 ====== */
  .ai-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .ai-btn {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: var(--radius-md);
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .ai-btn.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
  }

  .ai-btn.danger {
    margin-right: auto;
    color: var(--danger);
    border-color: var(--danger);
  }

  .ai-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ====== 底部 toast 通知 ====== */
  .toast {
    position: fixed;
    left: 50%;
    bottom: 32px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 480px;
    padding: 10px 16px;
    border-radius: var(--radius-md);
    background: var(--surface);
    border: 1px solid var(--border-soft);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    z-index: 200;
    animation: toast-in 0.18s ease-out;
  }

  .toast.ok .toast-ico {
    color: var(--pri-low);
  }

  .toast.fail .toast-ico {
    color: var(--danger);
  }

  .toast-ico {
    font-weight: 700;
    flex-shrink: 0;
  }

  .toast-text {
    color: var(--text);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  /* ====== 关于 ====== */
  .about-brand {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 0;
  }

  .about-mark {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 22px;
    font-weight: 800;
  }

  .about-brand-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .about-name {
    font-size: 17px;
    font-weight: 700;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .about-slogan {
    font-size: 12px;
    color: var(--text-muted);
  }

  .about-ver {
    margin-left: auto;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .about-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .about-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    padding: 8px 12px;
    background: var(--surface-1);
    border-radius: var(--radius-md);
  }

  .about-k {
    font-size: 12px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .about-v {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .about-v.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 500;
    font-size: 12px;
  }

  /* ====== 响应式 ====== */
  @media (max-width: 700px) {
    .settings {
      grid-template-columns: 1fr;
    }

    .section-nav {
      display: none;
    }
  }
</style>
