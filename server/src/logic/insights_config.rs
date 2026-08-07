//! `store_settings.insights_config` — native Insights policy for admins.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreInsightsConfig {
    /// Native Insights is deliberately restricted to governed `reporting.*` models.
    #[serde(default = "default_data_access_mode")]
    pub data_access_mode: String,
    /// Optional staff-facing reporting guidance.
    #[serde(default)]
    pub staff_note_markdown: String,
    /// Maximum rows returned by one native Insights query (hard-capped at 500).
    #[serde(default = "default_max_rows", alias = "cube_max_rows")]
    pub max_rows: i64,
    /// Automatically archive unpinned history after this many unused days.
    #[serde(default = "default_history_archive_days")]
    pub history_archive_days: i32,
}

pub async fn reporting_engine_ready(pool: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT COALESCE(BOOL_AND(TO_REGCLASS(view_name) IS NOT NULL), FALSE)
        FROM UNNEST(ARRAY[
            'reporting.transactions_core',
            'reporting.order_lines',
            'reporting.fulfillment_orders_core',
            'reporting.wedding_party_economics',
            'reporting.payment_ledger',
            'reporting.inventory_snapshot',
            'reporting.loyalty_customer_snapshot',
            'reporting.alterations_active',
            'reporting.shipments_active',
            'reporting.daily_sales_weather'
        ]) AS required_views(view_name)
        "#,
    )
    .fetch_one(pool)
    .await
}

fn default_data_access_mode() -> String {
    "reporting_views_only".to_string()
}

fn default_max_rows() -> i64 {
    500
}

fn default_history_archive_days() -> i32 {
    180
}

impl Default for StoreInsightsConfig {
    fn default() -> Self {
        Self {
            data_access_mode: default_data_access_mode(),
            staff_note_markdown: String::new(),
            max_rows: default_max_rows(),
            history_archive_days: default_history_archive_days(),
        }
    }
}

impl StoreInsightsConfig {
    pub fn from_json_value(value: Value) -> Self {
        let mut config: Self = serde_json::from_value(value).unwrap_or_default();
        // Retired Metabase configurations could delegate the full database. The
        // native replacement always fails back to the governed reporting schema.
        config.data_access_mode = default_data_access_mode();
        config.max_rows = config.max_rows.clamp(25, 500);
        config.history_archive_days = config.history_archive_days.clamp(30, 730);
        config
    }

    pub fn to_json_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }

    /// Merge PATCH body (partial object) into current config.
    pub fn apply_patch(&mut self, body: &Value) -> Result<(), String> {
        if let Some(mode) = body.get("data_access_mode").and_then(Value::as_str) {
            if mode.trim() != "reporting_views_only" {
                return Err("data_access_mode must be reporting_views_only".to_string());
            }
            self.data_access_mode = default_data_access_mode();
        }
        if let Some(note) = body.get("staff_note_markdown").and_then(Value::as_str) {
            if note.len() > 65_000 {
                return Err("staff_note_markdown exceeds 65000 bytes".to_string());
            }
            self.staff_note_markdown = note.to_string();
        }
        if let Some(max_rows) = body
            .get("max_rows")
            .or_else(|| body.get("cube_max_rows"))
            .and_then(Value::as_i64)
        {
            if !(25..=500).contains(&max_rows) {
                return Err("max_rows must be between 25 and 500".to_string());
            }
            self.max_rows = max_rows;
        }
        if let Some(days) = body.get("history_archive_days").and_then(Value::as_i64) {
            if !(30..=730).contains(&days) {
                return Err("history_archive_days must be between 30 and 730".to_string());
            }
            self.history_archive_days = days as i32;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_full_database_mode_is_not_restored() {
        let config = StoreInsightsConfig::from_json_value(json!({
            "data_access_mode": "full_database_delegate"
        }));
        assert_eq!(config.data_access_mode, "reporting_views_only");
    }

    #[test]
    fn validates_native_limits() {
        let mut config = StoreInsightsConfig::default();
        assert!(config.apply_patch(&json!({ "max_rows": 501 })).is_err());
        config
            .apply_patch(&json!({
                "max_rows": 250,
                "history_archive_days": 180
            }))
            .expect("valid policy");
        assert_eq!(config.max_rows, 250);
        assert_eq!(config.history_archive_days, 180);
    }
}
