import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, mondayOfWeek, todayOnly } from "../lib/calendar-grid";
import { formatTime } from "../lib/datetime";
import { lunarDay, lunarFull, lunarYearMonth } from "../lib/lunar";
import { useAppStore } from "../state/store";
import { editingEventOf, useCalendarStore } from "../state/calendar";
import { useWeatherStore } from "../state/weather";
import { WEATHER_ICONS, weatherInfo, type WeatherIcon } from "../lib/weather-code";
import type { Record as RecordT } from "../lib/types";
import styles from "./HomeView.module.css";

/**
 * 首页（仪表盘）：Banner（天气 + 时钟 + 问候 + 插画）、Stats 四卡、
 * 今日日程时间轴、月历 mini-grid（每日农历、高亮今日、点日钻取）。
 */

const now = new Date();
const today = todayOnly();
const pad = (n: number): string => String(n).padStart(2, "0");
const DOW = "日一二三四五六";
const USER_NAME = "Connor";
const round = Math.round;

const NOTES_STAT = { value: "12", sub: "3 篇未归档" };
const PROJECTS_STAT = { value: "3", sub: "全部正常" };

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
const footerLunar = lunarFull(today);
const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];
const CAL_COLORS = ["var(--cal-1)", "var(--cal-2)", "var(--cal-3)", "var(--cal-4)"];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 图标（安全静态串，dangerouslySetInnerHTML 渲染自家资源）。 */
function WIcon({ name }: { name: WeatherIcon }) {
  return <span dangerouslySetInnerHTML={{ __html: WEATHER_ICONS[name] }} />;
}

export default function HomeView() {
  const setView = useAppStore((s) => s.setView);
  const records = useAppStore((s) => s.records);
  const renderEvents = useCalendarStore((s) => s.renderEvents);
  const calEvents = useCalendarStore((s) => s.events);
  const editingId = useCalendarStore((s) => s.editingId);
  const loadEvents = useCalendarStore((s) => s.loadEvents);
  const startEditEvent = useCalendarStore((s) => s.startEditEvent);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const setMode = useCalendarStore((s) => s.setMode);

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

  const dueToday = useMemo(
    () =>
      records.filter(
        (r) => r.status === "active" && r.end_at !== null && isSameDay(new Date(r.end_at), now),
      ),
    [records],
  );
  const overdue = useMemo(
    () =>
      records.filter((r) => {
        if (r.end_at === null || r.status !== "active") return false;
        const d = new Date(r.end_at);
        return !Number.isNaN(d.getTime()) && d.getTime() < now.getTime() && !isSameDay(d, now);
      }),
    [records],
  );

  useEffect(() => {
    void loadWeather();
    void loadEvents(today, addDays(today, 1)).catch(() => {});
  }, [loadWeather, loadEvents]);

  // 事件编辑器关闭后刷新今日窗口（编辑可能换走了 mode/cursor 窗口）。
  const editing = editingEventOf(calEvents, editingId) !== undefined;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      void loadEvents(today, addDays(today, 1)).catch(() => {});
    }
    wasEditing.current = editing;
  }, [editing, loadEvents]);

  const todayEvents = useMemo(
    () =>
      [...renderEvents]
        .filter((e) => e.status !== "cancelled")
        .sort((a: RecordT, b: RecordT) => (a.start_at ?? "").localeCompare(b.start_at ?? "")),
    [renderEvents],
  );
  const nextEvent = todayEvents.find((e) => {
    if (e.data.all_day === true) return false;
    const s = new Date(e.start_at ?? "");
    return !Number.isNaN(s.getTime()) && s.getTime() >= now.getTime();
  });

  // —— 月历 mini-grid（本地月份状态，独立于日历视图翻页）——
  const [calYm, setCalYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
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
            <div className={styles["date-block"]}>
              <div className={styles.clock}>{clock}</div>
              <div className={styles["date-sub"]}>{bigDate} {dayLine}</div>
            </div>
          </div>
          <div className={styles.greeting}>{greeting}，{USER_NAME} 👋  今天有什么计划？</div>
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
        <section className={`${styles.card} ${styles.schedule}`}>
          <header className={styles["sec-head"]}>
            <div className={styles["sec-title"]}>
              <span className={styles["sec-ico"]}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
                  <path d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" />
                </svg>
              </span>
              <h2>今日日程</h2>
              <span className={styles.badge}>{todayEvents.length}</span>
            </div>
            <button type="button" className={styles.link} onClick={() => setView("calendar")}>
              查看全部 →
            </button>
          </header>

          {todayEvents.length === 0 ? (
            <div className={styles.empty}>
              今日暂无日程。
              <span className={styles.hint}>去「日历」新建事件。</span>
            </div>
          ) : (
            <ul className={styles["ev-list"]}>
              {todayEvents.map((ev, i) => (
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
                        style={{ background: i < todayEvents.length - 1 ? "var(--border-soft)" : "transparent" }}
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
