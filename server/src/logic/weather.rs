//! Weather for dashboards and Golden Rule session snapshots.
//!
//! When [StoreWeatherSettings] has a Visual Crossing API key and `enabled`, uses the
//! [Timeline Weather API](https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/).
//! Otherwise falls back to deterministic Buffalo-style mock data.
//!
//! **Env overrides** (optional): `RIVERSIDE_VISUAL_CROSSING_API_KEY` replaces the DB key; `RIVERSIDE_VISUAL_CROSSING_ENABLED`
//! (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`) forces live weather on or off regardless of `weather_config.enabled`.
//!
//! ## API usage cap
//! Each successful outbound Timeline request increments `weather_vc_daily_usage.pull_count` for the
//! current **UTC** calendar day. When the count would exceed the configured max (default **850**,
//! env `RIVERSIDE_WEATHER_VC_MAX_PULLS_PER_DAY`, max **900`), requests fail fast and callers fall back
//! to mock where applicable. Failed HTTP/parse decrements the counter. Identical requests are deduped
//! for `RIVERSIDE_WEATHER_VC_CACHE_SECONDS` (default **900**) without consuming quota.

use anyhow::Context;
use chrono::{Datelike, Duration, NaiveDate, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};
use tracing::{debug, info, warn};

/// Persisted in `store_settings.weather_config` (JSONB).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreWeatherSettings {
    #[serde(default = "default_weather_enabled")]
    pub enabled: bool,
    #[serde(default = "default_location")]
    pub location: String,
    /// `us` (Fahrenheit, inches) or `metric` (converted to F / inches for API consumers).
    #[serde(default = "default_unit_group")]
    pub unit_group: String,
    /// IANA timezone for interpreting "today" in forecast and dashboard ranges.
    #[serde(default = "default_weather_timezone")]
    pub timezone: String,
    #[serde(default)]
    pub api_key: String,
}

fn default_weather_enabled() -> bool {
    false
}

fn default_location() -> String {
    "Buffalo,NY,US".to_string()
}

fn default_unit_group() -> String {
    "us".to_string()
}

fn default_weather_timezone() -> String {
    "America/New_York".to_string()
}

impl Default for StoreWeatherSettings {
    fn default() -> Self {
        Self {
            enabled: default_weather_enabled(),
            location: default_location(),
            unit_group: default_unit_group(),
            timezone: default_weather_timezone(),
            api_key: String::new(),
        }
    }
}

