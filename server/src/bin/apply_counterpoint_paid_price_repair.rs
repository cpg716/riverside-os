use std::{env, fs};

use riverside_server::logic::counterpoint_paid_price_repair::{
    apply_counterpoint_paid_price_repairs, preview_counterpoint_paid_price_repairs,
    stage_counterpoint_paid_price_repair_manifest, COUNTERPOINT_PAID_PRICE_REPAIR_CONFIRMATION,
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
        "usage: apply_counterpoint_paid_price_repair --manifest <path> [--apply --staff-id <uuid>]",
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

    let staged = stage_counterpoint_paid_price_repair_manifest(&pool, &manifest_json).await?;
    let preview = preview_counterpoint_paid_price_repairs(&pool).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "staged": staged,
            "preview": {
                "manifest_digest": preview.manifest_digest,
                "staged_count": preview.staged_count,
                "ready_count": preview.ready_count,
                "blocked_count": preview.blocked_count,
                "already_applied_count": preview.already_applied_count,
                "line_rows_to_update": preview.line_rows_to_update,
                "blocked": preview.blocked,
            }
        }))?
    );

    if !apply {
        println!(
            "Preview only. Re-run with --apply --staff-id <uuid> after reviewing this output."
        );
        return Ok(());
    }
    if preview.blocked_count != 0
        || preview.ready_count + preview.already_applied_count != preview.staged_count
    {
        return Err(
            "reviewed manifest is not fully ready; no financial changes were applied".into(),
        );
    }

    let applied = apply_counterpoint_paid_price_repairs(
        &pool,
        staff_id.expect("checked above"),
        COUNTERPOINT_PAID_PRICE_REPAIR_CONFIRMATION,
        "User-authorized comprehensive Counterpoint paid-price correction",
        &preview.manifest_digest,
        preview.ready_count,
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&applied)?);
    Ok(())
}
