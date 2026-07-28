use std::{env, fs, process};

use riverside_server::logic::counterpoint_incident_reconciliation::{
    apply_counterpoint_incident_reconciliation, preview_counterpoint_incident_reconciliation,
    COUNTERPOINT_INCIDENT_RECONCILIATION_CONFIRMATION,
};
use serde_json::Value as JsonValue;
use uuid::Uuid;

fn value_after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|argument| argument == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().collect::<Vec<_>>();
    let Some(manifest_path) = value_after(&args, "--manifest") else {
        eprintln!(
            "usage: apply_counterpoint_incident_reconciliation --manifest <path> [--apply --staff-id <uuid> --manifest-digest <sha256>]"
        );
        process::exit(2);
    };
    let manifest_json = serde_json::from_str::<JsonValue>(&fs::read_to_string(&manifest_path)?)?;
    let database_url = env::var("DATABASE_URL")?;
    let pool = sqlx::PgPool::connect(&database_url).await?;
    let preview = preview_counterpoint_incident_reconciliation(&pool, &manifest_json).await?;
    println!("{}", serde_json::to_string_pretty(&preview)?);
    if !args.iter().any(|argument| argument == "--apply") {
        return Ok(());
    }
    let staff_id = value_after(&args, "--staff-id")
        .ok_or("--staff-id is required with --apply")?
        .parse::<Uuid>()?;
    let manifest_digest = value_after(&args, "--manifest-digest")
        .ok_or("--manifest-digest is required with --apply")?;
    let result = apply_counterpoint_incident_reconciliation(
        &pool,
        &manifest_json,
        staff_id,
        COUNTERPOINT_INCIDENT_RECONCILIATION_CONFIRMATION,
        "User-approved final reconciliation of the July 21 Counterpoint incident",
        &manifest_digest,
        preview.candidate_count,
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
