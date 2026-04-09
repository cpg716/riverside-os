//! Weather API: providing environmental context for sales analysis.

use axum::{
    extract::{Query, State},
    response::Json,
    Router,
};
use chrono::NaiveDate;
use serde::Deserialize;

use crate::api::AppState;
use crate::logic::weather::{
    fetch_weather_forecast, fetch_weather_range, DailyWeatherContext, WeatherForecastResponse,
};

#[derive(Debug, Deserialize)]
pub struct WeatherQuery {
    pub from: NaiveDate,
    pub to: NaiveDate,
}

/// GET /api/weather/history
///
/// Uses Visual Crossing when configured in Settings; otherwise mock Buffalo-style data.
async fn get_weather_history(
    State(state): State<AppState>,
    Query(q): Query<WeatherQuery>,
) -> Json<Vec<DailyWeatherContext>> {
    Json(fetch_weather_range(&state.http_client, &state.db, q.from, q.to).await)
}

/// GET /api/weather/forecast
///
/// Returns today and tomorrow daily rows plus optional `current` (Visual Crossing `currentConditions` when enabled).
async fn get_weather_forecast(State(state): State<AppState>) -> Json<WeatherForecastResponse> {
    Json(fetch_weather_forecast(&state.http_client, &state.db).await)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/history", axum::routing::get(get_weather_history))
        .route("/forecast", axum::routing::get(get_weather_forecast))
}
