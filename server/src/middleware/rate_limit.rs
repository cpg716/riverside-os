//! Global rate limiting middleware for API abuse prevention

use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const DEFAULT_GLOBAL_RATE_LIMIT: u32 = 1000; // requests per minute per IP
const DEFAULT_AUTHENTICATED_RATE_LIMIT: u32 = 5000; // requests per minute per app-authenticated IP
const DEFAULT_STAFF_SIGN_IN_RATE_LIMIT: u32 = 20; // PIN attempts per minute per IP
const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct RateLimitBucket {
    window_start: Instant,
    count: u32,
    last_exceeded_log: Option<Instant>,
}

#[derive(Debug)]
pub struct RateLimitState {
    // IP-based rate limiting for anonymous requests.
    ip_buckets: HashMap<String, RateLimitBucket>,
    // Higher per-IP bucket for ROS app requests that carry staff or POS session credentials.
    authenticated_buckets: HashMap<String, RateLimitBucket>,
    // Separate low-volume bucket for Staff Access PIN verification.
    staff_sign_in_buckets: HashMap<String, RateLimitBucket>,
}

impl RateLimitState {
    fn new() -> Self {
        Self {
            ip_buckets: HashMap::new(),
            authenticated_buckets: HashMap::new(),
            staff_sign_in_buckets: HashMap::new(),
        }
    }

    fn tick_bucket(bucket: &mut RateLimitBucket, now: Instant) {
        if now.duration_since(bucket.window_start) >= WINDOW {
            bucket.window_start = now;
            bucket.count = 0;
        }
    }

    fn check_limit(
        buckets: &mut HashMap<String, RateLimitBucket>,
        bucket_key: &str,
        limit: u32,
        now: Instant,
    ) -> RateLimitCheck {
        let bucket = buckets
            .entry(bucket_key.to_string())
            .or_insert(RateLimitBucket {
                window_start: now,
                count: 0,
                last_exceeded_log: None,
            });

        Self::tick_bucket(bucket, now);

        if bucket.count >= limit {
            let should_log = bucket
                .last_exceeded_log
                .is_none_or(|last| now.duration_since(last) >= WINDOW);
            if should_log {
                bucket.last_exceeded_log = Some(now);
            }
            return RateLimitCheck::Exceeded { should_log };
        }

        bucket.count += 1;

        // Cleanup old entries periodically
        if buckets.len() > 10000 {
            buckets.retain(|_, b| now.duration_since(b.window_start) < Duration::from_secs(120));
        }

        RateLimitCheck::Allowed
    }

