//! Unified shipment registry (POS, web, manual) and `shipment_event` audit log.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::types::Json;
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

use crate::logic::shippo::{
    self, ParcelInput, ShippingAddressInput, ShippoError, StoreShippingRatesResult,
};
use crate::models::{DbShipmentSource, DbShipmentStatus};

#[derive(Debug, Error)]
pub enum ShipmentError {
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Shippo(#[from] ShippoError),
}

#[derive(Debug, Deserialize, Default)]
pub struct ShipmentListQuery {
    pub customer_id: Option<Uuid>,
    pub status: Option<String>,
    pub source: Option<String>,
    pub search: Option<String>,
    #[serde(default)]
    pub open_only: bool,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ShipmentListRow {
    pub id: Uuid,
    pub source: String,
    pub status: String,
    pub transaction_id: Option<Uuid>,
    pub customer_id: Option<Uuid>,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub tracking_number: Option<String>,
    pub shipping_charged_usd: Option<Decimal>,
    pub quoted_amount_usd: Option<Decimal>,
    pub carrier: Option<String>,
    pub service_name: Option<String>,
    /// City, state, ZIP from `ship_to` JSON (for list grid).
    pub dest_summary: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ShipmentEventRow {
    pub id: Uuid,
    pub at: DateTime<Utc>,
    pub kind: String,
    pub message: String,
    pub metadata: Json<Value>,
    pub staff_id: Option<Uuid>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ShipmentDetailRow {
    pub id: Uuid,
    pub source: DbShipmentSource,
    pub status: DbShipmentStatus,
    pub transaction_id: Option<Uuid>,
    pub customer_id: Option<Uuid>,
    pub created_by_staff_id: Option<Uuid>,
    pub ship_to: Json<Value>,
    pub parcel: Option<Json<Value>>,
    pub quoted_amount_usd: Option<Decimal>,
    pub shipping_charged_usd: Option<Decimal>,
    pub label_cost_usd: Option<Decimal>,
    pub carrier: Option<String>,
    pub service_name: Option<String>,
    pub shippo_rate_object_id: Option<String>,
    pub shippo_shipment_object_id: Option<String>,
    pub shippo_transaction_object_id: Option<String>,
    pub tracking_number: Option<String>,
    pub tracking_url_provider: Option<String>,
    pub shipping_label_url: Option<String>,
    pub internal_notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
}

pub async fn append_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    shipment_id: Uuid,
    kind: &str,
    message: &str,
    metadata: Value,
    staff_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO shipment_event (shipment_id, kind, message, metadata, staff_id)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(shipment_id)
    .bind(kind)
    .bind(message)
    .bind(Json(metadata))
    .bind(staff_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE shipment SET updated_at = NOW() WHERE id = $1")
        .bind(shipment_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Called inside checkout transaction after the order row exists.
pub async fn insert_from_pos_order_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    operator_staff_id: Uuid,
    ship_to: Value,
    shipping_charged: Option<Decimal>,
    shippo_rate_object_id: Option<String>,
) -> Result<Uuid, sqlx::Error> {
    let status = if shipping_charged.map(|d| d > Decimal::ZERO).unwrap_or(false) {
        DbShipmentStatus::Quoted
    } else {
        DbShipmentStatus::Draft
    };
    let sid: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shipment (
            source, transaction_id, customer_id, created_by_staff_id,
            status, ship_to, quoted_amount_usd, shipping_charged_usd,
            shippo_rate_object_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
    )
    .bind(DbShipmentSource::PosOrder)
    .bind(transaction_id)
    .bind(customer_id)
    .bind(operator_staff_id)
    .bind(status)
    .bind(Json(ship_to))
    .bind(shipping_charged)
    .bind(shipping_charged)
    .bind(shippo_rate_object_id.as_ref())
    .fetch_one(&mut **tx)
    .await?;

    append_event_tx(
        tx,
        sid,
        "checkout",
        "Shipment registered from POS checkout (shipping on order).",
        json!({
            "transaction_id": transaction_id.to_string(),
            "source": "pos_order"
        }),
        Some(operator_staff_id),
    )
    .await?;
    Ok(sid)
}

pub async fn list_shipments(
    pool: &PgPool,
    q: &ShipmentListQuery,
) -> Result<Vec<ShipmentListRow>, sqlx::Error> {
    let limit = q.limit.unwrap_or(80).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
        r#"
        SELECT
            s.id,
            s.source::text AS source,
            s.status::text AS status,
            s.transaction_id,
            s.customer_id,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            s.created_at,
            s.tracking_number,
            s.shipping_charged_usd,
            s.quoted_amount_usd,
            s.carrier,
            s.service_name,
            NULLIF(
                trim(both ' ' FROM concat_ws(
                    ', ',
                    NULLIF(trim(both ' ' FROM s.ship_to->>'city'), ''),
                    NULLIF(trim(both ' ' FROM s.ship_to->>'state'), ''),
                    NULLIF(trim(both ' ' FROM s.ship_to->>'zip'), '')
                )),
                ''
            ) AS dest_summary
        FROM shipment s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE 1=1
        "#,
    );

    if let Some(cid) = q.customer_id {
        qb.push(" AND s.customer_id = ");
        qb.push_bind(cid);
    }
    if q.open_only {
        qb.push(
            " AND s.status NOT IN ('delivered'::shipment_status, 'cancelled'::shipment_status) ",
        );
    }
    if let Some(ref st) = q.status {
        if !st.trim().is_empty() {
            qb.push(" AND s.status::text = ");
            qb.push_bind(st.trim().to_string());
        }
    }
    if let Some(ref src) = q.source {
        if !src.trim().is_empty() {
            qb.push(" AND s.source::text = ");
            qb.push_bind(src.trim().to_string());
        }
    }
    if let Some(ref search) = q.search {
        let trimmed = search.trim();
        if !trimmed.is_empty() {
            let like = format!("%{trimmed}%");
            qb.push(" AND (");
            qb.push(" s.id::text ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(s.tracking_number, '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(s.carrier, '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(s.service_name, '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(c.first_name, '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(c.last_name, '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(s.ship_to->>'city', '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(s.ship_to->>'state', '') ILIKE ");
            qb.push_bind(like.clone());
            qb.push(" OR COALESCE(s.ship_to->>'zip', '') ILIKE ");
            qb.push_bind(like);
            qb.push(") ");
        }
    }

    qb.push(" ORDER BY s.created_at DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    qb.build_query_as().fetch_all(pool).await
}

pub async fn get_shipment_detail(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<ShipmentDetailRow>, sqlx::Error> {
    sqlx::query_as::<_, ShipmentDetailRow>(
        r#"
        SELECT
            s.id,
            s.source,
            s.status,
            s.transaction_id,
            s.customer_id,
            s.created_by_staff_id,
            s.ship_to,
            s.parcel,
            s.quoted_amount_usd,
            s.shipping_charged_usd,
            s.label_cost_usd,
            s.carrier,
            s.service_name,
            s.shippo_rate_object_id,
            s.shippo_shipment_object_id,
            s.shippo_transaction_object_id,
            s.tracking_number,
            s.tracking_url_provider,
            s.shipping_label_url,
            s.internal_notes,
            s.created_at,
            s.updated_at,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name
        FROM shipment s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn list_events(
    pool: &PgPool,
    shipment_id: Uuid,
) -> Result<Vec<ShipmentEventRow>, sqlx::Error> {
    sqlx::query_as::<_, ShipmentEventRow>(
        r#"
        SELECT id, at, kind, message, metadata, staff_id
        FROM shipment_event
        WHERE shipment_id = $1
        ORDER BY at DESC
        "#,
    )
    .bind(shipment_id)
    .fetch_all(pool)
    .await
}

fn ship_to_to_input(v: &Value) -> Result<ShippingAddressInput, ShipmentError> {
    serde_json::from_value(v.clone()).map_err(|_| {
        ShipmentError::InvalidPayload("ship_to must include name, street1, city, state, zip".into())
    })
}

pub async fn fetch_rates_for_shipment(
    pool: &PgPool,
    http: &reqwest::Client,
    shipment_id: Uuid,
    parcel_override: Option<&ParcelInput>,
    force_stub: bool,
    staff_id: Uuid,
) -> Result<StoreShippingRatesResult, ShipmentError> {
    let row = get_shipment_detail(pool, shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;
    let addr = ship_to_to_input(&row.ship_to.0)?;
    addr.validate()?;

    let _ = shippo::prune_expired_rate_quotes(pool).await;
    let res = shippo::store_shipping_rates(pool, http, &addr, parcel_override, force_stub).await?;

    let mut tx = pool.begin().await?;
    append_event_tx(
        &mut tx,
        shipment_id,
        "rates_fetched",
        &format!(
            "Fetched {} rate option(s). stub={}",
            res.rates.len(),
            res.stub
        ),
        json!({ "stub": res.stub, "count": res.rates.len() }),
        Some(staff_id),
    )
    .await?;
    tx.commit().await?;
    Ok(res)
}

#[derive(Debug, Deserialize)]
pub struct ApplyQuoteBody {
    pub rate_quote_id: Uuid,
}

pub async fn apply_rate_quote(
    pool: &PgPool,
    shipment_id: Uuid,
    quote_id: Uuid,
    staff_id: Uuid,
) -> Result<(), ShipmentError> {
    let _row = get_shipment_detail(pool, shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;

    let mut tx = pool.begin().await?;
    type DeletedRateQuoteRow = (Decimal, String, String, Json<Value>, Option<String>);
    let row: Option<DeletedRateQuoteRow> = sqlx::query_as(
        r#"
        DELETE FROM store_shipping_rate_quote
        WHERE id = $1 AND expires_at > NOW()
        RETURNING amount_usd, carrier, service_name, metadata, shippo_rate_object_id
        "#,
    )
    .bind(quote_id)
    .fetch_optional(&mut *tx)
    .await?;

    let (amt, carrier, service, _meta, rate_oid) =
        row.ok_or_else(|| ShipmentError::InvalidPayload("invalid or expired rate quote".into()))?;

    sqlx::query(
        r#"
        UPDATE shipment SET
            quoted_amount_usd = $2,
            carrier = $3,
            service_name = $4,
            shippo_rate_object_id = $5,
            status = 'quoted',
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(shipment_id)
    .bind(amt)
    .bind(&carrier)
    .bind(&service)
    .bind(&rate_oid)
    .execute(&mut *tx)
    .await?;

    append_event_tx(
        &mut tx,
        shipment_id,
        "quote_applied",
        &format!("Applied rate quote {quote_id}: {carrier} — {service} (${amt})"),
        json!({
            "rate_quote_id": quote_id.to_string(),
            "amount_usd": amt.to_string(),
            "carrier": carrier,
            "service_name": service
        }),
        Some(staff_id),
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateManualShipmentBody {
    pub customer_id: Option<Uuid>,
    pub ship_to: Value,
    #[serde(default)]
    pub internal_notes: Option<String>,
}

pub async fn create_manual_shipment(
    pool: &PgPool,
    body: CreateManualShipmentBody,
    staff_id: Uuid,
) -> Result<Uuid, ShipmentError> {
    let addr = ship_to_to_input(&body.ship_to)?;
    addr.validate()?;

    let mut tx = pool.begin().await?;
    let sid: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shipment (
            source, customer_id, created_by_staff_id,
            status, ship_to, internal_notes
        )
        VALUES ('manual_hub', $1, $2, 'draft', $3, $4)
        RETURNING id
        "#,
    )
    .bind(body.customer_id)
    .bind(staff_id)
    .bind(Json(body.ship_to))
    .bind(body.internal_notes.as_deref())
    .fetch_one(&mut *tx)
    .await?;

    append_event_tx(
        &mut tx,
        sid,
        "created",
        "Manual shipment created from Shipments hub.",
        json!({ "customer_id": body.customer_id.map(|u| u.to_string()) }),
        Some(staff_id),
    )
    .await?;
    tx.commit().await?;
    Ok(sid)
}

/// Buy a Shippo label using `shipment.shippo_rate_object_id` (from applied quote or POS checkout).
pub async fn purchase_shipment_label(
    pool: &PgPool,
    http: &reqwest::Client,
    shipment_id: Uuid,
    staff_id: Uuid,
) -> Result<shippo::PurchasedLabel, ShipmentError> {
    let row = get_shipment_detail(pool, shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;

    if row
        .shippo_transaction_object_id
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return Err(ShipmentError::InvalidPayload(
            "label already purchased for this shipment".into(),
        ));
    }

    let rate_oid = row
        .shippo_rate_object_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ShipmentError::InvalidPayload(
                "no Shippo rate on shipment — fetch live rates and apply a quote (stub rates cannot buy labels)"
                    .into(),
            )
        })?;

    let purchased = shippo::purchase_transaction_for_rate(http, rate_oid).await?;

    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE shipment SET
            shippo_shipment_object_id = COALESCE($2, shippo_shipment_object_id),
            shippo_transaction_object_id = $3,
            tracking_number = COALESCE($4, tracking_number),
            tracking_url_provider = COALESCE($5, tracking_url_provider),
            shipping_label_url = COALESCE($6, shipping_label_url),
            label_cost_usd = COALESCE($7, label_cost_usd),
            status = 'label_purchased',
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(shipment_id)
    .bind(&purchased.shippo_shipment_object_id)
    .bind(&purchased.shippo_transaction_object_id)
    .bind(&purchased.tracking_number)
    .bind(&purchased.tracking_url_provider)
    .bind(&purchased.shipping_label_url)
    .bind(purchased.label_cost_usd)
    .execute(&mut *tx)
    .await?;

    if let Some(oid) = row.transaction_id {
        sqlx::query(
            r#"
            UPDATE transactions SET
                shippo_shipment_object_id = COALESCE($2, shippo_shipment_object_id),
                shippo_transaction_object_id = $3,
                tracking_number = COALESCE($4, tracking_number),
                tracking_url_provider = COALESCE($5, tracking_url_provider),
                shipping_label_url = COALESCE($6, shipping_label_url)
            WHERE id = $1
            "#,
        )
        .bind(oid)
        .bind(&purchased.shippo_shipment_object_id)
        .bind(&purchased.shippo_transaction_object_id)
        .bind(&purchased.tracking_number)
        .bind(&purchased.tracking_url_provider)
        .bind(&purchased.shipping_label_url)
        .execute(&mut *tx)
        .await?;
    }

    append_event_tx(
        &mut tx,
        shipment_id,
        "label_purchased",
        "Purchased shipping label via Shippo.",
        json!({
            "transaction_id": purchased.shippo_transaction_object_id,
            "tracking_number": purchased.tracking_number,
            "label_url": purchased.shipping_label_url,
        }),
        Some(staff_id),
    )
    .await?;

    if let Some(oid) = row.transaction_id {
        let _ = crate::logic::commission_recalc::recalc_transaction_commissions_after_fulfillment(
            &mut tx,
            oid,
            &[],
        )
        .await?;
    }

    tx.commit().await?;
    Ok(purchased)
}

#[derive(Debug, Deserialize)]
pub struct StaffNoteBody {
    pub message: String,
}

pub async fn add_staff_note(
    pool: &PgPool,
    shipment_id: Uuid,
    message: String,
    staff_id: Uuid,
) -> Result<(), ShipmentError> {
    if message.trim().is_empty() {
        return Err(ShipmentError::InvalidPayload("message required".into()));
    }
    let ok = get_shipment_detail(pool, shipment_id).await?.is_some();
    if !ok {
        return Err(ShipmentError::NotFound);
    }
    let mut tx = pool.begin().await?;
    append_event_tx(
        &mut tx,
        shipment_id,
        "staff_note",
        message.trim(),
        json!({}),
        Some(staff_id),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct PatchShipmentBody {
    pub status: Option<String>,
    pub tracking_number: Option<String>,
    pub tracking_url_provider: Option<String>,
    pub internal_notes: Option<String>,
}

fn parse_status(s: &str) -> Result<DbShipmentStatus, ShipmentError> {
    match s.trim() {
        "draft" => Ok(DbShipmentStatus::Draft),
        "quoted" => Ok(DbShipmentStatus::Quoted),
        "label_purchased" => Ok(DbShipmentStatus::LabelPurchased),
        "in_transit" => Ok(DbShipmentStatus::InTransit),
        "delivered" => Ok(DbShipmentStatus::Delivered),
        "cancelled" => Ok(DbShipmentStatus::Cancelled),
        "exception" => Ok(DbShipmentStatus::Exception),
        _ => Err(ShipmentError::InvalidPayload(format!(
            "unknown status: {s}"
        ))),
    }
}

pub async fn patch_shipment(
    pool: &PgPool,
    shipment_id: Uuid,
    body: PatchShipmentBody,
    staff_id: Uuid,
) -> Result<(), ShipmentError> {
    let cur = get_shipment_detail(pool, shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;

    let mut tx = pool.begin().await?;
    let mut log_bits: Vec<String> = Vec::new();
    let mut recognition_touched = false;

    if let Some(ref st) = body.status {
        let st_e = parse_status(st)?;
        sqlx::query("UPDATE shipment SET status = $2, updated_at = NOW() WHERE id = $1")
            .bind(shipment_id)
            .bind(st_e)
            .execute(&mut *tx)
            .await?;
        log_bits.push(format!("status set to {st}"));
        if matches!(
            st_e,
            DbShipmentStatus::LabelPurchased
                | DbShipmentStatus::InTransit
                | DbShipmentStatus::Delivered
        ) {
            recognition_touched = true;
        }
    }
    if let Some(ref tn) = body.tracking_number {
        sqlx::query("UPDATE shipment SET tracking_number = $2, updated_at = NOW() WHERE id = $1")
            .bind(shipment_id)
            .bind(tn.trim())
            .execute(&mut *tx)
            .await?;
        log_bits.push("tracking number updated".to_string());
    }
    if let Some(ref tu) = body.tracking_url_provider {
        sqlx::query(
            "UPDATE shipment SET tracking_url_provider = $2, updated_at = NOW() WHERE id = $1",
        )
        .bind(shipment_id)
        .bind(tu.trim())
        .execute(&mut *tx)
        .await?;
        log_bits.push("tracking URL updated".to_string());
    }
    if let Some(ref notes) = body.internal_notes {
        sqlx::query("UPDATE shipment SET internal_notes = $2, updated_at = NOW() WHERE id = $1")
            .bind(shipment_id)
            .bind(notes)
            .execute(&mut *tx)
            .await?;
        log_bits.push("internal notes updated".to_string());
    }

    if !log_bits.is_empty() {
        append_event_tx(
            &mut tx,
            shipment_id,
            "updated",
            &log_bits.join("; "),
            json!({ "details": log_bits }),
            Some(staff_id),
        )
        .await?;
    }

    if recognition_touched {
        if let Some(oid) = cur.transaction_id {
            crate::logic::commission_recalc::recalc_transaction_commissions_after_fulfillment(
                &mut tx,
                oid,
                &[],
            )
            .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}
