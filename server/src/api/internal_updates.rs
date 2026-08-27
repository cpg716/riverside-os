use axum::{
    http::{header, uri::Authority, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use crate::api::AppState;
use crate::logic::internal_updates::{self, InternalReleaseManifest};

const RUNNING_BUILD_SHA: &str = env!("RIVERSIDE_GIT_SHA");

fn workstation_release_is_active(release_sha: &str, running_sha: &str) -> bool {
    release_sha.eq_ignore_ascii_case(running_sha)
}

fn public_base_url(headers: &HeaderMap) -> Result<String, String> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Internal update request did not include a valid Host header.".to_string()
        })?;
    if host.len() > 255
        || !host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':' | '[' | ']'))
    {
        return Err("Internal update request contained an invalid Host header.".to_string());
    }
    let authority: Authority = host
        .parse()
        .map_err(|_| "Internal update request contained an invalid Host authority.".to_string())?;

    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| matches!(*value, "http" | "https"))
        .unwrap_or("http");
    Ok(format!("{scheme}://{authority}"))
}

fn load_release_response() -> Result<InternalReleaseManifest, Response> {
    internal_updates::load_current_release()
        .map_err(|error| {
            tracing::error!(error = %error, "Internal release metadata is invalid");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "Internal release metadata failed validation." })),
            )
                .into_response()
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "No internal Riverside release is published." })),
            )
                .into_response()
        })
}

async fn release_metadata(headers: HeaderMap) -> Result<Json<serde_json::Value>, Response> {
    let release = load_release_response()?;
    let base = public_base_url(&headers).map_err(|error| {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
    })?;
    let package_url = format!(
        "{base}/api/internal-updates/files/{}",
        release.main_hub_package.file_name
    );

    Ok(Json(json!({
        "contractVersion": release.contract_version,
        "version": release.version,
        "sourceGitSha": release.source_git_sha,
        "publishedAt": release.published_at,
        "notes": release.notes,
        "mainHubPackage": {
            "fileName": release.main_hub_package.file_name,
            "url": package_url,
            "sha256": release.main_hub_package.sha256,
            "bytes": release.main_hub_package.bytes,
        },
    })))
}

async fn windows_latest(headers: HeaderMap) -> Result<Json<serde_json::Value>, Response> {
    let release = load_release_response()?;
    if !workstation_release_is_active(&release.source_git_sha, RUNNING_BUILD_SHA) {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "The published candidate must be installed on the Main Hub before workstation updates are available.",
                "candidateBuildSha": release.source_git_sha,
                "mainHubBuildSha": RUNNING_BUILD_SHA,
            })),
        )
            .into_response());
    }
    let base = public_base_url(&headers).map_err(|error| {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
    })?;
    let source_short = &release.source_git_sha[..8];
    let artifact_url = format!(
        "{base}/api/internal-updates/files/{}",
        release.windows_updater.file_name
    );

    Ok(Json(json!({
        "version": format!("{}+{}", release.version, source_short),
        "notes": release.notes,
        "pub_date": release.published_at,
        "build_sha": release.source_git_sha,
        "platforms": {
            "windows-x86_64": {
                "signature": release.windows_updater.signature,
                "url": artifact_url,
            }
        }
    })))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/release.json", get(release_metadata))
        .route("/windows/latest.json", get(windows_latest))
}

#[cfg(test)]
mod tests {
    use super::{public_base_url, workstation_release_is_active};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn update_urls_use_the_request_host_without_accepting_paths() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("10.64.70.196:3000"));
        assert_eq!(
            public_base_url(&headers).unwrap(),
            "http://10.64.70.196:3000"
        );
        headers.insert("host", HeaderValue::from_static("host/path"));
        assert!(public_base_url(&headers).is_err());
    }

    #[test]
    fn workstation_feed_unlocks_only_after_main_hub_runs_the_candidate() {
        let candidate = "0123456789abcdef0123456789abcdef01234567";
        assert!(workstation_release_is_active(candidate, candidate));
        assert!(workstation_release_is_active(
            candidate,
            "0123456789ABCDEF0123456789ABCDEF01234567"
        ));
        assert!(!workstation_release_is_active(
            candidate,
            "89abcdef0123456789abcdef0123456789abcdef"
        ));
    }
}
