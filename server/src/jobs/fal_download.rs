//! Background job handler for downloading and optimizing Fal.ai generated assets.

use async_trait::async_trait;
use std::path::PathBuf;
use uuid::Uuid;

use crate::api::AppState;
use crate::jobs::{JobContext, JobHandler};
use crate::jobs::job_types::FalDownloadJobPayload;
use crate::logic::staff_avatar_processor;

pub struct FalDownloadHandler {
    state: AppState,
}

impl FalDownloadHandler {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

#[async_trait]
impl JobHandler for FalDownloadHandler {
    fn job_type(&self) -> &'static str {
        "download_fal_asset"
    }

    async fn handle(
        &self,
        ctx: JobContext,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload: FalDownloadJobPayload = serde_json::from_value(ctx.payload)?;
        
        tracing::info!(
            job_id = %payload.job_id,
            image_url = %payload.image_url,
            job_type = %payload.job_type,
            target_id = %payload.target_id,
            "Starting Fal asset download and optimization"
        );

        // 1. Download image bytes
        let response = self.state.http_client
            .get(&payload.image_url)
            .send()
            .await?;

        if !response.status().is_success() {
            let err = format!("Failed to download image from Fal CDN: {}", response.status());
            sqlx::query(
                "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2"
            )
            .bind(&err)
            .bind(payload.job_id)
            .execute(&self.state.db)
            .await?;
            return Err(err.into());
        }

        let bytes = response.bytes().await?.to_vec();

        // 2. Perform post-processing
        let processed_bytes = if payload.job_type == "staff_avatar" {
            // Crop and resize to 512x512 JPEG using staff_avatar_processor
            match staff_avatar_processor::process_staff_avatar(&bytes) {
                Ok(proc) => proc,
                Err(e) => {
                    let err = format!("Avatar processing failed: {e}");
                    sqlx::query(
                        "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2"
                    )
                    .bind(&err)
                    .bind(payload.job_id)
                    .execute(&self.state.db)
                    .await?;
                    return Err(err.into());
                }
            }
        } else {
            // For product/promo, standardise to JPEG using image crate
            match image::load_from_memory(&bytes) {
                Ok(img) => {
                    let mut out = Vec::new();
                    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
                    if let Err(e) = img.write_with_encoder(encoder) {
                        tracing::warn!("Failed to re-encode product image, using original bytes: {}", e);
                        bytes
                    } else {
                        out
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to load product image for processing, using original bytes: {}", e);
                    bytes
                }
            }
        };

        // 3. Save file locally
        let file_id = if payload.target_id == Uuid::nil() {
            payload.job_id
        } else {
            payload.target_id
        };
        let file_name = format!("{}.jpg", file_id);
        
        // Resolve directory paths
        let uploads_dir = PathBuf::from("uploads/fal").join(&payload.job_type);
        tokio::fs::create_dir_all(&uploads_dir).await.ok();
        let uploads_path = uploads_dir.join(&file_name);
        tokio::fs::write(&uploads_path, &processed_bytes).await?;

        // Optional: also write to client/public/fal/{job_type} if parent dirs exist
        let client_public_dir = PathBuf::from("client/public/fal").join(&payload.job_type);
        if client_public_dir.parent().and_then(|p| p.parent()).map(|p| p.exists()).unwrap_or(false) {
            tokio::fs::create_dir_all(&client_public_dir).await.ok();
            let client_path = client_public_dir.join(&file_name);
            let _ = tokio::fs::write(&client_path, &processed_bytes).await;
        }

        // 4. Update the database
        let local_asset_path = format!("/uploads/fal/{}/{}", payload.job_type, file_name);

        let mut tx = self.state.db.begin().await?;

        sqlx::query(
            r#"
            UPDATE fal_generation_jobs
            SET local_asset_path = $1, status = 'completed', completed_at = NOW()
            WHERE id = $2
            "#
        )
        .bind(&local_asset_path)
        .bind(payload.job_id)
        .execute(&mut *tx)
        .await?;

        // Update target tables based on job type
        if payload.job_type == "staff_avatar" {
            sqlx::query(
                "UPDATE staff SET avatar_photo_url = $1 WHERE id = $2"
            )
            .bind(&local_asset_path)
            .bind(payload.target_id)
            .execute(&mut *tx)
            .await?;
        } else if payload.job_type == "product_image" && payload.target_id != Uuid::nil() {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM public.products WHERE id = $1)")
                .bind(payload.target_id)
                .fetch_one(&mut *tx)
                .await?;
            if exists {
                let max_sort: i32 = sqlx::query_scalar(
                    "SELECT COALESCE(MAX(sort_order), -1) FROM public.product_web_images WHERE product_id = $1"
                )
                .bind(payload.target_id)
                .fetch_one(&mut *tx)
                .await?;
                
                let is_hero = max_sort == -1;
                
                sqlx::query(
                    r#"
                    INSERT INTO public.product_web_images (product_id, url, alt_text, sort_order, is_hero)
                    VALUES ($1, $2, $3, $4, $5)
                    "#
                )
                .bind(payload.target_id)
                .bind(&local_asset_path)
                .bind("AI Generated Product Image")
                .bind(max_sort + 1)
                .bind(is_hero)
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;

        tracing::info!(
            job_id = %payload.job_id,
            local_asset_path = %local_asset_path,
            "Fal asset download and database update completed successfully"
        );

        Ok(())
    }
}
