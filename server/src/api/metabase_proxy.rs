//! Optional reverse proxy: `/metabase/*` → Metabase upstream (strip `/metabase` prefix).
//!
//! Set `RIVERSIDE_METABASE_UPSTREAM` (e.g. `http://127.0.0.1:3001`). **Unset or empty** uses the
//! default `http://127.0.0.1:3001`. Set to `0` / `off` / `false` / `disabled` (case-insensitive) to
//! disable the proxy (503). WebSocket upgrades are not proxied here; for full Metabase live features in
//! production, terminate `/metabase/` at nginx/Caddy with upgrade support if needed.

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{any, get},
    Router,
};
use futures_util::StreamExt;
use std::str::FromStr;

use super::AppState;

/// Values that explicitly turn the proxy off (must not include empty string — unset env defaults).
const DISABLED: &[&str] = &["0", "off", "false", "disabled"];

fn upstream_base() -> Option<String> {
    let raw = std::env::var("RIVERSIDE_METABASE_UPSTREAM").unwrap_or_default();
    let t = raw.trim();
    if t.is_empty() {
        return Some("http://127.0.0.1:3001".to_string());
    }
    if DISABLED.iter().any(|d| t.eq_ignore_ascii_case(d)) {
        return None;
    }
    Some(t.trim_end_matches('/').to_string())
}

fn strip_metabase_prefix(path: &str) -> Option<String> {
    let after = path.strip_prefix("/metabase")?;
    let p = match after {
        "" | "/" => "/".to_string(),
        p if p.starts_with('/') => p.to_string(),
        p => format!("/{p}"),
    };
    Some(p)
}

/// Metabase often sends `frame-ancestors 'none'` / `X-Frame-Options: DENY`, which blocks the
/// Insights shell iframe (same-origin subpath). Drop these; staff auth is already enforced on `/api`.
fn skip_metabase_embed_blocking_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("x-frame-options")
        || name.eq_ignore_ascii_case("content-security-policy")
        || name.eq_ignore_ascii_case("content-security-policy-report-only")
}

fn hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn append_header(headers: &mut HeaderMap, name: HeaderName, value: HeaderValue) {
    headers.append(name, value);
}

async fn metabase_redirect() -> impl IntoResponse {
    Redirect::permanent("/metabase/")
}

async fn proxy_request(State(state): State<AppState>, req: axum::extract::Request) -> Response {
    let Some(base) = upstream_base() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Metabase proxy disabled (RIVERSIDE_METABASE_UPSTREAM is 0/off/false/disabled).",
        )
            .into_response();
    };

    let path = req.uri().path();
    let Some(upstream_path) = strip_metabase_prefix(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut target = format!("{base}{upstream_path}");
    if let Some(q) = req.uri().query() {
        target.push('?');
        target.push_str(q);
    }

    let method = req.method().clone();
    let mut headers = req.headers().clone();

    // Forward client hints for correct absolute URLs in Metabase (Site URL should match public URL).
    if let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        let _ = headers.insert(
            HeaderName::from_static("x-forwarded-host"),
            HeaderValue::from_str(host).unwrap_or_else(|_| HeaderValue::from_static("localhost")),
        );
    }
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    let _ = headers.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_str(proto).unwrap_or_else(|_| HeaderValue::from_static("http")),
    );

    let body_bytes = match axum::body::to_bytes(req.into_body(), 256 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "metabase proxy: read request body failed");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    let mut rb = state.http_client.request(method.clone(), &target);
    for (k, v) in headers.iter() {
        let name = k.as_str();
        if hop_by_hop(name) || name.eq_ignore_ascii_case("host") {
            continue;
        }
        rb = rb.header(k, v);
    }
    rb = rb.body(body_bytes);

    let upstream = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, target = %target, "metabase proxy: upstream request failed");
            return (
                StatusCode::BAD_GATEWAY,
                "Could not reach Metabase upstream.",
            )
                .into_response();
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = HeaderMap::new();

    for (k, v) in upstream.headers().iter() {
        let name = k.as_str();
        if hop_by_hop(name) || skip_metabase_embed_blocking_header(name) {
            continue;
        }
        if let Ok(name) = HeaderName::from_str(name) {
            if let Ok(val) = HeaderValue::from_bytes(v.as_bytes()) {
                append_header(&mut out, name, val);
            }
        }
    }

    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(|e| std::io::Error::other(e.to_string())));
    let body = Body::from_stream(stream);

    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = out;
    res
}

pub fn router() -> Router<AppState> {
    // Axum `{*path}` does not match `/metabase/` or `/metabase` alone (empty tail); without an
    // explicit `/metabase/` route, requests fall through to SPA static fallback → 404.
    Router::new()
        .route("/metabase", get(metabase_redirect))
        .route("/metabase/", any(proxy_request))
        .route("/metabase/{*path}", any(proxy_request))
}