/// Optional Visual Crossing key from the environment (overrides DB `weather_config.api_key`). Never log this value.
pub fn weather_api_key_from_env() -> Option<String> {
    std::env::var("RIVERSIDE_VISUAL_CROSSING_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn weather_enabled_override_from_env() -> Option<bool> {
    match std::env::var("RIVERSIDE_VISUAL_CROSSING_ENABLED").ok() {
        Some(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        None => None,
    }
}

fn is_undefined_table_err(e: &sqlx::Error) -> bool {
    matches!(
        e,
        sqlx::Error::Database(db) if db.code().as_deref() == Some("42P01")
    )
}

/// Applies `RIVERSIDE_VISUAL_CROSSING_*` env overrides for runtime and Settings UI hints.
pub fn merge_weather_env_overrides(mut s: StoreWeatherSettings) -> StoreWeatherSettings {
    if let Some(k) = weather_api_key_from_env() {
        s.api_key = k;
    }
    if let Some(en) = weather_enabled_override_from_env() {
        s.enabled = en;
    }
    s
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyWeatherContext {
    pub date: NaiveDate,
    pub temp_high: f32,
    pub temp_low: f32,
    pub precipitation_inches: f32,
    pub condition: String,
}

/// Live “right now” conditions from Visual Crossing (`currentConditions`); omitted in mock mode except a simple synthetic snapshot from today’s daily row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentWeatherContext {
    pub temp: f32,
    pub feels_like: f32,
    pub condition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub humidity_pct: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_mph: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherForecastResponse {
    pub days: Vec<DailyWeatherContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<CurrentWeatherContext>,
    pub source: String,
}

fn vc_max_pulls_per_day() -> i32 {
    std::env::var("RIVERSIDE_WEATHER_VC_MAX_PULLS_PER_DAY")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| (1..=900).contains(&n))
        .unwrap_or(850)
}

fn vc_cache_ttl() -> StdDuration {
    StdDuration::from_secs(
        std::env::var("RIVERSIDE_WEATHER_VC_CACHE_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&s| s > 0 && s <= 86_400)
            .unwrap_or(900),
    )
}

struct VcCacheEntry {
    expires: Instant,
    payload: (Vec<DailyWeatherContext>, Option<CurrentWeatherContext>),
}

fn vc_cache_map() -> &'static Mutex<HashMap<String, VcCacheEntry>> {
    static M: OnceLock<Mutex<HashMap<String, VcCacheEntry>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn vc_cache_get(key: &str) -> Option<(Vec<DailyWeatherContext>, Option<CurrentWeatherContext>)> {
    let mut g = vc_cache_map().lock().ok()?;
    let now = Instant::now();
    if let Some(ent) = g.get(key) {
        if ent.expires >= now {
            return Some(ent.payload.clone());
        }
    }
    g.remove(key);
    None
}

fn vc_cache_put(key: String, payload: (Vec<DailyWeatherContext>, Option<CurrentWeatherContext>)) {
    if let Ok(mut g) = vc_cache_map().lock() {
        if g.len() > 64 {
            g.clear();
        }
        g.insert(
            key,
            VcCacheEntry {
                expires: Instant::now() + vc_cache_ttl(),
                payload,
            },
        );
    }
}

async fn vc_try_reserve_pull(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let usage_date = Utc::now().date_naive();
    let max = vc_max_pulls_per_day();
    if let Err(e) = sqlx::query(
        r#"INSERT INTO public.weather_vc_daily_usage (usage_date, pull_count) VALUES ($1, 0)
           ON CONFLICT (usage_date) DO NOTHING"#,
    )
    .bind(usage_date)
    .execute(pool)
    .await
    {
        if is_undefined_table_err(&e) {
            debug!(
                "public.weather_vc_daily_usage not on this database; Visual Crossing pull allowed without DB quota tracking"
            );
            return Ok(true);
        }
        return Err(e);
    }

    match sqlx::query_scalar::<_, Option<i32>>(
        r#"UPDATE public.weather_vc_daily_usage
           SET pull_count = pull_count + 1
           WHERE usage_date = $1 AND pull_count < $2
           RETURNING pull_count"#,
    )
    .bind(usage_date)
    .bind(max)
    .fetch_optional(pool)
    .await
    {
        Ok(n) => Ok(n.flatten().is_some()),
        Err(e) if is_undefined_table_err(&e) => {
            debug!(
                "public.weather_vc_daily_usage not on this database; Visual Crossing pull allowed without DB quota tracking"
            );
            Ok(true)
        }
        Err(e) => Err(e),
    }
}

async fn vc_release_pull(pool: &PgPool) {
    let usage_date = Utc::now().date_naive();
    if let Err(e) = sqlx::query(
        r#"UPDATE public.weather_vc_daily_usage
           SET pull_count = GREATEST(0, pull_count - 1)
           WHERE usage_date = $1"#,
    )
    .bind(usage_date)
    .execute(pool)
    .await
    {
        if !is_undefined_table_err(&e) {
            warn!(error = %e, "public.weather_vc_daily_usage release failed");
        }
    }
}

pub async fn load_store_weather_settings(pool: &PgPool) -> StoreWeatherSettings {
    let raw: serde_json::Value = match sqlx::query_scalar(
        "SELECT weather_config FROM store_settings WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            // Migration 46 adds `weather_config`; old DBs are valid until migrated.
            if matches!(
                &e,
                sqlx::Error::Database(db) if db.code().as_deref() == Some("42703")
            ) {
                debug!("store_settings.weather_config missing; apply migration 46_weather_config.sql — using defaults");
                return merge_weather_env_overrides(StoreWeatherSettings::default());
            }
            warn!(error = %e, "load weather_config failed; using defaults");
            return merge_weather_env_overrides(StoreWeatherSettings::default());
        }
    };
    merge_weather_env_overrides(serde_json::from_value(raw).unwrap_or_default())
}

/// Today and tomorrow in the configured store timezone (for short forecast).
pub fn local_today_plus_one_day(timezone: &str) -> (NaiveDate, NaiveDate) {
    let tz = chrono_tz::Tz::from_str(timezone.trim()).unwrap_or(chrono_tz::America::New_York);
    let today = Utc::now().with_timezone(&tz).date_naive();
    let tomorrow = today + Duration::days(1);
    (today, tomorrow)
}

/// Fetches live data when configured; otherwise mock. On upstream errors, logs and uses mock.
pub async fn fetch_weather_range(
    http: &reqwest::Client,
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Vec<DailyWeatherContext> {
    let settings = load_store_weather_settings(pool).await;
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };

    if !settings.enabled || settings.api_key.trim().is_empty() {
        return mock_range(start, end);
    }

    match fetch_visual_crossing(http, pool, &settings, start, end, VcInclude::Days).await {
        Ok((mut rows, _)) => {
            rows.sort_by_key(|r| r.date);
            rows
        }
        Err(e) => {
            warn!(error = %e, "visual crossing request failed; using mock");
            mock_range(start, end)
        }
    }
}

/// Historical daily rows from Visual Crossing only (no mock). Used to refresh stored snapshots after the day has ended.
pub async fn fetch_weather_range_vc_only(
    http: &reqwest::Client,
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<DailyWeatherContext>, String> {
    let settings = load_store_weather_settings(pool).await;
    if !settings.enabled || settings.api_key.trim().is_empty() {
        return Err("visual crossing is disabled or API key is missing".to_string());
    }
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };

    match fetch_visual_crossing(http, pool, &settings, start, end, VcInclude::Days).await {
        Ok((mut rows, _)) => {
            rows.sort_by_key(|r| r.date);
            Ok(rows)
        }
        Err(e) => Err(e),
    }
}

/// After local hour (default 3) on a new store-local day, re-fetch the last 7 calendar days from Visual Crossing
/// and overwrite `weather_snapshot` on closed register sessions and transactions whose local activity date matches.
/// Advances `weather_snapshot_finalize_ledger` only on full success. Skips when VC is off or the API fails.
pub async fn maybe_finalize_daily_weather_snapshots(
    http: &reqwest::Client,
    pool: &PgPool,
) -> anyhow::Result<()> {
    let settings = load_store_weather_settings(pool).await;
    if !settings.enabled || settings.api_key.trim().is_empty() {
        return Ok(());
    }

    let tz =
        chrono_tz::Tz::from_str(settings.timezone.trim()).unwrap_or(chrono_tz::America::New_York);
    let now_local = Utc::now().with_timezone(&tz);
    let store_today = now_local.date_naive();

    let after_hour: u32 = std::env::var("RIVERSIDE_WEATHER_FINALIZE_AFTER_LOCAL_HOUR")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|h| *h < 24)
        .unwrap_or(3);

    if now_local.hour() < after_hour {
        return Ok(());
    }

    let last_completed: NaiveDate = match sqlx::query_scalar(
        "SELECT last_completed_store_date FROM public.weather_snapshot_finalize_ledger WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.unwrap_or(NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch")),
        Err(e) if is_undefined_table_err(&e) => {
            debug!(
                "public.weather_snapshot_finalize_ledger not visible to this connection (wrong database or search_path); skipping EOD finalize"
            );
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };

    if last_completed >= store_today {
        return Ok(());
    }

    let yesterday = store_today - Duration::days(1);
    let range_start = yesterday - Duration::days(6);

    let daily = fetch_weather_range_vc_only(http, pool, range_start, yesterday)
        .await
        .map_err(|e| anyhow::anyhow!("visual crossing finalize fetch: {e}"))?;

    let tz_name = settings.timezone.trim().to_string();
    let mut tx = pool.begin().await?;

    for day in &daily {
        let js = serde_json::to_value(day).context("serialize daily weather")?;

        let n_sessions = sqlx::query(
            r#"
            UPDATE public.register_sessions
            SET weather_snapshot = $1
            WHERE is_open = false
              AND closed_at IS NOT NULL
              AND (closed_at AT TIME ZONE $2)::date = $3::date
            "#,
        )
        .bind(&js)
        .bind(&tz_name)
        .bind(day.date)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        let n_transactions = sqlx::query(
            r#"
            UPDATE public.transactions
            SET weather_snapshot = $1
            WHERE booked_at IS NOT NULL
              AND (booked_at AT TIME ZONE $2)::date = $3::date
            "#,
        )
        .bind(&js)
        .bind(&tz_name)
        .bind(day.date)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        if n_sessions > 0 || n_transactions > 0 {
            info!(
                date = %day.date,
                register_sessions = n_sessions,
                transactions = n_transactions,
                "weather EOD finalize: snapshots updated"
            );
        }
    }

    sqlx::query(
        "UPDATE public.weather_snapshot_finalize_ledger SET last_completed_store_date = $1 WHERE id = 1",
    )
    .bind(store_today)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    info!(
        store_local_date = %store_today,
        range_start = %range_start,
        range_end = %yesterday,
        days = daily.len(),
        "weather EOD finalize completed"
    );

    let _ = crate::logic::integration_alerts::record_integration_success(pool, "weather_finalize")
        .await;

    Ok(())
}

