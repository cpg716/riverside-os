//! Argon2-hashed staff PINs. Legacy rows with `pin_hash` NULL still authenticate with `cashier_code` only.

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use sqlx::{Executor, PgPool, Postgres};
use uuid::Uuid;

use crate::models::DbStaffRole;

#[derive(Debug, Clone)]
pub struct AuthenticatedStaff {
    pub id: Uuid,
    pub full_name: String,
    pub role: DbStaffRole,
    /// Bundled avatar slug (`client/public/staff-avatars/{key}.svg`).
    pub avatar_key: String,
    /// URL path to processed portrait photo; takes precedence over avatar_key.
    pub avatar_photo_url: Option<String>,
}

#[derive(Debug)]
pub enum PinAuthError {
    InvalidCredentials,
    WeakPin,
    Hash,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for PinAuthError {
    fn from(e: sqlx::Error) -> Self {
        PinAuthError::Database(e)
    }
}

/// Staff sign-in codes are exactly four digits (same value used as `cashier_code` and PIN verifier).
pub fn is_valid_staff_credential(s: &str) -> bool {
    let t = s.trim();
    t.len() == 4 && t.chars().all(|c| c.is_ascii_digit())
}

/// Hash a numeric PIN for storage (Argon2id). Must be exactly four digits.
pub fn hash_pin(pin: &str) -> Result<String, PinAuthError> {
    let pin = pin.trim();
    if !is_valid_staff_credential(pin) {
        return Err(PinAuthError::WeakPin);
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|_| PinAuthError::Hash)?;
    Ok(hash.to_string())
}

pub fn verify_pin(pin: &str, stored: &str) -> bool {
    let pin = pin.trim();
    if pin.is_empty() || stored.is_empty() {
        return false;
    }
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    Argon2::default()
        .verify_password(pin.as_bytes(), &parsed)
        .is_ok()
}

/// POS / register: lookup by `cashier_code`. If `pin_hash` is set, the same code must be provided as `pin` and verified.
#[allow(clippy::type_complexity)]
pub async fn authenticate_pos_staff(
    pool: &PgPool,
    cashier_code: &str,
    pin: Option<&str>,
) -> Result<AuthenticatedStaff, PinAuthError> {
    let badge = cashier_code.trim();
    if badge.is_empty() {
        return Err(PinAuthError::InvalidCredentials);
    }

    let row: Option<(
        Uuid,
        String,
        DbStaffRole,
        Option<String>,
        String,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT id, full_name, role, pin_hash, avatar_key, avatar_photo_url
        FROM staff
        WHERE cashier_code = $1 AND is_active = TRUE
        "#,
    )
    .bind(badge)
    .fetch_optional(pool)
    .await?;

    let Some((id, full_name, role, pin_hash, avatar_key, avatar_photo_url)) = row else {
        return Err(PinAuthError::InvalidCredentials);
    };

    // If this staff member has a PIN set, require the credential to match.
    // The user says "Each Staff has a 4 digit code... Not a Cashier Code and Login Pin."
    // So we treat the provided cashier_code and pin as the same secret.
    if let Some(stored) = &pin_hash {
        let provided = pin
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or(badge);

        // Safety check: in a single-code system, the PIN used for hash verification
        // must be the same digits as the cashier_code badge used for the DB lookup.
        if provided != badge {
            tracing::warn!(
                staff_id = %id,
                full_name = %full_name,
                "Authentication failed: provided pin/code mismatch (single-code invariant violated)"
            );
            return Err(PinAuthError::InvalidCredentials);
        }

        if !verify_pin(provided, stored) {
            tracing::warn!(
                staff_id = %id,
                full_name = %full_name,
                "Authentication failed: PIN hash verification failed"
            );
            if let Err(e) = crate::logic::integration_alerts::log_staff_pin_mismatch(pool, id).await
            {
                tracing::error!(error = %e, staff_id = %id, "log_staff_pin_mismatch");
            }
            return Err(PinAuthError::InvalidCredentials);
        }
    }

    Ok(AuthenticatedStaff {
        id,
        full_name,
        role,
        avatar_key,
        avatar_photo_url,
    })
}

pub async fn authenticate_admin(
    pool: &PgPool,
    cashier_code: &str,
    pin: Option<&str>,
) -> Result<AuthenticatedStaff, PinAuthError> {
    let s = authenticate_pos_staff(pool, cashier_code, pin).await?;
    if s.role != DbStaffRole::Admin {
        return Err(PinAuthError::InvalidCredentials);
    }
    Ok(s)
}

#[allow(clippy::type_complexity)]
pub async fn authenticate_staff_by_id(
    pool: &PgPool,
    staff_id: Uuid,
    pin: Option<&str>,
) -> Result<AuthenticatedStaff, PinAuthError> {
    let row: Option<(
        Uuid,
        String,
        DbStaffRole,
        Option<String>,
        String,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT id, full_name, role, pin_hash, avatar_key, avatar_photo_url
        FROM staff
        WHERE id = $1 AND is_active = TRUE
        "#,
    )
    .bind(staff_id)
    .fetch_optional(pool)
    .await?;

    let Some((id, full_name, role, pin_hash, avatar_key, avatar_photo_url)) = row else {
        return Err(PinAuthError::InvalidCredentials);
    };

    if let Some(stored) = &pin_hash {
        let provided = pin.ok_or(PinAuthError::InvalidCredentials)?;
        if !verify_pin(provided, stored) {
            return Err(PinAuthError::InvalidCredentials);
        }
    } else {
        let provided = pin.ok_or(PinAuthError::InvalidCredentials)?;
        let row_badge: String = sqlx::query_scalar("SELECT cashier_code FROM staff WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await?;
        if provided.trim() != row_badge.trim() {
            return Err(PinAuthError::InvalidCredentials);
        }
    }

    Ok(AuthenticatedStaff {
        id,
        full_name,
        role,
        avatar_key,
        avatar_photo_url,
    })
}

pub async fn log_staff_access(
    pool: &PgPool,
    staff_id: Uuid,
    event_kind: &str,
    mut metadata: serde_json::Value,
) -> Result<(), sqlx::Error> {
    strip_sensitive_audit_metadata(&mut metadata);
    sqlx::query(
        r#"
        INSERT INTO staff_access_log (staff_id, event_kind, metadata)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(staff_id)
    .bind(event_kind)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn log_staff_access_with_id(
    pool: &PgPool,
    staff_id: Uuid,
    event_kind: &str,
    mut metadata: serde_json::Value,
) -> Result<Uuid, sqlx::Error> {
    strip_sensitive_audit_metadata(&mut metadata);
    sqlx::query_scalar(
        r#"
        INSERT INTO staff_access_log (staff_id, event_kind, metadata)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(staff_id)
    .bind(event_kind)
    .bind(metadata)
    .fetch_one(pool)
    .await
}

pub async fn log_staff_access_once<'e, E>(
    executor: E,
    staff_id: Uuid,
    event_kind: &str,
    mut metadata: serde_json::Value,
    idempotency_key: &str,
) -> Result<(), sqlx::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    strip_sensitive_audit_metadata(&mut metadata);
    sqlx::query(
        r#"
        INSERT INTO staff_access_log (staff_id, event_kind, metadata, idempotency_key)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        "#,
    )
    .bind(staff_id)
    .bind(event_kind)
    .bind(metadata)
    .bind(idempotency_key)
    .execute(executor)
    .await?;
    Ok(())
}

pub fn is_sensitive_pin_metadata_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "pin"
        || normalized.ends_with("accesspin")
        || normalized.ends_with("managerpin")
        || normalized.ends_with("staffpin")
}

fn strip_sensitive_audit_metadata(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.retain(|key, _| !is_sensitive_pin_metadata_key(key));
            for nested in object.values_mut() {
                strip_sensitive_audit_metadata(nested);
            }
        }
        serde_json::Value::Array(values) => {
            for nested in values {
                strip_sensitive_audit_metadata(nested);
            }
        }
        serde_json::Value::String(encoded) => {
            if let Ok(mut decoded) = serde_json::from_str::<serde_json::Value>(encoded) {
                if decoded.is_object() || decoded.is_array() {
                    let original = decoded.clone();
                    strip_sensitive_audit_metadata(&mut decoded);
                    if decoded != original {
                        if let Ok(sanitized) = serde_json::to_string(&decoded) {
                            *encoded = sanitized;
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{is_sensitive_pin_metadata_key, strip_sensitive_audit_metadata};
    use serde_json::json;

    #[test]
    fn sensitive_pin_metadata_keys_include_normalized_authority_suffixes() {
        for key in [
            "pin",
            "temporary_access_pin",
            "backupManagerPin",
            "x-riverside-staff-pin",
        ] {
            assert!(is_sensitive_pin_metadata_key(key));
        }
        for key in ["shipping", "campaign", "manager_reason"] {
            assert!(!is_sensitive_pin_metadata_key(key));
        }
    }

    #[test]
    fn audit_scrub_removes_pin_keys_from_string_encoded_json() {
        let mut metadata = json!({
            "encoded": "{\"manager_pin\":\"1234\",\"nested\":[{\"staffPin\":\"5678\",\"reason\":\"approved\"}]}"
        });
        strip_sensitive_audit_metadata(&mut metadata);
        let decoded: serde_json::Value =
            serde_json::from_str(metadata["encoded"].as_str().unwrap()).unwrap();
        assert!(decoded.get("manager_pin").is_none());
        assert!(decoded["nested"][0].get("staffPin").is_none());
        assert_eq!(decoded["nested"][0]["reason"], "approved");
    }

    #[test]
    fn audit_scrub_preserves_safe_string_encoded_json_exactly() {
        let mut metadata = json!({
            "reason": "{ \"note\": \"approved\" }"
        });
        strip_sensitive_audit_metadata(&mut metadata);
        assert_eq!(metadata["reason"], "{ \"note\": \"approved\" }");
    }
}
