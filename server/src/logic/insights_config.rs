//! `store_settings.insights_config` — Metabase / Insights policy for admins.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreInsightsConfig {
    /// `reporting_views_only` (default) or `full_database_delegate` (ops uses a privileged DB user in Metabase).
    #[serde(default = "default_data_access_mode")]
    pub data_access_mode: String,
    /// Shown in Settings; optional staff-facing note for Metabase connection / collections.
    #[serde(default)]
    pub staff_note_markdown: String,
    /// When true and `RIVERSIDE_METABASE_JWT_SECRET` is set, Insights calls `POST /api/insights/metabase-launch` to mint a JWT for Metabase (requires Metabase **JWT authentication**, typically a paid plan).
    #[serde(default)]
    pub metabase_jwt_sso_enabled: bool,
    /// Synthetic email domain when `staff.email` is null: `{cashier_code}@{jwt_email_domain}`.
    #[serde(default = "default_jwt_email_domain")]
    pub jwt_email_domain: String,
    /// Free-form ops note (collections, Metabase groups named `ROS Admin`, etc.).
    #[serde(default)]
    pub metabase_collections_note: String,
}

fn default_data_access_mode() -> String {
    "reporting_views_only".to_string()
}

fn default_jwt_email_domain() -> String {
    "riverside-insights.local".to_string()
}

impl Default for StoreInsightsConfig {
    fn default() -> Self {
        Self {
            data_access_mode: default_data_access_mode(),
            staff_note_markdown: String::new(),
            metabase_jwt_sso_enabled: false,
            jwt_email_domain: default_jwt_email_domain(),
            metabase_collections_note: String::new(),
        }
    }
}

impl StoreInsightsConfig {
    pub fn from_json_value(v: Value) -> Self {
        serde_json::from_value(v).unwrap_or_default()
    }

    pub fn to_json_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }

    /// Merge PATCH body (partial object) into current config.
    pub fn apply_patch(&mut self, body: &Value) -> Result<(), String> {
        if let Some(s) = body.get("data_access_mode").and_then(|x| x.as_str()) {
            let t = s.trim();
            if t != "reporting_views_only" && t != "full_database_delegate" {
                return Err(
                    "data_access_mode must be reporting_views_only or full_database_delegate"
                        .to_string(),
                );
            }
            self.data_access_mode = t.to_string();
        }
        if let Some(s) = body.get("staff_note_markdown").and_then(|x| x.as_str()) {
            if s.len() > 65_000 {
                return Err("staff_note_markdown exceeds 65000 bytes".to_string());
            }
            self.staff_note_markdown = s.to_string();
        }
        if let Some(b) = body
            .get("metabase_jwt_sso_enabled")
            .and_then(|x| x.as_bool())
        {
            self.metabase_jwt_sso_enabled = b;
        }
        if let Some(s) = body.get("jwt_email_domain").and_then(|x| x.as_str()) {
            let t = s.trim();
            if t.is_empty() || t.len() > 255 {
                return Err("jwt_email_domain must be 1–255 characters".to_string());
            }
            if t.contains('@') || t.contains(' ') {
                return Err("jwt_email_domain must be a host/domain only (no @)".to_string());
            }
            self.jwt_email_domain = t.to_string();
        }
        if let Some(s) = body
            .get("metabase_collections_note")
            .and_then(|x| x.as_str())
        {
            if s.len() > 65_000 {
                return Err("metabase_collections_note exceeds 65000 bytes".to_string());
            }
            self.metabase_collections_note = s.to_string();
        }
        Ok(())
    }
}
