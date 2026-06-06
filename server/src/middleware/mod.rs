//! Request helpers (RBAC-style gates).

use axum::{
    extract::{ConnectInfo, Request},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use uuid::Uuid;

pub mod rate_limit;

use crate::api::AppState;
use crate::auth::permissions::{self, staff_has_permission, NOTIFICATIONS_VIEW};
use crate::auth::pins::AuthenticatedStaff;
use crate::auth::pos_session;
use crate::models::DbStaffRole;

fn staff_headers(
    headers: &HeaderMap,
) -> Result<(String, Option<String>), (StatusCode, axum::Json<serde_json::Value>)> {
    let code = headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();

    if code.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "x-riverside-staff-code header required" })),
        ));
    }

    let pin = headers
        .get("x-riverside-staff-pin")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .map(str::to_string);

    Ok((code, pin))
}

fn has_staff_code(headers: &HeaderMap) -> bool {
    headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
}

/// Active staff (POS PIN rules). Does not check permissions.
pub async fn require_authenticated_staff_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, (StatusCode, axum::Json<serde_json::Value>)> {
    let (code, pin) = staff_headers(headers)?;
    crate::auth::pins::authenticate_pos_staff(&state.db, &code, pin.as_deref())
        .await
        .map_err(|_| {
            (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": "invalid staff credentials" })),
            )
        })
}

/// Validates staff headers and requires an effective Back Office permission.
/// `DbStaffRole::Admin` receives full catalog in `effective_permissions` (see `auth::permissions`).
pub async fn require_staff_with_permission(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<AuthenticatedStaff, (StatusCode, axum::Json<serde_json::Value>)> {
    let staff = require_authenticated_staff_headers(state, headers).await?;
    let eff = permissions::effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "effective_permissions query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "permission resolution failed" })),
            )
        })?;

    let has = staff_has_permission(&eff, permission);

    tracing::debug!(
        staff_id = %staff.id,
        staff_name = %staff.full_name,
        staff_role = ?staff.role,
        requested_permission = %permission,
        permitted = %has,
        "Permission check"
    );

    if !has {
        return Err((
            StatusCode::FORBIDDEN,
            axum::Json(json!({
                "error": "missing permission",
                "permission": permission,
            })),
        ));
    }
    Ok(staff)
}

/// Caller is either Back Office staff (headers + PIN) or an open register session (opaque token).
#[derive(Debug, Clone)]
pub enum StaffOrPosSession {
    Staff(AuthenticatedStaff),
    PosSession { session_id: Uuid },
}

/// Authenticated staff **or** valid `x-riverside-pos-session-id` + `x-riverside-pos-session-token`.
pub async fn require_staff_or_pos_register_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<StaffOrPosSession, (StatusCode, axum::Json<serde_json::Value>)> {
    let staff_attempt = if has_staff_code(headers) {
        match require_authenticated_staff_headers(state, headers).await {
            Ok(staff) => return Ok(StaffOrPosSession::Staff(staff)),
            Err(err) => Some(err),
        }
    } else {
        None
    };

    if let Some((sid, tok)) = pos_session::pos_session_headers(headers) {
        match pos_session::verify_pos_session_token(&state.db, sid, &tok).await {
            Ok(true) => return Ok(StaffOrPosSession::PosSession { session_id: sid }),
            Ok(false) => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "error": "invalid or expired register session token" })),
                ));
            }
            Err(e) => {
                tracing::error!(error = %e, "register session token verify failed");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "session verification failed" })),
                ));
            }
        }
    }

    if let Some(err) = staff_attempt {
        return Err(err);
    }

    let staff = require_authenticated_staff_headers(state, headers).await?;
    Ok(StaffOrPosSession::Staff(staff))
}

