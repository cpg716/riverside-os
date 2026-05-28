//! Daily update check: compares running version against latest GitHub release,
//! broadcasts an admin notification when a newer version is available.

use chrono::Timelike;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/cpg716/riverside-os/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    /// Whether right now is within the safe update window (before open / after close).
    pub safe_window: bool,
    /// Human-readable guidance on when to update.
    pub safe_window_hint: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    body: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
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

/// Fetch the latest GitHub release and compare to the running server version.
pub async fn check_for_update(client: &reqwest::Client) -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let res = client
        .get(GITHUB_RELEASES_URL)
        .header("User-Agent", "RiversideOS-UpdateCheck")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("GitHub API returned {}", res.status()));
    }

    let release: GithubRelease = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub release: {e}"))?;

    let latest = strip_v(&release.tag_name).to_string();
    let update_available = latest != strip_v(&current);

    let (safe_window, safe_window_hint) = is_safe_update_window();

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version: latest,
        update_available,
        release_notes: release.body,
        release_url: release.html_url,
        published_at: release.published_at,
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
            "Daily update check: already on latest"
        );
        return;
    }

    let message = format!(
        "Riverside OS {} is available (you are on {}). {}",
        result.latest_version, result.current_version, result.safe_window_hint,
    );

    // Dedupe key: one notification per (version, day) pair so it doesn't spam every hour.
    let today = chrono::Utc::now().format("%Y-%m-%d");
    let dedup_key = format!("update_available_{}_{}", result.latest_version, today);

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