/// Today and tomorrow daily rows plus optional current conditions (Visual Crossing `include=days,current`).
pub async fn fetch_weather_forecast(
    http: &reqwest::Client,
    pool: &PgPool,
) -> WeatherForecastResponse {
    let settings = load_store_weather_settings(pool).await;
    let (today, tomorrow) = local_today_plus_one_day(&settings.timezone);

    if !settings.enabled || settings.api_key.trim().is_empty() {
        let days = mock_range(today, tomorrow);
        let current = days.first().map(mock_current_from_daily);
        return WeatherForecastResponse {
            days,
            current,
            source: "mock".to_string(),
        };
    }

    match fetch_visual_crossing(
        http,
        pool,
        &settings,
        today,
        tomorrow,
        VcInclude::DaysCurrent,
    )
    .await
    {
        Ok((mut days, current)) => {
            if days.is_empty() {
                warn!("visual crossing returned no days; using mock forecast");
                let days = mock_range(today, tomorrow);
                let current = days.first().map(mock_current_from_daily);
                return WeatherForecastResponse {
                    days,
                    current,
                    source: "mock".to_string(),
                };
            }
            days.sort_by_key(|r| r.date);
            let current = current.or_else(|| days.first().map(mock_current_from_daily));
            WeatherForecastResponse {
                days,
                current,
                source: "live".to_string(),
            }
        }
        Err(e) => {
            warn!(error = %e, "visual crossing forecast failed; using mock");
            let days = mock_range(today, tomorrow);
            let current = days.first().map(mock_current_from_daily);
            WeatherForecastResponse {
                days,
                current,
                source: "mock".to_string(),
            }
        }
    }
}

