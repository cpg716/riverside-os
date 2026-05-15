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
    self, ParcelInput, PickupLocationInput, ShippingAddressInput, ShippoError,
    StoreShippingRatesResult,
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
    pub direction: String,
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
    pub shippo_carrier_account_object_id: Option<String>,
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
pub struct ShipmentBatchRow {
    pub id: Uuid,
    pub batch_type: String,
    pub status: String,
    pub carrier_account: String,
    pub shipment_date: Option<DateTime<Utc>>,
    pub requested_start_time: Option<DateTime<Utc>>,
    pub requested_end_time: Option<DateTime<Utc>>,
    pub building_location_type: Option<String>,
    pub building_type: Option<String>,
    pub instructions: Option<String>,
    pub shippo_manifest_object_id: Option<String>,
    pub shippo_pickup_object_id: Option<String>,
    pub confirmation_code: Option<String>,
    pub document_url: Option<String>,
    pub created_by_staff_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub shipment_count: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ShipmentDetailRow {
    pub id: Uuid,
    pub source: DbShipmentSource,
    pub direction: String,
    pub parent_shipment_id: Option<Uuid>,
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
    pub shippo_carrier_account_object_id: Option<String>,
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
            s.direction,
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
            s.shippo_carrier_account_object_id,
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
            s.direction,
            s.parent_shipment_id,
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
            s.shippo_carrier_account_object_id,
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

#[allow(clippy::too_many_arguments)]
pub async fn fetch_rates_for_shipment(
    pool: &PgPool,
    http: &reqwest::Client,
    shipment_id: Uuid,
    parcel_override: Option<&ParcelInput>,
    parcels_override: Option<&[ParcelInput]>,
    customs_declaration_object_id: Option<&str>,
    force_stub: bool,
    staff_id: Uuid,
) -> Result<StoreShippingRatesResult, ShipmentError> {
    let row = get_shipment_detail(pool, shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;
    let addr = ship_to_to_input(&row.ship_to.0)?;
    addr.validate()?;
    let is_return = row.direction == "return";

    let _ = shippo::prune_expired_rate_quotes(pool).await;
    let res = shippo::store_shipping_rates(
        pool,
        http,
        &addr,
        parcel_override,
        parcels_override,
        customs_declaration_object_id,
        is_return,
        force_stub,
    )
    .await?;

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
    let shipment = get_shipment_detail(pool, shipment_id)
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
    let quote_is_return = _meta
        .0
        .get("is_return")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if quote_is_return != (shipment.direction == "return") {
        return Err(ShipmentError::InvalidPayload(
            "rate quote does not match shipment direction".into(),
        ));
    }
    let carrier_account = _meta
        .0
        .get("shippo_carrier_account_object_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    sqlx::query(
        r#"
        UPDATE shipment SET
            quoted_amount_usd = $2,
            carrier = $3,
            service_name = $4,
            shippo_rate_object_id = $5,
            shippo_carrier_account_object_id = $6,
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
    .bind(&carrier_account)
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
            "service_name": service,
            "shippo_carrier_account_object_id": carrier_account
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
            direction, status, ship_to, internal_notes
        )
        VALUES ('manual_hub', $1, $2, 'outbound', 'draft', $3, $4)
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
            shippo_carrier_account_object_id = COALESCE(shippo_carrier_account_object_id, $8),
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
    .bind(&row.shippo_carrier_account_object_id)
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
        let _ =
            crate::logic::commission_events::upsert_fulfilled_transaction_events(&mut tx, oid, &[])
                .await?;
    }

    tx.commit().await?;
    Ok(purchased)
}

pub async fn refund_shipment_label(
    pool: &PgPool,
    http: &reqwest::Client,
    shipment_id: Uuid,
    staff_id: Uuid,
) -> Result<shippo::ShippoRefundResult, ShipmentError> {
    let row = get_shipment_detail(pool, shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;
    let transaction_id = row
        .shippo_transaction_object_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ShipmentError::InvalidPayload(
                "no Shippo label transaction is available to refund".to_string(),
            )
        })?;

    let refund = shippo::request_label_refund(http, transaction_id).await?;
    let mut tx = pool.begin().await?;
    append_event_tx(
        &mut tx,
        shipment_id,
        "label_refund_requested",
        "Requested unused label refund through Shippo.",
        json!({
            "shippo_refund_object_id": refund.object_id,
            "shippo_refund_status": refund.status,
            "shippo_transaction_object_id": refund.transaction,
        }),
        Some(staff_id),
    )
    .await?;
    tx.commit().await?;
    Ok(refund)
}

pub async fn create_return_shipment(
    pool: &PgPool,
    outbound_shipment_id: Uuid,
    staff_id: Uuid,
) -> Result<Uuid, ShipmentError> {
    let outbound = get_shipment_detail(pool, outbound_shipment_id)
        .await?
        .ok_or(ShipmentError::NotFound)?;
    if outbound.direction == "return" {
        return Err(ShipmentError::InvalidPayload(
            "return labels must start from an outbound shipment".into(),
        ));
    }
    if outbound
        .shippo_transaction_object_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return Err(ShipmentError::InvalidPayload(
            "buy the outbound label before creating a return label".into(),
        ));
    }

