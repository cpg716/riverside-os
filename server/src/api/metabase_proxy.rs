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
    let query_str = req.uri().query().unwrap_or_default();

    // Check for silent-auth session handoff
    let mut session_to_set: Option<String> = None;
    let mut filtered_query = String::new();

    for pair in query_str.split('&') {
        if let Some(val) = pair.strip_prefix("metabase_session_id=") {
            session_to_set = Some(val.to_string());
        } else if !pair.is_empty() {
            if !filtered_query.is_empty() {
                filtered_query.push('&');
            }
            filtered_query.push_str(pair);
        }
    }

    let Some(upstream_path) = strip_metabase_prefix(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut target = format!("{base}{upstream_path}");
    if !filtered_query.is_empty() {
        target.push('?');
        target.push_str(&filtered_query);
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
        if hop_by_hop(name) || name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("accept-encoding") {
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

    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let is_html = content_type.contains("text/html");

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = HeaderMap::new();

    for (k, v) in upstream.headers().iter() {
        let name = k.as_str();
        if hop_by_hop(name) || skip_metabase_embed_blocking_header(name) {
            continue;
        }
        // If we are rebranding HTML, we must strip Content-Encoding because we'll be serving a plain string
        if is_html && name.eq_ignore_ascii_case("content-encoding") {
            continue;
        }
        if let Ok(name) = HeaderName::from_str(name) {
            if let Ok(val) = HeaderValue::from_bytes(v.as_bytes()) {
                append_header(&mut out, name, val);
            }
        }
    }

    if is_html && status == StatusCode::OK {
        // For HTML pages (the main app), we read the body and inject our rebranding payload.
        let body_bytes = match upstream.bytes().await {
            Ok(b) => b,
            Err(e) => {
                tracing::error!(error = %e, "metabase proxy: failed to read response body for injection");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };

        let mut html = String::from_utf8_lossy(&body_bytes).into_owned();

        // Inject custom CSS and JS to hide Metabase branding
        let injection = r#"
<style>
  /* Hide Metabase logos and branding elements */
  .Logo, .LogoWithText, .Metabase-logo, [class*="Logo"], [class*="metabase-logo"] { display: none !important; }
  .Nav-item--logo { visibility: hidden !important; width: 20px !important; }
  .App-header { border-bottom: 1px solid rgba(139, 92, 246, 0.2) !important; background: rgba(255, 255, 255, 0.8) !important; backdrop-filter: blur(8px) !important; }
  .Button--primary { background-color: #7c3aed !important; border-color: #7c3aed !important; }
  .text-brand { color: #7c3aed !important; }
</style>
<script>
  (function() {
    const BrandName = "Data Insights";
    document.title = BrandName;
    const rename = () => {
      document.title = BrandName;
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length === 0 && el.textContent.includes('Metabase')) {
          el.textContent = el.textContent.replace(/Metabase/g, BrandName);
        }
      });
    };
    setInterval(rename, 1000);
    window.addEventListener('DOMContentLoaded', rename);
  })();
</script>
</head>"#;

        html = html.replace("</head>", injection);

        // Remove Content-Length so Axum recalculates it (important since we changed the body)
        out.remove(header::CONTENT_LENGTH);

        if let Some(sid) = session_to_set {
            let cookie_val =
                format!("metabase.SESSION={sid}; Path=/metabase; HttpOnly; SameSite=Lax");
            if let Ok(hv) = HeaderValue::from_str(&cookie_val) {
                out.append(header::SET_COOKIE, hv);
            }
        }

        let mut res = Response::new(Body::from(html));
        *res.status_mut() = status;
        *res.headers_mut() = out;
        res
    } else {
        let stream = upstream
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| std::io::Error::other(e.to_string())));
        let body = Body::from_stream(stream);

        let mut res = Response::new(body);
        *res.status_mut() = status;

        if let Some(sid) = session_to_set {
            let cookie_val =
                format!("metabase.SESSION={sid}; Path=/metabase; HttpOnly; SameSite=Lax");
            if let Ok(hv) = HeaderValue::from_str(&cookie_val) {
                out.append(header::SET_COOKIE, hv);
            }
        }

        *res.headers_mut() = out;
        res
    }
}

pub fn router() -> Router<AppState> {
    // Axum `{*path}` does not match `/metabase/` or `/metabase` alone (empty tail); without an
    // explicit `/metabase/` route, requests fall through to SPA static fallback → 404.
    Router::new()
        .route("/metabase", get(metabase_redirect))
        .route("/metabase/", any(proxy_request))
        .route("/metabase/{*path}", any(proxy_request))
}
