//! Sliding-window rate limits for public `/api/store/account/*` (abuse reduction).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::http::{header::HeaderName, HeaderMap};

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct MinuteBucket {
    window_start: Instant,
    count: u32,
}

#[derive(Debug, Default)]
pub struct StoreAccountRateState {
    unauth_post_by_ip: HashMap<String, MinuteBucket>,
    authed_by_customer: HashMap<String, MinuteBucket>,
}

/// Prefer first `X-Forwarded-For` hop when present (reverse proxy); else peer IP.
pub fn store_account_client_key(headers: &HeaderMap, peer: SocketAddr) -> String {
    if let Some(ff) = headers
        .get(HeaderName::from_static("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
    {
        if let Some(first) = ff.split(',').next() {
            let t = first.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    peer.ip().to_string()
}

impl StoreAccountRateState {
    fn tick_bucket(bucket: &mut MinuteBucket, now: Instant) {
        if now.duration_since(bucket.window_start) >= WINDOW {
            bucket.window_start = now;
            bucket.count = 0;
        }
    }

    /// Login / register / activate (per client key, usually IP).
    pub fn try_consume_unauth_post(
        &mut self,
        key: &str,
        max_per_minute: u32,
        now: Instant,
    ) -> bool {
        if max_per_minute == 0 {
            return true;
        }
        let b = self
            .unauth_post_by_ip
            .entry(key.to_string())
            .or_insert(MinuteBucket {
                window_start: now,
                count: 0,
            });
        Self::tick_bucket(b, now);
        if b.count >= max_per_minute {
            return false;
        }
        b.count += 1;
        if self.unauth_post_by_ip.len() > 2048 {
            self.unauth_post_by_ip
                .retain(|_, b| now.duration_since(b.window_start) < Duration::from_secs(120));
        }
        true
    }

    /// Authenticated account routes (per `customer_id`).
    pub fn try_consume_authed(
        &mut self,
        customer_key: &str,
        max_per_minute: u32,
        now: Instant,
    ) -> bool {
        if max_per_minute == 0 {
            return true;
        }
        let b = self
            .authed_by_customer
            .entry(customer_key.to_string())
            .or_insert(MinuteBucket {
                window_start: now,
                count: 0,
            });
        Self::tick_bucket(b, now);
        if b.count >= max_per_minute {
            return false;
        }
        b.count += 1;
        if self.authed_by_customer.len() > 4096 {
            self.authed_by_customer
                .retain(|_, b| now.duration_since(b.window_start) < Duration::from_secs(120));
        }
        true
    }
}
