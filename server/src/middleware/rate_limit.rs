//! Global rate limiting middleware for API abuse prevention

use axum::{
    extract::{Request, State},
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
const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct RateLimitBucket {
    window_start: Instant,
    count: u32,
}

#[derive(Debug)]
pub struct RateLimitState {
    // IP-based rate limiting for anonymous requests
    ip_buckets: HashMap<String, RateLimitBucket>,
}

impl RateLimitState {
    fn new() -> Self {
        Self {
            ip_buckets: HashMap::new(),
        }
    }

    fn tick_bucket(bucket: &mut RateLimitBucket, now: Instant) {
        if now.duration_since(bucket.window_start) >= WINDOW {
            bucket.window_start = now;
            bucket.count = 0;
        }
    }

    fn check_ip_limit(&mut self, ip_key: &str, limit: u32, now: Instant) -> bool {
        let bucket = self
            .ip_buckets
            .entry(ip_key.to_string())
            .or_insert(RateLimitBucket {
                window_start: now,
                count: 0,
            });

        Self::tick_bucket(bucket, now);

        if bucket.count >= limit {
            return false;
        }

        bucket.count += 1;

        // Cleanup old entries periodically
        if self.ip_buckets.len() > 10000 {
            self.ip_buckets
                .retain(|_, b| now.duration_since(b.window_start) < Duration::from_secs(120));
        }

        true
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
    let now = Instant::now();

    // Extract client IP
    let client_ip = extract_client_ip(&request);

    let mut state = rate_limit.write().await;

    let limit = std::env::var("RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_GLOBAL_RATE_LIMIT);

    let allowed = state.check_ip_limit(&client_ip, limit, now);

    drop(state); // Release lock before proceeding

    if !allowed {
        tracing::warn!(client_ip = %client_ip, "Rate limit exceeded");

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

fn extract_client_ip(request: &Request) -> String {
    // Check for X-Forwarded-For header (reverse proxy)
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

    // Fall back to remote address
    request
        .extensions()
        .get::<SocketAddr>()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

// JWT-based user rate limiting can be added here in the future by extracting
// the Authorization header and validating the token against AppState.
