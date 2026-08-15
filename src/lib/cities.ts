/**
 * 预设城市表（前端纯展示数据）。
 *
 * 严格遵守 design §6.2 / §8：**不含任何坐标**。`query` 是 Open-Meteo geocode
 * 查询串（英文城市名），作为城市标识持久化；经纬度由后端首次取天气时 geocode
 * 解析并复用。后端不持有城市表，对 `query` 通用 geocode。
 *
 * `name` 为展示用中文名，`query` 为送往后端的标识。两者解耦：展示名可本地化，
 * 查询串保持 ASCII 稳定（避免拼音歧义）。
 */

export interface City {
  /** 展示用中文名（下拉、Banner 显示）。 */
  name: string;
  /** geocode 查询串（英文城市名），作为城市标识持久化。 */
  query: string;
}

/** 常用城市（国内主要城市，12 个）。 */
export const CITIES: City[] = [
  { name: "北京", query: "Beijing" },
  { name: "上海", query: "Shanghai" },
  { name: "广州", query: "Guangzhou" },
  { name: "深圳", query: "Shenzhen" },
  { name: "杭州", query: "Hangzhou" },
  { name: "成都", query: "Chengdu" },
  { name: "武汉", query: "Wuhan" },
  { name: "西安", query: "Xian" },
  { name: "南京", query: "Nanjing" },
  { name: "重庆", query: "Chongqing" },
  { name: "天津", query: "Tianjin" },
  { name: "长沙", query: "Changsha" },
];

/** query→name 反查；Banner 显示当前城市名用。未命中回退 query 原值。 */
export function cityNameOf(query: string): string {
  return CITIES.find((c) => c.query === query)?.name ?? query;
}
