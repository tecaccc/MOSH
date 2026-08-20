/**
 * 城市搜索选择器（combobox）：输入 ≥2 字符自动搜索（300ms 防抖），
 * 候选显示「城市 · 省市」消歧（GeoNames 同名城市多），点选即生效。
 *
 * 数据流：输入 → searchCities（ipc → Rust → Open-Meteo geocoding）→ 候选列表；
 * 点选 → selectCity（坐标直存，免二次 geocode）。后端搜索已是多候选，
 * 前端不再持有城市表（旧预设表仅留 cityNameOf 反查兼容已存设置）。
 */

import { useEffect, useRef, useState } from "react";
import { searchCities } from "../lib/ipc";
import type { CityCandidate } from "../lib/types";
import { useWeatherStore } from "../state/weather";
import styles from "./SettingsView.module.css";

/** 候选一行文案：「城市 · 省份 市级」（缺省字段跳过）。 */
function labelOf(c: CityCandidate): string {
  const admin = [c.admin1, c.admin2].filter(Boolean).join(" ");
  return admin ? `${c.name} · ${admin}` : c.name;
}

export default function CityPicker() {
  const cityName = useWeatherStore((s) => s.cityName);
  const selectCity = useWeatherStore((s) => s.selectCity);
  const wStatus = useWeatherStore((s) => s.status);

  const [input, setInput] = useState("");
  const [candidates, setCandidates] = useState<CityCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭候选浮层。
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // 输入 → 防抖搜索（≥2 字符；中文单字/单字母不触发，API 也搜不到）。
  useEffect(() => {
    const q = input.trim();
    if (q.length < 2) {
      setCandidates([]);
      setSearching(false);
      setErr("");
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const list = await searchCities(q);
        setCandidates(list);
        setErr("");
      } catch (e) {
        setCandidates([]);
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [input]);

  async function pick(c: CityCandidate) {
    setOpen(false);
    setInput("");
    setCandidates([]);
    // 候选即持久化标识：中文名 + 坐标直存（免二次 geocode、重名消歧由用户选择保证）。
    await selectCity(c.name, c);
  }

  return (
    <div className={styles["city-picker"]} ref={boxRef}>
      <input
        className={styles["city-input"]}
        type="text"
        value={input}
        placeholder={cityName || "搜索城市（中文或拼音）…"}
        onChange={(e) => {
          setInput(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && input.trim().length >= 2 ? (
        <div className={styles["city-drop"]}>
          {searching ? <div className={styles["city-hint"]}>搜索中…</div> : null}
          {!searching && err ? <div className={styles["city-hint"]}>搜索失败：{err}</div> : null}
          {!searching && !err && candidates.length === 0 ? (
            <div className={styles["city-hint"]}>未找到匹配城市</div>
          ) : null}
          {candidates.map((c) => (
            <button
              type="button"
              key={`${c.latitude},${c.longitude},${c.name}`}
              className={styles["city-item"]}
              onClick={() => void pick(c)}
              title={labelOf(c)}
            >
              <span className={styles["city-name"]}>{c.name}</span>
              <span className={styles["city-admin"]}>
                {[c.admin1, c.admin2].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {/* 已选城市提示（选中后输入框清空，这里常驻展示当前生效值）。 */}
      {cityName && input.trim().length === 0 ? (
        <div className={styles["city-current"]}>
          当前：{cityName}
          {wStatus === "loading" ? "（取数中…）" : ""}
        </div>
      ) : null}
    </div>
  );
}