fn mock_current_from_daily(d: &DailyWeatherContext) -> CurrentWeatherContext {
    let mid = (d.temp_high + d.temp_low) / 2.0;
    CurrentWeatherContext {
        temp: mid,
        feels_like: mid,
        condition: d.condition.clone(),
        humidity_pct: None,
        wind_mph: None,
    }
}

#[derive(Clone, Copy)]
enum VcInclude {
    Days,
    /// Matches Visual Crossing `include=days,current` (no `hours` / `alerts` — smaller payload, lower cost than full timeline).
    DaysCurrent,
}

impl VcInclude {
    fn as_param(self) -> &'static str {
        match self {
            VcInclude::Days => "days",
            VcInclude::DaysCurrent => "days,current",
        }
    }
}

#[derive(Deserialize)]
struct VcRoot {
    #[serde(default)]
    days: Vec<VcDay>,
    #[serde(default, rename = "currentConditions")]
    current_conditions: Option<VcCurrent>,
}

#[derive(Deserialize)]
struct VcCurrent {
    temp: Option<f64>,
    feelslike: Option<f64>,
    #[serde(default)]
    conditions: String,
    humidity: Option<f64>,
    windspeed: Option<f64>,
}

#[derive(Deserialize)]
struct VcDay {
    datetime: String,
    tempmax: Option<f64>,
    tempmin: Option<f64>,
    precip: Option<f64>,
    #[serde(default)]
    conditions: String,
}

