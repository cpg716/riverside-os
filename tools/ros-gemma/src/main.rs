//! Minimal HTTP worker for ROS-AI: `GET /health`, `POST /v1/complete`.
//!
//! **Modes**
//! - **llama.cpp HTTP**: forward to official [`llama-server`](https://github.com/ggml-org/llama.cpp)
//!   OpenAI-compatible `POST /v1/chat/completions`.
//! - **Unconfigured** (503 on `POST /v1/complete`): `LLAMA_CPP_SERVER_URL` empty and no image
//!   default — should not happen with the repo Dockerfile + `docker-compose.yml`.
//!
//! Bind: `ROS_GEMMA_BIND` (default `127.0.0.1:8787`). Optional shared secret: `ROS_GEMMA_SHARED_SECRET`
//! (must match server `AI_WORKER_SHARED_SECRET`).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};

#[derive(Clone)]
struct AppState {
    cfg: Arc<AppCfg>,
    http: reqwest::Client,
}

#[derive(Clone, Default)]
struct AppCfg {
    shared_secret: Option<String>,
    /// Documented for operators; weights load in llama-server when using HTTP mode.
    model_path: Option<String>,
    llama_server_base: Option<String>,
    llama_chat_model: String,
    llama_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CompleteReq {
    system: String,
    user: String,
    #[serde(default = "default_max_tokens")]
    max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    512
}

#[derive(Debug, Serialize)]
struct CompleteRes {
    text: String,
}

#[derive(Debug, Serialize)]
struct OaiChatReq {
    model: String,
    messages: Vec<OaiMessage>,
    max_tokens: u32,
    temperature: f32,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct OaiMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OaiChatRes {
    choices: Vec<OaiChoice>,
}

#[derive(Debug, Deserialize)]
struct OaiChoice {
    message: OaiAssistantMessage,
}

#[derive(Debug, Deserialize)]
struct OaiAssistantMessage {
    content: Option<String>,
}

fn check_secret(headers: &HeaderMap, cfg: &AppCfg) -> bool {
    let Some(expected) = cfg.shared_secret.as_ref().filter(|s| !s.is_empty()) else {
        return true;
    };
    headers
        .get("x-ros-ai-worker-secret")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == expected.as_str())
        .unwrap_or(false)
}

fn normalize_base_url(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

fn resolve_llama_server_base() -> Option<String> {
    std::env::var("LLAMA_CPP_SERVER_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| normalize_base_url(&s))
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mode = if state.cfg.llama_server_base.is_some() {
        "llamacpp_http"
    } else {
        "unconfigured"
    };
    Json(serde_json::json!({
        "status": "ok",
        "service": "ros-gemma",
        "inference_mode": mode,
        "llm_ready": state.cfg.llama_server_base.is_some(),
    }))
}

async fn complete_via_llama(
    state: &AppState,
    body: CompleteReq,
) -> Result<Json<CompleteRes>, StatusCode> {
    let base = state
        .cfg
        .llama_server_base
        .as_ref()
        .map(|s| normalize_base_url(s))
        .filter(|s| !s.is_empty())
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let url = format!("{base}/v1/chat/completions");

    let mut messages = Vec::new();
    if !body.system.trim().is_empty() {
        messages.push(OaiMessage {
            role: "system".to_string(),
            content: body.system,
        });
    }
    messages.push(OaiMessage {
        role: "user".to_string(),
        content: body.user,
    });

    let req_body = OaiChatReq {
        model: state.cfg.llama_chat_model.clone(),
        messages,
        max_tokens: body.max_tokens.max(1),
        temperature: 0.2,
        stream: false,
    };

    let mut req = state.http.post(&url).json(&req_body);
    if let Some(key) = state.cfg.llama_api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    let res = req.send().await.map_err(|e| {
        error!(error = %e, %url, "llama-server request failed");
        StatusCode::BAD_GATEWAY
    })?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        error!(%status, body = %err_text.chars().take(500).collect::<String>(), %url, "llama-server returned error");
        return Err(StatusCode::BAD_GATEWAY);
    }

    let parsed: OaiChatRes = res.json().await.map_err(|e| {
        error!(error = %e, %url, "llama-server response JSON parse failed");
        StatusCode::BAD_GATEWAY
    })?;

    let text = parsed
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();

    Ok(Json(CompleteRes { text }))
}

async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CompleteReq>,
) -> Result<Json<CompleteRes>, (StatusCode, Json<serde_json::Value>)> {
    if !check_secret(&headers, &state.cfg) {
        return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "unauthorized" }))));
    }

    if state.cfg.llama_server_base.is_some() {
        return complete_via_llama(&state, body).await.map_err(|status| {
            (
                status,
                Json(serde_json::json!({
                    "error": "llama-server request failed or returned an error",
                    "code": "llama_upstream",
                })),
            )
        });
    }

    if let Some(mp) = state.cfg.model_path.as_ref() {
        if !mp.is_empty() {
            warn!(
                model_path = %mp,
                "ROS_GEMMA_MODEL_PATH is set but LLAMA_CPP_SERVER_URL is empty; use docker compose (ros-gemma + llama-server) per docs/ROS_GEMMA_WORKER.md."
            );
        }
    }

    warn!("POST /v1/complete rejected: LLAMA_CPP_SERVER_URL unset — run ros-gemma via repo docker compose (see docs/ROS_GEMMA_WORKER.md)");
    Err((
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "LLM not configured: ros-gemma needs LLAMA_CPP_SERVER_URL (repo docker-compose.yml + Dockerfile set http://llama-server:8080). Rebuild/restart the stack — docs/ROS_GEMMA_WORKER.md",
            "code": "llm_not_configured",
        })),
    ))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let bind = std::env::var("ROS_GEMMA_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let shared_secret = std::env::var("ROS_GEMMA_SHARED_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let model_path = std::env::var("ROS_GEMMA_MODEL_PATH")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let llama_server_base = resolve_llama_server_base();

    let llama_chat_model = std::env::var("LLAMA_CPP_CHAT_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string());

    let llama_api_key = std::env::var("LLAMA_CPP_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let timeout_sec: u64 = std::env::var("LLAMA_CPP_TIMEOUT_SEC")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_sec))
        .build()
        .expect("reqwest client");

    let cfg = Arc::new(AppCfg {
        shared_secret,
        model_path,
        llama_server_base: llama_server_base.clone(),
        llama_chat_model: llama_chat_model.clone(),
        llama_api_key,
    });

    let state = AppState {
        cfg: Arc::clone(&cfg),
        http,
    };

    if let Some(ref url) = llama_server_base {
        info!(
            %url,
            model = %llama_chat_model,
            timeout_sec,
            "ros-gemma inference: llamacpp_http (OpenAI /v1/chat/completions)"
        );
    } else {
        info!("ros-gemma: LLAMA_CPP_SERVER_URL empty — POST /v1/complete returns 503; use repo docker compose — docs/ROS_GEMMA_WORKER.md");
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/complete", post(complete))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    info!(%bind, "ros-gemma listening");
    axum::serve(listener, app).await.expect("serve");
}
