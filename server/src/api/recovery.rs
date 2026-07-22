use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_can_approve_manager_access, REGISTER_REPORTS,
};
use crate::auth::pins;
use crate::logic::transaction_checkout::{
    checkout_request_fingerprints, execute_recovery_checkout, CheckoutDone,
    CheckoutRecoveryContext, CheckoutRecoverySource, CheckoutRequest,
};
use crate::middleware::{self, StaffOrPosSession};

const MAX_RECOVERY_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
enum RecoveryError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("recovery job not found")]
    NotFound,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for RecoveryError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::Unauthorized(message) => (StatusCode::UNAUTHORIZED, message),
            Self::Forbidden(message) => (StatusCode::FORBIDDEN, message),
            Self::NotFound => (StatusCode::NOT_FOUND, "recovery job not found".to_string()),
            Self::Database(error) => {
                tracing::error!(error = %error, "operational recovery database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

fn map_auth_error(error: (StatusCode, Json<Value>)) -> RecoveryError {
    let (status, Json(body)) = error;
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => RecoveryError::Unauthorized(message),
        StatusCode::FORBIDDEN => RecoveryError::Forbidden(message),
        _ => RecoveryError::BadRequest(message),
    }
}

async fn require_recovery_caller(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<StaffOrPosSession, RecoveryError> {
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map_err(map_auth_error)
}

#[derive(Debug, Deserialize)]
struct UpsertRecoveryJob {
    client_job_key: String,
    kind: String,
    status: String,
    register_session_id: Option<Uuid>,
    transaction_id: Option<Uuid>,
    checkout_client_id: Option<Uuid>,
    label: Option<String>,
    payload: Value,
    last_error: Option<String>,
    attempt_count: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ResolveRecoveryJob {
    status: String,
    resolution_note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StationCloseStatusRequest {
    pending_checkout_count: i32,
    blocked_checkout_count: i32,
}

#[derive(Debug, Deserialize)]
struct ReplayCheckoutRecoveryRequest {
    manager_staff_id: Uuid,
    manager_pin: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PickupRecoveryStep {
    ShipTransaction {
        transaction_id: Uuid,
        #[serde(default)]
        transaction_line_ids: Vec<Uuid>,
    },
    PickupTransaction {
        transaction_id: Uuid,
        #[serde(default)]
        transaction_line_ids: Vec<Uuid>,
    },
    AlterationPickup {
        alteration_id: Uuid,
    },
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct RecoveryJob {
    client_job_key: String,
    kind: String,
    status: String,
    register_session_id: Option<Uuid>,
    transaction_id: Option<Uuid>,
    checkout_client_id: Option<Uuid>,
    station_key: Option<String>,
    label: Option<String>,
    payload: Value,
    last_error: Option<String>,
    attempt_count: i32,
    first_seen_at: chrono::DateTime<chrono::Utc>,
    last_seen_at: chrono::DateTime<chrono::Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_recovery_jobs).post(upsert_recovery_job))
        .route("/station-close-status", post(report_station_close_status))
        .route(
            "/{client_job_key}/replay-checkout",
            post(replay_checkout_recovery_job),
        )
        .route(
            "/{client_job_key}/verify-follow-up",
            post(verify_pickup_recovery_job),
        )
        .route("/{client_job_key}", patch(resolve_recovery_job))
}

fn header_text(headers: &HeaderMap, name: &'static str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_kind(kind: &str) -> Result<&str, RecoveryError> {
    if kind == "exchange_settlement" {
        return Err(RecoveryError::BadRequest(
            "exchange settlement recovery is server-owned and can only be created by replacement checkout"
                .to_string(),
        ));
    }
    match kind {
        "checkout_offline" | "checkout_unconfirmed" | "pickup_after_payment" | "receipt_print" => {
            Ok(kind)
        }
        _ => Err(RecoveryError::BadRequest(
            "unsupported recovery job kind".to_string(),
        )),
    }
}

fn contains_sensitive_pin_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            pins::is_sensitive_pin_metadata_key(key) || contains_sensitive_pin_key(nested)
        }),
        Value::Array(values) => values.iter().any(contains_sensitive_pin_key),
        Value::String(encoded) => serde_json::from_str::<Value>(encoded)
            .ok()
            .filter(|decoded| decoded.is_object() || decoded.is_array())
            .is_some_and(|decoded| contains_sensitive_pin_key(&decoded)),
        _ => false,
    }
}

#[cfg(test)]
mod sensitive_recovery_payload_tests {
    use super::contains_sensitive_pin_key;
    use serde_json::json;

    #[test]
    fn rejects_pin_alias_suffixes_at_any_json_depth() {
        for payload in [
            json!({"pin": "1234"}),
            json!({"nested": {"backup_staff_pin": "1234"}}),
            json!({"rows": [{"supervisorManagerPin": "1234"}]}),
            json!({"approval": {"temporary-access-pin": "1234"}}),
            json!({"x-riverside-staff-pin": "1234"}),
        ] {
            assert!(contains_sensitive_pin_key(&payload));
        }
    }

    #[test]
    fn rejects_pin_keys_hidden_in_string_encoded_json() {
        assert!(contains_sensitive_pin_key(&json!({
            "metadata": "{\"nested\":[{\"manager_pin\":\"1234\"}]}"
        })));
        assert!(contains_sensitive_pin_key(&json!({
            "metadata": "[{\"payload\":\"{\\\"staffPin\\\":\\\"1234\\\"}\"}]"
        })));
    }

    #[test]
    fn permits_non_secret_pin_substrings_and_plain_string_values() {
        assert!(!contains_sensitive_pin_key(&json!({
            "shipping": "pin",
            "campaign": "spring",
            "manager_reason": "Manager approved after review",
            "metadata": "{\"opinion\":\"pin\"}"
        })));
    }
}

