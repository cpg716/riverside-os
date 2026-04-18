//! HS256 JWT for Metabase JWT-based SSO (Identity Provider handoff).
//! Metabase must have Authentication → JWT enabled with the same signing secret as
//! `RIVERSIDE_METABASE_JWT_SECRET` (see Metabase docs; feature is typically on paid plans).

use crate::models::DbStaffRole;
use chrono::Utc;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize)]
struct MetabaseJwtClaims {
    /// Stable Metabase user identity (staff UUID).
    sub: String,
    email: String,
    first_name: String,
    last_name: String,
    /// Metabase group sync: names should match Metabase groups or JWT mappings.
    groups: Vec<String>,
    exp: i64,
    iat: i64,
}

fn split_full_name(full_name: &str) -> (String, String) {
    let t = full_name.trim();
    if t.is_empty() {
        return ("Staff".to_string(), "User".to_string());
    }
    let mut parts = t.split_whitespace();
    let first = parts.next().unwrap_or("Staff").to_string();
    let rest: Vec<_> = parts.collect();
    let last = if rest.is_empty() {
        "User".to_string()
    } else {
        rest.join(" ")
    };
    (first, last)
}

fn role_metabase_groups(role: DbStaffRole) -> Vec<String> {
    match role {
        DbStaffRole::Admin => vec!["ROS Admin".to_string(), "All Users".to_string()],
        DbStaffRole::Salesperson => vec!["ROS Sales".to_string(), "All Users".to_string()],
        DbStaffRole::SalesSupport => vec!["ROS Sales Support".to_string(), "All Users".to_string()],
        DbStaffRole::StaffSupport => vec!["ROS Staff Support".to_string(), "All Users".to_string()],
        DbStaffRole::Alterations => vec!["ROS Alterations".to_string(), "All Users".to_string()],
    }
}

/// Build a short-lived JWT for `/auth/sso?jwt=…` (proxied as `/metabase/auth/sso`).
pub fn mint_metabase_staff_jwt(
    secret: &str,
    staff_id: Uuid,
    full_name: &str,
    role: DbStaffRole,
    email_opt: Option<&str>,
    cashier_code: &str,
    email_domain: &str,
) -> Result<String, String> {
    if secret.len() < 16 {
        return Err("RIVERSIDE_METABASE_JWT_SECRET must be at least 16 characters".to_string());
    }
    let (first_name, last_name) = split_full_name(full_name);
    let email = match email_opt {
        Some(e) if !e.trim().is_empty() => e.trim().to_string(),
        _ => format!("{cashier_code}@{email_domain}"),
    };
    let now = Utc::now().timestamp();
    let exp = now + 300;
    let groups = role_metabase_groups(role);
    let claims = MetabaseJwtClaims {
        sub: staff_id.to_string(),
        email,
        first_name,
        last_name,
        groups,
        exp,
        iat: now,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("jwt encode: {e}"))
}