async fn fetch_visual_crossing(
    http: &reqwest::Client,
    pool: &PgPool,
    settings: &StoreWeatherSettings,
    start: NaiveDate,
    end: NaiveDate,
    include: VcInclude,
) -> Result<(Vec<DailyWeatherContext>, Option<CurrentWeatherContext>), String> {
    let loc = settings.location.trim();
    if loc.is_empty() {
        return Err("weather location is empty".to_string());
    }

    let d1 = start.format("%Y-%m-%d").to_string();
    let d2 = end.format("%Y-%m-%d").to_string();
    let unit = if settings.unit_group.to_lowercase() == "metric" {
        "metric"
    } else {
        "us"
    };

    let cache_key = format!("{}|{}|{}|{}|{}", loc, unit, d1, d2, include.as_param());
    if let Some(hit) = vc_cache_get(&cache_key) {
        return Ok(hit);
    }

    let reserved = vc_try_reserve_pull(pool)
        .await
        .map_err(|e| format!("weather API quota accounting failed: {e}"))?;
    if !reserved {
        return Err(format!(
            "visual crossing daily API quota reached (max {} Timeline pulls per UTC day)",
            vc_max_pulls_per_day()
        ));
    }

    let path_loc = urlencoding::encode(loc);
    // Match Visual Crossing Timeline docs: unitGroup, contentType=json, include for subsections; date range in path.
    let url = format!(
        "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/{}/{}/{}?unitGroup={}&contentType=json&include={}&key={}",
        path_loc,
        d1,
        d2,
        unit,
        include.as_param(),
        urlencoding::encode(settings.api_key.trim())
    );

    let resp = match http.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            vc_release_pull(pool).await;
            return Err(e.to_string());
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        vc_release_pull(pool).await;
        return Err(format!(
            "HTTP {} — {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let parsed: VcRoot = match resp.json().await {
        Ok(p) => p,
        Err(e) => {
            vc_release_pull(pool).await;
            return Err(e.to_string());
        }
    };

    let metric = settings.unit_group.to_lowercase() == "metric";

    let current = parsed
        .current_conditions
        .and_then(|c| map_vc_current(c, metric));

    let mut out = Vec::new();
    for day in parsed.days {
        let date_part = day
            .datetime
            .split('T')
            .next()
            .unwrap_or(day.datetime.as_str());
        let Some(date) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d").ok() else {
            continue;
        };

        if date < start || date > end {
            continue;
        }

        let tmax = day.tempmax.unwrap_or(0.0);
        let tmin = day.tempmin.unwrap_or(0.0);
        let (temp_high, temp_low) = if metric {
            (
                (tmax * 9.0 / 5.0 + 32.0) as f32,
                (tmin * 9.0 / 5.0 + 32.0) as f32,
            )
        } else {
            (tmax as f32, tmin as f32)
        };

        let precip_raw = day.precip.unwrap_or(0.0);
        let precipitation_inches = if metric {
            (precip_raw / 25.4) as f32
        } else {
            precip_raw as f32
        };

        let condition = if day.conditions.trim().is_empty() {
            "Unknown".to_string()
        } else {
            day.conditions
        };

        out.push(DailyWeatherContext {
            date,
            temp_high,
            temp_low,
            precipitation_inches,
            condition,
        });
    }

    if out.is_empty() {
        vc_release_pull(pool).await;
        return Err("visual crossing returned no days in range".to_string());
    }

    let result = (out, current);
    vc_cache_put(cache_key, result.clone());
    Ok(result)
}

fn map_vc_current(c: VcCurrent, metric: bool) -> Option<CurrentWeatherContext> {
    let t = c.temp?;
    let fl = c.feelslike.unwrap_or(t);
    let (temp, feels_like) = if metric {
        (
            (t * 9.0 / 5.0 + 32.0) as f32,
            (fl * 9.0 / 5.0 + 32.0) as f32,
        )
    } else {
        (t as f32, fl as f32)
    };
    let condition = if c.conditions.trim().is_empty() {
        "Unknown".to_string()
    } else {
        c.conditions
    };
    let humidity_pct = c.humidity.map(|h| h as f32);
    let wind_mph = c.windspeed.map(|w| {
        if metric {
            (w * 0.621_371) as f32
        } else {
            w as f32
        }
    });
    Some(CurrentWeatherContext {
        temp,
        feels_like,
        condition,
        humidity_pct,
        wind_mph,
    })
}

fn mock_range(start: NaiveDate, end: NaiveDate) -> Vec<DailyWeatherContext> {
    let mut out = Vec::new();
    let mut curr = start;
    while curr <= end {
        out.push(generate_mock_weather(curr));
        if let Some(n) = curr.succ_opt() {
            curr = n;
        } else {
            break;
        }
    }
    out
}

fn generate_mock_weather(date: NaiveDate) -> DailyWeatherContext {
    let month = date.month();
    let seed = (date.year() as u32 + month + date.day()) % 20;

    let (base_high, base_low) = match month {
        1 => (31.0, 18.0),
        2 => (33.0, 19.0),
        3 => (42.0, 26.0),
        4 => (55.0, 37.0),
        5 => (67.0, 48.0),
        6 => (76.0, 58.0),
        7 => (81.0, 63.0),
        8 => (79.0, 62.0),
        9 => (72.0, 54.0),
        10 => (60.0, 44.0),
        11 => (48.0, 35.0),
        12 => (36.0, 25.0),
        _ => (60.0, 45.0),
    };

    let variance = (seed as f32 % 8.0) - 4.0;
    let temp_high = base_high + variance;
    let temp_low = base_low + (variance * 0.8);

    let mut precip = 0.0;
    let mut condition = "Sunny".to_string();

    if seed % 4 == 0 {
        precip = (seed as f32 % 5.0) * 0.15 + 0.05;
        condition = if temp_high < 34.0 {
            "Snow".to_string()
        } else {
            "Rain".to_string()
        };
    } else if seed % 3 == 0 {
        condition = "Cloudy".to_string();
    } else if seed % 7 == 0 {
        condition = "Partly Cloudy".to_string();
    }

    DailyWeatherContext {
        date,
        temp_high,
        temp_low,
        precipitation_inches: precip,
        condition,
    }
}
