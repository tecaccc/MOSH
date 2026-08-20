//! Open-Meteo 天气：geocoding（城市查询串→经纬度/timezone）+ forecast（经纬度→当前天气）。无 API key。
//!
//! 三步（城市坐标由调用方持久化复用，见 `src-tauri` 的 `get_current_weather`；本模块纯无状态）：
//!
//! ```text
//! 1) search   GET geocoding-api.open-meteo.com/v1/search?name=<q>&count=10&language=zh
//!            （多候选：选城市用；geocode 单结果：旧设置首次取数解析坐标）
//! 2) geocode  GET 同上 ?count=1（单结果：旧设置只有 query 时首次取数解析坐标）
//! 3) forecast GET api.open-meteo.com/v1/forecast?latitude=&longitude=
//!             &current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code
//!             &timezone=<tz|auto>
//! ```
//!
//! `weather_code` 为原始 WMO 代码，中文文案/图标映射在前端（见 `weather-code.ts`）。

use crate::error::CoreError;
use serde::{Deserialize, Serialize};

/// HTTP 客户端类型（`reqwest::Client` 别名）。由 `mosh-core` 独占 reqwest 依赖，
/// 上层（src-tauri）经此别名注入 `Tauri State`，无需自行声明 reqwest 依赖。
pub type HttpClient = reqwest::Client;

/// 当前天气（current 子集）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CurrentWeather {
    /// temperature_2m，°C。
    pub temperature: f64,
    /// 体感温度，°C。
    pub apparent_temperature: f64,
    /// relative_humidity_2m，%。
    pub humidity: f64,
    /// WMO weather_code（0=晴 … 95-99=雷暴）。
    pub weather_code: u8,
}

/// 天气城市配置：`query` 为 geocode 查询串（城市标识）；`lat`/`lng`/`tz` 解析后复用。
/// `query` 非空而 `lat` 为 `None` ⇒ 已选城市、尚未解析坐标。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeatherConfig {
    pub query: String,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    #[serde(default)]
    pub tz: Option<String>,
}

impl WeatherConfig {
    /// 坐标是否已解析（lat 与 lng 均存在）。
    pub fn has_coords(&self) -> bool {
        self.lat.is_some() && self.lng.is_some()
    }
}

const GEOCODE_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const CURRENT_VARS: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code";

/// 城市搜索候选（选城市用；含中文展示名与省/市消歧字段，数据源 GeoNames）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CityCandidate {
    /// 城市名（`language=zh` 时为中文名）。
    pub name: String,
    /// 一级行政区（省/州），如「浙江」；可缺。
    pub admin1: Option<String>,
    /// 二级行政区（地级市），如「杭州市」；可缺。
    pub admin2: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    /// IANA 时区，如 `Asia/Shanghai`；可缺。
    pub timezone: Option<String>,
    /// 人口（排序参考；可缺）。
    #[serde(default)]
    pub population: Option<u64>,
}

/// geocoding 返回（仅取需要的字段）。
#[derive(Debug, Deserialize)]
struct GeocodeResponse {
    /// 无匹配时 Open-Meteo 不返回 `results` 键 → serde 视缺失 `Option` 为 `None`。
    results: Option<Vec<GeocodeResult>>,
}

#[derive(Debug, Deserialize)]
struct GeocodeResult {
    #[serde(default)]
    name: String,
    #[serde(default)]
    admin1: Option<String>,
    #[serde(default)]
    admin2: Option<String>,
    latitude: f64,
    longitude: f64,
    timezone: Option<String>,
    #[serde(default)]
    population: Option<u64>,
}

/// forecast 返回的 `current` 子集。
#[derive(Debug, Deserialize)]
struct ForecastResponse {
    current: ForecastCurrent,
}

#[derive(Debug, Deserialize)]
struct ForecastCurrent {
    temperature_2m: f64,
    apparent_temperature: f64,
    relative_humidity_2m: f64,
    weather_code: u8,
}

