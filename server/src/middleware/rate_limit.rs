//! Global rate limiting middleware for API abuse prevention

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::AppState;

const DEFAULT_GLOBAL_RATE_LIMIT: u32 = 1000; // requests per minute per IP
const DEFAULT_AUTHENTICATED_RATE_LIMIT: u32 = 5000; // requests per minute per authenticated user
const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct RateLimitBucket {
    window_start: Instant,
    count: u32,
}

#[derive(Debug)]
struct RateLimitState {
    // IP-based rate limiting for anonymous requests
    ip_buckets: HashMap<String, RateLimitBucket>,
    // User-based rate limiting for authenticated requests
    user_buckets: HashMap<Uuid, RateLimitBucket>,
}

impl RateLimitState {
    fn new() -> Self {
        Self {
            ip_buckets: HashMap::new(),
            user_buckets: HashMap::new(),
        }
    }

    fn tick_bucket(bucket: &mut RateLimitBucket, now: Instant) {
        if now.duration_since(bucket.window_start) >= WINDOW {
            bucket.window_start = now;
            bucket.count = 0;
        }
    }

    fn check_ip_limit(&mut self, ip_key: &str, limit: u32, now: Instant) -> bool {
        let bucket = self.ip_buckets.entry(ip_key.to_string()).or_insert(RateLimitBucket {
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
            self.ip_buckets.retain(|_, b| now.duration_since(b.window_start) < Duration::from_secs(120));
        }
        
        true
    }

    fn check_user_limit(&mut self, user_id: Uuid, limit: u32, now: Instant) -> bool {
        let bucket = self.user_buckets.entry(user_id).or_insert(RateLimitBucket {
            window_start: now,
            count: 0,
        });
        
        Self::tick_bucket(bucket, now);
        
        if bucket.count >= limit {
            return false;
        }
        
        bucket.count += 1;
        
        // Cleanup old entries periodically
        if self.user_buckets.len() > 5000 {
            self.user_buckets.retain(|_, b| now.duration_since(b.window_start) < Duration::from_secs(120));
        }
        
        true
    }
}

pub type RateLimitMiddleware = Arc<RwLock<RateLimitState>>;

pub fn rate_limit_middleware() -> RateLimitMiddleware {
    Arc::new(RwLock::new(RateLimitState::new()))
}

pub async fn rate_limit_handler(
    State(rate_limit_state): State<RateLimitMiddleware>,
    State(app_state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let now = Instant::now();
    
    // Extract client IP
    let client_ip = extract_client_ip(&request);
    
    // Check for authenticated user
    let user_id = extract_user_id(&request, &app_state).await;
    
    let mut state = rate_limit_state.write().await;
    
    let allowed = if let Some(user_id) = user_id {
        // Authenticated user - use higher limit
        let limit = std::env::var("RIVERSIDE_AUTHENTICATED_RATE_LIMIT_PER_MINUTE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_AUTHENTICATED_RATE_LIMIT);
        
        state.check_user_limit(user_id, limit, now)
    } else {
        // Anonymous request - use IP-based limit
        let limit = std::env::var("RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_GLOBAL_RATE_LIMIT);
        
        state.check_ip_limit(&client_ip, limit, now)
    };
    
    drop(state); // Release lock before proceeding
    
    if !allowed {
        tracing::warn!(
            client_ip = %client_ip,
            user_id = ?user_id,
            "Rate limit exceeded"
        );
        
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    
    // Add rate limit headers
    let mut response = next.run(request).await;
    
    let headers = response.headers_mut();
    headers.insert("X-RateLimit-Limit", "1000".parse().unwrap());
    headers.insert("X-RateLimit-Window", "60".parse().unwrap());
    headers.insert("X-RateLimit-Remaining", "999".parse().unwrap());
    
    Ok(response)
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

async fn extract_user_id(request: &Request, app_state: &AppState) -> Option<Uuid> {
    // Check Authorization header for JWT token
    if let Some(auth_header) = request.headers().get("authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                // Validate JWT token and extract user ID
                // This is a simplified version - in production you'd want proper JWT validation
                if let Ok(claims) = validate_jwt_token(token, &app_state).await {
                    return claims.user_id;
                }
            }
        }
    }
    
    None
}

#[derive(Debug)]
struct JwtClaims {
    user_id: Option<Uuid>,
}

async fn validate_jwt_token(token: &str, _app_state: &AppState) -> Result<JwtClaims, ()> {
    // Simplified JWT validation - in production this would be more robust
    // For now, we'll just return None to indicate no authenticated user
    // The actual JWT validation logic should be implemented based on your auth system
    
    // This is a placeholder - implement proper JWT validation
    Err(())
}