/// Valid POS API token for the **path** `session_id`, or Back Office staff with `permission`
/// (e.g. `register.reports` for Z/X / reconciliation reads).
pub async fn require_pos_session_secret_or_permission(
    state: &AppState,
    headers: &HeaderMap,
    session_id: Uuid,
    permission: &str,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    let permission_attempt = if has_staff_code(headers) {
        match require_staff_with_permission(state, headers, permission).await {
            Ok(_) => return Ok(()),
            Err(err) => Some(err),
        }
    } else {
        None
    };

    if let Some((sid, tok)) = pos_session::pos_session_headers(headers) {
        if sid == session_id {
            match pos_session::verify_pos_session_token(&state.db, sid, &tok).await {
                Ok(true) => return Ok(()),
                Ok(false) => {
                    return Err((
                        StatusCode::UNAUTHORIZED,
                        axum::Json(json!({ "error": "invalid or expired register session token" })),
                    ));
                }
                Err(e) => {
                    tracing::error!(error = %e, "register session token verify failed");
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        axum::Json(json!({ "error": "session verification failed" })),
                    ));
                }
            }
        }
    }
    if let Some(err) = permission_attempt {
        return Err(err);
    }
    require_staff_with_permission(state, headers, permission)
        .await
        .map(|_| ())
}

/// Open register **POS token** (any valid session), or Back Office staff with `permission`.
/// Used for receiving / batch-scan where the register device is trusted without a separate BO permission on the handheld.
pub async fn require_staff_perm_or_pos_session(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<StaffOrPosSession, (StatusCode, axum::Json<serde_json::Value>)> {
    let permission_attempt = if has_staff_code(headers) {
        match require_staff_with_permission(state, headers, permission).await {
            Ok(staff) => return Ok(StaffOrPosSession::Staff(staff)),
            Err(err) => Some(err),
        }
    } else {
        None
    };

    if let Some((sid, tok)) = pos_session::pos_session_headers(headers) {
        match pos_session::verify_pos_session_token(&state.db, sid, &tok).await {
            Ok(true) => return Ok(StaffOrPosSession::PosSession { session_id: sid }),
            Ok(false) => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "error": "invalid or expired register session token" })),
                ));
            }
            Err(e) => {
                tracing::error!(error = %e, "register session token verify failed");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "session verification failed" })),
                ));
            }
        }
    }
    if let Some(err) = permission_attempt {
        return Err(err);
    }
    let staff = require_staff_with_permission(state, headers, permission).await?;
    Ok(StaffOrPosSession::Staff(staff))
}

/// Checkout: POS headers must match `payload.session_id`.
pub async fn require_pos_register_session_for_checkout(
    state: &AppState,
    headers: &HeaderMap,
    body_session_id: Uuid,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    let Some((sid, tok)) = pos_session::pos_session_headers(headers) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({
                "error": "checkout requires x-riverside-pos-session-id and x-riverside-pos-session-token from an open register session",
            })),
        ));
    };
    if sid != body_session_id {
        return Err((
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "pos session id must match checkout session_id" })),
        ));
    }
    match pos_session::verify_pos_session_token(&state.db, sid, &tok).await {
        Ok(true) => Ok(()),
        Ok(false) => Err((
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "invalid or expired register session token" })),
        )),
        Err(e) => {
            tracing::error!(error = %e, "register session token verify failed");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "session verification failed" })),
            ))
        }
    }
}

/// Inbox + bell: Back Office staff headers, or valid POS register session (`opened_by` staff).
pub async fn require_notification_viewer(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, (StatusCode, axum::Json<serde_json::Value>)> {
    let code = headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();

    let staff = if !code.is_empty() {
        require_authenticated_staff_headers(state, headers).await?
    } else if let Some((sid, tok)) = pos_session::pos_session_headers(headers) {
        match pos_session::verify_pos_session_token(&state.db, sid, &tok).await {
            Ok(true) => {}
            Ok(false) => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "error": "invalid or expired register session token" })),
                ));
            }
            Err(e) => {
                tracing::error!(error = %e, "register session token verify failed (notifications)");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "session verification failed" })),
                ));
            }
        }
        let row: Option<(Uuid, String, DbStaffRole, String, Option<String>)> = sqlx::query_as(
            r#"
            SELECT s.id, s.full_name, s.role, s.avatar_key, s.avatar_photo_url
            FROM register_sessions rs
            JOIN staff s ON s.id = COALESCE(rs.shift_primary_staff_id, rs.opened_by)
            WHERE rs.id = $1 AND rs.is_open = true AND s.is_active = TRUE
            "#,
        )
        .bind(sid)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "notification viewer opened_by lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "database error" })),
            )
        })?;
        let Some((id, full_name, role, avatar_key, avatar_photo_url)) = row else {
            return Err((
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": "no open register session for notifications" })),
            ));
        };
        AuthenticatedStaff {
            id,
            full_name,
            role,
            avatar_key,
            avatar_photo_url,
        }
    } else {
        return Err((
            StatusCode::UNAUTHORIZED,
            axum::Json(
                json!({ "error": "x-riverside-staff-code or register session headers required" }),
            ),
        ));
    };

    let eff = permissions::effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "effective_permissions for notifications");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "permission resolution failed" })),
            )
        })?;
    if !staff_has_permission(&eff, NOTIFICATIONS_VIEW) {
        return Err((
            StatusCode::FORBIDDEN,
            axum::Json(json!({
                "error": "missing permission",
                "permission": NOTIFICATIONS_VIEW,
            })),
        ));
    }
    Ok(staff)
}