/// 城市搜索（多候选）：中文名/拼音全拼均可；空结果返回空 Vec（不报错）。
/// 候选按人口降序——重名城市（朝阳/杭州…）靠 admin1/admin2 在 UI 消歧。
pub async fn search_cities(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<CityCandidate>, CoreError> {
    let resp: GeocodeResponse = client
        .get(GEOCODE_URL)
        .query(&[("name", query), ("count", "10"), ("language", "zh")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut list = resp.results.unwrap_or_default();
    list.sort_by(|a, b| {
        b.population
            .unwrap_or(0)
            .cmp(&a.population.unwrap_or(0))
    });
    Ok(list
        .into_iter()
        .map(|r| CityCandidate {
            name: r.name,
            admin1: r.admin1,
            admin2: r.admin2,
            latitude: r.latitude,
            longitude: r.longitude,
            timezone: r.timezone,
            population: r.population,
        })
        .collect())
}

/// 用查询串解析城市经纬度/timezone。无结果 ⇒ `Weather("未找到该城市")`。
pub async fn geocode(
    client: &reqwest::Client,
    query: &str,
) -> Result<(f64, f64, Option<String>), CoreError> {
    let resp: GeocodeResponse = client
        .get(GEOCODE_URL)
        .query(&[("name", query), ("count", "1"), ("language", "zh")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let r = resp
        .results
        .and_then(|mut v| v.pop())
        .ok_or_else(|| CoreError::Weather(format!("未找到该城市：{query}")))?;
    Ok((r.latitude, r.longitude, r.timezone))
}

/// 用经纬度取当前天气。`tz` 为 `None` 时用 `timezone=auto` 让 API 自判。
pub async fn forecast(
    client: &reqwest::Client,
    lat: f64,
    lng: f64,
    tz: Option<&str>,
) -> Result<CurrentWeather, CoreError> {
    let lat_s = lat.to_string();
    let lng_s = lng.to_string();
    let tz_val = tz.unwrap_or("auto");
    let resp: ForecastResponse = client
        .get(FORECAST_URL)
        .query(&[
            ("latitude", lat_s.as_str()),
            ("longitude", lng_s.as_str()),
            ("current", CURRENT_VARS),
            ("timezone", tz_val),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(CurrentWeather {
        temperature: resp.current.temperature_2m,
        apparent_temperature: resp.current.apparent_temperature,
        humidity: resp.current.relative_humidity_2m,
        weather_code: resp.current.weather_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_has_coords_requires_both_lat_lng() {
        let mut c = WeatherConfig::default();
        assert!(!c.has_coords());
        c.lat = Some(30.0);
        assert!(!c.has_coords(), "仅有 lat 不算已解析");
        c.lng = Some(120.0);
        assert!(c.has_coords());
    }

    #[test]
    fn config_serde_roundtrip() {
        let c = WeatherConfig {
            query: "Hangzhou".into(),
            lat: Some(30.29),
            lng: Some(120.16),
            tz: Some("Asia/Shanghai".into()),
        };
        let s = serde_json::to_string(&c).unwrap();
        let back: WeatherConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn parse_forecast_sample() {
        let json = r#"{"current":{"temperature_2m":28.3,"apparent_temperature":30.1,
            "relative_humidity_2m":65,"weather_code":0,"wind_speed_10m":3.2}}"#;
        let f: ForecastResponse = serde_json::from_str(json).unwrap();
        assert!((f.current.temperature_2m - 28.3).abs() < 1e-9);
        assert_eq!(f.current.weather_code, 0);
        // 多余字段（wind_speed_10m）被 serde 忽略。
    }

    #[test]
    fn parse_geocode_sample() {
        let json = r#"{"results":[{"latitude":30.29365,"longitude":120.16142,
            "timezone":"Asia/Shanghai"}]}"#;
        let g: GeocodeResponse = serde_json::from_str(json).unwrap();
        let r = g.results.unwrap().pop().unwrap();
        assert!((r.latitude - 30.29365).abs() < 1e-6);
        assert_eq!(r.timezone.as_deref(), Some("Asia/Shanghai"));
    }

    #[test]
    fn parse_geocode_no_results_key_is_none() {
        // 无匹配时 Open-Meteo 不返回 results 键；serde 视缺失 Option 字段为 None。
        let json = r#"{"generationtime_ms":0.019}"#;
        let g: GeocodeResponse = serde_json::from_str(json).unwrap();
        assert!(g.results.is_none());
    }

    /// 搜索样本（真实响应裁剪）：多候选含 admin1/admin2/population，
    /// 重名城市（朝阳）靠这些字段消歧。无 results 键 → 空 Vec。
    #[test]
    fn parse_search_results_and_sort_by_population() {
        let json = r#"{"results":[
            {"id":8398083,"name":"朝阳","latitude":31.4,"longitude":109.05,
             "country_code":"CN","admin1":"重庆市","admin2":"重庆市",
             "timezone":"Asia/Shanghai","population":13524},
            {"id":2038580,"name":"朝阳","latitude":41.57,"longitude":120.45,
             "country_code":"CN","admin1":"辽宁","admin2":"朝阳市",
             "timezone":"Asia/Shanghai","population":3044527}],
          "generationtime_ms":0.3}"#;
        let g: GeocodeResponse = serde_json::from_str(json).unwrap();
        let mut list = g.results.unwrap();
        list.sort_by(|a, b| {
            b.population.unwrap_or(0).cmp(&a.population.unwrap_or(0))
        });
        // 人口多的辽宁朝阳排前。
        assert_eq!(list[0].admin1.as_deref(), Some("辽宁"));
        assert_eq!(list[0].population, Some(3044527));
        assert_eq!(list[1].admin1.as_deref(), Some("重庆市"));

        // 候选序列化（Tauri 命令返回值）字段完整。
        let c = CityCandidate {
            name: list[0].name.clone(),
            admin1: list[0].admin1.clone(),
            admin2: list[0].admin2.clone(),
            latitude: list[0].latitude,
            longitude: list[0].longitude,
            timezone: list[0].timezone.clone(),
            population: list[0].population,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["admin1"], "辽宁");
        assert!(v["latitude"].as_f64().unwrap() > 41.0);
    }
}
