use std::{env, fs};

use riverside_server::logic::counterpoint_return_safety::{
    apply_counterpoint_return_review_blocks, preview_counterpoint_return_review_blocks,
    COUNTERPOINT_RETURN_REVIEW_CONFIRMATION,
};
use serde_json::Value as JsonValue;
use sqlx::PgPool;
use uuid::Uuid;

fn value_after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|value| value == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().collect::<Vec<_>>();
    let manifest_path = value_after(&args, "--manifest").ok_or(
        "usage: apply_counterpoint_return_review_blocks --manifest <path> [--apply --staff-id <uuid>]",
    )?;
    let apply = args.iter().any(|value| value == "--apply");
    let staff_id = value_after(&args, "--staff-id")
        .map(|value| Uuid::parse_str(&value))
        .transpose()?;
    if apply && staff_id.is_none() {
        return Err("--staff-id is required with --apply".into());
    }

    let database_url = env::var("DATABASE_URL")?;
    let manifest_json: JsonValue = serde_json::from_str(&fs::read_to_string(&manifest_path)?)?;
    let pool = PgPool::connect(&database_url).await?;
    let preview = preview_counterpoint_return_review_blocks(&pool, &manifest_json).await?;
    println!("{}", serde_json::to_string_pretty(&preview)?);
    if !apply {
        println!(
            "Preview only. Re-run with --apply --staff-id <uuid> after reviewing this output."
        );
        return Ok(());
    }
    if preview.blocked_count != 0
        || preview.ready_count + preview.already_active_count != preview.reviewed_count
    {
        return Err(
            "reviewed Counterpoint return-safety manifest is not fully ready; no blocks were applied"
                .into(),
        );
    }

    let applied = apply_counterpoint_return_review_blocks(
        &pool,
        &manifest_json,
        staff_id.expect("checked above"),
        COUNTERPOINT_RETURN_REVIEW_CONFIRMATION,
        &preview.manifest_digest,
        preview.reviewed_count,
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&applied)?);
    Ok(())
}
