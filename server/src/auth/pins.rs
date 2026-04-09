//! Argon2-hashed staff PINs. Legacy rows with `pin_hash` NULL still authenticate with `cashier_code` only.

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::DbStaffRole;

#[derive(Debug, Clone)]
pub struct AuthenticatedStaff {
    pub id: Uuid,
    pub full_name: String,
    pub role: DbStaffRole,
    /// Bundled avatar slug (`client/public/staff-avatars/{key}.svg`).
    pub avatar_key: String,
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
pub async fn authenticate_pos_staff(
    pool: &PgPool,
    cashier_code: &str,
    pin: Option<&str>,
) -> Result<AuthenticatedStaff, PinAuthError> {
    let badge = cashier_code.trim();
    if badge.is_empty() {
        return Err(PinAuthError::InvalidCredentials);
    }

    let row: Option<(Uuid, String, DbStaffRole, Option<String>, String)> = sqlx::query_as(
        r#"
        SELECT id, full_name, role, pin_hash, avatar_key
        FROM staff
        WHERE cashier_code = $1 AND is_active = TRUE
        "#,
    )
    .bind(badge)
    .fetch_optional(pool)
    .await?;

    let Some((id, full_name, role, pin_hash, avatar_key)) = row else {
        return Err(PinAuthError::InvalidCredentials);
    };

    // If this staff member has a PIN set, require the same 4-digit credential as `cashier_code`.
    if let Some(stored) = &pin_hash {
        let provided = pin.ok_or(PinAuthError::InvalidCredentials)?;
        let p = provided.trim();
        if p != badge {
            return Err(PinAuthError::InvalidCredentials);
        }
        if !verify_pin(p, stored) {
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

pub async fn log_staff_access(
    pool: &PgPool,
    staff_id: Uuid,
    event_kind: &str,
    metadata: serde_json::Value,
) -> Result<(), sqlx::Error> {
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
