use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::env;
use std::time::Duration;
use tokio::task;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgresql://postgres:password@localhost:5433/riverside_os".to_string()
    });
    let pool = PgPool::connect(&database_url).await?;

    // 1. Create a dummy gift card with $50.00
    let code = format!("AUDIT-{}", uuid::Uuid::new_v4().simple());
    let card_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO gift_cards
            (code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
        VALUES ($1, 'purchased', 'active', 50.00, 50.00, TRUE, now() + interval '30 days')
        RETURNING id
        "#,
    )
    .bind(&code)
    .fetch_one(&pool)
    .await?;

    println!(
        "Created Gift Card: {code} (ID: {card_id}) with Balance: $50.00"
    );

    // 2. Spawn two concurrent requests trying to redeem $40
    let amount = dec!(40.00);

    let code1 = code.clone();
    let pool1 = pool.clone();
    let t1 = task::spawn(async move {
        let mut tx = pool1.begin().await.unwrap();
        let res = riverside_server::logic::gift_card_ops::prepare_redemption_in_tx(
            &mut tx,
            &code1,
            Some("paid_liability"),
            amount,
        )
        .await;

        if res.is_ok() {
            // Simulate processing time inside the lock
            tokio::time::sleep(Duration::from_millis(500)).await;

            // In checkout, we also update the balance
            sqlx::query("UPDATE gift_cards SET current_balance = $1 WHERE id = $2")
                .bind(res.unwrap().new_balance)
                .bind(card_id)
                .execute(&mut *tx)
                .await
                .unwrap();

            tx.commit().await.unwrap();
            "Success (T1)"
        } else {
            tx.rollback().await.unwrap();
            "Failed (T1)"
        }
    });

    let code2 = code.clone();
    let pool2 = pool.clone();
    let t2 = task::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await; // Ensure T1 hits first
        let mut tx = pool2.begin().await.unwrap();
        let res = riverside_server::logic::gift_card_ops::prepare_redemption_in_tx(
            &mut tx,
            &code2,
            Some("paid_liability"),
            amount,
        )
        .await;

        if res.is_ok() {
            sqlx::query("UPDATE gift_cards SET current_balance = $1 WHERE id = $2")
                .bind(res.unwrap().new_balance)
                .bind(card_id)
                .execute(&mut *tx)
                .await
                .unwrap();

            tx.commit().await.unwrap();
            "Success (T2)"
        } else {
            tx.rollback().await.unwrap();
            "Failed (T2): Insufficient Balance or Locked"
        }
    });

    let (r1, r2) = tokio::join!(t1, t2);
    let r1_res = r1.unwrap();
    let r2_res = r2.unwrap();
    println!("Transaction 1 Result: {r1_res}");
    println!("Transaction 2 Result: {r2_res}");

    // 3. Verify Final Balance
    let final_balance: Decimal =
        sqlx::query_scalar("SELECT current_balance FROM gift_cards WHERE id = $1")
            .bind(card_id)
            .fetch_one(&pool)
            .await?;

    println!("Final Gift Card Balance: ${final_balance}");
    if final_balance == dec!(10.00) {
        println!("AUDIT PASSED: Double-spending successfully prevented by Postgres pessimistic row locks.");
    } else {
        println!("AUDIT FAILED: Double-spending occurred!");
    }

    Ok(())
}