async fn report_station_close_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StationCloseStatusRequest>,
) -> Result<Json<Value>, RecoveryError> {
    if request.pending_checkout_count < 0 || request.blocked_checkout_count < 0 {
        return Err(RecoveryError::BadRequest(
            "checkout recovery counts cannot be negative".to_string(),
        ));
    }
    let caller = require_recovery_caller(&state, &headers).await?;
    let StaffOrPosSession::PosSession { session_id } = caller else {
        return Err(RecoveryError::Forbidden(
            "station close acknowledgement requires an active Register session".to_string(),
        ));
    };
    let station_key = header_text(&headers, "x-riverside-station-key").ok_or_else(|| {
        RecoveryError::BadRequest("Register workstation identity is missing".to_string())
    })?;
    let lifecycle: Option<(String, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        r#"
        SELECT lifecycle_status, reconcile_started_at
        FROM register_sessions
        WHERE id = $1 AND is_open = true
        "#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((lifecycle_status, reconcile_started_at)) = lifecycle else {
        return Err(RecoveryError::BadRequest(
            "Register session is not open".to_string(),
        ));
    };

    let eligible = lifecycle_status == "reconciling" && reconcile_started_at.is_some();
    if eligible {
        sqlx::query(
            r#"
            INSERT INTO register_station_close_acknowledgement (
                register_session_id, station_key,
                pending_checkout_count, blocked_checkout_count, acknowledged_at
            )
            VALUES ($1, $2, $3, $4, now())
            ON CONFLICT (register_session_id, station_key) DO UPDATE SET
                pending_checkout_count = EXCLUDED.pending_checkout_count,
                blocked_checkout_count = EXCLUDED.blocked_checkout_count,
                acknowledged_at = now()
            "#,
        )
        .bind(session_id)
        .bind(&station_key)
        .bind(request.pending_checkout_count)
        .bind(request.blocked_checkout_count)
        .execute(&state.db)
        .await?;
    }

    Ok(Json(json!({
        "lifecycle_status": lifecycle_status,
        "eligible_for_close_acknowledgement": eligible,
    })))
}

