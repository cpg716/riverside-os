//! Customer profile completeness for POS gating (phone + email).

use chrono::NaiveDate;
use sqlx::postgres::PgConnection;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ProfileFields<'a> {
    pub phone: Option<&'a str>,
    pub email: Option<&'a str>,
}

fn non_empty(s: Option<&str>) -> bool {
    s.map(str::trim).filter(|t| !t.is_empty()).is_some()
}

/// POS requires phone and email before checkout with a named customer (address optional).
pub fn is_profile_complete(f: ProfileFields<'_>) -> bool {
    non_empty(f.phone) && non_empty(f.email)
}

#[derive(Debug, Clone, Copy)]
pub enum CustomerCreatedSource {
    Store,
    OnlineStore,
    Counterpoint,
    Podium,
}

#[derive(Debug, Clone)]
pub struct InsertCustomerParams {
    /// When `None`, a new `ROS-########` code is allocated from `customer_code_seq`.
    pub customer_code: Option<String>,
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub date_of_birth: Option<NaiveDate>,
    pub anniversary_date: Option<NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: bool,
    pub marketing_sms_opt_in: bool,
    pub transactional_sms_opt_in: bool,
    pub transactional_email_opt_in: bool,
    pub customer_created_source: CustomerCreatedSource,
}

/// Next store-facing customer code (`ROS-` + zero-padded sequence). Concurrency-safe.
pub async fn next_customer_code(pool: &PgPool) -> Result<String, sqlx::Error> {
    let n: i64 = sqlx::query_scalar("SELECT nextval('customer_code_seq')")
        .fetch_one(pool)
        .await?;
    Ok(format!("ROS-{n:08}"))
}

async fn next_customer_code_conn(conn: &mut PgConnection) -> Result<String, sqlx::Error> {
    let n: i64 = sqlx::query_scalar("SELECT nextval('customer_code_seq')")
        .fetch_one(&mut *conn)
        .await?;
    Ok(format!("ROS-{n:08}"))
}

async fn insert_customer_conn(
    conn: &mut PgConnection,
    p: InsertCustomerParams,
) -> Result<Uuid, sqlx::Error> {
    let code = match &p.customer_code {
        Some(c) => {
            let t = c.trim();
            if t.is_empty() {
                next_customer_code_conn(conn).await?
            } else {
                t.to_string()
            }
        }
        None => next_customer_code_conn(conn).await?,
    };

    let created_src = match p.customer_created_source {
        CustomerCreatedSource::Store => "store",
        CustomerCreatedSource::OnlineStore => "online_store",
        CustomerCreatedSource::Counterpoint => "counterpoint",
        CustomerCreatedSource::Podium => "podium",
    };

    sqlx::query_scalar(
        r#"
        INSERT INTO customers (
            customer_code, first_name, last_name, company_name,
            email, phone,
            address_line1, address_line2, city, state, postal_code,
            date_of_birth, anniversary_date,
            custom_field_1, custom_field_2, custom_field_3, custom_field_4,
            marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
            transactional_email_opt_in, customer_created_source
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        RETURNING id
        "#,
    )
    .bind(&code)
    .bind(&p.first_name)
    .bind(&p.last_name)
    .bind(&p.company_name)
    .bind(&p.email)
    .bind(&p.phone)
    .bind(&p.address_line1)
    .bind(&p.address_line2)
    .bind(&p.city)
    .bind(&p.state)
    .bind(&p.postal_code)
    .bind(p.date_of_birth)
    .bind(p.anniversary_date)
    .bind(&p.custom_field_1)
    .bind(&p.custom_field_2)
    .bind(&p.custom_field_3)
    .bind(&p.custom_field_4)
    .bind(p.marketing_email_opt_in)
    .bind(p.marketing_sms_opt_in)
    .bind(p.transactional_sms_opt_in)
    .bind(p.transactional_email_opt_in)
    .bind(created_src)
    .fetch_one(&mut *conn)
    .await
}

pub async fn insert_customer(pool: &PgPool, p: InsertCustomerParams) -> Result<Uuid, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    insert_customer_conn(conn.as_mut(), p).await
}

pub async fn insert_customer_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: InsertCustomerParams,
) -> Result<Uuid, sqlx::Error> {
    insert_customer_conn(tx.as_mut(), p).await
}