/// In-app help search: authenticated staff headers **or** valid open register session (no extra permission).
pub async fn require_help_viewer(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    let code = headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();

    if !code.is_empty() {
        if require_authenticated_staff_headers(state, headers)
            .await
            .is_ok()
        {
            return Ok(());
        }
    }

    if let Some((sid, tok)) = pos_session::pos_session_headers(headers) {
        match pos_session::verify_pos_session_token(&state.db, sid, &tok).await {
            Ok(true) => return Ok(()),
            Ok(false) => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "error": "invalid or expired register session token" })),
                ));
            }
            Err(e) => {
                tracing::error!(error = %e, "register session token verify failed (help)");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "session verification failed" })),
                ));
            }
        }
    }

    Err((
        StatusCode::UNAUTHORIZED,
        axum::Json(
            json!({ "error": "x-riverside-staff-code or register session headers required" }),
        ),
    ))
}

/// IP shield middleware for `/api/ops/*` routing to restrict access to local/private and Tailscale networks.
pub async fn ops_shield_middleware(request: Request, next: Next) -> Response {
    let client_ip = extract_client_ip(&request);

    if let Some(ip) = client_ip {
        if is_allowed_ip(ip) {
            next.run(request).await
        } else {
            tracing::warn!(
                client_ip = %ip,
                path = request.uri().path(),
                "Ops shield: blocked request from unauthorized IP space"
            );
            StatusCode::FORBIDDEN.into_response()
        }
    } else {
        tracing::warn!(
            path = request.uri().path(),
            "Ops shield: blocked request due to unresolvable client IP"
        );
        StatusCode::FORBIDDEN.into_response()
    }
}

fn extract_client_ip(request: &Request) -> Option<IpAddr> {
    // Check for X-Forwarded-For header (reverse proxy)
    if let Some(forwarded) = request.headers().get("x-forwarded-for") {
        if let Ok(forwarded_str) = forwarded.to_str() {
            if let Some(first_ip) = forwarded_str.split(',').next() {
                let ip = first_ip.trim();
                if !ip.is_empty() {
                    if let Ok(parsed_ip) = ip.parse::<IpAddr>() {
                        return Some(parsed_ip);
                    }
                }
            }
        }
    }

    // Fall back to ConnectInfo SocketAddr extension
    if let Some(conn_info) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        return Some(conn_info.0.ip());
    }

    // Fall back to direct SocketAddr extension
    if let Some(addr) = request.extensions().get::<SocketAddr>() {
        return Some(addr.ip());
    }

    None
}

fn is_allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            // Loopback: 127.0.0.0/8
            if ipv4.is_loopback() {
                return true;
            }
            // RFC 1918:
            // 10.0.0.0/8
            // 172.16.0.0/12
            // 192.168.0.0/16
            let octets = ipv4.octets();
            if octets[0] == 10 {
                return true;
            }
            if octets[0] == 172 && (octets[1] >= 16 && octets[1] <= 31) {
                return true;
            }
            if octets[0] == 192 && octets[1] == 168 {
                return true;
            }
            // Tailscale: 100.64.0.0/10
            if octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127) {
                return true;
            }
            false
        }
        IpAddr::V6(ipv6) => {
            if ipv6.is_loopback() {
                return true;
            }
            // Tailscale IPv6: fd7a:115c:a1e0::/48
            let segments = ipv6.segments();
            if segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0 {
                return true;
            }
            false
        }
    }
}
