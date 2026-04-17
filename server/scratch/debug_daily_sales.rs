use sqlx::PgPool;
use riverside_api::logic::report_basis::ReportBasis;
use riverside_api::logic::register_day_activity::fetch_register_day_summary;
use chrono::NaiveDate;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool = PgPool::connect("postgresql://postgres:password@localhost:5433/riverside_os").await?;
    let from = NaiveDate::from_ymd_opt(2026, 4, 13).unwrap();
    let to = NaiveDate::from_ymd_opt(2026, 4, 13).unwrap();
    let basis = ReportBasis::Booked;
    
    let summary = fetch_register_day_summary(&pool, from, to, None, basis).await?;
    
    println!("Sales Count: {}", summary.sales_count);
    println!("Activities Count: {}", summary.activities.len());
    
    for (i, a) in summary.activities.iter().enumerate() {
        println!("{}. {} - {} ({})", i+1, a.occurred_at, a.title, a.kind);
    }
    
    Ok(())
}
