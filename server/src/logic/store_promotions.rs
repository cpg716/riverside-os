//! Web storefront coupon validation (cart preview; redemption rows on paid web orders).

use chrono::Utc;
use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoreCouponRow {
    pub id: Uuid,
    pub code: String,
    pub kind: String,
    pub value: Decimal,
    pub max_discount_usd: Option<Decimal>,
    pub starts_at: Option<chrono::DateTime<Utc>>,
    pub ends_at: Option<chrono::DateTime<Utc>>,
    pub min_subtotal_usd: Option<Decimal>,
    pub max_uses: Option<i32>,
    pub uses_count: i32,
    pub is_active: bool,
}

#[derive(Debug, Clone)]
pub struct AppliedCouponPreview {
    pub coupon_id: Uuid,
    pub code: String,
    pub kind: String,
    pub discount_amount: Decimal,
    pub free_shipping: bool,
}

#[derive(Debug, Error)]
pub enum CouponError {
    #[error("coupon not found")]
    NotFound,
    #[error("coupon is inactive")]
    Inactive,
    #[error("coupon is not valid yet")]
    NotStarted,
    #[error("coupon has expired")]
    Expired,
    #[error("order subtotal is below the minimum for this coupon")]
    BelowMinSubtotal,
    #[error("coupon has reached its maximum redemptions")]
    MaxUsesReached,
    #[error("invalid coupon configuration")]
    InvalidConfig,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub async fn load_coupon_by_code(
    pool: &PgPool,
    code: &str,
) -> Result<Option<StoreCouponRow>, sqlx::Error> {
    let code_norm = code.trim().to_lowercase();
    if code_norm.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query_as::<_, StoreCouponRow>(
        r#"
        SELECT
            id,
            code,
            kind::text AS kind,
            value,
            max_discount_usd,
            starts_at,
            ends_at,
            min_subtotal_usd,
            max_uses,
            uses_count,
            is_active
        FROM store_coupons
        WHERE lower(trim(code)) = $1
        "#,
    )
    .bind(&code_norm)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

fn validate_window(c: &StoreCouponRow) -> Result<(), CouponError> {
    if !c.is_active {
        return Err(CouponError::Inactive);
    }
    let now = Utc::now();
    if let Some(s) = c.starts_at {
        if now < s {
            return Err(CouponError::NotStarted);
        }
    }
    if let Some(e) = c.ends_at {
        if now > e {
            return Err(CouponError::Expired);
        }
    }
    if let Some(max) = c.max_uses {
        if c.uses_count >= max {
            return Err(CouponError::MaxUsesReached);
        }
    }
    Ok(())
}

/// Validates coupon and returns discount for `subtotal` (does not increment `uses_count`).
pub fn preview_discount(
    subtotal: Decimal,
    c: &StoreCouponRow,
) -> Result<AppliedCouponPreview, CouponError> {
    validate_window(c)?;
    if subtotal < Decimal::ZERO {
        return Err(CouponError::InvalidConfig);
    }
    if let Some(min) = c.min_subtotal_usd {
        if subtotal < min {
            return Err(CouponError::BelowMinSubtotal);
        }
    }

    match c.kind.as_str() {
        "percent" => {
            if c.value < Decimal::ZERO || c.value > Decimal::new(100, 0) {
                return Err(CouponError::InvalidConfig);
            }
            let mut disc = (subtotal * c.value / Decimal::new(100, 0))
                .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
            if let Some(cap) = c.max_discount_usd {
                if disc > cap {
                    disc = cap;
                }
            }
            if disc > subtotal {
                disc = subtotal;
            }
            Ok(AppliedCouponPreview {
                coupon_id: c.id,
                code: c.code.clone(),
                kind: c.kind.clone(),
                discount_amount: disc,
                free_shipping: false,
            })
        }
        "fixed_amount" => {
            if c.value < Decimal::ZERO {
                return Err(CouponError::InvalidConfig);
            }
            let disc = c
                .value
                .min(subtotal)
                .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
            Ok(AppliedCouponPreview {
                coupon_id: c.id,
                code: c.code.clone(),
                kind: c.kind.clone(),
                discount_amount: disc,
                free_shipping: false,
            })
        }
        "free_shipping" => Ok(AppliedCouponPreview {
            coupon_id: c.id,
            code: c.code.clone(),
            kind: c.kind.clone(),
            discount_amount: Decimal::ZERO,
            free_shipping: true,
        }),
        _ => Err(CouponError::InvalidConfig),
    }
}

pub async fn apply_coupon_code(
    pool: &PgPool,
    code: &str,
    subtotal: Decimal,
) -> Result<AppliedCouponPreview, CouponError> {
    let c = load_coupon_by_code(pool, code)
        .await?
        .ok_or(CouponError::NotFound)?;
    preview_discount(subtotal, &c)
}
