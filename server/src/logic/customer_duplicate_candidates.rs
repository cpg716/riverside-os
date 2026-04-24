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
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub match_reason: String,
}

type CustomerSlim = (
    Uuid,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub struct DuplicateCandidateParams<'a> {
    pub email: Option<&'a str>,
    pub phone: Option<&'a str>,
    pub first_name: Option<&'a str>,
    pub last_name: Option<&'a str>,
    pub postal_code: Option<&'a str>,
    pub exclude_customer_id: Option<Uuid>,
    pub limit: i64,
}

/// Find likely duplicates for create-time UX. Excludes `exclude_id` when present.
pub async fn find_duplicate_candidates(
    pool: &PgPool,
    params: DuplicateCandidateParams<'_>,
) -> Result<Vec<DuplicateCandidateRow>, sqlx::Error> {
    let lim = params.limit.clamp(1, 50);
    let ne = params.email.and_then(normalize_email);
    let np = params.phone.and_then(normalize_phone);
    let nf = params
        .first_name
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let nl = params
        .last_name
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let nz = params
        .postal_code
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    if ne.is_none() && np.is_none() && (nf.is_none() || nl.is_none()) {
        return Ok(vec![]);
    }

    let mut out: Vec<DuplicateCandidateRow> = Vec::new();

    if let Some(ref em) = ne {
        let rows: Vec<CustomerSlim> = if let Some(ex) = params.exclude_customer_id {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone,
                       address_line1, address_line2, city, state, postal_code
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
                SELECT id, customer_code, first_name, last_name, email, phone,
                       address_line1, address_line2, city, state, postal_code
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
        for (
            id,
            customer_code,
            first_name,
            last_name,
            email,
            phone,
            address_line1,
            address_line2,
            city,
            state,
            postal_code,
        ) in rows
        {
            out.push(DuplicateCandidateRow {
                id,
                customer_code,
                first_name,
                last_name,
                email,
                phone,
                address_line1,
                address_line2,
                city,
                state,
                postal_code,
                match_reason: "same_email".to_string(),
            });
        }
    }

    if let Some(ref digits) = np {
        let rows: Vec<CustomerSlim> = if let Some(ex) = params.exclude_customer_id {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone,
                       address_line1, address_line2, city, state, postal_code
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
                SELECT id, customer_code, first_name, last_name, email, phone,
                       address_line1, address_line2, city, state, postal_code
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
        for (
            id,
            customer_code,
            first_name,
            last_name,
            email,
            phone,
            address_line1,
            address_line2,
            city,
            state,
            postal_code,
        ) in rows
        {
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
                address_line1,
                address_line2,
                city,
                state,
                postal_code,
                match_reason: "same_phone_digits".to_string(),
            });
        }
    }

    if let (Some(ref fnl), Some(ref lnl)) = (&nf, &nl) {
        let rows: Vec<CustomerSlim> = if let Some(ex) = params.exclude_customer_id {
            sqlx::query_as(
                r#"
                SELECT id, customer_code, first_name, last_name, email, phone,
                       address_line1, address_line2, city, state, postal_code
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
                SELECT id, customer_code, first_name, last_name, email, phone,
                       address_line1, address_line2, city, state, postal_code
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
        for (
            id,
            customer_code,
            first_name,
            last_name,
            email,
            phone,
            address_line1,
            address_line2,
            city,
            state,
            postal_code,
        ) in rows
        {
            if out.iter().any(|r| r.id == id) {
                continue;
            }
            let same_zip = match (&nz, &postal_code) {
                (Some(input_zip), Some(candidate_zip)) => {
                    candidate_zip.trim().eq_ignore_ascii_case(input_zip)
                }
                _ => false,
            };
            out.push(DuplicateCandidateRow {
                id,
                customer_code,
                first_name,
                last_name,
                email,
                phone,
                address_line1,
                address_line2,
                city,
                state,
                postal_code,
                match_reason: if same_zip {
                    "same_name_zip".to_string()
                } else {
                    "same_name".to_string()
                },
            });
        }
    }

    out.truncate(lim as usize);
    Ok(out)
}
