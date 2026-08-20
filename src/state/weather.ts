/**
 * 天气状态（zustand；原 weather.svelte.ts 迁移）。
 *
 * 数据流不变：前端永不直连 Open-Meteo，所有请求经 ipc → Rust。
 * loadWeather() = 读配置 →（未配置则 unconfigured）→ 取数；
 * selectCity(q, c?) = 写配置（可选携带搜索候选的坐标/展示名，免二次 geocode）→ 取数；
 * refreshWeather() = 强制重取（后端 TTL 节流）。
 */

import { create } from "zustand";
import { cityNameOf } from "../lib/cities";
import {
  getCurrentWeather as ipcGetCurrentWeather,
  getWeatherConfig as ipcGetWeatherConfig,
  setCity as ipcSetCity,
} from "../lib/ipc";
import type { CurrentWeather } from "../lib/types";

/** 天气状态机；首页 Banner 与设置页据此分态渲染。 */
export type WeatherStatus = "idle" | "loading" | "ok" | "error" | "unconfigured";

interface WeatherState {
  status: WeatherStatus;
  weather: CurrentWeather | null;
  cityName: string;
  cityQuery: string;
  error: string;

  loadWeather(): Promise<void>;
  selectCity(query: string, candidate?: { name: string } & Coordinates): Promise<void>;
  refreshWeather(): Promise<void>;
}

/** 搜索候选携带的坐标部分（直存免二次 geocode）。 */
interface Coordinates {
  latitude: number;
  longitude: number;
  timezone?: string | null;
}

/** 取数核心：按 cityQuery 状态机取数。 */
async function fetchWeather(set: (partial: Partial<WeatherState>) => void): Promise<void> {
  const q = useWeatherStore.getState().cityQuery;
  if (!q) {
    set({ status: "unconfigured" });
    return;
  }
  set({ status: "loading" });
  try {
    const w = await ipcGetCurrentWeather();
    if (w === null) {
      set({ weather: null, status: "unconfigured" });
      return;
    }
    set({ weather: w, error: "", status: "ok" });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e), status: "error" });
  }
}

export const useWeatherStore = create<WeatherState>()((set) => ({
  status: "idle",
  weather: null,
  cityName: "",
  cityQuery: "",
  error: "",

  loadWeather: async () => {
    try {
      const cfg = await ipcGetWeatherConfig();
      if (cfg === null) {
        set({
          cityQuery: "",
          cityName: "",
          weather: null,
          status: "unconfigured",
        });
        return;
      }
      set({ cityQuery: cfg.query, cityName: cityNameOf(cfg.query) });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), status: "error" });
      return;
    }
    await fetchWeather(set);
  },

  selectCity: async (query, candidate) => {
    await ipcSetCity(
      query,
      candidate
        ? {
            lat: candidate.latitude,
            lng: candidate.longitude,
            tz: candidate.timezone ?? null,
          }
        : null,
    );
    // 展示名：候选优先（中文名）；否则旧预设表反查，再回退 query 原值。
    set({ cityQuery: query, cityName: candidate?.name ?? cityNameOf(query) });
    await fetchWeather(set);
  },

  refreshWeather: async () => {
    await fetchWeather(set);
  },
}));
