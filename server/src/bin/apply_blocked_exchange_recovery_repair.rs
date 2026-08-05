use std::env;

use riverside_server::logic::blocked_exchange_recovery_repair::{
    apply_blocked_exchange_repair, preview_blocked_exchange_repair,
    BLOCKED_EXCHANGE_REPAIR_CONFIRMATION,
};
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
    let client_job_key = value_after(&args, "--client-job-key").ok_or(
        "usage: apply_blocked_exchange_recovery_repair --client-job-key <key> [--apply --staff-id <uuid> --confirmation <phrase> --reason <reason>]",
    )?;
    let apply = args.iter().any(|value| value == "--apply");
    let pool = PgPool::connect(&env::var("DATABASE_URL")?).await?;
    let preview = preview_blocked_exchange_repair(&pool, &client_job_key).await?;
    println!("{}", serde_json::to_string_pretty(&preview)?);
    if !apply {
        println!(
            "Preview only. Apply with --staff-id, --confirmation '{}', and a specific reason.",
            BLOCKED_EXCHANGE_REPAIR_CONFIRMATION
        );
        return Ok(());
    }

    let staff_id = Uuid::parse_str(
        &value_after(&args, "--staff-id").ok_or("--staff-id is required with --apply")?,
    )?;
    let confirmation =
        value_after(&args, "--confirmation").ok_or("--confirmation is required with --apply")?;
    let reason = value_after(&args, "--reason").ok_or("--reason is required with --apply")?;
    let result =
        apply_blocked_exchange_repair(&pool, &client_job_key, staff_id, &confirmation, &reason)
            .await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