async fn replay_checkout_recovery_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(client_job_key): Path<String>,
    Json(request): Json<ReplayCheckoutRecoveryRequest>,
) -> Result<Json<Value>, RecoveryError> {
    require_recovery_caller(&state, &headers).await?;
    let reason = request.reason.trim();
    if reason.chars().count() < 12 || reason.chars().count() > 500 {
        return Err(RecoveryError::BadRequest(
            "manager recovery reason must be between 12 and 500 characters".to_string(),
        ));
    }
    let manager = pins::authenticate_staff_by_id(
        &state.db,
        request.manager_staff_id,
        Some(request.manager_pin.trim()),
    )
    .await
    .map_err(|_| RecoveryError::Forbidden("Manager Access was not approved".to_string()))?;
    let effective = effective_permissions_for_staff(&state.db, manager.id, manager.role).await?;
    if !staff_can_approve_manager_access(&effective, manager.role) {
        return Err(RecoveryError::Forbidden(
            "manager.approval permission required".to_string(),
        ));
    }

    let job: Option<(
        String,
        String,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Value,
    )> = sqlx::query_as(
        r#"
        SELECT kind, status, register_session_id, transaction_id, checkout_client_id, payload
        FROM operational_recovery_job
        WHERE client_job_key = $1
        "#,
    )
    .bind(&client_job_key)
    .fetch_optional(&state.db)
    .await?;
    let Some((
        kind,
        status,
        register_session_id,
        recovery_transaction_id,
        checkout_client_id,
        job_payload,
    )) = job
    else {
        return Err(RecoveryError::NotFound);
    };
    if !matches!(kind.as_str(), "checkout_offline" | "checkout_unconfirmed") {
        return Err(RecoveryError::BadRequest(
            "only checkout recovery jobs can be replayed".to_string(),
        ));
    }
    if !matches!(status.as_str(), "pending" | "blocked" | "resolved") {
        return Err(RecoveryError::BadRequest(
            "checkout recovery job is already closed".to_string(),
        ));
    }
    let raw_checkout = job_payload.get("payload").cloned().ok_or_else(|| {
        RecoveryError::BadRequest("checkout recovery payload is missing".to_string())
    })?;
    let checkout: CheckoutRequest = serde_json::from_value(raw_checkout).map_err(|_| {
        RecoveryError::BadRequest("checkout recovery payload is invalid".to_string())
    })?;
    let recovery_checkout_client_id = checkout_client_id.ok_or_else(|| {
        RecoveryError::BadRequest(
            "checkout recovery requires its exact non-null checkout_client_id".to_string(),
        )
    })?;
    let payload_checkout_client_id = checkout.checkout_client_id.ok_or_else(|| {
        RecoveryError::BadRequest(
            "checkout recovery payload requires its exact non-null checkout_client_id".to_string(),
        )
    })?;
    if register_session_id != Some(checkout.session_id)
        || recovery_checkout_client_id != payload_checkout_client_id
    {
        return Err(RecoveryError::Forbidden(
            "checkout recovery identity does not match its original Register session".to_string(),
        ));
    }

    let recovery_session_id = checkout.session_id;
    let existing_checkout: Option<(
        Uuid,
        String,
        String,
        Option<Uuid>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT id, display_id, status::text, register_session_id,
               checkout_request_fingerprint, checkout_payment_fingerprint
        FROM transactions
        WHERE checkout_client_id = $1
        "#,
    )
    .bind(recovery_checkout_client_id)
    .fetch_optional(&state.db)
    .await?;
    if let (Some(expected_transaction_id), Some((actual_transaction_id, ..))) =
        (recovery_transaction_id, existing_checkout.as_ref())
    {
        if expected_transaction_id != *actual_transaction_id {
            return Err(RecoveryError::Forbidden(
                "checkout recovery Transaction Record does not match its committed checkout identity"
                    .to_string(),
            ));
        }
    }
    if status == "resolved" && (recovery_transaction_id.is_none() || existing_checkout.is_none()) {
        return Err(RecoveryError::BadRequest(
            "resolved checkout recovery is missing its exact committed Transaction Record"
                .to_string(),
        ));
    }

    let legacy_committed_without_replay = existing_checkout.as_ref().is_some_and(
        |(_, _, _, _, request_fingerprint, payment_fingerprint)| {
            request_fingerprint.is_none() || payment_fingerprint.is_none()
        },
    );
    let (transaction_id, display_id) = if legacy_committed_without_replay {
        let Some((
            transaction_id,
            display_id,
            transaction_status,
            transaction_session_id,
            request_fingerprint,
            payment_fingerprint,
        )) = existing_checkout
        else {
            unreachable!("legacy checkout was checked above")
        };
        if request_fingerprint.is_some() || payment_fingerprint.is_some() {
            return Err(RecoveryError::BadRequest(
                "committed checkout has incomplete replay fingerprints; verify it in the Transaction Record and Payments Health before audited resolution"
                    .to_string(),
            ));
        }
        if transaction_status == "processing" {
            return Err(RecoveryError::BadRequest(
                "legacy processing checkout cannot be replayed safely; verify provider and Transaction Record evidence before audited resolution"
                    .to_string(),
            ));
        }
        if transaction_session_id != Some(recovery_session_id) {
            return Err(RecoveryError::Forbidden(
                "legacy committed checkout belongs to a different Register session".to_string(),
            ));
        }
        (transaction_id, display_id)
    } else {
        let outcome = execute_recovery_checkout(
            &state.db,
            &state.http_client,
            state.global_employee_markup,
            checkout,
            CheckoutRecoveryContext {
                source: CheckoutRecoverySource::OfflineCheckout {
                    recovery_client_job_key: client_job_key.clone(),
                },
                payment_provider_attempt_id: None,
                authorized_by_staff_id: manager.id,
                approved_at: chrono::Utc::now(),
                note: reason.to_string(),
                allow_closed_session: true,
                require_checkout_binding: true,
            },
        )
        .await
        .map_err(|error| RecoveryError::BadRequest(error.to_string()))?;
        match outcome {
            CheckoutDone::Idempotent {
                transaction_id,
                display_id,
            }
            | CheckoutDone::Completed {
                transaction_id,
                display_id,
                ..
            } => (transaction_id, display_id),
        }
    };

    let mut tx = state.db.begin().await?;
    // Use the same session-row lock order as Register close and recovery creation.
    // If close wins the lock, this observes its final closed_at; if recovery wins,
    // close cannot race past the evidence decision before this transaction commits.
    let session_closed_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        r#"
        SELECT closed_at
        FROM register_sessions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(recovery_session_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        RecoveryError::BadRequest("checkout recovery Register session no longer exists".to_string())
    })?;
    let locked_job: Option<(
        String,
        String,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT kind, status, register_session_id, transaction_id, checkout_client_id,
               resolved_by_staff_id, resolution_note
        FROM operational_recovery_job
        WHERE client_job_key = $1
        FOR UPDATE
        "#,
    )
    .bind(&client_job_key)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        locked_kind,
        locked_status,
        locked_session_id,
        locked_transaction_id,
        locked_checkout_client_id,
        locked_resolved_by_staff_id,
        locked_resolution_note,
    )) = locked_job
    else {
        return Err(RecoveryError::NotFound);
    };
    if locked_kind != kind
        || locked_session_id != Some(recovery_session_id)
        || locked_checkout_client_id != Some(recovery_checkout_client_id)
        || locked_transaction_id.is_some_and(|id| id != transaction_id)
    {
        return Err(RecoveryError::Forbidden(
            "checkout recovery identity changed before audited finalization".to_string(),
        ));
    }

    let session_was_closed_during_checkout: Option<bool> = sqlx::query_scalar(
        r#"
        SELECT metadata->>'register_session_was_closed' = 'true'
        FROM transaction_activity_log
        WHERE transaction_id = $1
          AND event_kind = 'checkout_recovered'
          AND metadata->>'recovery_client_job_key' = $2
          AND metadata ? 'register_session_was_closed'
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(transaction_id)
    .bind(&client_job_key)
    .fetch_optional(&mut *tx)
    .await?;
    let existing_post_close_evidence: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM register_post_close_checkout_recovery
            WHERE recovery_client_job_key = $1
              AND register_session_id = $2
              AND transaction_id = $3
        )
        "#,
    )
    .bind(&client_job_key)
    .bind(recovery_session_id)
    .bind(transaction_id)
    .fetch_one(&mut *tx)
    .await?;
    let post_close = session_was_closed_during_checkout
        .unwrap_or_else(|| existing_post_close_evidence || session_closed_at.is_some());
    let audit_idempotency_key =
        format!("register-checkout-recovery:{client_job_key}:{transaction_id}");
    let audit_metadata = json!({
        "client_job_key": &client_job_key,
        "register_session_id": recovery_session_id,
        "transaction_id": transaction_id,
        "transaction_display_id": &display_id,
        "post_close": post_close,
        "legacy_committed_without_replay": legacy_committed_without_replay,
        "reason": reason,
    });

    match locked_status.as_str() {
        "pending" | "blocked" => {
            sqlx::query(
                r#"
                UPDATE operational_recovery_job
                SET status = 'resolved', resolved_at = now(), resolved_by_staff_id = $2,
                    resolution_note = $3, transaction_id = $4, last_seen_at = now()
                WHERE client_job_key = $1
                "#,
            )
            .bind(&client_job_key)
            .bind(manager.id)
            .bind(reason)
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;

            if post_close {
                sqlx::query(
                    r#"
                    INSERT INTO register_post_close_checkout_recovery (
                        recovery_client_job_key, register_session_id, transaction_id,
                        recovered_by_staff_id, manager_reason, metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (recovery_client_job_key) DO NOTHING
                    "#,
                )
                .bind(&client_job_key)
                .bind(recovery_session_id)
                .bind(transaction_id)
                .bind(manager.id)
                .bind(reason)
                .bind(json!({
                    "kind": &kind,
                    "transaction_display_id": &display_id,
                    "original_closed_at": session_closed_at,
                }))
                .execute(&mut *tx)
                .await?;
            }

            pins::log_staff_access_once(
                &mut *tx,
                manager.id,
                "register_checkout_recovery",
                audit_metadata.clone(),
                &audit_idempotency_key,
            )
            .await?;
        }
        "resolved" => {
            if locked_transaction_id != Some(transaction_id)
                || locked_resolved_by_staff_id != Some(manager.id)
                || locked_resolution_note.as_deref() != Some(reason)
            {
                return Err(RecoveryError::BadRequest(
                    "checkout recovery was resolved with different Manager approval evidence"
                        .to_string(),
                ));
            }
        }
        _ => {
            return Err(RecoveryError::BadRequest(
                "checkout recovery job is already closed".to_string(),
            ));
        }
    }

    let exact_audit_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM staff_access_log
            WHERE idempotency_key = $1
              AND staff_id = $2
              AND event_kind = 'register_checkout_recovery'
              AND metadata @> $3
        )
        "#,
    )
    .bind(&audit_idempotency_key)
    .bind(manager.id)
    .bind(&audit_metadata)
    .fetch_one(&mut *tx)
    .await?;
    if !exact_audit_exists {
        return Err(RecoveryError::BadRequest(
            "resolved checkout recovery is missing its required exact Manager audit".to_string(),
        ));
    }
    if post_close {
        let exact_post_close_evidence_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM register_post_close_checkout_recovery
                WHERE recovery_client_job_key = $1
                  AND register_session_id = $2
                  AND transaction_id = $3
                  AND recovered_by_staff_id = $4
                  AND manager_reason = $5
            )
            "#,
        )
        .bind(&client_job_key)
        .bind(recovery_session_id)
        .bind(transaction_id)
        .bind(manager.id)
        .bind(reason)
        .fetch_one(&mut *tx)
        .await?;
        if !exact_post_close_evidence_exists {
            return Err(RecoveryError::BadRequest(
                "resolved post-close checkout recovery is missing its required session evidence"
                    .to_string(),
            ));
        }
    }
    tx.commit().await?;

    Ok(Json(json!({
        "status": "resolved",
        "transaction_id": transaction_id,
        "transaction_display_id": display_id,
        "post_close_recovery": post_close,
        "legacy_committed_without_replay": legacy_committed_without_replay,
    })))
}

