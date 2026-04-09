//! Pillar 5a: deterministic duplicate candidates (normalized email / phone / name).

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

fn normalize_email(s: &str) -> Option<String> {
    let t = s.trim().to_lowercase();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn normalize_phone(s: &str) -> Option<String> {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 7 {
        None
    } else {
        Some(digits)
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DuplicateCandidateRow {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub match_reason: String,
}

type CustomerSlim = (
    Uuid,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Find likely duplicates for create-time UX. Excludes `exclude_id` when present.
pub async fn find_duplicate_candidates(
    pool: &PgPool,
    email: Option<&str>,
    phone: Option<&str>,
    first_name: Option<&str>,
    last_name: Option<&str>,
    exclude_customer_id: Option<Uuid>,
    limit: i64,
) -> Result<Vec<DuplicateCandidateRow>, sqlx::Error> {
    let lim = limit.clamp(1, 50);
    let ne = email.and_then(normalize_email);
    let np = phone.and_then(normalize_phone);
    let nf = first_name
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let nl = last_name
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    if ne.is_none() && np.is_none() && (nf.is_none() || nl.is_none()) {
        return Ok(vec![]);
    }

    let mut out: Vec<DuplicateCandidateRow> = Vec::new();

    if let Some(ref em) = ne {
        let rows: Vec<CustomerSlim> = if let Some(ex) = exclude_customer_id {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone
                FROM customers
                WHERE is_active = true
                  AND lower(trim(email)) = $1
                  AND id <> $2
                LIMIT $3
                "#,
            )
            .bind(em)
            .bind(ex)
            .bind(lim)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone
                FROM customers
                WHERE is_active = true
                  AND lower(trim(email)) = $1
                LIMIT $2
                "#,
            )
            .bind(em)
            .bind(lim)
            .fetch_all(pool)
            .await?
        };
        for (id, customer_code, first_name, last_name, email, phone) in rows {
            out.push(DuplicateCandidateRow {
                id,
                customer_code,
                first_name,
                last_name,
                email,
                phone,
                match_reason: "same_email".to_string(),
            });
        }
    }

    if let Some(ref digits) = np {
        let rows: Vec<CustomerSlim> = if let Some(ex) = exclude_customer_id {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone
                FROM customers
                WHERE is_active = true
                  AND regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $1
                  AND id <> $2
                LIMIT $3
                "#,
            )
            .bind(digits)
            .bind(ex)
            .bind(lim)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone
                FROM customers
                WHERE is_active = true
                  AND regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $1
                LIMIT $2
                "#,
            )
            .bind(digits)
            .bind(lim)
            .fetch_all(pool)
            .await?
        };
        for (id, customer_code, first_name, last_name, email, phone) in rows {
            if out.iter().any(|r| r.id == id) {
                continue;
            }
            out.push(DuplicateCandidateRow {
                id,
                customer_code,
                first_name,
                last_name,
                email,
                phone,
                match_reason: "same_phone_digits".to_string(),
            });
        }
    }

    if let (Some(ref fnl), Some(ref lnl)) = (&nf, &nl) {
        let rows: Vec<CustomerSlim> = if let Some(ex) = exclude_customer_id {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone
                FROM customers
                WHERE is_active = true
                  AND lower(trim(COALESCE(first_name, ''))) = $1
                  AND lower(trim(COALESCE(last_name, ''))) = $2
                  AND id <> $3
                LIMIT $4
                "#,
            )
            .bind(fnl)
            .bind(lnl)
            .bind(ex)
            .bind(lim)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone
                FROM customers
                WHERE is_active = true
                  AND lower(trim(COALESCE(first_name, ''))) = $1
                  AND lower(trim(COALESCE(last_name, ''))) = $2
                LIMIT $3
                "#,
            )
            .bind(fnl)
            .bind(lnl)
            .bind(lim)
            .fetch_all(pool)
            .await?
        };
        for (id, customer_code, first_name, last_name, email, phone) in rows {
            if out.iter().any(|r| r.id == id) {
                continue;
            }
            out.push(DuplicateCandidateRow {
                id,
                customer_code,
                first_name,
                last_name,
                email,
                phone,
                match_reason: "same_name".to_string(),
            });
        }
    }

    out.truncate(lim as usize);
    Ok(out)
}
