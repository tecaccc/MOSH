/**
 * 天气 reactive 状态（Svelte 5 runes 模块级 `$state`）。
 *
 * 遵守 `frontend/state-management` spec 的**函数导出**模式（同 store.svelte.ts /
 * calendar.svelte.ts）：被重新赋值的 `$state`（_status/_weather/_cityName/
 * _cityQuery/_error）一律模块私有，外部只通过导出函数读取，以维持响应式。
 *
 * 数据流（design §1/§7）：前端永不直连 Open-Meteo，所有请求经 ipc → Tauri IPC →
 * Rust（geocode+forecast，含内存缓存与失败回退）。本 store 仅做状态编排：
 *   loadWeather() = 读配置 →（未配置则 unconfigured）→ 取数；
 *   selectCity(q) = 写配置（后端清坐标/缓存）→ 取数；
 *   refreshWeather() = 强制重取（后端 TTL 节流）。
 */

import {
  getCurrentWeather as ipcGetCurrentWeather,
  getWeatherConfig as ipcGetWeatherConfig,
  setCity as ipcSetCity,
} from "./ipc";
import { cityNameOf } from "./cities";
import type { CurrentWeather } from "./types";

/** 天气状态机；首页 Banner 与设置页据此分态渲染（design §7 状态矩阵）。 */
export type WeatherStatus =
  | "idle"
  | "loading"
  | "ok"
  | "error"
  | "unconfigured";

let _status = $state<WeatherStatus>("idle");
let _weather = $state<CurrentWeather | null>(null);
let _cityName = $state<string>("");
let _cityQuery = $state<string>("");
let _error = $state<string>("");

/** 当前状态（响应式）。 */
export function weatherStatus(): WeatherStatus {
  return _status;
}

/** 当前天气数据（响应式；`ok` 态有值，其余为 null）。 */
export function weather(): CurrentWeather | null {
  return _weather;
}

/** 当前城市中文名（响应式；由 query 反查，未命中回退 query 原值）。 */
export function cityName(): string {
  return _cityName;
}

/** 当前城市 query 标识（响应式；设置页下拉回显用）。 */
export function cityQuery(): string {
  return _cityQuery;
}

/** 最近一次取数错误信息（响应式；`error` 态有值）。 */
export function weatherError(): string {
  return _error;
}

/**
 * 取数核心：假定 `_cityQuery` 已就位（来自配置或刚选的城市），按状态机取数。
 * - `getCurrentWeather()` 返回 null ⇒ 未配置城市（unconfigured）。
 * - resolve ⇒ ok；reject ⇒ error。
 */
async function fetchWeather(): Promise<void> {
  if (!_cityQuery) {
    _status = "unconfigured";
    return;
  }
  _status = "loading";
  try {
    const w = await ipcGetCurrentWeather();
    if (w === null) {
      _weather = null;
      _status = "unconfigured";
      return;
    }
    _weather = w;
    _error = "";
    _status = "ok";
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
    _status = "error";
  }
}

/**
 * 读配置并取数。首页 onMount、城市变更后调用。
 * - 配置读取失败（非 Tauri 环境/IPC 异常）⇒ error 态。
 * - 未配置 ⇒ unconfigured；否则按城市取数。
 */
export async function loadWeather(): Promise<void> {
  try {
    const cfg = await ipcGetWeatherConfig();
    if (cfg === null) {
      _cityQuery = "";
      _cityName = "";
      _weather = null;
      _status = "unconfigured";
      return;
    }
    _cityQuery = cfg.query;
    _cityName = cityNameOf(cfg.query);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
    _status = "error";
    return;
  }
  await fetchWeather();
}

/**
 * 选择（切换）城市。后端 `set_city` 会清空旧坐标与天气缓存，对新城首次 geocode。
 * 写入后立即取数，使设置页与首页同步刷新到新城市天气。
 */
export async function selectCity(query: string): Promise<void> {
  await ipcSetCity(query);
  _cityQuery = query;
  _cityName = cityNameOf(query);
  await fetchWeather();
}

/** 强制重取（用户点「重试」）。后端内存缓存 TTL（30min）负责节流。 */
export async function refreshWeather(): Promise<void> {
  await fetchWeather();
}