    fn check_ip_limit(
        &mut self,
        ip_key: &str,
        limit: u32,
        scope: RateLimitScope,
        now: Instant,
    ) -> RateLimitCheck {
        match scope {
            RateLimitScope::Anonymous => {
                Self::check_limit(&mut self.ip_buckets, ip_key, limit, now)
            }
            RateLimitScope::RosAppAuthenticated => {
                Self::check_limit(&mut self.authenticated_buckets, ip_key, limit, now)
            }
            RateLimitScope::StaffSignIn => {
                Self::check_limit(&mut self.staff_sign_in_buckets, ip_key, limit, now)
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RateLimitCheck {
    Allowed,
    Exceeded { should_log: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RateLimitScope {
    Anonymous,
    RosAppAuthenticated,
    StaffSignIn,
}

impl RateLimitScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Anonymous => "anonymous",
            Self::RosAppAuthenticated => "ros-app-authenticated",
            Self::StaffSignIn => "staff-sign-in",
        }
    }
}

pub type RateLimitMiddleware = Arc<RwLock<RateLimitState>>;

pub fn rate_limit_middleware() -> RateLimitMiddleware {
    Arc::new(RwLock::new(RateLimitState::new()))
}

/// Axum middleware handler for global rate limiting.
pub async fn rate_limit_handler(
    State(rate_limit): State<RateLimitMiddleware>,
    request: Request,
    next: Next,
) -> Response {
    if is_loopback_connection(&request) {
        let mut response = next.run(request).await;
        response
            .headers_mut()
            .insert("X-RateLimit-Bypass", "loopback".parse().unwrap());
        return response;
    }

    if is_health_probe_request(&request) {
        let mut response = next.run(request).await;
        response
            .headers_mut()
            .insert("X-RateLimit-Bypass", "health-probe".parse().unwrap());
        return response;
    }

    let now = Instant::now();

    // Extract client IP
    let client_ip = extract_client_ip(&request);

    let mut state = rate_limit.write().await;

    let scope = if is_staff_sign_in_request(&request) {
        RateLimitScope::StaffSignIn
    } else if has_ros_app_auth_headers(&request) {
        RateLimitScope::RosAppAuthenticated
    } else {
        RateLimitScope::Anonymous
    };
    let limit = match scope {
        RateLimitScope::Anonymous => std::env::var("RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_GLOBAL_RATE_LIMIT),
        RateLimitScope::RosAppAuthenticated => {
            std::env::var("RIVERSIDE_AUTHENTICATED_RATE_LIMIT_PER_MINUTE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_AUTHENTICATED_RATE_LIMIT)
        }
        RateLimitScope::StaffSignIn => {
            std::env::var("RIVERSIDE_STAFF_SIGN_IN_RATE_LIMIT_PER_MINUTE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_STAFF_SIGN_IN_RATE_LIMIT)
        }
    };

    let bucket_key = if scope == RateLimitScope::RosAppAuthenticated {
        authenticated_bucket_key(&request, &client_ip)
    } else {
        client_ip.clone()
    };
    let rate_limit_check = state.check_ip_limit(&bucket_key, limit, scope, now);

    drop(state); // Release lock before proceeding

    if let RateLimitCheck::Exceeded { should_log } = rate_limit_check {
        if should_log {
            tracing::warn!(
                client_ip = %client_ip,
                method = %request.method(),
                path = %request.uri().path(),
                limit_per_minute = limit,
                scope = scope.as_str(),
                "Rate limit exceeded"
            );
        }

        let mut response = StatusCode::TOO_MANY_REQUESTS.into_response();
        let headers = response.headers_mut();
        headers.insert("X-RateLimit-Limit", limit.to_string().parse().unwrap());
        headers.insert("X-RateLimit-Window", "60".parse().unwrap());
        headers.insert("X-RateLimit-Remaining", "0".parse().unwrap());
        return response;
    }

    // Add rate limit headers
    let mut response = next.run(request).await;

    let headers = response.headers_mut();
    headers.insert("X-RateLimit-Limit", limit.to_string().parse().unwrap());
    headers.insert("X-RateLimit-Window", "60".parse().unwrap());
    headers.insert("X-RateLimit-Remaining", "999".parse().unwrap());

    response
}

fn has_ros_app_auth_headers(request: &Request) -> bool {
    let headers = request.headers();
    let has_staff_credentials = header_has_value(headers, "x-riverside-staff-code")
        && header_has_value(headers, "x-riverside-staff-pin");
    let has_pos_credentials = header_has_value(headers, "x-riverside-pos-session-id")
        && header_has_value(headers, "x-riverside-pos-session-token")
        && header_has_value(headers, "x-riverside-station-key");
    let has_staff_session = header_has_value(headers, "x-riverside-staff-session")
        && header_has_value(headers, "x-riverside-station-key")
        && header_has_value(headers, "x-riverside-connection-key");
    has_staff_credentials || has_staff_session || has_pos_credentials
}

fn authenticated_bucket_key(request: &Request, client_ip: &str) -> String {
    let headers = request.headers();
    let station = headers
        .get("x-riverside-station-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let session = headers
        .get("x-riverside-pos-session-id")
        .or_else(|| headers.get("x-riverside-staff-session"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match (station, session) {
        (Some(station), Some(session)) => format!("{client_ip}:{station}:{session}"),
        (Some(station), None) => format!("{client_ip}:{station}"),
        _ => client_ip.to_string(),
    }
}

fn is_staff_sign_in_request(request: &Request) -> bool {
    request.method() == axum::http::Method::POST && request.uri().path() == "/api/staff/session"
}

fn header_has_value(headers: &axum::http::HeaderMap, name: &'static str) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn is_loopback_connection(request: &Request) -> bool {
    if let Some(connect_info) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        return connect_info.0.ip().is_loopback();
    }

    request
        .extensions()
        .get::<SocketAddr>()
        .is_some_and(|addr| addr.ip().is_loopback())
}

fn is_health_probe_request(request: &Request) -> bool {
    matches!(
        request.uri().path(),
        "/api/health" | "/api/health/" | "/api/ready" | "/api/live"
    )
}

fn extract_client_ip(request: &Request) -> String {
    // Forwarded headers are client-controlled unless a trusted reverse proxy overwrites them.
    if trust_proxy_headers() {
        if let Some(forwarded) = request.headers().get("x-forwarded-for") {
            if let Ok(forwarded_str) = forwarded.to_str() {
                if let Some(first_ip) = forwarded_str.split(',').next() {
                    let ip = first_ip.trim();
                    if !ip.is_empty() {
                        return ip.to_string();
                    }
                }
            }
        }

        if let Some(real_ip) = request.headers().get("x-real-ip") {
            if let Ok(real_ip_str) = real_ip.to_str() {
                let ip = real_ip_str.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }

    if let Some(connect_info) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        return connect_info.0.ip().to_string();
    }

    // Fall back to direct remote address for tests or non-Axum callers.
    request
        .extensions()
        .get::<SocketAddr>()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn trust_proxy_headers() -> bool {
    std::env::var("RIVERSIDE_TRUST_PROXY_HEADERS")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

// JWT-based user rate limiting can be added here in the future by extracting
// the Authorization header and validating the token against AppState.

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    fn request_for(path: &str) -> Request {
        Request::builder()
            .uri(path)
            .body(Body::empty())
            .expect("test request")
    }

    fn request_with_headers(path: &str, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::builder().uri(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).expect("test request")
    }

    #[test]
    fn health_probe_paths_bypass_rate_limit() {
        for path in ["/api/health", "/api/health/", "/api/ready", "/api/live"] {
            assert!(is_health_probe_request(&request_for(path)));
        }
    }

    #[test]
    fn normal_api_paths_do_not_bypass_rate_limit() {
        assert!(!is_health_probe_request(&request_for("/api/transactions")));
    }

    #[test]
    fn ros_app_auth_headers_require_complete_credentials() {
        assert!(!has_ros_app_auth_headers(&request_for("/api/transactions")));
        assert!(!has_ros_app_auth_headers(&request_with_headers(
            "/api/sync/counterpoint/tickets",
            &[("x-ros-sync-token", "unverified-at-middleware")]
        )));
        assert!(!has_ros_app_auth_headers(&request_with_headers(
            "/api/transactions",
            &[("x-riverside-staff-code", "1234")]
        )));
        assert!(has_ros_app_auth_headers(&request_with_headers(
            "/api/transactions",
            &[
                ("x-riverside-staff-code", "1234"),
                ("x-riverside-staff-pin", "1234")
            ]
        )));
        assert!(!has_ros_app_auth_headers(&request_with_headers(
            "/api/transactions",
            &[
                (
                    "x-riverside-pos-session-id",
                    "4d67bb88-2858-4a83-80ac-6f6f7b88a124"
                ),
                ("x-riverside-pos-session-token", "token")
            ]
        )));
        assert!(has_ros_app_auth_headers(&request_with_headers(
            "/api/transactions",
            &[
                (
                    "x-riverside-pos-session-id",
                    "4d67bb88-2858-4a83-80ac-6f6f7b88a124"
                ),
                ("x-riverside-pos-session-token", "token"),
                ("x-riverside-station-key", "station")
            ]
        )));
        assert!(!has_ros_app_auth_headers(&request_with_headers(
            "/api/transactions",
            &[("x-riverside-staff-session", "opaque")]
        )));
        assert!(has_ros_app_auth_headers(&request_with_headers(
            "/api/transactions",
            &[
                ("x-riverside-staff-session", "opaque"),
                ("x-riverside-station-key", "station"),
                ("x-riverside-connection-key", "connection")
            ]
        )));
    }

    #[test]
    fn staff_sign_in_scope_matches_only_session_creation_posts() {
        let post = Request::builder()
            .method(axum::http::Method::POST)
            .uri("/api/staff/session")
            .body(Body::empty())
            .expect("test request");
        assert!(is_staff_sign_in_request(&post));
        assert!(!is_staff_sign_in_request(&request_for(
            "/api/staff/session"
        )));
        assert!(!is_staff_sign_in_request(&request_for(
            "/api/staff/effective-permissions"
        )));
    }

    #[test]
    fn exceeded_rate_limit_logs_once_per_window() {
        let mut state = RateLimitState::new();
        let now = Instant::now();

        assert_eq!(
            state.check_ip_limit("10.64.70.117", 1, RateLimitScope::Anonymous, now),
            RateLimitCheck::Allowed
        );
        assert_eq!(
            state.check_ip_limit(
                "10.64.70.117",
                1,
                RateLimitScope::Anonymous,
                now + Duration::from_secs(1)
            ),
            RateLimitCheck::Exceeded { should_log: true }
        );
        assert_eq!(
            state.check_ip_limit(
                "10.64.70.117",
                1,
                RateLimitScope::Anonymous,
                now + Duration::from_secs(2)
            ),
            RateLimitCheck::Exceeded { should_log: false }
        );
        assert_eq!(
            state.check_ip_limit("10.64.70.117", 1, RateLimitScope::Anonymous, now + WINDOW),
            RateLimitCheck::Allowed
        );
        assert_eq!(
            state.check_ip_limit(
                "10.64.70.117",
                1,
                RateLimitScope::Anonymous,
                now + WINDOW + Duration::from_secs(1)
            ),
            RateLimitCheck::Exceeded { should_log: true }
        );
    }

    #[test]
    fn authenticated_scope_uses_separate_bucket() {
        let mut state = RateLimitState::new();
        let now = Instant::now();

        assert_eq!(
            state.check_ip_limit("10.64.70.117", 1, RateLimitScope::Anonymous, now),
            RateLimitCheck::Allowed
        );
        assert_eq!(
            state.check_ip_limit("10.64.70.117", 1, RateLimitScope::RosAppAuthenticated, now),
            RateLimitCheck::Allowed
        );
        assert_eq!(
            state.check_ip_limit(
                "10.64.70.117",
                1,
                RateLimitScope::Anonymous,
                now + Duration::from_secs(1)
            ),
            RateLimitCheck::Exceeded { should_log: true }
        );
        assert_eq!(
            state.check_ip_limit(
                "10.64.70.117",
                1,
                RateLimitScope::RosAppAuthenticated,
                now + Duration::from_secs(1)
            ),
            RateLimitCheck::Exceeded { should_log: true }
        );
    }
}
