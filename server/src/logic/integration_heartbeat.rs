use crate::api::qbo;
use crate::logic::fal_sidecar;
use crate::logic::nuorder::{nuorder_client_from_pool, NuorderClientLoadError};
use crate::logic::podium;
use crate::logic::shippo;
use crate::logic::weather;
use chrono::Utc;
use sqlx::PgPool;

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct ConnectivityLog {
    pub id: uuid::Uuid,
    pub source: String,
    pub old_status: String,
    pub new_status: String,
    pub detail: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
}

pub async fn run_integration_heartbeat(
    pool: &PgPool,
    http_client: &reqwest::Client,
    meilisearch_client: Option<&meilisearch_sdk::client::Client>,
) -> Result<(), anyhow::Error> {
    // 1. QBO
    let qbo_h = qbo::health_check(pool, http_client).await;
    let (qbo_status, qbo_detail) = if !qbo_h.configured {
        (
            "CAUTION".to_string(),
            "QBO integration not configured".to_string(),
        )
    } else if qbo_h.reachable {
        ("GOOD".to_string(), "QBO is reachable".to_string())
    } else {
        ("WARNING".to_string(), qbo_h.message)
    };
    let qbo_has_failed = qbo_status == "WARNING";
    record_status(pool, "qbo", &qbo_status, &qbo_detail, qbo_has_failed).await?;

    // 2. Podium
    let podium_h = podium::health_check(http_client).await;
    let (podium_status, podium_detail) = if !podium_h.configured {
        (
            "CAUTION".to_string(),
            "Podium integration not configured".to_string(),
        )
    } else if podium_h.reachable {
        ("GOOD".to_string(), "Podium is reachable".to_string())
    } else {
        ("WARNING".to_string(), podium_h.message)
    };
    let podium_has_failed = podium_status == "WARNING";
    record_status(
        pool,
        "podium",
        &podium_status,
        &podium_detail,
        podium_has_failed,
    )
    .await?;

    // 3. Shippo
    let shippo_h = shippo::health_check(http_client).await;
    let (shippo_status, shippo_detail) = if !shippo_h.configured {
        (
            "CAUTION".to_string(),
            "Shippo integration not configured".to_string(),
        )
    } else if shippo_h.reachable {
        ("GOOD".to_string(), "Shippo is reachable".to_string())
    } else {
        ("WARNING".to_string(), shippo_h.message)
    };
    let shippo_has_failed = shippo_status == "WARNING";
    record_status(
        pool,
        "shippo",
        &shippo_status,
        &shippo_detail,
        shippo_has_failed,
    )
    .await?;

    // 4. Weather
    let weather_h = weather::health_check(http_client, pool).await;
    let (weather_status, weather_detail) = if !weather_h.configured {
        (
            "CAUTION".to_string(),
            "Weather integration not configured".to_string(),
        )
    } else if weather_h.reachable {
        ("GOOD".to_string(), "Weather is reachable".to_string())
    } else {
        ("WARNING".to_string(), weather_h.message)
    };
    let weather_has_failed = weather_status == "WARNING";
    record_status(
        pool,
        "weather",
        &weather_status,
        &weather_detail,
        weather_has_failed,
    )
    .await?;

    // 5. Fal.ai
    let fal_h = fal_sidecar::health_check(http_client).await;
    let (fal_status, fal_detail) = if !fal_h.configured {
        (
            "CAUTION".to_string(),
            "Fal.ai integration not configured".to_string(),
        )
    } else if fal_h.reachable {
        ("GOOD".to_string(), "Fal.ai is reachable".to_string())
    } else {
        ("WARNING".to_string(), fal_h.message)
    };
    let fal_has_failed = fal_status == "WARNING";
    record_status(pool, "fal_ai", &fal_status, &fal_detail, fal_has_failed).await?;

    // 6. NuORDER
    let (nu_status, nu_detail, nu_has_failed) = match nuorder_client_from_pool(pool).await {
        Ok(client) => {
            let nu_h = client.health_check().await;
            if nu_h.reachable {
                (
                    "GOOD".to_string(),
                    "NuORDER is reachable".to_string(),
                    false,
                )
            } else {
                ("WARNING".to_string(), nu_h.message, true)
            }
        }
        Err(error) => {
            let (status, detail, has_failed) = classify_nuorder_load_failure(&error);
            if has_failed {
                tracing::warn!(%error, "NuORDER heartbeat could not load credentials");
            }
            (status.to_string(), detail.to_string(), has_failed)
        }
    };
    record_status(pool, "nuorder", &nu_status, &nu_detail, nu_has_failed).await?;

    // 7. Meilisearch
    let (ms_status, ms_detail) = if let Some(client) = meilisearch_client {
        let ms_h = crate::logic::meilisearch_client::health_check(client).await;
        if ms_h.reachable {
            match crate::logic::meilisearch_search::full_reindex_proof(pool).await {
                Ok(proof) if proof.is_fresh() => (
                    "GOOD".to_string(),
                    format!("Meilisearch is reachable. {}", proof.detail),
                ),
                Ok(proof) => (
                    "CAUTION".to_string(),
                    format!(
                        "Meilisearch is reachable, but search freshness is not proven. {}",
                        proof.detail
                    ),
                ),
                Err(error) => (
                    "CAUTION".to_string(),
                    format!(
                        "Meilisearch is reachable, but full-rebuild proof could not be read: {error}"
                    ),
                ),
            }
        } else {
            ("WARNING".to_string(), ms_h.message)
        }
    } else {
        (
            "CAUTION".to_string(),
            "Meilisearch not configured".to_string(),
        )
    };
    let ms_has_failed = ms_status == "WARNING";
    record_status(pool, "meilisearch", &ms_status, &ms_detail, ms_has_failed).await?;

    Ok(())
}

