//! Daily update check: compares running version AND build SHA against the
//! published latest.json updater manifest, so new builds of the same version
//! are also detected.

use chrono::Timelike;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

/// The updater manifest is published to the GitHub release as `latest.json`.
/// We read it directly so we can compare `build_sha` in addition to `version`.
const LATEST_JSON_URL: &str =
    "https://github.com/cpg716/riverside-os/releases/latest/download/latest.json";

/// Build SHA injected at compile time by the build script (`build.rs`).
/// Falls back to "dev" in local builds where the env var is absent.
const CURRENT_BUILD_SHA: &str = env!("RIVERSIDE_GIT_SHA");

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub current_build_sha: String,
    pub latest_version: String,
    pub latest_build_sha: Option<String>,
    pub update_available: bool,
    /// True when the version matches but the build SHA differs (same-version rebuild).
    pub rebuild_available: bool,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    /// Whether right now is within the safe update window (before open / after close).
    pub safe_window: bool,
    /// Human-readable guidance on when to update.
    pub safe_window_hint: String,
}

#[derive(Deserialize)]
struct LatestManifest {
    /// Semver string, e.g. "0.80.9"
    version: String,
    /// Full git commit SHA of the build, e.g. "abc1234..." — added in v0.80.9+.
    /// Absent in older manifests; treated as unknown.
    build_sha: Option<String>,
    /// ISO-8601 publish date from the workflow.
    pub_date: Option<String>,
    /// Release notes body.
    notes: Option<String>,
}

/// Returns true when the local time is before 10 AM or after 6 PM — i.e. before
/// the store opens or after it closes.  Admin staff should run updates then.
pub fn is_safe_update_window() -> (bool, String) {
    let now = chrono::Local::now();
    let hour = now.hour();
    if hour < 10 {
        (
            true,
            format!(
                "Good time to update — it's {}:{:02} AM, before store hours.",
                hour,
                now.minute()
            ),
        )
    } else if hour >= 18 {
        (
            true,
            format!(
                "Good time to update — it's {}:{:02} PM, after store hours.",
                hour - 12,
                now.minute()
            ),
        )
    } else {
        (
            false,
            format!(
                "Store is open ({}:{:02}). Schedule the update before 10 AM or after 6 PM.",
                if hour > 12 { hour - 12 } else { hour },
                now.minute()
            ),
        )
    }
}

/// Strip a leading 'v' from a GitHub tag so "v0.80.9" compares equal to "0.80.9".
fn strip_v(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

/// Fetch the published `latest.json` updater manifest and compare both the
/// semver version AND the build SHA to the running server.
///
/// `update_available` is true when the version is strictly newer.
/// `rebuild_available` is true when the version matches but the build SHA differs
/// (i.e. the same release tag was re-published with a new build).
pub async fn check_for_update(client: &reqwest::Client) -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let current_sha = CURRENT_BUILD_SHA.to_string();

    let res = client
        .get(LATEST_JSON_URL)
        .header("User-Agent", "RiversideOS-UpdateCheck")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest.json: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("latest.json returned HTTP {}", res.status()));
    }

    let manifest: LatestManifest = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse latest.json: {e}"))?;

    let latest_ver = strip_v(&manifest.version).to_string();
    let current_ver = strip_v(&current).to_string();

    let version_newer = latest_ver != current_ver;
    let rebuild_available = !version_newer
        && manifest
            .build_sha
            .as_deref()
            .map(|sha| {
                // Compare full SHA or the first 8 chars against CURRENT_BUILD_SHA
                let current_short = &current_sha[..current_sha.len().min(8)];
                let latest_short = &sha[..sha.len().min(8)];
                latest_short != current_short && current_sha != "dev"
            })
            .unwrap_or(false);

    let update_available = version_newer || rebuild_available;

    let (safe_window, safe_window_hint) = is_safe_update_window();

    Ok(UpdateCheckResult {
        current_version: current,
        current_build_sha: current_sha,
        latest_version: latest_ver,
        latest_build_sha: manifest.build_sha,
        update_available,
        rebuild_available,
        release_notes: manifest.notes,
        published_at: manifest.pub_date,
        safe_window,
        safe_window_hint,
    })
}

/// Run once per day: check GitHub for a newer release and notify all admin staff
/// if one is found.  Deduped by day — will not fire more than once per calendar day.
pub async fn run_daily_update_check(pool: &PgPool, client: &reqwest::Client) {
    let result = match check_for_update(client).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "Daily update check failed");
            return;
        }
    };

    if !result.update_available {
        tracing::debug!(
            version = %result.current_version,
            sha = %result.current_build_sha,
            "Daily update check: already on latest"
        );
        return;
    }

    let message = if result.rebuild_available {
        format!(
            "Riverside OS {} has a new build available (current build: {}). {}",
            result.latest_version,
            &result.current_build_sha[..result.current_build_sha.len().min(8)],
            result.safe_window_hint,
        )
    } else {
        format!(
            "Riverside OS {} is available (you are on {}). {}",
            result.latest_version, result.current_version, result.safe_window_hint,
        )
    };

    // Dedupe key: one notification per (version+sha, day) so same-version rebuilds
    // also fire once per day without spamming.
    let today = chrono::Utc::now().format("%Y-%m-%d");
    let sha_short = result
        .latest_build_sha
        .as_deref()
        .map(|s| &s[..s.len().min(8)])
        .unwrap_or("unknown");
    let dedup_key = format!(
        "update_available_{}_{}_{}",
        result.latest_version, sha_short, today
    );

    if let Err(e) =
        broadcast_update_notification(pool, &message, &result.latest_version, &dedup_key).await
    {
        tracing::warn!(error = %e, "Failed to broadcast update notification");
    } else {
        tracing::info!(
            latest = %result.latest_version,
            current = %result.current_version,
            "Update available — admin notification sent"
        );
    }
}

async fn broadcast_update_notification(
    pool: &PgPool,
    message: &str,
    version: &str,
    dedup_key: &str,
) -> Result<(), sqlx::Error> {
    use crate::logic::notifications::{
        fan_out_notification_to_staff_ids, insert_app_notification_deduped,
    };
    use serde_json::json;
    use uuid::Uuid;

    let admin_staff: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT sp.staff_id
        FROM staff_permissions sp
        JOIN permissions p ON sp.permission_id = p.id
        WHERE p.key = 'settings.admin'
          AND sp.granted = TRUE
        "#,
    )
    .fetch_all(pool)
    .await?;

    if admin_staff.is_empty() {
        tracing::warn!("No admin staff found for update notification");
        return Ok(());
    }

    let notification_id = insert_app_notification_deduped(
        pool,
        "update_available",
        &format!("Riverside OS {} Available", version),
        message,
        json!({ "route": "/settings/updates" }),
        "system",
        json!({ "roles": ["admin"] }),
        Some(dedup_key),
    )
    .await?;

    if let Some(id) = notification_id {
        fan_out_notification_to_staff_ids(pool, id, &admin_staff).await?;
    }

    Ok(())
}
