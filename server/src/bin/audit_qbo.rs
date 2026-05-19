use sqlx::PgPool;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| "postgresql://postgres:password@localhost:5433/riverside_os".to_string());
    let pool = PgPool::connect(&database_url).await?;

    // We'll run the propose_daily_journal for today's date
    let today = chrono::Local::now().date_naive();
    println!("Proposing QBO Journal for date: {}", today);

    let proposal = riverside_server::logic::qbo_journal::propose_daily_journal(&pool, today).await?;

    println!("Found {} journal lines.", proposal.lines.len());
    
    let mut total_debits = rust_decimal::Decimal::ZERO;
    let mut total_credits = rust_decimal::Decimal::ZERO;
    let mut has_rounding = false;

    for line in &proposal.lines {
        total_debits += line.debit;
        total_credits += line.credit;
        if line.memo.contains("Swedish Rounding Adjustments") {
            has_rounding = true;
            println!("  [Found Rounding] {} - Debit: {}, Credit: {}", line.memo, line.debit, line.credit);
        }
    }

    println!("\nTotal Debits:  ${}", total_debits);
    println!("Total Credits: ${}", total_credits);

    if !has_rounding {
        println!("WARNING: No rounding adjustments were found in today's transactions. The test might not be fully exercising the rounding logic, but we will check balance.");
    }

    if total_debits == total_credits {
        println!("AUDIT PASSED: Journal entry balances perfectly (Debits = Credits).");
    } else {
        println!("AUDIT FAILED: Journal entry is UNBALANCED by ${}", (total_debits - total_credits).abs());
        std::process::exit(1);
    }

    Ok(())
}