fn classify_nuorder_load_failure(
    error: &NuorderClientLoadError,
) -> (&'static str, &'static str, bool) {
    match error {
        NuorderClientLoadError::MissingCredentials => {
            ("CAUTION", "NuORDER integration not configured", false)
        }
        NuorderClientLoadError::IncompleteCredentials => {
            ("WARNING", "NuORDER credential set is incomplete", true)
        }
        NuorderClientLoadError::CredentialStore(
            crate::logic::integration_credentials::IntegrationCredentialError::Database(_),
        ) => (
            "WARNING",
            "NuORDER credential store could not be read",
            true,
        ),
        NuorderClientLoadError::CredentialStore(
            crate::logic::integration_credentials::IntegrationCredentialError::InvalidPayload(_),
        ) => (
            "WARNING",
            "NuORDER credentials could not be decrypted or validated",
            true,
        ),
    }
}

async fn record_status(
    pool: &PgPool,
    source: &str,
    new_status: &str,
    detail: &str,
    has_failed: bool,
) -> Result<(), sqlx::Error> {
    let prev: Option<(String,)> =
        sqlx::query_as("SELECT status FROM integration_alert_state WHERE source = $1")
            .bind(source)
            .fetch_optional(pool)
            .await?;

    let old_status = prev.map(|(s,)| s).unwrap_or_else(|| "UNKNOWN".to_string());

    if old_status != new_status {
        // Log transition to ops_connectivity_logs
        sqlx::query(
            r#"
            INSERT INTO ops_connectivity_logs (source, old_status, new_status, detail)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(source)
        .bind(&old_status)
        .bind(new_status)
        .bind(detail)
        .execute(pool)
        .await?;
    }

    // Upsert into integration_alert_state. A skipped/unconfigured probe is CAUTION, not a
    // successful provider call, so it must not advance last_success_at.
    if has_failed {
        sqlx::query(
            r#"
            INSERT INTO integration_alert_state (source, status, last_failure_at, detail, updated_at)
            VALUES ($1, $2, NOW(), $3, NOW())
            ON CONFLICT (source) DO UPDATE SET
                status = EXCLUDED.status,
                last_failure_at = EXCLUDED.last_failure_at,
                detail = EXCLUDED.detail,
                updated_at = EXCLUDED.updated_at
            "#
        )
        .bind(source)
        .bind(new_status)
        .bind(detail)
        .execute(pool)
        .await?;
    } else if new_status.eq_ignore_ascii_case("GOOD") {
        sqlx::query(
            r#"
            INSERT INTO integration_alert_state (source, status, last_success_at, detail, updated_at)
            VALUES ($1, $2, NOW(), $3, NOW())
            ON CONFLICT (source) DO UPDATE SET
                status = EXCLUDED.status,
                last_success_at = EXCLUDED.last_success_at,
                detail = EXCLUDED.detail,
                updated_at = EXCLUDED.updated_at
            "#
        )
        .bind(source)
        .bind(new_status)
        .bind(detail)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO integration_alert_state (source, status, detail, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (source) DO UPDATE SET
                status = EXCLUDED.status,
                detail = EXCLUDED.detail,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(source)
        .bind(new_status)
        .bind(detail)
        .execute(pool)
        .await?;
    }

    Ok(())
}

pub async fn get_connectivity_logs(pool: &PgPool) -> Result<Vec<ConnectivityLog>, sqlx::Error> {
    sqlx::query_as::<_, ConnectivityLog>(
        "SELECT id, source, old_status, new_status, detail, created_at FROM ops_connectivity_logs ORDER BY created_at DESC LIMIT 100"
    )
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::classify_nuorder_load_failure;
    use crate::logic::integration_credentials::IntegrationCredentialError;
    use crate::logic::nuorder::NuorderClientLoadError;

    #[test]
    fn nuorder_missing_config_is_caution_but_bad_credentials_are_warning() {
        assert_eq!(
            classify_nuorder_load_failure(&NuorderClientLoadError::MissingCredentials),
            ("CAUTION", "NuORDER integration not configured", false)
        );
        assert_eq!(
            classify_nuorder_load_failure(&NuorderClientLoadError::IncompleteCredentials),
            ("WARNING", "NuORDER credential set is incomplete", true)
        );
        assert_eq!(
            classify_nuorder_load_failure(&NuorderClientLoadError::CredentialStore(
                IntegrationCredentialError::InvalidPayload("decrypt failed".to_string()),
            )),
            (
                "WARNING",
                "NuORDER credentials could not be decrypted or validated",
                true,
            )
        );
    }
}
