import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, eventOnDay, mondayOfWeek } from "../lib/calendar-grid";
import { useToday } from "../lib/use-today";
import { formatDate, formatTime, toDateOnly } from "../lib/datetime";
import { lunarDay, lunarFull, lunarYearMonth } from "../lib/lunar";
import { useAppStore } from "../state/store";
import { editingEventOf, useCalendarStore } from "../state/calendar";
import { useProfileStore } from "../state/profile";
import { useWeatherStore } from "../state/weather";
import { WEATHER_ICONS, weatherInfo, type WeatherIcon } from "../lib/weather-code";
import type { Priority, RecordData as RecordT } from "../lib/types";
import Avatar from "./Avatar";
import styles from "./HomeView.module.css";

/**
 * 首页（仪表盘）：Banner（天气 + 时钟 + 问候 + 插画）、Stats 四卡、
 * 日程安排（今天起 30 天，按日分组时间轴）、待办事项卡、
 * 月历 mini-grid（每日农历、高亮今日、点日钻取）。
 */

/** 「日程安排」卡片的加载与展示窗口：今天起 N 天（对齐议程视图惯例）。 */
const SCHEDULE_DAYS = 30;
const pad = (n: number): string => String(n).padStart(2, "0");
const DOW = "日一二三四五六";
const round = Math.round;

const NOTES_STAT = { value: "12", sub: "3 篇未归档" };
const PROJECTS_STAT = { value: "3", sub: "全部正常" };

const PRIO_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };
const PRIO_LABEL: Record<Priority, string> = { none: "无", low: "低", medium: "中", high: "高" };
const PRIO_DOT: Record<Priority, string> = {
  none: styles.pNone,
  low: styles.pLow,
  medium: styles.pMedium,
  high: styles.pHigh,
};

/** 时段问候（按小时）。 */
function greetingOf(d: Date): string {
  const h = d.getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}
const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];
const CAL_COLORS = ["var(--cal-1)", "var(--cal-2)", "var(--cal-3)", "var(--cal-4)"];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** date-only 的本地星期（`周X`）。 */
function weekdayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `周${DOW[new Date(y, m - 1, d).getDay()]}`;
}

/** 分组头：今天 / 明天 / M月D日。 */
function dayLabel(day: string, today: string, tomorrow: string): string {
  if (day === today) return "今天";
  if (day === tomorrow) return "明天";
  return formatDate(day);
}

/** 待办截止的紧凑展示（仅日期；空 → ""）。 */
function dueLabelOf(r: RecordT): string {
  return formatDate(toDateOnly(r.end_at));
}

/** 待办是否逾期（按本地日期比较；当天截止不算逾期）。 */
function isOverdue(r: RecordT, today: string): boolean {
  const day = toDateOnly(r.end_at);
  return day !== "" && day < today;
}

/** 图标（安全静态串，dangerouslySetInnerHTML 渲染自家资源）。 */
function WIcon({ name }: { name: WeatherIcon }) {
  return <span dangerouslySetInnerHTML={{ __html: WEATHER_ICONS[name] }} />;
}

