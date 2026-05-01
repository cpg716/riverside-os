//! Staff-uploaded images served at `GET /api/store/media/{id}`.

use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

const MAX_BYTES: usize = 3 * 1024 * 1024;

#[derive(Debug)]
pub enum MediaAssetError {
    TooLarge,
    BadMime,
    Database(sqlx::Error),
}

pub fn normalize_image_mime(raw: &str) -> Option<&'static str> {
    match raw.trim().to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

pub async fn insert_image(
    pool: &PgPool,
    mime_type: &str,
    filename: Option<&str>,
    bytes: &[u8],
    created_by_staff_id: Option<Uuid>,
) -> Result<Uuid, MediaAssetError> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(MediaAssetError::TooLarge);
    }
    let Some(norm) = normalize_image_mime(mime_type) else {
        return Err(MediaAssetError::BadMime);
    };

    let id = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO store_media_asset (mime_type, original_filename, byte_size, bytes, created_by_staff_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(norm)
    .bind(filename.filter(|s| !s.trim().is_empty()))
    .bind(bytes.len() as i32)
    .bind(bytes)
    .bind(created_by_staff_id)
    .fetch_one(pool)
    .await
    .map_err(MediaAssetError::Database)?;

    Ok(id)
}

pub struct MediaAssetBlob {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub async fn fetch_image(pool: &PgPool, id: Uuid) -> Result<Option<MediaAssetBlob>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT mime_type, bytes FROM store_media_asset WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| MediaAssetBlob {
        mime_type: r.try_get("mime_type").unwrap_or_default(),
        bytes: r.try_get("bytes").unwrap_or_default(),
    }))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MediaAssetRow {
    pub id: Uuid,
    pub mime_type: String,
    pub original_filename: Option<String>,
    pub byte_size: i32,
    pub alt_text: Option<String>,
    pub usage_note: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub async fn list_images(pool: &PgPool, limit: i64) -> Result<Vec<MediaAssetRow>, sqlx::Error> {
    sqlx::query_as::<_, MediaAssetRow>(
        r#"
        SELECT id, mime_type, original_filename, byte_size, alt_text, usage_note, created_at
        FROM store_media_asset
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await
}