async fn verify_pickup_recovery_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(client_job_key): Path<String>,
    Json(request): Json<ReplayCheckoutRecoveryRequest>,
) -> Result<Json<Value>, RecoveryError> {
    require_recovery_caller(&state, &headers).await?;
    let reason = request.reason.trim();
    if reason.chars().count() < 12 || reason.chars().count() > 500 {
        return Err(RecoveryError::BadRequest(
            "manager recovery reason must be between 12 and 500 characters".to_string(),
        ));
    }
    let manager = pins::authenticate_staff_by_id(
        &state.db,
        request.manager_staff_id,
        Some(request.manager_pin.trim()),
    )
    .await
    .map_err(|_| RecoveryError::Forbidden("Manager Access was not approved".to_string()))?;
    let effective = effective_permissions_for_staff(&state.db, manager.id, manager.role).await?;
    if !staff_can_approve_manager_access(&effective, manager.role) {
        return Err(RecoveryError::Forbidden(
            "manager.approval permission required".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let job: Option<(
        String,
        String,
        Value,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT kind, status, payload, register_session_id, transaction_id, checkout_client_id,
               resolved_by_staff_id, resolution_note
        FROM operational_recovery_job
        WHERE client_job_key = $1
        FOR UPDATE
        "#,
    )
    .bind(&client_job_key)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        kind,
        status,
        payload,
        register_session_id,
        recovery_transaction_id,
        checkout_client_id,
        resolved_by_staff_id,
        resolution_note,
    )) = job
    else {
        return Err(RecoveryError::NotFound);
    };
    if kind != "pickup_after_payment" {
        return Err(RecoveryError::BadRequest(
            "only paid pickup, shipping, or alteration follow-up can be verified here".to_string(),
        ));
    }
    if !matches!(status.as_str(), "pending" | "blocked" | "resolved") {
        return Err(RecoveryError::BadRequest(
            "pickup follow-up recovery job is already closed".to_string(),
        ));
    }
    let already_resolved = status == "resolved";
    if already_resolved
        && (resolved_by_staff_id != Some(manager.id) || resolution_note.as_deref() != Some(reason))
    {
        return Err(RecoveryError::BadRequest(
            "pickup follow-up recovery was resolved with different Manager approval evidence"
                .to_string(),
        ));
    }

    let steps: Vec<PickupRecoveryStep> =
        serde_json::from_value(payload.get("recovery_steps").cloned().ok_or_else(|| {
            RecoveryError::BadRequest(
                "pickup follow-up is missing its exact recovery checklist".to_string(),
            )
        })?)
        .map_err(|_| {
            RecoveryError::BadRequest("pickup follow-up recovery checklist is invalid".to_string())
        })?;
    if steps.is_empty() || steps.len() > 100 {
        return Err(RecoveryError::BadRequest(
            "pickup follow-up recovery checklist must contain 1 to 100 steps".to_string(),
        ));
    }

    let register_session_id = register_session_id.ok_or_else(|| {
        RecoveryError::BadRequest(
            "paid follow-up is missing its authoritative Register session".to_string(),
        )
    })?;
    let recovery_transaction_id = recovery_transaction_id.ok_or_else(|| {
        RecoveryError::BadRequest(
            "paid follow-up is missing its authoritative Transaction Record".to_string(),
        )
    })?;
    let checkout_client_id = checkout_client_id.ok_or_else(|| {
        RecoveryError::BadRequest(
            "paid follow-up is missing its authoritative checkout identity".to_string(),
        )
    })?;
    let authoritative_transaction_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        WITH checkout_transaction AS (
            SELECT id
            FROM transactions
            WHERE checkout_client_id = $1
              AND register_session_id = $2
              AND status <> 'processing'::order_status
        ),
        checkout_payments AS (
            SELECT DISTINCT pa.transaction_id
            FROM payment_allocations pa
            INNER JOIN checkout_transaction checkout
              ON checkout.id = pa.target_transaction_id
        ),
        authoritative_transactions AS (
            SELECT id FROM checkout_transaction
            UNION
            SELECT pa.target_transaction_id
            FROM payment_allocations pa
            WHERE pa.transaction_id IN (SELECT transaction_id FROM checkout_payments)
            UNION
            SELECT links.target_transaction_id
            FROM pos_shipping_charge_links links
            WHERE links.shipping_transaction_id IN (SELECT id FROM checkout_transaction)
        )
        SELECT id FROM authoritative_transactions
        "#,
    )
    .bind(checkout_client_id)
    .bind(register_session_id)
    .fetch_all(&mut *tx)
    .await?;
    if !authoritative_transaction_ids.contains(&recovery_transaction_id) {
        return Err(RecoveryError::Forbidden(
            "paid follow-up Transaction Record is not bound to its committed checkout evidence"
                .to_string(),
        ));
    }

    let mut incomplete = Vec::new();
    for step in &steps {
        match step {
            PickupRecoveryStep::ShipTransaction {
                transaction_id,
                transaction_line_ids,
            } => {
                if !authoritative_transaction_ids.contains(transaction_id) {
                    return Err(RecoveryError::Forbidden(
                        "shipping recovery step is not bound to the committed checkout".to_string(),
                    ));
                }
                let all_lines = transaction_line_ids.is_empty();
                let complete: bool = sqlx::query_scalar(
                    r#"
                    WITH target AS (
                        SELECT is_fulfilled, fulfilled_at, shipped_at
                        FROM transaction_lines
                        WHERE transaction_id = $1
                          AND COALESCE(is_internal, false) = false
                          AND ($2::boolean OR id = ANY($3::uuid[]))
                    )
                    SELECT EXISTS(SELECT 1 FROM target)
                       AND ($2::boolean OR (SELECT COUNT(*) FROM target) = cardinality($3::uuid[]))
                       AND NOT EXISTS(
                           SELECT 1 FROM target
                           WHERE is_fulfilled = false
                              OR fulfilled_at IS NULL
                              OR shipped_at IS NULL
                       )
                    "#,
                )
                .bind(transaction_id)
                .bind(all_lines)
                .bind(transaction_line_ids)
                .fetch_one(&mut *tx)
                .await?;
                if !complete {
                    incomplete.push(format!("shipping for Transaction Record {transaction_id}"));
                }
            }
            PickupRecoveryStep::PickupTransaction {
                transaction_id,
                transaction_line_ids,
            } => {
                if !authoritative_transaction_ids.contains(transaction_id) {
                    return Err(RecoveryError::Forbidden(
                        "pickup recovery step is not bound to the committed checkout".to_string(),
                    ));
                }
                let all_lines = transaction_line_ids.is_empty();
                let complete: bool = sqlx::query_scalar(
                    r#"
                    WITH target AS (
                        SELECT is_fulfilled, fulfilled_at
                        FROM transaction_lines
                        WHERE transaction_id = $1
                          AND COALESCE(is_internal, false) = false
                          AND ($2::boolean OR id = ANY($3::uuid[]))
                    )
                    SELECT EXISTS(SELECT 1 FROM target)
                       AND ($2::boolean OR (SELECT COUNT(*) FROM target) = cardinality($3::uuid[]))
                       AND NOT EXISTS(
                           SELECT 1 FROM target
                           WHERE is_fulfilled = false OR fulfilled_at IS NULL
                       )
                    "#,
                )
                .bind(transaction_id)
                .bind(all_lines)
                .bind(transaction_line_ids)
                .fetch_one(&mut *tx)
                .await?;
                if !complete {
                    incomplete.push(format!("pickup for Transaction Record {transaction_id}"));
                }
            }
            PickupRecoveryStep::AlterationPickup { alteration_id } => {
                let complete: bool = sqlx::query_scalar(
                    r#"
                    SELECT EXISTS(
                        SELECT 1
                        FROM alteration_orders
                        WHERE id = $1
                          AND (
                              transaction_id = ANY($2::uuid[])
                              OR source_transaction_id = ANY($2::uuid[])
                              OR source_transaction_line_id IN (
                                  SELECT id FROM transaction_lines
                                  WHERE transaction_id = ANY($2::uuid[])
                              )
                              OR charge_transaction_line_id IN (
                                  SELECT id FROM transaction_lines
                                  WHERE transaction_id = ANY($2::uuid[])
                              )
                          )
                          AND status::text = 'picked_up'
                          AND picked_up_at IS NOT NULL
                          AND picked_up_by_staff_id IS NOT NULL
                    )
                    "#,
                )
                .bind(alteration_id)
                .bind(&authoritative_transaction_ids)
                .fetch_one(&mut *tx)
                .await?;
                if !complete {
                    incomplete.push(format!("alteration pickup {alteration_id}"));
                }
            }
        }
    }
    if !incomplete.is_empty() {
        return Err(RecoveryError::BadRequest(format!(
            "Follow-up is still incomplete: {}. Complete the listed work, then verify again.",
            incomplete.join(", ")
        )));
    }

    sqlx::query(
        r#"
        UPDATE operational_recovery_job
        SET status = 'resolved', resolved_at = now(), resolved_by_staff_id = $2,
            resolution_note = $3, last_seen_at = now()
        WHERE client_job_key = $1
          AND status IN ('pending', 'blocked')
        "#,
    )
    .bind(&client_job_key)
    .bind(manager.id)
    .bind(reason)
    .execute(&mut *tx)
    .await?;
    let audit_idempotency_key = format!("register-pickup-followup-recovery:{client_job_key}");
    let audit_metadata = json!({
        "client_job_key": &client_job_key,
        "verified_steps": steps.len(),
        "reason": reason,
    });
    pins::log_staff_access_once(
        &mut *tx,
        manager.id,
        "register_pickup_followup_recovery",
        audit_metadata.clone(),
        &audit_idempotency_key,
    )
    .await?;
    let exact_audit_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM staff_access_log
            WHERE idempotency_key = $1
              AND staff_id = $2
              AND event_kind = 'register_pickup_followup_recovery'
              AND metadata @> $3
        )
        "#,
    )
    .bind(&audit_idempotency_key)
    .bind(manager.id)
    .bind(&audit_metadata)
    .fetch_one(&mut *tx)
    .await?;
    if !exact_audit_exists {
        return Err(RecoveryError::BadRequest(
            "pickup follow-up recovery audit identity conflicts with existing evidence".to_string(),
        ));
    }
    tx.commit().await?;

    Ok(Json(json!({
        "status": "resolved",
        "verified_steps": steps.len(),
        "idempotent_replay": already_resolved,
    })))
}

