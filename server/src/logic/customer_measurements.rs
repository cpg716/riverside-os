//! Sync retail sizing between `wedding_members` text grid and `customer_measurements` vault.

use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

type WeddingMemberRetailSizingRow = (
    Uuid,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type CustomerRetailTextRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Upserts retail columns from a wedding member row and mirrors them to every member row for that customer.
pub async fn sync_retail_from_wedding_member(
    pool: &PgPool,
    member_id: Uuid,
) -> Result<(), sqlx::Error> {
    let row: Option<WeddingMemberRetailSizingRow> = sqlx::query_as(
        r#"
            SELECT customer_id, suit, waist, vest, shirt, shoe
            FROM wedding_members
            WHERE id = $1
            "#,
    )
    .bind(member_id)
    .fetch_optional(pool)
    .await?;

    let Some((customer_id, suit, waist, vest, shirt, shoe)) = row else {
        return Ok(());
    };

    upsert_retail_block(
        pool,
        customer_id,
        suit.as_deref(),
        waist.as_deref(),
        vest.as_deref(),
        shirt.as_deref(),
        shoe.as_deref(),
    )
    .await?;
    mirror_retail_to_wedding_members(
        pool,
        customer_id,
        norm_opt_str(suit.as_deref()),
        norm_opt_str(waist.as_deref()),
        norm_opt_str(vest.as_deref()),
        norm_opt_str(shirt.as_deref()),
        norm_opt_str(shoe.as_deref()),
    )
    .await
}

fn norm_opt_str(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|t| !t.is_empty())
}

async fn upsert_retail_block(
    pool: &PgPool,
    customer_id: Uuid,
    suit: Option<&str>,
    waist: Option<&str>,
    vest: Option<&str>,
    shirt: Option<&str>,
    shoe: Option<&str>,
) -> Result<(), sqlx::Error> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM customer_measurements WHERE customer_id = $1)",
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    if !exists {
        sqlx::query(
            r#"
            INSERT INTO customer_measurements (id, customer_id, retail_suit, retail_waist, retail_vest, retail_shirt, retail_shoe)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(customer_id)
        .bind(norm_opt_str(suit))
        .bind(norm_opt_str(waist))
        .bind(norm_opt_str(vest))
        .bind(norm_opt_str(shirt))
        .bind(norm_opt_str(shoe))
        .execute(pool)
        .await?;
        return Ok(());
    }

    sqlx::query(
        r#"
        UPDATE customer_measurements SET
            retail_suit = $2,
            retail_waist = $3,
            retail_vest = $4,
            retail_shirt = $5,
            retail_shoe = $6
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .bind(norm_opt_str(suit))
    .bind(norm_opt_str(waist))
    .bind(norm_opt_str(vest))
    .bind(norm_opt_str(shirt))
    .bind(norm_opt_str(shoe))
    .execute(pool)
    .await?;

    Ok(())
}

fn empty_as_none(s: Option<String>) -> Option<String> {
    s.filter(|t| !t.trim().is_empty())
}

async fn mirror_retail_to_wedding_members(
    pool: &PgPool,
    customer_id: Uuid,
    suit: Option<&str>,
    waist: Option<&str>,
    vest: Option<&str>,
    shirt: Option<&str>,
    shoe: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE wedding_members SET
            suit = $2,
            waist = $3,
            vest = $4,
            shirt = $5,
            shoe = $6
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .bind(suit)
    .bind(waist)
    .bind(vest)
    .bind(shirt)
    .bind(shoe)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Default)]
pub struct PatchMeasurementBlock {
    pub neck: Option<Decimal>,
    pub sleeve: Option<Decimal>,
    pub chest: Option<Decimal>,
    pub waist: Option<Decimal>,
    pub seat: Option<Decimal>,
    pub inseam: Option<Decimal>,
    pub outseam: Option<Decimal>,
    pub shoulder: Option<Decimal>,
    pub retail_suit: Option<String>,
    pub retail_waist: Option<String>,
    pub retail_vest: Option<String>,
    pub retail_shirt: Option<String>,
    pub retail_shoe: Option<String>,
}

/// `None` = leave unchanged; `Some(None)` not used — empty string clears retail text fields.
pub async fn patch_measurement_block(
    pool: &PgPool,
    customer_id: Uuid,
    patch: &PatchMeasurementBlock,
) -> Result<(), sqlx::Error> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM customer_measurements WHERE customer_id = $1)",
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    if !exists {
        sqlx::query(
            "INSERT INTO customer_measurements (id, customer_id) VALUES (gen_random_uuid(), $1)",
        )
        .bind(customer_id)
        .execute(pool)
        .await?;
    }

    let (set_suit, val_suit) = retail_case(patch.retail_suit.as_ref());
    let (set_waist, val_waist) = retail_case(patch.retail_waist.as_ref());
    let (set_vest, val_vest) = retail_case(patch.retail_vest.as_ref());
    let (set_shirt, val_shirt) = retail_case(patch.retail_shirt.as_ref());
    let (set_shoe, val_shoe) = retail_case(patch.retail_shoe.as_ref());

    sqlx::query(
        r#"
        UPDATE customer_measurements SET
            neck = COALESCE($2, neck),
            sleeve = COALESCE($3, sleeve),
            chest = COALESCE($4, chest),
            waist = COALESCE($5, waist),
            seat = COALESCE($6, seat),
            inseam = COALESCE($7, inseam),
            outseam = COALESCE($8, outseam),
            shoulder = COALESCE($9, shoulder),
            retail_suit = CASE WHEN $10::boolean THEN $11 ELSE retail_suit END,
            retail_waist = CASE WHEN $12::boolean THEN $13 ELSE retail_waist END,
            retail_vest = CASE WHEN $14::boolean THEN $15 ELSE retail_vest END,
            retail_shirt = CASE WHEN $16::boolean THEN $17 ELSE retail_shirt END,
            retail_shoe = CASE WHEN $18::boolean THEN $19 ELSE retail_shoe END
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .bind(patch.neck)
    .bind(patch.sleeve)
    .bind(patch.chest)
    .bind(patch.waist)
    .bind(patch.seat)
    .bind(patch.inseam)
    .bind(patch.outseam)
    .bind(patch.shoulder)
    .bind(set_suit)
    .bind(val_suit)
    .bind(set_waist)
    .bind(val_waist)
    .bind(set_vest)
    .bind(val_vest)
    .bind(set_shirt)
    .bind(val_shirt)
    .bind(set_shoe)
    .bind(val_shoe)
    .execute(pool)
    .await?;

    let row: Option<CustomerRetailTextRow> = sqlx::query_as(
        r#"
            SELECT retail_suit, retail_waist, retail_vest, retail_shirt, retail_shoe
            FROM customer_measurements
            WHERE customer_id = $1
            "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;

    if let Some((suit, waist, vest, shirt, shoe)) = row {
        mirror_retail_to_wedding_members(
            pool,
            customer_id,
            suit.as_deref(),
            waist.as_deref(),
            vest.as_deref(),
            shirt.as_deref(),
            shoe.as_deref(),
        )
        .await?;
    }

    Ok(())
}

fn retail_case(v: Option<&String>) -> (bool, Option<String>) {
    match v {
        None => (false, None),
        Some(s) => (true, empty_as_none(Some(s.clone()))),
    }
}
