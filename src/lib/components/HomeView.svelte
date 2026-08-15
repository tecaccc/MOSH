<script lang="ts">
  /**
   * 首页（仪表盘）：严格按 docs/pencil-new.pen 的「Home 首页」(Aot2d) 还原。
   *   - Banner：天气 + 大日期 + 星期（上行）/ 问候（下行）+ 右侧装饰插画
   *   - Stats：今日任务 / 今日日程 / 待办笔记 / 活跃项目
   *   - 今日日程：当日事件时间轴列表（点事件 → 开 EventEditor）
   *   - 月历 mini-grid：当月网格 + 每日农历、高亮今日、点日 → 钻取到日历
   *
   * 数据：今日任务取 store.records（本地派生）；今日日程取 calendar.loadEvents(今日)。
   * 待接入项：天气（暂以静态样例呈现，待接天气服务）、待办笔记/活跃项目
   * （功能未上线，卡片按设计稿静态值呈现）。
   */
  import { onMount } from "svelte";
  import { records, setView } from "../store.svelte";
  import {
    editingEvent,
    renderEvents,
    loadEvents,
    setCursor,
    setMode,
    startEditEvent,
  } from "../calendar.svelte";
  import { addDays, mondayOfWeek, todayOnly } from "../calendar-grid";
  import { formatTime } from "../datetime";
  import { lunarDay, lunarFull, lunarYearMonth } from "../lunar";
  import {
    cityName,
    loadWeather,
    refreshWeather,
    weather,
    weatherError,
    weatherStatus,
  } from "../weather.svelte";
  import { WEATHER_ICONS, weatherInfo } from "../weather-code";
  import type { Record as RecordT } from "../types";

  const now = new Date();
  const today = todayOnly();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const DOW = "日一二三四五六";

  /** 用户名（设计稿问候语含「Connor」；待接入用户档案后替换）。 */
  const USER_NAME = "Connor";

  /**
   * 天气（响应式，由 weather store 驱动）。`round` 取整展示；`wInfo` 由
   * `weather_code` 映射中文文案/图标。状态机见 design §7：有数据即显示（含
   * loading 时保留上次值），无数据则按 unconfigured/error/占位 分态呈现。
   */
  const round = Math.round;
  const wInfo = $derived(weather() ? weatherInfo(weather()!.weather_code) : null);

  /**
   * 待办笔记 / 活跃项目：功能尚未上线，按设计稿 (Aot2d) 静态值占位呈现，
   * 待对应数据源就绪后接真实计数。
   */
  const NOTES_STAT = { value: "12", sub: "3 篇未归档" };
  const PROJECTS_STAT = { value: "3", sub: "全部正常" };

  // —— Banner ——
  const greeting = (() => {
    const h = now.getHours();
    if (h < 6) return "夜深了";
    if (h < 11) return "早上好";
    if (h < 13) return "中午好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();
  const bigDate = `${now.getMonth() + 1}月${now.getDate()}日`;
  const dayLine = `星期${DOW[now.getDay()]} · ${now.getFullYear()}`;
  const footerDate = `今日 · ${now.getMonth() + 1}月${now.getDate()}日 周${DOW[now.getDay()]}`;

  // —— 实时时钟（显示到分钟；对齐分钟边界刷新，日期仍取挂载时的 now）——
  let clockNow = $state(new Date());
  $effect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      clockNow = new Date();
      // 定时到下一分钟起点（+50ms 余量）：分钟跳变不迟滞，也不每秒空转。
      id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    return () => clearTimeout(id);
  });
  const clock = $derived(
    `${pad(clockNow.getHours())}:${pad(clockNow.getMinutes())}`,
  );

  // —— 今日任务 / 逾期（响应式：依赖 records）——
  function isSameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }
  const dueToday = $derived(
    records.filter(
      (r) =>
        r.status === "active" &&
        r.end_at !== null &&
        isSameDay(new Date(r.end_at), now),
    ),
  );
  const overdue = $derived(
    records.filter((r) => {
      if (r.end_at === null || r.status !== "active") return false;
      const d = new Date(r.end_at);
      return (
        !Number.isNaN(d.getTime()) &&
        d.getTime() < now.getTime() &&
        !isSameDay(d, now)
      );
    }),
  );

  // —— 今日日程（响应式：依赖 calendar events）——
  onMount(async () => {
    // 天气取数（错误由 store 内部转为 error 态，不向上抛）。
    void loadWeather();
    try {
      await loadEvents(today, addDays(today, 1));
    } catch {
      /* 非 Tauri 环境忽略；根页有统一错误提示 */
    }
  });

  // 事件编辑器关闭后刷新今日窗口（编辑经 calendar store 的 loadRange，
  // 可能换了 mode/cursor 窗口，需复位首页的「今日」窗口）。
  let wasEditing = $state(false);
  $effect(() => {
    const editing = editingEvent() !== undefined;
    if (wasEditing && !editing) {
      void loadEvents(today, addDays(today, 1));
    }
    wasEditing = editing;
  });

  function byStart(a: RecordT, b: RecordT): number {
    return (a.start_at ?? "").localeCompare(b.start_at ?? "");
  }
  const todayEvents = $derived(
    [...renderEvents()].filter((e) => e.status !== "cancelled").sort(byStart),
  );
  const nextEvent = $derived(
    todayEvents.find((e) => {
      if (e.data.all_day === true) return false;
      const s = new Date(e.start_at ?? "");
      return !Number.isNaN(s.getTime()) && s.getTime() >= now.getTime();
    }),
  );

  const CAL_COLORS = ["var(--cal-1)", "var(--cal-2)", "var(--cal-3)", "var(--cal-4)"];

  // —— 月历 mini-grid（本地月份状态，独立于日历视图翻页）——
  let calYm = $state({ y: now.getFullYear(), m: now.getMonth() });
  const monthTitle = $derived(`${calYm.y}年 ${calYm.m + 1}月`);
  // 月历农历副标题（取当月 15 号所在农历月作代表，如「丙午年 · 七月」）。
  const monthLunarSub = $derived(
    lunarYearMonth(`${calYm.y}-${pad(calYm.m + 1)}-15`),
  );
  // 今日农历完整串（页脚），如「农历丙午年 七月初一」。
  const footerLunar = lunarFull(today);
  const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];
  const cells = $derived.by(() => {
    const first = `${calYm.y}-${pad(calYm.m + 1)}-01`;
    const start = mondayOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  });
  function inMonth(day: string): boolean {
    return day.slice(5, 7) === pad(calYm.m + 1);
  }
  /** 周末判断（按本地日期解析 date-only，避免 UTC 时区偏移）。 */
  function isWeekend(day: string): boolean {
    const [y, mo, d] = day.split("-").map(Number);
    const g = new Date(y, mo - 1, d).getDay();
    return g === 0 || g === 6;
  }
  function shiftMonth(delta: number): void {
    let { y, m } = calYm;
    m += delta;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    calYm = { y, m };
  }
  function openDay(day: string): void {
    setCursor(day);
    setMode("day");
    setView("calendar");
  }

  // 内联图标（currentColor 取色，stroke 风格贴近 lucide）。
  const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="17" height="17" viewBox="0 0 24 24"';
  const tasksIcon = `<svg ${S}><path d="M3.5 6.5l2 2 3.5-4"/><path d="M11 7h9.5"/><path d="M3.5 13l2 2 3.5-4"/><path d="M11 13.5h9.5"/><path d="M3.5 19.5l2 2 3.5-4"/><path d="M11 20h9.5"/></svg>`;
  const calIcon = `<svg ${S}><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17"/><path d="M8 3v4M16 3v4"/></svg>`;
  const noteIcon = `<svg ${S}><path d="M4 5a1 1 0 0 1 1-1h9l6 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M14 4v6h6"/></svg>`;
  const projIcon = `<svg ${S}><path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>`;
  const chevLeft = `<svg ${S}><path d="M15 6l-6 6 6 6"/></svg>`;
  const chevRight = `<svg ${S}><path d="M9 6l6 6-6 6"/></svg>`;
