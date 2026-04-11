//! Stripe card vaulting logic: allows saving PaymentMethods to a Customer and retrieving them for POS checkout.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use stripe::{
    Client as StripeClient, CreateSetupIntent, ListPaymentMethods, PaymentMethod, SetupIntent,
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StripeVaultError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Stripe error: {0}")]
    Stripe(String),
    #[error("Customer not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultedPaymentMethod {
    pub id: Uuid,
    pub stripe_payment_method_id: String,
    pub brand: String,
    pub last4: String,
    pub exp_month: i32,
    pub exp_year: i32,
}

/// Lists all vaulted payment methods for a customer by syncing with Stripe.
pub async fn list_vaulted_methods(
    pool: &PgPool,
    stripe_client: &StripeClient,
    customer_id: Uuid,
) -> Result<Vec<VaultedPaymentMethod>, StripeVaultError> {
    // 1. Get stripe_customer_id
    let stripe_cust_id: String = sqlx::query_scalar::<_, Option<String>>(
        "SELECT stripe_customer_id FROM customers WHERE id = $1",
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?
    .ok_or_else(|| StripeVaultError::NotFound("Customer has no Stripe ID".to_string()))?;

    // 2. Fetch from Stripe
    let mut list_params = ListPaymentMethods::new();
    list_params.customer = Some(
        stripe_cust_id
            .parse()
            .map_err(|_| StripeVaultError::Stripe("Invalid ID".into()))?,
    );
    // types_ is sometimes used instead of type_ or it's a specific filter.
    // Omit filtering to ensure compatibility; we'll filter cards in the loop.

    let methods = PaymentMethod::list(stripe_client, &list_params)
        .await
        .map_err(|e| StripeVaultError::Stripe(e.to_string()))?;

    let mut out = Vec::new();

    for pm in methods.data {
        if let Some(card) = pm.card {
            out.push(VaultedPaymentMethod {
                id: Uuid::new_v4(),
                stripe_payment_method_id: pm.id.to_string(),
                brand: format!("{:?}", card.brand).to_lowercase(),
                last4: card.last4,
                exp_month: card.exp_month as i32,
                exp_year: card.exp_year as i32,
            });
        }
    }

    Ok(out)
}

/// Creates a SetupIntent for the frontend to securely collect card details.
pub async fn create_setup_intent(
    pool: &PgPool,
    stripe_client: &StripeClient,
    customer_id: Uuid,
) -> Result<String, StripeVaultError> {
    let stripe_cust_id: String = sqlx::query_scalar::<_, Option<String>>(
        "SELECT stripe_customer_id FROM customers WHERE id = $1",
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?
    .ok_or_else(|| StripeVaultError::NotFound("Customer has no Stripe ID".to_string()))?;

    let mut params = CreateSetupIntent::new();
    params.customer = Some(
        stripe_cust_id
            .parse()
            .map_err(|_| StripeVaultError::Stripe("Invalid ID".into()))?,
    );

    let setup_intent = SetupIntent::create(stripe_client, params)
        .await
        .map_err(|e| StripeVaultError::Stripe(e.to_string()))?;

    Ok(setup_intent.client_secret.unwrap_or_default())
}

/// Records a successfully vaulted card in the local database.
pub async fn record_vaulted_method(
    pool: &PgPool,
    customer_id: Uuid,
    pm_id: &str,
    brand: &str,
    last4: &str,
    exp_month: i32,
    exp_year: i32,
) -> Result<Uuid, StripeVaultError> {
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customer_vaulted_payment_methods 
            (customer_id, stripe_payment_method_id, brand, last4, exp_month, exp_year)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (customer_id, stripe_payment_method_id) 
        DO UPDATE SET 
            brand = EXCLUDED.brand,
            last4 = EXCLUDED.last4,
            exp_month = EXCLUDED.exp_month,
            exp_year = EXCLUDED.exp_year
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(pm_id)
    .bind(brand)
    .bind(last4)
    .bind(exp_month)
    .bind(exp_year)
    .fetch_one(pool)
    .await?;

    Ok(id)
}

/// Detaches a payment method from Stripe and removes it from local cache.
pub async fn delete_vaulted_method(
    pool: &PgPool,
    stripe_client: &StripeClient,
    customer_id: Uuid,
    pm_id: &str,
) -> Result<(), StripeVaultError> {
    // 1. Stripe Detach
    let pm_id_parsed = pm_id
        .parse()
        .map_err(|_| StripeVaultError::Stripe("Invalid PM ID".into()))?;
    let _ = PaymentMethod::detach(stripe_client, &pm_id_parsed)
        .await
        .map_err(|e| StripeVaultError::Stripe(e.to_string()))?;

    // 2. DB Delete
    sqlx::query("DELETE FROM customer_vaulted_payment_methods WHERE customer_id = $1 AND stripe_payment_method_id = $2")
        .bind(customer_id)
        .bind(pm_id)
        .execute(pool)
        .await?;

    Ok(())
}