fn validate_open_status(status: &str) -> Result<&str, RecoveryError> {
    match status {
        "pending" | "blocked" => Ok(status),
        _ => Err(RecoveryError::BadRequest(
            "recovery status must be pending or blocked".to_string(),
        )),
    }
}

async fn upsert_recovery_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<UpsertRecoveryJob>,
) -> Result<Json<RecoveryJob>, RecoveryError> {
    let caller = require_recovery_caller(&state, &headers).await?;
    let client_job_key = request.client_job_key.trim();
    if client_job_key.is_empty() || client_job_key.len() > 200 {
        return Err(RecoveryError::BadRequest(
            "client_job_key must contain 1 to 200 characters".to_string(),
        ));
    }
    let kind = validate_kind(request.kind.trim())?;
    let status = validate_open_status(request.status.trim())?;
    if contains_sensitive_pin_key(&request.payload) {
        return Err(RecoveryError::BadRequest(
            "recovery payload must not contain an Access PIN".to_string(),
        ));
    }
    if serde_json::to_vec(&request.payload)
        .map_err(|_| RecoveryError::BadRequest("invalid recovery payload".to_string()))?
        .len()
        > MAX_RECOVERY_PAYLOAD_BYTES
    {
        return Err(RecoveryError::BadRequest(
            "recovery payload exceeds 2 MiB".to_string(),
        ));
    }
    let register_session_id = match caller {
        StaffOrPosSession::PosSession { session_id } => {
            if request
                .register_session_id
                .is_some_and(|id| id != session_id)
            {
                return Err(RecoveryError::Forbidden(
                    "register session does not match authenticated session".to_string(),
                ));
            }
            Some(session_id)
        }
        StaffOrPosSession::Staff(_) => {
            middleware::require_staff_with_permission(&state, &headers, REGISTER_REPORTS)
                .await
                .map_err(map_auth_error)?;
            request.register_session_id
        }
    };
    if matches!(kind, "checkout_offline" | "checkout_unconfirmed") {
        let register_session_id = register_session_id.ok_or_else(|| {
            RecoveryError::BadRequest(
                "checkout recovery requires an exact non-null Register session".to_string(),
            )
        })?;
        let checkout_client_id = request.checkout_client_id.ok_or_else(|| {
            RecoveryError::BadRequest(
                "checkout recovery requires an exact non-null checkout_client_id".to_string(),
            )
        })?;
        let checkout_payload: CheckoutRequest =
            serde_json::from_value(request.payload.get("payload").cloned().ok_or_else(|| {
                RecoveryError::BadRequest("checkout recovery payload is missing".to_string())
            })?)
            .map_err(|_| {
                RecoveryError::BadRequest("checkout recovery payload is invalid".to_string())
            })?;
        if checkout_payload.session_id != register_session_id
            || checkout_payload.checkout_client_id != Some(checkout_client_id)
        {
            return Err(RecoveryError::Forbidden(
                "checkout recovery payload identity does not match its Register session and checkout_client_id"
                    .to_string(),
            ));
        }
    }
    let station_key = header_text(&headers, "x-riverside-station-key");
    let attempt_count = request.attempt_count.unwrap_or(0).max(0);
    let mut tx = state.db.begin().await?;
    if let Some(session_id) = register_session_id {
        let locked_open_session: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT id
            FROM register_sessions
            WHERE id = $1 AND is_open = true
            FOR UPDATE
            "#,
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?;
        if locked_open_session.is_none() {
            return Err(RecoveryError::BadRequest(
                "Register session closed before the recovery record could be saved".to_string(),
            ));
        }
    }
    let row = sqlx::query_as(
        r#"
        INSERT INTO operational_recovery_job (
            client_job_key, kind, status, register_session_id, transaction_id,
            checkout_client_id, station_key, label, payload, last_error, attempt_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (client_job_key) DO UPDATE SET
            kind = operational_recovery_job.kind,
            status = CASE
                WHEN operational_recovery_job.status IN ('resolved', 'dismissed')
                    THEN operational_recovery_job.status
                WHEN operational_recovery_job.status = 'blocked'
                    THEN 'blocked'
                ELSE EXCLUDED.status
            END,
            register_session_id = COALESCE(operational_recovery_job.register_session_id, EXCLUDED.register_session_id),
            transaction_id = COALESCE(operational_recovery_job.transaction_id, EXCLUDED.transaction_id),
            checkout_client_id = COALESCE(operational_recovery_job.checkout_client_id, EXCLUDED.checkout_client_id),
            station_key = COALESCE(operational_recovery_job.station_key, EXCLUDED.station_key),
            label = CASE
                WHEN operational_recovery_job.status IN ('resolved', 'dismissed')
                    THEN operational_recovery_job.label
                WHEN operational_recovery_job.status = 'blocked'
                  AND EXCLUDED.status = 'pending'
                    THEN operational_recovery_job.label
                ELSE EXCLUDED.label
            END,
            payload = CASE
                WHEN operational_recovery_job.status IN ('resolved', 'dismissed')
                  OR operational_recovery_job.kind <> 'receipt_print'
                    THEN operational_recovery_job.payload
                ELSE EXCLUDED.payload
            END,
            last_error = CASE
                WHEN operational_recovery_job.status IN ('resolved', 'dismissed')
                    THEN operational_recovery_job.last_error
                WHEN operational_recovery_job.status = 'blocked'
                  AND EXCLUDED.status = 'pending'
                    THEN operational_recovery_job.last_error
                ELSE EXCLUDED.last_error
            END,
            attempt_count = CASE
                WHEN operational_recovery_job.status IN ('resolved', 'dismissed')
                    THEN operational_recovery_job.attempt_count
                ELSE GREATEST(operational_recovery_job.attempt_count, EXCLUDED.attempt_count)
            END,
            last_seen_at = now()
        WHERE operational_recovery_job.kind = EXCLUDED.kind
          AND operational_recovery_job.register_session_id
              IS NOT DISTINCT FROM EXCLUDED.register_session_id
          AND operational_recovery_job.checkout_client_id
              IS NOT DISTINCT FROM EXCLUDED.checkout_client_id
          AND (
              operational_recovery_job.transaction_id
                  IS NOT DISTINCT FROM EXCLUDED.transaction_id
              OR (
                  operational_recovery_job.status IN ('pending', 'blocked')
                  AND operational_recovery_job.transaction_id IS NULL
                  AND EXCLUDED.transaction_id IS NOT NULL
              )
          )
        RETURNING client_job_key, kind, status, register_session_id, transaction_id,
                  checkout_client_id, station_key, label, payload, last_error, attempt_count,
                  first_seen_at, last_seen_at
        "#,
    )
    .bind(client_job_key)
    .bind(kind)
    .bind(status)
    .bind(register_session_id)
    .bind(request.transaction_id)
    .bind(request.checkout_client_id)
    .bind(station_key)
    .bind(request.label.as_deref().map(str::trim).filter(|v| !v.is_empty()))
    .bind(request.payload)
    .bind(
        request
            .last_error
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(attempt_count)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(|| {
        RecoveryError::Forbidden(
            "recovery job identity collides with an existing server-owned or unrelated recovery record"
                .to_string(),
        )
    })?;
    tx.commit().await?;
    Ok(Json(row))
}

async fn list_recovery_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RecoveryJob>>, RecoveryError> {
    let caller = require_recovery_caller(&state, &headers).await?;
    let rows = match caller {
        StaffOrPosSession::PosSession { session_id } => {
            sqlx::query_as(
                r#"
                SELECT client_job_key, kind, status, register_session_id, transaction_id,
                       checkout_client_id, station_key, label, payload, last_error, attempt_count,
                       first_seen_at, last_seen_at
                FROM operational_recovery_job
                WHERE status IN ('pending', 'blocked')
                  AND register_session_id IN (
                      SELECT sibling.id
                      FROM register_sessions current_session
                      JOIN register_sessions sibling
                        ON sibling.till_close_group_id = current_session.till_close_group_id
                      WHERE current_session.id = $1
                  )
                ORDER BY first_seen_at
                "#,
            )
            .bind(session_id)
            .fetch_all(&state.db)
            .await?
        }
        StaffOrPosSession::Staff(_) => {
            middleware::require_staff_with_permission(&state, &headers, REGISTER_REPORTS)
                .await
                .map_err(map_auth_error)?;
            sqlx::query_as(
                r#"
                SELECT client_job_key, kind, status, register_session_id, transaction_id,
                       checkout_client_id, station_key, label, payload, last_error, attempt_count,
                       first_seen_at, last_seen_at
                FROM operational_recovery_job
                WHERE status IN ('pending', 'blocked')
                ORDER BY first_seen_at
                "#,
            )
            .fetch_all(&state.db)
            .await?
        }
    };
    Ok(Json(rows))
}

async fn resolve_recovery_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(client_job_key): Path<String>,
    Json(request): Json<ResolveRecoveryJob>,
) -> Result<StatusCode, RecoveryError> {
    if !matches!(request.status.as_str(), "resolved" | "dismissed") {
        return Err(RecoveryError::BadRequest(
            "resolution status must be resolved or dismissed".to_string(),
        ));
    }
    let caller = require_recovery_caller(&state, &headers).await?;
    let (session_scope, resolved_by_staff_id, is_pos_automatic_resolution) = match caller {
        StaffOrPosSession::PosSession { session_id } => (Some(session_id), None, true),
        StaffOrPosSession::Staff(staff) => {
            middleware::require_staff_with_permission(&state, &headers, REGISTER_REPORTS)
                .await
                .map_err(map_auth_error)?;
            (None, Some(staff.id), false)
        }
    };
    let resolution_note = request
        .resolution_note
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut tx = state.db.begin().await?;
    let job: Option<(
        String,
        String,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Value,
        Option<Uuid>,
    )> = sqlx::query_as(
        r#"
        SELECT kind, status, register_session_id, transaction_id, checkout_client_id,
               payload, resolved_by_staff_id
        FROM operational_recovery_job
        WHERE client_job_key = $1
          AND (
              $2::uuid IS NULL
              OR register_session_id IN (
                  SELECT sibling.id
                  FROM register_sessions current_session
                  JOIN register_sessions sibling
                    ON sibling.till_close_group_id = current_session.till_close_group_id
                  WHERE current_session.id = $2
              )
          )
          AND status IN ('pending', 'blocked', 'resolved', 'dismissed')
        FOR UPDATE
        "#,
    )
    .bind(&client_job_key)
    .bind(session_scope)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        kind,
        current_status,
        register_session_id,
        transaction_id,
        checkout_client_id,
        job_payload,
        current_resolved_by_staff_id,
    )) = job
    else {
        return Err(RecoveryError::NotFound);
    };

    if request.status == "dismissed" && kind != "receipt_print" {
        return Err(RecoveryError::Forbidden(
            "financial recovery records cannot be dismissed; complete recovery or use the audited Manager force-close workflow"
                .to_string(),
        ));
    }
    if kind == "exchange_settlement" {
        return Err(RecoveryError::Forbidden(
            "exchange recovery is resolved only by the exchange settlement workflow".to_string(),
        ));
    }
    if matches!(kind.as_str(), "checkout_offline" | "checkout_unconfirmed") {
        if request.status != "resolved" || !is_pos_automatic_resolution {
            return Err(RecoveryError::Forbidden(
                "checkout recovery can only be cleared automatically by its exact active Register after the committed Transaction Record is verified; use audited Manager replay for historical recovery"
                    .to_string(),
            ));
        }
        let caller_session_id = session_scope.ok_or_else(|| {
            RecoveryError::Forbidden(
                "automatic checkout recovery requires its exact active Register session"
                    .to_string(),
            )
        })?;
        let recovery_session_id = register_session_id.ok_or_else(|| {
            RecoveryError::BadRequest(
                "checkout recovery is missing its exact Register session".to_string(),
            )
        })?;
        if recovery_session_id != caller_session_id {
            return Err(RecoveryError::Forbidden(
                "checkout recovery belongs to a different Register session".to_string(),
            ));
        }
        let recovery_checkout_client_id = checkout_client_id.ok_or_else(|| {
            RecoveryError::BadRequest(
                "checkout recovery is missing its exact checkout identity".to_string(),
            )
        })?;
        let checkout_payload: CheckoutRequest =
            serde_json::from_value(job_payload.get("payload").cloned().ok_or_else(|| {
                RecoveryError::BadRequest("checkout recovery payload is missing".to_string())
            })?)
            .map_err(|_| {
                RecoveryError::BadRequest("checkout recovery payload is invalid".to_string())
            })?;
        if checkout_payload.session_id != recovery_session_id
            || checkout_payload.checkout_client_id != Some(recovery_checkout_client_id)
        {
            return Err(RecoveryError::Forbidden(
                "checkout recovery payload identity does not match its exact Register session"
                    .to_string(),
            ));
        }
        let (request_fingerprint, payment_fingerprint) =
            checkout_request_fingerprints(&checkout_payload)
                .map_err(|error| RecoveryError::BadRequest(error.to_string()))?;
        let committed_checkout: Option<(Uuid, Uuid, Option<String>, Option<String>)> =
            sqlx::query_as(
                r#"
            SELECT t.id, t.operator_id, t.checkout_request_fingerprint,
                   t.checkout_payment_fingerprint
            FROM transactions t
            WHERE t.checkout_client_id = $1
              AND t.register_session_id = $2
              AND ($3::uuid IS NULL OR t.id = $3)
              AND t.status <> 'processing'::order_status
            "#,
            )
            .bind(recovery_checkout_client_id)
            .bind(recovery_session_id)
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((
            committed_transaction_id,
            operator_staff_id,
            stored_request_fingerprint,
            stored_payment_fingerprint,
        )) = committed_checkout
        else {
            return Err(RecoveryError::Forbidden(
                "checkout recovery cannot be resolved until its committed Transaction Record is verified"
                    .to_string(),
            ));
        };
        if stored_request_fingerprint.as_deref() != Some(request_fingerprint.as_str())
            || stored_payment_fingerprint.as_deref() != Some(payment_fingerprint.as_str())
        {
            return Err(RecoveryError::Forbidden(
                "checkout recovery payload does not match the exact committed Transaction Record; keep it blocked for audited Manager review"
                    .to_string(),
            ));
        }

        let audit_idempotency_key = format!(
            "register-checkout-auto-resolution:{client_job_key}:{committed_transaction_id}"
        );
        let audit_metadata = json!({
            "client_job_key": &client_job_key,
            "register_session_id": recovery_session_id,
            "transaction_id": committed_transaction_id,
            "checkout_client_id": recovery_checkout_client_id,
            "resolution_path": "automatic_register_checkout_sync",
        });

        match current_status.as_str() {
            "pending" | "blocked" => {
                let updated = sqlx::query(
                    r#"
                    UPDATE operational_recovery_job
                    SET status = 'resolved', resolved_at = now(), resolved_by_staff_id = $2,
                        resolution_note = $3, transaction_id = $4, last_seen_at = now()
                    WHERE client_job_key = $1
                      AND status IN ('pending', 'blocked')
                    "#,
                )
                .bind(&client_job_key)
                .bind(operator_staff_id)
                .bind(resolution_note.unwrap_or("Checkout synchronized"))
                .bind(committed_transaction_id)
                .execute(&mut *tx)
                .await?;
                if updated.rows_affected() != 1 {
                    return Err(RecoveryError::BadRequest(
                        "checkout recovery changed before automatic resolution".to_string(),
                    ));
                }
                pins::log_staff_access_once(
                    &mut *tx,
                    operator_staff_id,
                    "register_checkout_recovery_auto_resolved",
                    audit_metadata.clone(),
                    &audit_idempotency_key,
                )
                .await?;
            }
            "resolved" => {
                if transaction_id != Some(committed_transaction_id)
                    || current_resolved_by_staff_id != Some(operator_staff_id)
                {
                    return Err(RecoveryError::BadRequest(
                        "checkout recovery was resolved with different automatic evidence"
                            .to_string(),
                    ));
                }
            }
            _ => {
                return Err(RecoveryError::BadRequest(
                    "checkout recovery job is already closed".to_string(),
                ));
            }
        }

        let exact_audit_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM staff_access_log
                WHERE idempotency_key = $1
                  AND staff_id = $2
                  AND event_kind = 'register_checkout_recovery_auto_resolved'
                  AND metadata @> $3
            )
            "#,
        )
        .bind(&audit_idempotency_key)
        .bind(operator_staff_id)
        .bind(&audit_metadata)
        .fetch_one(&mut *tx)
        .await?;
        if !exact_audit_exists {
            return Err(RecoveryError::BadRequest(
                "automatic checkout recovery audit identity conflicts with existing evidence"
                    .to_string(),
            ));
        }
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if request.status == "resolved" && kind == "pickup_after_payment" {
        return Err(RecoveryError::Forbidden(
            "paid pickup follow-up can be resolved only after the dedicated recovery verifier confirms every recorded pickup, shipping, and alteration step"
                .to_string(),
        ));
    }

    if !matches!(current_status.as_str(), "pending" | "blocked") {
        if current_status == request.status {
            tx.commit().await?;
            return Ok(StatusCode::NO_CONTENT);
        }
        return Err(RecoveryError::BadRequest(
            "recovery job is already closed with a different status".to_string(),
        ));
    }

    let result = sqlx::query(
        r#"
        UPDATE operational_recovery_job
        SET status = $2, resolved_at = now(), resolved_by_staff_id = $3,
            resolution_note = $4, last_seen_at = now()
        WHERE client_job_key = $1
          AND (
              $5::uuid IS NULL
              OR register_session_id IN (
                  SELECT sibling.id
                  FROM register_sessions current_session
                  JOIN register_sessions sibling
                    ON sibling.till_close_group_id = current_session.till_close_group_id
                  WHERE current_session.id = $5
              )
          )
          AND status IN ('pending', 'blocked')
        "#,
    )
    .bind(&client_job_key)
    .bind(&request.status)
    .bind(resolved_by_staff_id)
    .bind(resolution_note)
    .bind(session_scope)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecoveryError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
