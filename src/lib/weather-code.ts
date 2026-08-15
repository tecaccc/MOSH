/**
 * WMO weather_code → 中文文案/图标映射（design §6.6）。
 *
 * 后端只回传原始 WMO 数值（`u8`），文案与图标归属前端：贴近 UI、改图标免重编 Rust。
 * 图标为内联 SVG（currentColor 取色，stroke 风格贴近 HomeView 现有 lucide 图标）；
 * 实际尺寸由消费方 CSS 控制（如 `.weather-ico :global(svg)` 设 40px）。
 *
 * WMO weather_code 全集见 Open-Meteo 文档；此处覆盖常见代码，未知代码回退"未知"。
 */

/** 图标键：对应 `WEATHER_ICONS` 中的一组内联 SVG。 */
export type WeatherIcon =
  | "sun"
  | "cloud-sun"
  | "cloud"
  | "fog"
  | "rain"
  | "snow"
  | "storm";

export interface WeatherInfo {
  /** 中文文案（晴/多云/小雨/雷暴…）。 */
  label: string;
  /** 图标键。 */
  icon: WeatherIcon;
}

/** 未知/超出映射表的代码统一回退。 */
const UNKNOWN: WeatherInfo = { label: "未知", icon: "cloud" };

/**
 * 按 WMO weather_code 返回中文文案与图标键。
 * 覆盖：0,1-3,45,48,51-57,61-67,71-77,80-82,85-86,95-99。
 */
export function weatherInfo(code: number): WeatherInfo {
  switch (code) {
    case 0:
      return { label: "晴", icon: "sun" };
    case 1:
      return { label: "晴间多云", icon: "cloud-sun" };
    case 2:
      return { label: "多云", icon: "cloud-sun" };
    case 3:
      return { label: "阴", icon: "cloud" };
    case 45:
      return { label: "雾", icon: "fog" };
    case 48:
      return { label: "雾凇", icon: "fog" };
    case 51:
      return { label: "小毛毛雨", icon: "rain" };
    case 53:
      return { label: "毛毛雨", icon: "rain" };
    case 55:
      return { label: "密毛毛雨", icon: "rain" };
    case 56:
      return { label: "小冻毛毛雨", icon: "rain" };
    case 57:
      return { label: "密冻毛毛雨", icon: "rain" };
    case 61:
      return { label: "小雨", icon: "rain" };
    case 63:
      return { label: "中雨", icon: "rain" };
    case 65:
      return { label: "大雨", icon: "rain" };
    case 66:
      return { label: "小冻雨", icon: "rain" };
    case 67:
      return { label: "冻雨", icon: "rain" };
    case 71:
      return { label: "小雪", icon: "snow" };
    case 73:
      return { label: "中雪", icon: "snow" };
    case 75:
      return { label: "大雪", icon: "snow" };
    case 77:
      return { label: "雪粒", icon: "snow" };
    case 80:
      return { label: "小阵雨", icon: "rain" };
    case 81:
      return { label: "阵雨", icon: "rain" };
    case 82:
      return { label: "强阵雨", icon: "rain" };
    case 85:
      return { label: "小阵雪", icon: "snow" };
    case 86:
      return { label: "强阵雪", icon: "snow" };
    case 95:
      return { label: "雷暴", icon: "storm" };
    case 96:
      return { label: "雷暴伴小冰雹", icon: "storm" };
    case 99:
      return { label: "雷暴伴冰雹", icon: "storm" };
    default:
      return UNKNOWN;
  }
}

/** SVG 共用样式（与 HomeView 内联图标一致的 stroke 风格）。 */
const S =
  'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" viewBox="0 0 24 24"';

/**
 * 图标键 → 内联 SVG markup。
 * 用 `{@html weatherIconSvg(info.icon)}` 渲染；currentColor 取色，CSS 控尺寸。
 */
export const WEATHER_ICONS: Record<WeatherIcon, string> = {
  sun: `<svg ${S}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
  "cloud-sun": `<svg ${S}><circle cx="8" cy="7" r="2.5"/><path d="M8 1.5v1.5M8 11v1.5M2.5 7H4M12 7h1.5M3.64 2.64l1.06 1.06M11.36 10.36l1.06 1.06M11.36 3.64l-1.06 1.06M3.64 11.36l1.06-1.06"/><path d="M18 19H9a3.5 3.5 0 1 1 .8-6.9A4.5 4.5 0 0 1 18.5 13 3.5 3.5 0 0 1 18 19z"/></svg>`,
  cloud: `<svg ${S}><path d="M18 18H7a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 18.5 11 4 4 0 0 1 18 18z"/></svg>`,
  fog: `<svg ${S}><path d="M17 12H7a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 12z"/><path d="M4 16h13M5 19.5h11"/></svg>`,
  rain: `<svg ${S}><path d="M17 12H7a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 12z"/><path d="M8 15.5l-1 3M12 15.5l-1 3M16 15.5l-1 3"/></svg>`,
  snow: `<svg ${S}><path d="M17 12H7a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 12z"/><path d="M8 17.5v2M7 18.5h2M12 17.5v2M11 18.5h2M16 17.5v2M15 18.5h2"/></svg>`,
  storm: `<svg ${S}><path d="M17 12H7a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 12z"/><path d="M11.5 13l-2.5 5h3l-1.5 4 4.5-6.5h-3l1-2.5z"/></svg>`,
};
