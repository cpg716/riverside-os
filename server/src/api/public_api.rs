//! Unauthenticated read-only endpoints for public surfaces (e.g. storefront embeds).

use axum::{extract::State, Json};
use serde::Serialize;

use crate::api::AppState;
use crate::logic::podium;

#[derive(Debug, Serialize)]
pub struct StorefrontEmbedsResponse {
    pub podium_widget: PodiumWidgetPublic,
}

#[derive(Debug, Serialize)]
pub struct PodiumWidgetPublic {
    pub enabled: bool,
    /// Raw HTML/JS snippet from Podium dashboard (inject only on public storefront builds).
    pub snippet_html: String,
}

pub async fn get_storefront_embeds(
    State(state): State<AppState>,
) -> Json<StorefrontEmbedsResponse> {
    let cfg = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT podium_sms_config FROM store_settings WHERE id = 1",
    )
    .fetch_one(&state.db)
    .await
    .ok()
    .map(podium::StorePodiumSmsConfig::load_from_json)
    .unwrap_or_default();

    let enabled = cfg.widget_embed_enabled && !cfg.widget_snippet_html.trim().is_empty();
    Json(StorefrontEmbedsResponse {
        podium_widget: PodiumWidgetPublic {
            enabled,
            snippet_html: if enabled {
                cfg.widget_snippet_html
            } else {
                String::new()
            },
        },
    })
}

pub fn router() -> axum::Router<AppState> {
    use axum::routing::get;
    axum::Router::new().route("/storefront-embeds", get(get_storefront_embeds))
}
