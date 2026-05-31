//! E2E API Gateway for ROSIE to run isolated workflows on the E2E test environment.
//!
//! This allows ROSIE to:
//! - Generate help center manuals with screenshots using the E2E stack
//! - Test workflows for bug/error testing without affecting production data
//! - Run Playwright automation on the deterministic E2E database

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tokio::process::Command;

use crate::api::AppState;
use crate::auth::permissions::HELP_MANAGE;
use crate::middleware;

/// E2E workflow execution request
#[derive(Debug, Deserialize)]
pub struct E2EWorkflowRequest {
    pub workflow_name: String,
    pub params: Value,
    pub dry_run: Option<bool>,
}

/// E2E workflow execution response
#[derive(Debug, Serialize)]
pub struct E2EWorkflowResponse {
    pub success: bool,
    pub screenshots: Vec<String>,
    pub output: String,
    pub error: Option<String>,
    pub dry_run: bool,
}

/// E2E manual generation request
#[derive(Debug, Deserialize)]
pub struct E2EManualGenerationRequest {
    pub manual_id: String,
    pub workflow_name: String,
    pub dry_run: Option<bool>,
}

/// E2E manual generation response
#[derive(Debug, Serialize)]
pub struct E2EManualGenerationResponse {
    pub success: bool,
    pub manual_path: Option<String>,
    pub screenshots: Vec<String>,
    pub markdown: Option<String>,
    pub error: Option<String>,
    pub dry_run: bool,
}

/// E2E bug testing request
#[derive(Debug, Deserialize)]
pub struct E2EBugTestRequest {
    pub workflow_name: String,
    pub params: Value,
    pub dry_run: Option<bool>,
}

/// E2E bug testing response
#[derive(Debug, Serialize)]
pub struct E2EBugTestResponse {
    pub success: bool,
    pub workflow_passed: bool,
    pub error_logs: Vec<String>,
    pub screenshots: Vec<String>,
    pub suggested_fix: Option<String>,
    pub dry_run: bool,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn e2e_workflow_script_path() -> PathBuf {
    repo_root().join("scripts").join("rosie-e2e-workflows.mjs")
}

/// Execute an E2E workflow via Playwright
async fn execute_e2e_workflow(
    workflow_name: &str,
    params: &Value,
    dry_run: bool,
) -> Result<E2EWorkflowResponse, String> {
    let script_path = e2e_workflow_script_path();
    if !script_path.exists() {
        return Err(format!(
            "E2E workflow script not found: {}",
            script_path.display()
        ));
    }

    if dry_run {
        return Ok(E2EWorkflowResponse {
            success: true,
            screenshots: vec![],
            output: format!("Dry run: would execute workflow '{}'", workflow_name),
            error: None,
            dry_run: true,
        });
    }

    let params_json =
        serde_json::to_string(params).map_err(|e| format!("Failed to serialize params: {}", e))?;

    let output = Command::new("node")
        .arg(script_path)
        .arg("--workflow")
        .arg(workflow_name)
        .arg("--params")
        .arg(&params_json)
        .output()
        .await
        .map_err(|e| format!("Failed to execute E2E workflow: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("E2E workflow failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse E2E workflow output: {}", e))?;

    Ok(E2EWorkflowResponse {
        success: result
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        screenshots: result
            .get("screenshots")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        output: result
            .get("output")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        error: result
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from),
        dry_run: false,
    })
}

/// Run an E2E workflow for ROSIE
pub async fn rosie_e2e_run_workflow(
    State(_state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<E2EWorkflowRequest>,
) -> Result<Json<E2EWorkflowResponse>, Response> {
    // Require HELP_MANAGE permission for E2E operations
    let _staff = middleware::require_staff_with_permission(&_state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let dry_run = body.dry_run.unwrap_or(false);
    let response = execute_e2e_workflow(&body.workflow_name, &body.params, dry_run)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response()
        })?;

    Ok(Json(response))
}

/// Generate a help manual using E2E environment with screenshots
pub async fn rosie_e2e_generate_manual(
    State(_state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<E2EManualGenerationRequest>,
) -> Result<Json<E2EManualGenerationResponse>, Response> {
    // Require HELP_MANAGE permission for manual generation
    let _staff = middleware::require_staff_with_permission(&_state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let dry_run = body.dry_run.unwrap_or(false);

    // Build params for manual generation workflow
    let mut params = serde_json::json!({
        "manual_id": body.manual_id,
        "action": "generate_manual"
    });

    let workflow_response = execute_e2e_workflow(&body.workflow_name, &params, dry_run)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response()
        })?;

    let response = E2EManualGenerationResponse {
        success: workflow_response.success,
        manual_path: workflow_response
            .output
            .lines()
            .find(|line| line.starts_with("manual_path:"))
            .map(|line| line.trim_start_matches("manual_path:").trim().to_string()),
        screenshots: workflow_response.screenshots,
        markdown: if workflow_response.success {
            Some(workflow_response.output)
        } else {
            None
        },
        error: workflow_response.error,
        dry_run: workflow_response.dry_run,
    };

    Ok(Json(response))
}

/// Test a workflow for bugs using E2E environment
pub async fn rosie_e2e_test_workflow(
    State(_state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<E2EBugTestRequest>,
) -> Result<Json<E2EBugTestResponse>, Response> {
    // Require HELP_MANAGE permission for bug testing
    let _staff = middleware::require_staff_with_permission(&_state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let dry_run = body.dry_run.unwrap_or(false);

    // Build params for bug testing workflow
    let mut params = body.params.clone();
    params["action"] = serde_json::json!("test_bug");

    let workflow_response = execute_e2e_workflow(&body.workflow_name, &params, dry_run)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response()
        })?;

    let response = E2EBugTestResponse {
        success: workflow_response.success,
        workflow_passed: workflow_response
            .output
            .lines()
            .any(|line| line.contains("PASSED")),
        error_logs: workflow_response
            .output
            .lines()
            .filter(|line| line.contains("ERROR") || line.contains("FAIL"))
            .map(|line| line.to_string())
            .collect(),
        screenshots: workflow_response.screenshots,
        suggested_fix: workflow_response
            .output
            .lines()
            .find(|line| line.starts_with("suggested_fix:"))
            .map(|line| line.trim_start_matches("suggested_fix:").trim().to_string()),
        dry_run: workflow_response.dry_run,
    };

    Ok(Json(response))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/workflow/run", post(rosie_e2e_run_workflow))
        .route("/manual/generate", post(rosie_e2e_generate_manual))
        .route("/workflow/test", post(rosie_e2e_test_workflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repo_root_returns_valid_path() {
        let root = repo_root();
        assert!(root.exists());
    }

    #[test]
    fn test_e2e_workflow_script_path_returns_expected_location() {
        let path = e2e_workflow_script_path();
        assert!(path.ends_with("scripts/rosie-e2e-workflows.mjs"));
    }
}