    let existing: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM shipment
        WHERE direction = 'return'
          AND parent_shipment_id = $1
          AND status NOT IN ('cancelled'::shipment_status, 'delivered'::shipment_status)
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(outbound_shipment_id)
    .fetch_optional(pool)
    .await?;
    if let Some(id) = existing {
        return Ok(id);
    }

    let mut tx = pool.begin().await?;
    let return_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shipment (
            source, direction, parent_shipment_id, transaction_id, customer_id,
            created_by_staff_id, status, ship_to, parcel, internal_notes
        )
        VALUES ($1, 'return', $2, $3, $4, $5, 'draft', $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(outbound.source)
    .bind(outbound_shipment_id)
    .bind(outbound.transaction_id)
    .bind(outbound.customer_id)
    .bind(staff_id)
    .bind(outbound.ship_to)
    .bind(outbound.parcel)
    .bind("Return label workflow created from outbound shipment.")
    .fetch_one(&mut *tx)
    .await?;

    append_event_tx(
        &mut tx,
        return_id,
        "return_created",
        "Return label workflow created.",
        json!({ "outbound_shipment_id": outbound_shipment_id.to_string() }),
        Some(staff_id),
    )
    .await?;
    append_event_tx(
        &mut tx,
        outbound_shipment_id,
        "return_created",
        "Return label workflow created for this outbound shipment.",
        json!({ "return_shipment_id": return_id.to_string() }),
        Some(staff_id),
    )
    .await?;
    tx.commit().await?;
    Ok(return_id)
}

#[derive(Debug, Deserialize)]
pub struct CreateManifestBody {
    pub shipment_ids: Vec<Uuid>,
    #[serde(default)]
    pub carrier_account: Option<String>,
    #[serde(default)]
    pub shipment_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePickupBody {
    pub shipment_ids: Vec<Uuid>,
    #[serde(default)]
    pub carrier_account: Option<String>,
    pub requested_start_time: String,
    pub requested_end_time: String,
    pub building_location_type: String,
    #[serde(default)]
    pub building_type: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ShipmentBatchCandidateRow {
    pub id: Uuid,
    pub direction: String,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub carrier: Option<String>,
    pub service_name: Option<String>,
    pub tracking_number: Option<String>,
    pub shippo_transaction_object_id: String,
    pub shippo_carrier_account_object_id: String,
    pub created_at: DateTime<Utc>,
}

pub async fn list_batch_candidates(
    pool: &PgPool,
) -> Result<Vec<ShipmentBatchCandidateRow>, sqlx::Error> {
    sqlx::query_as::<_, ShipmentBatchCandidateRow>(
        r#"
        SELECT
            s.id,
            s.direction,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            s.carrier,
            s.service_name,
            s.tracking_number,
            s.shippo_transaction_object_id,
            s.shippo_carrier_account_object_id,
            s.created_at
        FROM shipment s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.status IN ('label_purchased'::shipment_status, 'in_transit'::shipment_status)
          AND NULLIF(btrim(s.shippo_transaction_object_id), '') IS NOT NULL
          AND NULLIF(btrim(s.shippo_carrier_account_object_id), '') IS NOT NULL
        ORDER BY s.created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn list_shipment_batches(pool: &PgPool) -> Result<Vec<ShipmentBatchRow>, sqlx::Error> {
    sqlx::query_as::<_, ShipmentBatchRow>(
        r#"
        SELECT
            b.id,
            b.batch_type,
            b.status,
            b.carrier_account,
            b.shipment_date,
            b.requested_start_time,
            b.requested_end_time,
            b.building_location_type,
            b.building_type,
            b.instructions,
            b.shippo_manifest_object_id,
            b.shippo_pickup_object_id,
            b.confirmation_code,
            b.document_url,
            b.created_by_staff_id,
            b.created_at,
            b.updated_at,
            COUNT(bs.shipment_id)::bigint AS shipment_count
        FROM shipment_batch b
        LEFT JOIN shipment_batch_shipment bs ON bs.batch_id = b.id
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(pool)
    .await
}

#[derive(Debug, sqlx::FromRow)]
struct BatchShipmentSourceRow {
    id: Uuid,
    shippo_transaction_object_id: String,
    shippo_carrier_account_object_id: String,
}

async fn batch_source_rows(
    pool: &PgPool,
    shipment_ids: &[Uuid],
    carrier_account_override: Option<&str>,
) -> Result<(String, Vec<BatchShipmentSourceRow>), ShipmentError> {
    if shipment_ids.is_empty() {
        return Err(ShipmentError::InvalidPayload(
            "select at least one shipment".into(),
        ));
    }
    let rows = sqlx::query_as::<_, BatchShipmentSourceRow>(
        r#"
        SELECT
            id,
            shippo_transaction_object_id,
            shippo_carrier_account_object_id
        FROM shipment
        WHERE id = ANY($1)
          AND status IN ('label_purchased'::shipment_status, 'in_transit'::shipment_status)
          AND NULLIF(btrim(shippo_transaction_object_id), '') IS NOT NULL
          AND NULLIF(btrim(shippo_carrier_account_object_id), '') IS NOT NULL
        "#,
    )
    .bind(shipment_ids)
    .fetch_all(pool)
    .await?;
    if rows.len() != shipment_ids.len() {
        return Err(ShipmentError::InvalidPayload(
            "all selected shipments need purchased labels and carrier accounts".into(),
        ));
    }

    let carrier_account = carrier_account_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| rows[0].shippo_carrier_account_object_id.clone());
    if rows
        .iter()
        .any(|row| row.shippo_carrier_account_object_id != carrier_account)
    {
        return Err(ShipmentError::InvalidPayload(
            "selected shipments must use the same carrier account".into(),
        ));
    }
    Ok((carrier_account, rows))
}

pub async fn create_manifest_batch(
    pool: &PgPool,
    http: &reqwest::Client,
    body: CreateManifestBody,
    staff_id: Uuid,
) -> Result<ShipmentBatchRow, ShipmentError> {
    let (carrier_account, rows) =
        batch_source_rows(pool, &body.shipment_ids, body.carrier_account.as_deref()).await?;
    let eff = shippo::load_effective_shippo_config(pool).await?;
    let shipment_date = body
        .shipment_date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let transactions = rows
        .iter()
        .map(|row| row.shippo_transaction_object_id.clone())
        .collect::<Vec<_>>();
    let result = shippo::create_manifest(
        http,
        &carrier_account,
        &shipment_date,
        &transactions,
        &eff.store.from_address,
    )
    .await?;
    let batch_status = normalize_shippo_batch_status(result.status.as_deref());

    let mut tx = pool.begin().await?;
    let batch_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shipment_batch (
            batch_type, status, carrier_account, shipment_date,
            shippo_manifest_object_id, document_url, raw_response, created_by_staff_id
        )
        VALUES ('manifest', $1, $2, $3::timestamptz, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(&batch_status)
    .bind(&carrier_account)
    .bind(&shipment_date)
    .bind(&result.object_id)
    .bind(&result.document_url)
    .bind(Json(result.raw_response.clone()))
    .bind(staff_id)
    .fetch_one(&mut *tx)
    .await?;

    for row in rows {
        sqlx::query(
            r#"
            INSERT INTO shipment_batch_shipment (batch_id, shipment_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(batch_id)
        .bind(row.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            UPDATE shipment
            SET shippo_manifest_object_id = COALESCE($2, shippo_manifest_object_id),
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(row.id)
        .bind(&result.object_id)
        .execute(&mut *tx)
        .await?;
        append_event_tx(
            &mut tx,
            row.id,
            "manifest_created",
            "Shipment included in Shippo manifest.",
            json!({
                "shipment_batch_id": batch_id.to_string(),
                "shippo_manifest_object_id": result.object_id,
                "document_url": result.document_url
            }),
            Some(staff_id),
        )
        .await?;
    }
    tx.commit().await?;
    get_batch(pool, batch_id).await
}

pub async fn create_pickup_batch(
    pool: &PgPool,
    http: &reqwest::Client,
    body: CreatePickupBody,
    staff_id: Uuid,
) -> Result<ShipmentBatchRow, ShipmentError> {
    let (carrier_account, rows) =
        batch_source_rows(pool, &body.shipment_ids, body.carrier_account.as_deref()).await?;
    let eff = shippo::load_effective_shippo_config(pool).await?;
    let pickup = PickupLocationInput {
        requested_start_time: body.requested_start_time.clone(),
        requested_end_time: body.requested_end_time.clone(),
        building_location_type: body.building_location_type.clone(),
        building_type: body.building_type.clone(),
        instructions: body.instructions.clone(),
    };
    let transactions = rows
        .iter()
        .map(|row| row.shippo_transaction_object_id.clone())
        .collect::<Vec<_>>();
    let result = shippo::create_pickup(
        http,
        &carrier_account,
        &transactions,
        &eff.store.from_address,
        &pickup,
    )
    .await?;
    let batch_status = normalize_shippo_batch_status(result.status.as_deref());

    let mut tx = pool.begin().await?;
    let batch_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shipment_batch (
            batch_type, status, carrier_account, requested_start_time, requested_end_time,
            building_location_type, building_type, instructions,
            shippo_pickup_object_id, confirmation_code, raw_response, created_by_staff_id
        )
        VALUES ('pickup', $1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
        "#,
    )
    .bind(&batch_status)
    .bind(&carrier_account)
    .bind(&body.requested_start_time)
    .bind(&body.requested_end_time)
    .bind(&body.building_location_type)
    .bind(&body.building_type)
    .bind(&body.instructions)
    .bind(&result.object_id)
    .bind(&result.confirmation_code)
    .bind(Json(result.raw_response.clone()))
    .bind(staff_id)
    .fetch_one(&mut *tx)
    .await?;

    for row in rows {
        sqlx::query(
            r#"
            INSERT INTO shipment_batch_shipment (batch_id, shipment_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(batch_id)
        .bind(row.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            UPDATE shipment
            SET shippo_pickup_object_id = COALESCE($2, shippo_pickup_object_id),
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(row.id)
        .bind(&result.object_id)
        .execute(&mut *tx)
        .await?;
        append_event_tx(
            &mut tx,
            row.id,
            "pickup_scheduled",
            "Shipment included in Shippo pickup request.",
            json!({
                "shipment_batch_id": batch_id.to_string(),
                "shippo_pickup_object_id": result.object_id,
                "confirmation_code": result.confirmation_code
            }),
            Some(staff_id),
        )
        .await?;
    }
    tx.commit().await?;
    get_batch(pool, batch_id).await
}

async fn get_batch(pool: &PgPool, batch_id: Uuid) -> Result<ShipmentBatchRow, ShipmentError> {
    sqlx::query_as::<_, ShipmentBatchRow>(
        r#"
        SELECT
            b.id,
            b.batch_type,
            b.status,
            b.carrier_account,
            b.shipment_date,
            b.requested_start_time,
            b.requested_end_time,
            b.building_location_type,
            b.building_type,
            b.instructions,
            b.shippo_manifest_object_id,
            b.shippo_pickup_object_id,
            b.confirmation_code,
            b.document_url,
            b.created_by_staff_id,
            b.created_at,
            b.updated_at,
            COUNT(bs.shipment_id)::bigint AS shipment_count
        FROM shipment_batch b
        LEFT JOIN shipment_batch_shipment bs ON bs.batch_id = b.id
        WHERE b.id = $1
        GROUP BY b.id
        "#,
    )
    .bind(batch_id)
    .fetch_one(pool)
    .await
    .map_err(ShipmentError::Database)
}

fn normalize_shippo_batch_status(status: Option<&str>) -> String {
    match status
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("queued") => "queued".to_string(),
        Some("success") => "success".to_string(),
        Some("error") => "error".to_string(),
        Some("confirmed") => "confirmed".to_string(),
        Some("cancelled") | Some("canceled") => "cancelled".to_string(),
        _ => "created".to_string(),
    }
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
            crate::logic::commission_events::upsert_fulfilled_transaction_events(&mut tx, oid, &[])
                .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}
