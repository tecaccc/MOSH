/**
 * 旧预设城市表（仅兼容反查；新选择走搜索，不再依赖此表）。
 *
 * 严格遵守 design §6.2 / §8：**不含任何坐标**。`query` 是 Open-Meteo geocode
 * 查询串（英文城市名），作为旧版设置的城市标识持久化；坐标由后端首次取天气时
 * geocode 解析并复用。v0.5.2 起新选城市直接存中文名 + 候选坐标（见 CityPicker），
 * 本表仅为旧设置的城市名反查服务（Banner 显示），不再增长。
 */

export interface City {
  /** 展示用中文名（下拉、Banner 显示）。 */
  name: string;
  /** geocode 查询串（英文城市名），作为城市标识持久化。 */
  query: string;
}

/** 旧版常用城市（国内主要城市，12 个；新选择不再经过此表）。 */
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

/** query→name 反查；Banner 显示当前城市名用。未命中（新选城市已存中文名）
 * 回退 query 原值——新选择的城市名本身就是中文展示名，直接可显。 */
export function cityNameOf(query: string): string {
  return CITIES.find((c) => c.query === query)?.name ?? query;
}