export default function HomeView() {
  const setView = useAppStore((s) => s.setView);
  const records = useAppStore((s) => s.records);
  const setTodoStatus = useAppStore((s) => s.setTodoStatus);
  const startEdit = useAppStore((s) => s.startEdit);
  // 个人资料（可配置名称/头像；未配置时问候不带称呼 + 首字圆标兑底）。
  const profileName = useProfileStore((s) => s.name);
  const profileAvatar = useProfileStore((s) => s.avatar);
  const renderEvents = useCalendarStore((s) => s.renderEvents);
  const editingId = useCalendarStore((s) => s.editingId);
  const loadEvents = useCalendarStore((s) => s.loadEvents);
  const startEditEvent = useCalendarStore((s) => s.startEditEvent);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const setMode = useCalendarStore((s) => s.setMode);
  // AI 工具等外部变更后自增，触发本视图重载事件窗口。
  const dataVersion = useAppStore((s) => s.dataVersion);

  const wStatus = useWeatherStore((s) => s.status);
  const weather = useWeatherStore((s) => s.weather);
  const cityName = useWeatherStore((s) => s.cityName);
  const weatherError = useWeatherStore((s) => s.error);
  const loadWeather = useWeatherStore((s) => s.loadWeather);
  const refreshWeather = useWeatherStore((s) => s.refreshWeather);
  const wInfo = weather ? weatherInfo(weather.weather_code) : null;

  // —— 实时时钟（对齐分钟边界刷新）——
  const [clockNow, setClockNow] = useState(new Date());
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setClockNow(new Date());
      id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    return () => clearTimeout(id);
  }, []);
  const clock = `${pad(clockNow.getHours())}:${pad(clockNow.getMinutes())}`;

  // 响应式「今天」+ 分钟级时钟：托盘常驻跨午夜后，日期文案/问候/今日过滤/逾期
  // 判定全部跟随滚动（模块顶层固化 now/today 是「定位到昨天」BUG 的根因）。
  const today = useToday();
  const tomorrow = addDays(today, 1);
  const now = clockNow;
  const greeting = greetingOf(now);
  const bigDate = `${now.getMonth() + 1}月${now.getDate()}日`;
  const dayLine = `星期${DOW[now.getDay()]} · ${now.getFullYear()}`;
  const footerDate = `今日 · ${now.getMonth() + 1}月${now.getDate()}日 周${DOW[now.getDay()]}`;
  const footerLunar = lunarFull(today);

  const dueToday = useMemo(
    () =>
      records.filter(
        (r) => r.status === "active" && r.end_at !== null && isSameDay(new Date(r.end_at), now),
      ),
    [records, now],
  );
  const overdue = useMemo(
    () =>
      records.filter((r) => {
        if (r.end_at === null || r.status !== "active") return false;
        const d = new Date(r.end_at);
        return !Number.isNaN(d.getTime()) && d.getTime() < now.getTime() && !isSameDay(d, now);
      }),
    [records, now],
  );

  useEffect(() => {
    void loadWeather();
  }, [loadWeather]);

  // 事件窗口：挂载 + 外部数据变更（AI 工具等，dataVersion）+ 跨天时重载。
  useEffect(() => {
    void loadEvents(today, addDays(today, SCHEDULE_DAYS)).catch(() => {});
  }, [loadEvents, dataVersion, today]);

  // 事件编辑器关闭后刷新日程窗口（编辑可能换走了 mode/cursor 窗口）。
  const editing = editingEventOf(renderEvents, editingId) !== undefined;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      void loadEvents(today, addDays(today, SCHEDULE_DAYS)).catch(() => {});
    }
    wasEditing.current = editing;
  }, [editing, loadEvents, today]);

  // —— 日程安排：窗口内全部事件（升序）+ 今日子集（统计卡）——
  const allEvents = useMemo(
    () =>
      [...renderEvents]
        .filter((e) => e.status !== "cancelled")
        .sort((a: RecordT, b: RecordT) => (a.start_at ?? "").localeCompare(b.start_at ?? "")),
    [renderEvents],
  );
  const todayEvents = useMemo(() => allEvents.filter((e) => eventOnDay(e, today)), [allEvents, today]);
  const nextEvent = todayEvents.find((e) => {
    if (e.data.all_day === true) return false;
    const s = new Date(e.start_at ?? "");
    return !Number.isNaN(s.getTime()) && s.getTime() >= now.getTime();
  });

  // —— 按日分组（今天起 30 天；全天归开始日，定时按触及日）——
  const scheduleGroups = useMemo(() => {
    return Array.from({ length: SCHEDULE_DAYS }, (_, i) => addDays(today, i))
      .map((day) => {
        const starting = allEvents.filter(
          (e) => e.data.all_day === true && (e.start_at ?? "") === day,
        );
        const timed = allEvents.filter((e) => e.data.all_day !== true && eventOnDay(e, day));
        const items = [...starting, ...timed].sort((a, b) =>
          (a.start_at ?? "").localeCompare(b.start_at ?? ""),
        );
        return { day, items };
      })
      .filter((g) => g.items.length > 0);
  }, [allEvents, today]);
  const scheduleCount = scheduleGroups.reduce((n, g) => n + g.items.length, 0);

  // —— 待办事项卡：进行中的顶层待办，按截止/优先级排序（逾期自然置顶）——
  const activeTodos = useMemo(() => {
    return records
      .filter((r) => r.parent_id === null && r.status === "active")
      .sort((a, b) => {
        const ka = `${a.end_at ?? "9999-12-31T23:59:59Z"}|${PRIO_RANK[a.data.priority ?? "none"]}|${a.title}`;
        const kb = `${b.end_at ?? "9999-12-31T23:59:59Z"}|${PRIO_RANK[b.data.priority ?? "none"]}|${b.title}`;
        return ka.localeCompare(kb);
      });
  }, [records]);

  // 勾选完成（单条互斥防抖）。
  const [togglingId, setTogglingId] = useState<string | null>(null);
  async function toggleTodo(id: string) {
    if (togglingId !== null) return;
    setTogglingId(id);
    try {
      await setTodoStatus(id, "done");
    } finally {
      setTogglingId(null);
    }
  }

  // —— 月历 mini-grid（本地月份状态，独立于日历视图翻页）——
  const [calYm, setCalYm] = useState({ y: clockNow.getFullYear(), m: clockNow.getMonth() });
  const monthTitle = `${calYm.y}年 ${calYm.m + 1}月`;
  const monthLunarSub = lunarYearMonth(`${calYm.y}-${pad(calYm.m + 1)}-15`);
  const cells = useMemo(() => {
    const first = `${calYm.y}-${pad(calYm.m + 1)}-01`;
    const start = mondayOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [calYm]);
  const inMonth = (day: string) => day.slice(5, 7) === pad(calYm.m + 1);
  const isWeekend = (day: string) => {
    const [y, mo, d] = day.split("-").map(Number);
    const g = new Date(y, mo - 1, d).getDay();
    return g === 0 || g === 6;
  };
  function shiftMonth(delta: number) {
    setCalYm((prev) => {
      let { y, m } = prev;
      m += delta;
      if (m < 0) {
        m = 11;
        y -= 1;
      } else if (m > 11) {
        m = 0;
        y += 1;
      }
      return { y, m };
    });
  }
  function openDay(day: string) {
    setCursor(day);
    setMode("day");
    setView("calendar");
  }

  return (
    <section className={styles.home}>
      {/* Banner */}
      <div className={styles.banner}>
        <div className={styles["banner-left"]}>
          <div className={styles["banner-top"]}>
            <div className={styles.weather}>
              {weather && wInfo ? (
                <>
                  <span className={styles["weather-ico"]}>
                    <WIcon name={wInfo.icon} />
                  </span>
                  <div className={styles["weather-info"]}>
                    <div className={styles["weather-temp"]}>
                      {round(weather.temperature)}°&nbsp;&nbsp;{wInfo.label}
                    </div>
                    <div className={styles["weather-desc"]}>
                      {cityName} · 体感 {round(weather.apparent_temperature)}° · 湿度 {round(weather.humidity)}%
                    </div>
                  </div>
                </>
              ) : wStatus === "unconfigured" ? (
                <>
                  <span className={`${styles["weather-ico"]} ${styles.dim}`}>
                    <WIcon name="cloud" />
                  </span>
                  <button type="button" className={styles["weather-cta"]} onClick={() => setView("settings")}>
                    <div className={`${styles["weather-temp"]} ${styles.cta}`}>前往设置选择城市</div>
                    <div className={styles["weather-desc"]}>未配置天气城市</div>
                  </button>
                </>
              ) : wStatus === "error" ? (
                <>
                  <span className={`${styles["weather-ico"]} ${styles.dim}`}>
                    <WIcon name="cloud" />
                  </span>
                  <button type="button" className={styles["weather-cta"]} onClick={() => void refreshWeather()}>
                    <div className={`${styles["weather-temp"]} ${styles.cta}`}>天气获取失败 · 点击重试</div>
                    <div className={styles["weather-desc"]}>{weatherError}</div>
                  </button>
                </>
              ) : (
                <>
                  <span className={`${styles["weather-ico"]} ${styles.dim}`}>
                    <WIcon name="cloud" />
                  </span>
                  <div className={styles["weather-info"]}>
                    <div className={`${styles["weather-temp"]} ${styles.dim}`}>—</div>
                    <div className={styles["weather-desc"]}>天气加载中…</div>
                  </div>
                </>
              )}
            </div>
            <span className={styles["banner-sep"]} aria-hidden="true">\</span>
            <div className={styles["date-block"]}>
              <div className={styles.clock}>{clock}</div>
              <div className={styles["date-sub"]}>{bigDate} {dayLine}</div>
            </div>
          </div>
          <div className={styles["greet-line"]}>
            <Avatar name={profileName} avatar={profileAvatar} size={44} />
            <div className={styles.greeting}>
              {profileName ? `${greeting}，${profileName}` : greeting} 👋&nbsp; 今天有什么计划？
            </div>
          </div>
        </div>
        <div
          className={styles["banner-art"]}
          style={{ backgroundImage: "url('/home-banner.png')" }}
          role="img"
          aria-label="首页装饰"
        />
      </div>

      {/* Stats */}
      <div className={styles.stats}>
        <button type="button" className={styles.stat} onClick={() => setView("today")}>
          <div className={styles["stat-top"]}>
            <span className={styles["stat-label"]}>今日任务</span>
            <span className={`${styles["icon-box"]} ${styles.c1}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                <path d="M3.5 6.5l2 2 3.5-4" /><path d="M11 7h9.5" />
                <path d="M3.5 13l2 2 3.5-4" /><path d="M11 13.5h9.5" />
                <path d="M3.5 19.5l2 2 3.5-4" /><path d="M11 20h9.5" />
              </svg>
            </span>
          </div>
          <div className={styles["stat-value"]}>{dueToday.length}</div>
          <div className={styles["stat-sub"]}>
            {overdue.length > 0 ? `${overdue.length} 项逾期` : "暂无逾期"}
          </div>
        </button>

        <button type="button" className={styles.stat} onClick={() => setView("calendar")}>
          <div className={styles["stat-top"]}>
            <span className={styles["stat-label"]}>今日日程</span>
            <span className={`${styles["icon-box"]} ${styles.c2}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
                <path d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" />
              </svg>
            </span>
          </div>
          <div className={styles["stat-value"]}>{todayEvents.length}</div>
          <div className={styles["stat-sub"]}>
            {nextEvent
              ? `下一项 ${formatTime(nextEvent.start_at)}`
              : todayEvents.length
                ? "今日日程已过"
                : "今日无日程"}
          </div>
        </button>

        <div className={styles.stat}>
          <div className={styles["stat-top"]}>
            <span className={styles["stat-label"]}>待办笔记</span>
            <span className={`${styles["icon-box"]} ${styles.c3}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                <path d="M4 5a1 1 0 0 1 1-1h9l6 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
                <path d="M14 4v6h6" />
              </svg>
            </span>
          </div>
          <div className={styles["stat-value"]}>{NOTES_STAT.value}</div>
          <div className={styles["stat-sub"]}>{NOTES_STAT.sub}</div>
        </div>

        <div className={styles.stat}>
          <div className={styles["stat-top"]}>
            <span className={styles["stat-label"]}>活跃项目</span>
            <span className={`${styles["icon-box"]} ${styles.c4}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                <path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
              </svg>
            </span>
          </div>
          <div className={styles["stat-value"]}>{PROJECTS_STAT.value}</div>
          <div className={styles["stat-sub"]}>{PROJECTS_STAT.sub}</div>
        </div>
      </div>

      {/* Content */}
      <div className={styles.content}>
        {/* 日程安排 */}
        <section className={`${styles.card} ${styles.schedule}`}>
          <header className={styles["sec-head"]}>
            <div className={styles["sec-title"]}>
              <span className={styles["sec-ico"]}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
                  <path d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" />
                </svg>
              </span>
              <h2>日程安排</h2>
              <span className={styles.badge}>{scheduleCount}</span>
            </div>
            <button type="button" className={styles.link} onClick={() => setView("calendar")}>
              查看全部 →
            </button>
          </header>

          {scheduleGroups.length === 0 ? (
            <div className={styles.empty}>
              未来 {SCHEDULE_DAYS} 天暂无日程。
              <span className={styles.hint}>去「日历」新建事件，或让 AI 助手帮你安排。</span>
            </div>
          ) : (
            <div className={styles["sched-scroll"]}>
              {scheduleGroups.map((g) => (
                <div key={g.day} className={styles["day-group"]}>
                  <div className={`${styles["day-head"]}${g.day === today ? ` ${styles.isToday}` : ""}`}>
                    <span className={styles["day-main"]}>{dayLabel(g.day, today, tomorrow)}</span>
                    <span className={styles["day-sub"]}>{weekdayOf(g.day)}</span>
                  </div>
                  <ul className={styles["ev-list"]}>
                    {g.items.map((ev, i) => (
                      <li key={ev.id}>
                        <button type="button" className={styles.ev} onClick={() => startEditEvent(ev.id)}>
                          <span className={styles.tl}>
                            <span className={styles["tl-time"]}>
                              {ev.data.all_day === true
                                ? "全天"
                                : `${formatTime(ev.start_at)} — ${formatTime(ev.end_at)}`}
                            </span>
                            <span className={styles["tl-dot"]} style={{ background: CAL_COLORS[i % 4] }} />
                            <span
                              className={styles["tl-line"]}
                              style={{ background: i < g.items.length - 1 ? "var(--border-soft)" : "transparent" }}
                            />
                          </span>
                          <span className={styles["ev-body"]}>
                            <span className={styles["ev-title"]}>{ev.title}</span>
                            {typeof ev.data.location === "string" && ev.data.location ? (
                              <span className={styles["ev-loc"]}>{ev.data.location as string}</span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 待办事项 */}
        <section className={`${styles.card} ${styles.todos}`}>
          <header className={styles["sec-head"]}>
            <div className={styles["sec-title"]}>
              <span className={styles["sec-ico"]}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <path d="M3.5 6.5l2 2 3.5-4" /><path d="M11 7h9.5" />
                  <path d="M3.5 13l2 2 3.5-4" /><path d="M11 13.5h9.5" />
                  <path d="M3.5 19.5l2 2 3.5-4" /><path d="M11 20h9.5" />
                </svg>
              </span>
              <h2>待办事项</h2>
              <span className={styles.badge}>{activeTodos.length}</span>
            </div>
            <button type="button" className={styles.link} onClick={() => setView("today")}>
              查看全部 →
            </button>
          </header>

          {activeTodos.length === 0 ? (
            <div className={styles.empty}>
              暂无进行中的待办。
              <span className={styles.hint}>去「今日」视图或让 AI 助手创建。</span>
            </div>
          ) : (
            <div className={styles["todo-scroll"]}>
              <ul className={styles["todo-list"]}>
                {activeTodos.map((t) => {
                  const due = dueLabelOf(t);
                  const overdue = isOverdue(t, today);
                  const prio = t.data.priority ?? "none";
                  return (
                    <li key={t.id}>
                      <div className={styles.todo}>
                        <input
                          type="checkbox"
                          checked={false}
                          disabled={togglingId === t.id}
                          onChange={() => void toggleTodo(t.id)}
                          aria-label={`完成「${t.title}」`}
                        />
                        <span
                          className={`${styles["prio-dot"]} ${PRIO_DOT[prio]}`}
                          title={`优先级：${PRIO_LABEL[prio]}`}
                        />
                        <button
                          type="button"
                          className={styles["todo-title"]}
                          onClick={() => startEdit(t.id)}
                          title="编辑待办"
                        >
                          {t.title}
                        </button>
                        {due ? (
                          <span className={`${styles["todo-due"]}${overdue ? ` ${styles.overdue}` : ""}`}>
                            {overdue ? `逾期 ${due}` : due}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        <section className={`${styles.card} ${styles.minical}`}>
          <header className={styles["mc-head"]}>
            <div className={styles["mc-title"]}>
              <span className={styles["mc-month"]}>{monthTitle}</span>
              <span className={styles["mc-lunar-sub"]}>{monthLunarSub}</span>
            </div>
            <div className={styles["mc-nav"]}>
              <button type="button" className={styles["mc-arrow"]} onClick={() => shiftMonth(-1)} aria-label="上个月">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <button type="button" className={styles["mc-arrow"]} onClick={() => shiftMonth(1)} aria-label="下个月">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </header>

          <div className={styles["mc-weekdays"]}>
            {weekdayLabels.map((w) => (
              <span key={w} className={styles["mc-wd"]}>{w}</span>
            ))}
          </div>

          <div className={styles["mc-grid"]}>
            {cells.map((day) => (
              <button
                key={day}
                type="button"
                className={`${styles["mc-cell"]}${!inMonth(day) ? ` ${styles.muted}` : ""}${inMonth(day) && isWeekend(day) ? ` ${styles.weekend}` : ""}${day === today ? ` ${styles.today}` : ""}`}
                onClick={() => openDay(day)}
              >
                <span className={styles["mc-num"]}>{Number(day.slice(8, 10))}</span>
                <span className={styles["mc-lun"]}>{lunarDay(day)}</span>
              </button>
            ))}
          </div>

          <div className={styles["mc-foot"]}>
            <span className={styles["mc-dot"]} />
            <div className={styles["mc-foot-text"]}>
              <div className={styles["mc-foot-main"]}>{footerDate}</div>
              <div className={styles["mc-foot-sub"]}>{footerLunar}</div>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