</script>

<section class="home">
  <!-- Banner -->
  <div class="banner">
    <div class="banner-left">
      <div class="banner-top">
        <!-- 天气：weather store 驱动，4 态（有数据/未配置/错误/加载中） -->
        <div class="weather">
          {#if weather() && wInfo}
            <span class="weather-ico">{@html WEATHER_ICONS[wInfo.icon]}</span>
            <div class="weather-info">
              <div class="weather-temp"
                >{round(weather()!.temperature)}°&nbsp;&nbsp;{wInfo.label}</div
              >
              <div class="weather-desc"
                >{cityName()} · 体感 {round(weather()!.apparent_temperature)}° · 湿度
                  {round(weather()!.humidity)}%</div
              >
            </div>
          {:else if weatherStatus() === "unconfigured"}
            <span class="weather-ico dim">{@html WEATHER_ICONS["cloud"]}</span>
            <button type="button" class="weather-cta" onclick={() => setView("settings")}>
              <div class="weather-temp cta">前往设置选择城市</div>
              <div class="weather-desc">未配置天气城市</div>
            </button>
          {:else if weatherStatus() === "error"}
            <span class="weather-ico dim">{@html WEATHER_ICONS["cloud"]}</span>
            <button
              type="button"
              class="weather-cta"
              onclick={() => void refreshWeather()}
            >
              <div class="weather-temp cta">天气获取失败 · 点击重试</div>
              <div class="weather-desc">{weatherError()}</div>
            </button>
          {:else}
            <span class="weather-ico dim">{@html WEATHER_ICONS["cloud"]}</span>
            <div class="weather-info">
              <div class="weather-temp dim">—</div>
              <div class="weather-desc">天气加载中…</div>
            </div>
          {/if}
        </div>
        <div class="date-block">
          <div class="clock">{clock}</div>
          <div class="date-sub">{bigDate} {dayLine}</div>
        </div>
      </div>
      <div class="greeting">{greeting}，{USER_NAME} 👋  今天有什么计划？</div>
    </div>
    <div
      class="banner-art"
      style:background-image="url('/home-banner.png')"
      role="img"
      aria-label="首页装饰"
    ></div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <button type="button" class="stat" onclick={() => setView("today")}>
      <div class="stat-top">
        <span class="stat-label">今日任务</span>
        <span class="icon-box c1">{@html tasksIcon}</span>
      </div>
      <div class="stat-value">{dueToday.length}</div>
      <div class="stat-sub">
        {overdue.length > 0 ? `${overdue.length} 项逾期` : "暂无逾期"}
      </div>
    </button>

    <button type="button" class="stat" onclick={() => setView("calendar")}>
      <div class="stat-top">
        <span class="stat-label">今日日程</span>
        <span class="icon-box c2">{@html calIcon}</span>
      </div>
      <div class="stat-value">{todayEvents.length}</div>
      <div class="stat-sub">
        {nextEvent
          ? `下一项 ${formatTime(nextEvent.start_at)}`
          : todayEvents.length
            ? "今日日程已过"
            : "今日无日程"}
      </div>
    </button>

    <div class="stat">
      <div class="stat-top">
        <span class="stat-label">待办笔记</span>
        <span class="icon-box c3">{@html noteIcon}</span>
      </div>
      <div class="stat-value">{NOTES_STAT.value}</div>
      <div class="stat-sub">{NOTES_STAT.sub}</div>
    </div>

    <div class="stat">
      <div class="stat-top">
        <span class="stat-label">活跃项目</span>
        <span class="icon-box c4">{@html projIcon}</span>
      </div>
      <div class="stat-value">{PROJECTS_STAT.value}</div>
      <div class="stat-sub">{PROJECTS_STAT.sub}</div>
    </div>
  </div>

  <!-- Content -->
  <div class="content">
    <section class="card schedule">
      <header class="sec-head">
        <div class="sec-title">
          <span class="sec-ico">{@html calIcon}</span>
          <h2>今日日程</h2>
          <span class="badge">{todayEvents.length}</span>
        </div>
        <button type="button" class="link" onclick={() => setView("calendar")}>
          查看全部 →
        </button>
      </header>

      {#if todayEvents.length === 0}
        <div class="empty">
          今日暂无日程。
          <span class="hint">去「日历」新建事件。</span>
        </div>
      {:else}
        <ul class="ev-list">
          {#each todayEvents as ev, i (ev.id)}
            <li>
              <button type="button" class="ev" onclick={() => startEditEvent(ev.id)}>
                <span class="tl">
                  <span class="tl-time">
                    {ev.data.all_day === true
                      ? "全天"
                      : `${formatTime(ev.start_at)} — ${formatTime(ev.end_at)}`}
                  </span>
                  <span class="tl-dot" style:background={CAL_COLORS[i % 4]}></span>
                  <span
                    class="tl-line"
                    style:background={i < todayEvents.length - 1
                      ? "var(--border-soft)"
                      : "transparent"}
                  ></span>
                </span>
                <span class="ev-body">
                  <span class="ev-title">{ev.title}</span>
                  {#if ev.data.location}
                    <span class="ev-loc">{ev.data.location}</span>
                  {/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card minical">
      <header class="mc-head">
        <div class="mc-title">
          <span class="mc-month">{monthTitle}</span>
          <span class="mc-lunar-sub">{monthLunarSub}</span>
        </div>
        <div class="mc-nav">
          <button
            type="button"
            class="mc-arrow"
            onclick={() => shiftMonth(-1)}
            aria-label="上个月"
          >{@html chevLeft}</button>
          <button
            type="button"
            class="mc-arrow"
            onclick={() => shiftMonth(1)}
            aria-label="下个月"
          >{@html chevRight}</button>
        </div>
      </header>

      <div class="mc-weekdays">
        {#each weekdayLabels as w}<span class="mc-wd">{w}</span>{/each}
      </div>

      <div class="mc-grid">
        {#each cells as day (day)}
          <button
            type="button"
            class="mc-cell"
            class:muted={!inMonth(day)}
            class:weekend={inMonth(day) && isWeekend(day)}
            class:today={day === today}
            onclick={() => openDay(day)}
          >
            <span class="mc-num">{Number(day.slice(8, 10))}</span>
            <span class="mc-lun">{lunarDay(day)}</span>
          </button>
        {/each}
      </div>

      <div class="mc-foot">
        <span class="mc-dot"></span>
        <div class="mc-foot-text">
          <div class="mc-foot-main">{footerDate}</div>
          <div class="mc-foot-sub">{footerLunar}</div>
        </div>
      </div>
    </section>
  </div>
</section>

<style>
  .home {
    height: 100%;
    overflow-y: auto;
    padding: 28px 36px 40px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    background: var(--bg);
  }

  /* Banner */
  .banner {
    display: flex;
    height: 220px;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    flex-shrink: 0;
  }
  .banner-left {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 32px;
    min-width: 0;
  }
  .banner-top {
    display: flex;
    align-items: center;
    gap: 32px;
    flex-wrap: wrap;
  }
  .weather {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .weather-ico {
    color: var(--cal-3);
    display: flex;
  }
  .weather-ico :global(svg) {
    width: 40px;
    height: 40px;
  }
  .weather-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .weather-temp {
    font-size: 28px;
    font-weight: 700;
    color: var(--text);
    line-height: 1.1;
  }
  .weather-desc {
    font-size: 13px;
    color: var(--text-dim);
  }
  .weather-ico.dim {
    color: var(--text-muted);
  }
  .weather-temp.dim {
    color: var(--text-muted);
  }
  /* 未配置/错误态：按钮形式的可点击天气区，继承列布局与字号梯度。 */
  .weather-cta {
    border: none;
    background: transparent;
    padding: 0;
    margin: 0;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    color: inherit;
    font-family: inherit;
  }
  .weather-temp.cta {
    font-size: 16px;
    font-weight: 600;
  }
  .weather-cta:hover .weather-temp.cta {
    color: var(--accent);
  }
  .date-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .clock {
    font-size: 36px;
    font-weight: 700;
    color: var(--text);
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
  .date-sub {
    font-size: 14px;
    color: var(--text-dim);
  }
  .greeting {
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
  }
  .banner-art {
    width: 360px;
    flex-shrink: 0;
    background-size: cover;
    background-position: center;
  }

  /* Stats */
  .stats {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .stat {
    flex: 1 1 220px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 20px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    cursor: default;
    color: inherit;
    text-align: left;
    transition:
      border-color 0.12s,
      transform 0.05s;
  }
  button.stat {
    cursor: pointer;
  }
  button.stat:hover {
    border-color: var(--accent);
  }
  button.stat:active {
    transform: translateY(1px);
  }
  .stat-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .stat-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
  }
  .icon-box {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-fg);
  }
  .icon-box.c1 {
    background: var(--cal-1);
  }
  .icon-box.c2 {
    background: var(--cal-2);
  }
  .icon-box.c3 {
    background: var(--cal-3);
  }
  .icon-box.c4 {
    background: var(--pri-low);
  }
  .stat-value {
    font-size: 28px;
    font-weight: 700;
    color: var(--text);
    line-height: 1;
  }
  .stat-sub {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Content */
  .content {
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .schedule {
    flex: 1;
    min-width: 0;
  }
  .minical {
    width: 380px;
    flex-shrink: 0;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    padding: 16px;
  }

  /* Schedule */
  .sec-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .sec-title {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sec-ico {
    width: 18px;
    height: 18px;
    color: var(--accent);
    display: flex;
  }
  .sec-title h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }
  .badge {
    padding: 2px 10px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .link {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 0;
  }
  .link:hover {
    color: var(--accent);
  }
  .empty {
    padding: 24px 8px;
    text-align: center;
    color: var(--text-dim);
    font-size: 14px;
  }
  .empty .hint {
    display: block;
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .ev-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ev {
    width: 100%;
    display: flex;
    gap: 14px;
    text-align: left;
    border: none;
    background: transparent;
    color: inherit;
    padding: 6px 8px;
    border-radius: var(--radius-md);
    cursor: pointer;
    align-items: flex-start;
  }
  .ev:hover {
    background: var(--surface-2);
  }
  .tl {
    width: 96px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding-top: 2px;
  }
  .tl-time {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tl-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--surface);
    box-shadow: 0 0 0 1px var(--border-soft);
  }
  .tl-line {
    width: 2px;
    flex: 1;
    min-height: 16px;
  }
  .ev-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 1px;
  }
  .ev-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .ev-loc {
    font-size: 11px;
    color: var(--text-muted);
  }

  /* Mini calendar */
  .mc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .mc-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mc-month {
    font-size: 17px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.1;
  }
  .mc-lunar-sub {
    font-size: 11px;
    color: var(--text-dim);
  }
  .mc-nav {
    display: flex;
    gap: 6px;
  }
  .mc-arrow {
    width: 30px;
    height: 30px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mc-arrow:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .mc-weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
    margin-bottom: 4px;
  }
  .mc-wd {
    text-align: center;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    padding: 4px 0;
  }
  .mc-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }
  .mc-cell {
    height: 42px;
    border: none;
    background: transparent;
    color: var(--text);
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    padding: 0;
  }
  .mc-cell:hover {
    background: var(--surface-2);
  }
  .mc-cell.muted .mc-num {
    color: var(--text-muted);
    opacity: 0.5;
  }
  .mc-cell.muted .mc-lun {
    opacity: 0.5;
  }
  .mc-cell.weekend .mc-num {
    color: var(--accent);
    font-weight: 600;
  }
  .mc-cell.today {
    background: var(--accent);
  }
  .mc-cell.today .mc-num {
    color: var(--accent-fg);
    font-weight: 700;
  }
  .mc-cell.today .mc-lun {
    color: var(--accent-fg);
    opacity: 0.9;
    font-weight: 700;
  }
  .mc-num {
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
  }
  .mc-lun {
    font-size: 9px;
    color: var(--text-muted);
    line-height: 1;
  }
  .mc-foot {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--accent-soft);
    border-radius: var(--radius-md);
  }
  .mc-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .mc-foot-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .mc-foot-main {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .mc-foot-sub {
    font-size: 10px;
    color: var(--text-dim);
  }

  @media (max-width: 1000px) {
    .banner-art {
      display: none;
    }
    .content {
      flex-direction: column;
    }
    .minical {
      width: 100%;
    }
  }
</style>
