use std::env;

use riverside_server::logic::counterpoint_reconciliation::{
    apply_counterpoint_transaction_reconciliation, preview_counterpoint_transaction_reconciliation,
    COUNTERPOINT_RECONCILIATION_CONFIRMATION,
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
    let apply = args.iter().any(|value| value == "--apply");
    let staff_id = value_after(&args, "--staff-id")
        .map(|value| Uuid::parse_str(&value))
        .transpose()?;
    if apply && staff_id.is_none() {
        return Err("--staff-id is required with --apply".into());
    }

    let pool = PgPool::connect(&env::var("DATABASE_URL")?).await?;
    let preview = preview_counterpoint_transaction_reconciliation(&pool).await?;
    println!("{}", serde_json::to_string_pretty(&preview)?);
    if !apply {
        println!(
            "Preview only. Re-run with --apply --staff-id <uuid> after reviewing this output."
        );
        return Ok(());
    }

    let applied = apply_counterpoint_transaction_reconciliation(
        &pool,
        staff_id.expect("checked above"),
        COUNTERPOINT_RECONCILIATION_CONFIRMATION,
        "User-authorized Counterpoint order and payment reconciliation",
        &preview.manifest_digest,
        preview.candidate_count,
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&applied)?);
    Ok(())
}
