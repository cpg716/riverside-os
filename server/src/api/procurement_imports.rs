use axum::{
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{PROCUREMENT_MUTATE, PROCUREMENT_VIEW};
use crate::logic::procurement_imports::{
    cancel_import, convert_import, extract_document, get_import_detail, learn_vendor_profile,
    list_imports, match_document, patch_document, patch_line, upload_document,
    ConvertProcurementImportRequest, PatchProcurementImportDocumentRequest,
    PatchProcurementImportLineRequest, ProcurementImportDetail, ProcurementImportDocumentSummary,
    ProcurementImportError, ProcurementImportListQuery, UploadDocumentInput,
};
use crate::middleware;

#[derive(Debug, Error)]
pub enum ProcurementImportApiError {
    #[error("{0}")]
    Domain(#[from] ProcurementImportError),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("Invalid upload: {0}")]
    InvalidUpload(String),
}

fn map_auth_error(e: (StatusCode, Json<serde_json::Value>)) -> ProcurementImportApiError {
    let (status, Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => ProcurementImportApiError::Unauthorized(msg),
        StatusCode::FORBIDDEN => ProcurementImportApiError::Forbidden(msg),
        _ => ProcurementImportApiError::InvalidUpload(msg),
    }
}

impl IntoResponse for ProcurementImportApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ProcurementImportApiError::Unauthorized(message) => (StatusCode::UNAUTHORIZED, message),
            ProcurementImportApiError::Forbidden(message) => (StatusCode::FORBIDDEN, message),
            ProcurementImportApiError::InvalidUpload(message) => (StatusCode::BAD_REQUEST, message),
            ProcurementImportApiError::Domain(ProcurementImportError::NotFound) => (
                StatusCode::NOT_FOUND,
                "Import document not found".to_string(),
            ),
            ProcurementImportApiError::Domain(ProcurementImportError::InvalidPayload(message))
            | ProcurementImportApiError::Domain(ProcurementImportError::Extraction(message)) => {
                (StatusCode::BAD_REQUEST, message)
            }
            ProcurementImportApiError::Domain(ProcurementImportError::Io(error)) => {
                tracing::error!(error = %error, "procurement import file operation failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "File storage failed".to_string(),
                )
            }
            ProcurementImportApiError::Domain(ProcurementImportError::Json(error)) => (
                StatusCode::BAD_REQUEST,
                format!("Invalid document JSON: {error}"),
            ),
            ProcurementImportApiError::Domain(ProcurementImportError::Database(error)) => {
                tracing::error!(error = %error, "procurement import database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

async fn require_procurement_staff(
    state: &AppState,
    headers: &HeaderMap,
    permission: &'static str,
) -> Result<crate::auth::pins::AuthenticatedStaff, ProcurementImportApiError> {
    middleware::require_staff_with_permission(state, headers, permission)
        .await
        .map_err(map_auth_error)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_handler))
        .route("/upload", post(upload_handler))
        .route(
            "/{document_id}",
            get(get_handler).patch(patch_document_handler),
        )
        .route("/{document_id}/extract", post(extract_handler))
        .route("/{document_id}/match", post(match_handler))
        .route("/{document_id}/convert", post(convert_handler))
        .route("/{document_id}/learn", post(learn_handler))
        .route("/{document_id}/cancel", post(cancel_handler))
        .route("/{document_id}/lines/{line_id}", patch(patch_line_handler))
}

async fn list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ProcurementImportListQuery>,
) -> Result<Json<Vec<ProcurementImportDocumentSummary>>, ProcurementImportApiError> {
    require_procurement_staff(&state, &headers, PROCUREMENT_VIEW).await?;
    Ok(Json(list_imports(&state.db, query).await?))
}

async fn get_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    require_procurement_staff(&state, &headers, PROCUREMENT_VIEW).await?;
    Ok(Json(get_import_detail(&state.db, document_id).await?))
}

async fn upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<ProcurementImportDocumentSummary>, ProcurementImportApiError> {
    let staff = require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    let mut vendor_id: Option<Uuid> = None;
    let mut document_kind: Option<String> = None;
    let mut upload: Option<(String, String, Vec<u8>)> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ProcurementImportApiError::InvalidUpload(e.to_string()))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "vendor_id" => {
                let value = field
                    .text()
                    .await
                    .map_err(|e| ProcurementImportApiError::InvalidUpload(e.to_string()))?;
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    vendor_id = Some(Uuid::parse_str(trimmed).map_err(|_| {
                        ProcurementImportApiError::InvalidUpload(
                            "vendor_id must be a valid uuid".to_string(),
                        )
                    })?);
                }
            }
            "document_kind" => {
                let value = field
                    .text()
                    .await
                    .map_err(|e| ProcurementImportApiError::InvalidUpload(e.to_string()))?;
                if !value.trim().is_empty() {
                    document_kind = Some(value.trim().to_string());
                }
            }
            "file" => {
                let filename = field
                    .file_name()
                    .unwrap_or("vendor-document.bin")
                    .to_string();
                let content_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| ProcurementImportApiError::InvalidUpload(e.to_string()))?
                    .to_vec();
                upload = Some((filename, content_type, bytes));
            }
            _ => {}
        }
    }

    let Some((source_filename, content_type, bytes)) = upload else {
        return Err(ProcurementImportApiError::InvalidUpload(
            "file field is required".to_string(),
        ));
    };

    Ok(Json(
        upload_document(
            &state.db,
            staff.id,
            UploadDocumentInput {
                vendor_id,
                document_kind,
                source_filename,
                content_type,
                bytes,
            },
        )
        .await?,
    ))
}

async fn extract_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    Ok(Json(extract_document(&state.db, document_id).await?))
}

async fn match_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    Ok(Json(match_document(&state.db, document_id).await?))
}

async fn patch_document_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
    Json(payload): Json<PatchProcurementImportDocumentRequest>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    let staff = require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    Ok(Json(
        patch_document(&state.db, document_id, staff.id, payload).await?,
    ))
}

async fn patch_line_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((document_id, line_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<PatchProcurementImportLineRequest>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    let staff = require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    Ok(Json(
        patch_line(&state.db, document_id, line_id, staff.id, payload).await?,
    ))
}

async fn convert_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
    Json(payload): Json<ConvertProcurementImportRequest>,
) -> Result<Json<serde_json::Value>, ProcurementImportApiError> {
    let staff = require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    let converted = convert_import(&state.db, document_id, staff.id, payload).await?;
    Ok(Json(json!(converted)))
}

async fn learn_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    Ok(Json(learn_vendor_profile(&state.db, document_id).await?))
}

async fn cancel_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(document_id): Path<Uuid>,
) -> Result<Json<ProcurementImportDetail>, ProcurementImportApiError> {
    require_procurement_staff(&state, &headers, PROCUREMENT_MUTATE).await?;
    Ok(Json(cancel_import(&state.db, document_id).await?))
}
