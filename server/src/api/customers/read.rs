// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::require_customer_perm_or_pos;
use super::CustomerError;
use crate::api::AppState;
use crate::auth::permissions::{
    CUSTOMERS_HUB_VIEW, CUSTOMERS_MEASUREMENTS, CUSTOMERS_TIMELINE, ORDERS_VIEW,
};
use crate::logic::customer_hub::{days_since_last_visit, fetch_hub_stats};
use crate::logic::customer_open_deposit;
use crate::logic::customer_transaction_history::{
    query_customer_transaction_history, CustomerTransactionHistoryQuery,
    CustomerTransactionHistoryResponse,
};
use crate::logic::customers::{is_profile_complete, ProfileFields};
use crate::logic::podium_messaging;
use crate::logic::store_credit;
use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerProfileRow {
    pub id: Uuid,
    pub customer_code: String,
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
    pub date_of_birth: Option<chrono::NaiveDate>,
    pub anniversary_date: Option<chrono::NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: bool,
    pub marketing_sms_opt_in: bool,
    pub transactional_sms_opt_in: bool,
    pub transactional_email_opt_in: bool,
    pub podium_conversation_url: Option<String>,
    pub is_vip: bool,
    pub loyalty_points: i32,
    pub customer_created_source: String,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
    pub couple_linked_at: Option<DateTime<Utc>>,
    pub open_balance_due: Decimal,
    pub lifetime_sales: Decimal,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingMembershipRow {
    pub wedding_member_id: Uuid,
    pub wedding_party_id: Uuid,
    pub transaction_id: Option<Uuid>,
    pub party_name: String,
    pub event_date: chrono::NaiveDate,
    pub role: String,
    pub status: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
pub struct CustomerProfileResponse {
    #[serde(flatten)]
    pub customer: CustomerProfileRow,
    pub profile_complete: bool,
    pub weddings: Vec<WeddingMembershipRow>,
}

#[derive(Debug, Serialize)]
pub struct CustomerHubStats {
    pub lifetime_spend_usd: Decimal,
    pub balance_due_usd: Decimal,
    pub wedding_party_count: i64,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub days_since_last_visit: Option<i64>,
    pub marketing_needs_attention: bool,
    pub loyalty_points: i32,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CoupleMemberPreview {
    pub id: Uuid,
    pub first_name: String,
    pub last_name: String,
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CustomerHubResponse {
    #[serde(flatten)]
    pub customer: CustomerProfileRow,
    pub profile_complete: bool,
    pub weddings: Vec<WeddingMembershipRow>,
    pub stats: CustomerHubStats,
    pub partner: Option<CoupleMemberPreview>,
}

#[derive(Debug, Serialize)]
pub struct CustomerTimelineEvent {
    pub at: DateTime<Utc>,
    pub kind: String,
    pub summary: String,
    pub reference_id: Option<Uuid>,
    pub reference_type: Option<String>,
    pub wedding_party_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct CustomerTimelineResponse {
    pub events: Vec<CustomerTimelineEvent>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct MeasurementRecord {
    pub id: Uuid,
    pub neck: Option<Decimal>,
    pub sleeve: Option<Decimal>,
    pub chest: Option<Decimal>,
    pub waist: Option<Decimal>,
    pub seat: Option<Decimal>,
    pub inseam: Option<Decimal>,
    pub outseam: Option<Decimal>,
    pub shoulder: Option<Decimal>,
    #[sqlx(default)]
    pub retail_suit: Option<String>,
    #[sqlx(default)]
    pub retail_waist: Option<String>,
    #[sqlx(default)]
    pub retail_vest: Option<String>,
    #[sqlx(default)]
    pub retail_shirt: Option<String>,
    #[sqlx(default)]
    pub retail_shoe: Option<String>,
    pub measured_at: DateTime<Utc>,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct MeasurementVaultResponse {
    pub latest: Option<MeasurementRecord>,
    pub history: Vec<MeasurementRecord>,
}

#[derive(Debug, Deserialize)]
pub struct ListPodiumInboxQuery {
    pub limit: Option<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/podium/messaging-inbox", get(list_podium_messaging_inbox))
        .route("/{customer_id}/hub", get(get_customer_hub))
        .route("/{customer_id}/timeline", get(get_customer_timeline))
        .route(
            "/{customer_id}/transaction-history",
            get(get_customer_transaction_history),
        )
        .route(
            "/{customer_id}/measurements",
            get(get_customer_measurement_vault),
        )
        .route(
            "/{customer_id}/open-deposit",
            get(get_customer_open_deposit_summary),
        )
        .route(
            "/{customer_id}/store-credit",
            get(get_customer_store_credit_summary),
        )
        .route("/{customer_id}/profile", get(get_customer_profile))
        .route(
            "/{customer_id}/podium/messages",
            get(get_customer_podium_messages),
        )
        .route("/{customer_id}/weddings", get(list_customer_weddings))
        .route("/{customer_id}", get(get_customer))
}

pub async fn load_customer_profile_row(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<CustomerProfileRow, CustomerError> {
    let row = sqlx::query_as::<_, CustomerProfileRow>(
        r#"
        SELECT
            c.id, c.customer_code,
            COALESCE(c.first_name, '') AS first_name,
            COALESCE(c.last_name, '') AS last_name,
            c.company_name, c.email, c.phone,
            c.address_line1, c.address_line2, c.city, c.state, c.postal_code,
            c.date_of_birth, c.anniversary_date,
            c.custom_field_1, c.custom_field_2, c.custom_field_3, c.custom_field_4,
            c.marketing_email_opt_in, c.marketing_sms_opt_in, c.transactional_sms_opt_in,
            c.transactional_email_opt_in, c.podium_conversation_url,
            c.is_vip, c.loyalty_points, c.customer_created_source,
            c.couple_id, c.couple_primary_id, c.couple_linked_at,
            COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
            COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales
        FROM customers c
        LEFT JOIN LATERAL (
            SELECT 
                SUM(balance_due) FILTER (WHERE status = 'open'::order_status) AS balance_sum,
                SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales
            FROM transactions
            WHERE customer_id = c.id
        ) ob ON true
        WHERE c.id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?
    .ok_or(CustomerError::NotFound)?;
    Ok(row)
}

pub async fn list_wedding_rows(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Vec<WeddingMembershipRow>, sqlx::Error> {
    sqlx::query_as::<_, WeddingMembershipRow>(&format!(
        r#"
        SELECT
            wm.id AS wedding_member_id,
            wp.id AS wedding_party_id,
            wm.transaction_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            wp.event_date,
            wm.role,
            wm.status,
            (wp.event_date >= CURRENT_DATE) AS active
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        WHERE wm.customer_id = $1
          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
        ORDER BY wp.event_date DESC
        "#
    ))
    .bind(customer_id)
    .fetch_all(pool)
    .await
}

fn short_order_ref(id: Uuid) -> String {
    let s = id.simple().to_string();
    s.chars().take(8).collect()
}

#[derive(Debug, FromRow)]
struct OrderTimelineRow {
    id: Uuid,
    booked_at: DateTime<Utc>,
    items_summary: Option<String>,
}

#[derive(Debug, FromRow)]
struct PaymentTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    payment_method: String,
    amount: Decimal,
    category: String,
}

#[derive(Debug, FromRow)]
struct WeddingLogTimelineRow {
    created_at: DateTime<Utc>,
    description: String,
    action_type: String,
    wedding_party_id: Uuid,
    party_name: String,
}

#[derive(Debug, FromRow)]
struct NoteTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    body: String,
}

#[derive(Debug, FromRow)]
struct MeasTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ApptTimelineRow {
    id: Uuid,
    datetime: DateTime<Utc>,
    appt_type: String,
}

#[derive(Debug, FromRow)]
struct ShipmentTimelineRow {
    at: DateTime<Utc>,
    kind: String,
    message: String,
    shipment_id: Uuid,
    staff_name: Option<String>,
}

async fn build_customer_timeline(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Vec<CustomerTimelineEvent>, sqlx::Error> {
    let couple_id: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?;

    let orders = if let Some(cid) = couple_id {
        sqlx::query_as::<_, OrderTimelineRow>(
            r#"
            SELECT
                o.id,
                o.booked_at,
                STRING_AGG(
                    (oi.quantity::text || '× ' || COALESCE(p.product_name, 'Item')),
                    ', ' ORDER BY COALESCE(p.product_name, '')
                ) FILTER (WHERE oi.id IS NOT NULL) AS items_summary
            FROM transactions o
            LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND o.status != 'cancelled'::order_status
            GROUP BY o.id, o.booked_at
            ORDER BY o.booked_at DESC
            LIMIT 25
            "#,
        )
        .bind(cid)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, OrderTimelineRow>(
            r#"
            SELECT
                o.id,
                o.booked_at,
                STRING_AGG(
                    (oi.quantity::text || '× ' || COALESCE(p.product_name, 'Item')),
                    ', ' ORDER BY COALESCE(p.product_name, '')
                ) FILTER (WHERE oi.id IS NOT NULL) AS items_summary
            FROM transactions o
            LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id = $1
              AND o.status != 'cancelled'::order_status
            GROUP BY o.id, o.booked_at
            ORDER BY o.booked_at DESC
            LIMIT 25
            "#,
        )
        .bind(customer_id)
        .fetch_all(pool)
        .await?
    };

    let payments = if let Some(cid) = couple_id {
        sqlx::query_as::<_, PaymentTimelineRow>(
            r#"
            SELECT id, created_at, payment_method, amount, category::text AS category
            FROM payment_transactions
            WHERE payer_id IN (SELECT id FROM customers WHERE couple_id = $1)
            ORDER BY created_at DESC
            LIMIT 28
            "#,
        )
        .bind(cid)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, PaymentTimelineRow>(
            r#"
            SELECT id, created_at, payment_method, amount, category::text AS category
            FROM payment_transactions
            WHERE payer_id = $1
            ORDER BY created_at DESC
            LIMIT 28
            "#,
        )
        .bind(customer_id)
        .fetch_all(pool)
        .await?
    };

    let wedding_logs = sqlx::query_as::<_, WeddingLogTimelineRow>(&format!(
        r#"
        SELECT
            l.created_at,
            l.description,
            l.action_type,
            l.wedding_party_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name
        FROM wedding_activity_log l
        JOIN wedding_parties wp ON wp.id = l.wedding_party_id
        WHERE EXISTS (
            SELECT 1 FROM wedding_members wm
            WHERE wm.wedding_party_id = l.wedding_party_id
              AND wm.customer_id = $1
              AND (l.wedding_member_id IS NULL OR l.wedding_member_id = wm.id)
        )
          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
        ORDER BY l.created_at DESC
        LIMIT 35
        "#
    ))
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let notes = sqlx::query_as::<_, NoteTimelineRow>(
        r#"
        SELECT id, created_at, body
        FROM customer_timeline_notes
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 30
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let meas = sqlx::query_as::<_, MeasTimelineRow>(
        r#"
        SELECT id, created_at
        FROM measurements
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 18
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let appts = sqlx::query_as::<_, ApptTimelineRow>(
        r#"
        SELECT wa.id, wa.starts_at AS datetime, wa.appointment_type AS appt_type
        FROM wedding_appointments wa
        LEFT JOIN wedding_members wm ON wm.id = wa.wedding_member_id
        WHERE wa.customer_id = $1
           OR wm.customer_id = $1
        ORDER BY wa.starts_at DESC
        LIMIT 20
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let shipment_events = sqlx::query_as::<_, ShipmentTimelineRow>(
        r#"
        SELECT
            e.at,
            e.kind,
            e.message,
            s.id AS shipment_id,
            st.name AS staff_name
        FROM shipment_event e
        INNER JOIN shipment s ON s.id = e.shipment_id
        LEFT JOIN staff st ON st.id = e.staff_id
        WHERE s.customer_id = $1
        ORDER BY e.at DESC
        LIMIT 35
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let mut events: Vec<CustomerTimelineEvent> = Vec::new();

    for o in orders {
        let items = o.items_summary.unwrap_or_else(|| "Purchase".to_string());
        let d = o.booked_at.format("%m/%d/%y").to_string();
        events.push(CustomerTimelineEvent {
            at: o.booked_at,
            kind: "sale".to_string(),
            summary: format!(
                "{}: Purchased {} (Order · {})",
                d,
                items,
                short_order_ref(o.id)
            ),
            reference_id: Some(o.id),
            reference_type: Some("order".to_string()),
            wedding_party_id: None,
        });
    }

    for p in payments {
        events.push(CustomerTimelineEvent {
            at: p.created_at,
            kind: "payment".to_string(),
            summary: format!(
                "{}: Paid {} {} ({})",
                p.created_at.format("%m/%d/%y"),
                p.amount,
                p.payment_method,
                p.category
            ),
            reference_id: Some(p.id),
            reference_type: Some("payment".to_string()),
            wedding_party_id: None,
        });
    }

    for w in wedding_logs {
        let desc = w.description.trim();
        let summary = if desc.is_empty() {
            format!(
                "{}: {} — {}",
                w.created_at.format("%m/%d/%y"),
                w.party_name,
                w.action_type
            )
        } else {
            format!(
                "{}: {} — {}",
                w.created_at.format("%m/%d/%y"),
                w.party_name,
                desc
            )
        };
        events.push(CustomerTimelineEvent {
            at: w.created_at,
            kind: "wedding".to_string(),
            summary,
            reference_id: None,
            reference_type: Some("wedding_activity".to_string()),
            wedding_party_id: Some(w.wedding_party_id),
        });
    }

    for n in notes {
        events.push(CustomerTimelineEvent {
            at: n.created_at,
            kind: "note".to_string(),
            summary: format!("{}: {}", n.created_at.format("%m/%d/%y"), n.body),
            reference_id: Some(n.id),
            reference_type: Some("note".to_string()),
            wedding_party_id: None,
        });
    }

    for m in meas {
        events.push(CustomerTimelineEvent {
            at: m.created_at,
            kind: "measurement".to_string(),
            summary: format!(
                "{}: Body measurements recorded",
                m.created_at.format("%m/%d/%y")
            ),
            reference_id: Some(m.id),
            reference_type: Some("measurement".to_string()),
            wedding_party_id: None,
        });
    }

    for a in appts {
        events.push(CustomerTimelineEvent {
            at: a.datetime,
            kind: "appointment".to_string(),
            summary: format!(
                "{}: Scheduled {} appointment",
                a.datetime.format("%m/%d/%y"),
                a.appt_type
            ),
            reference_id: Some(a.id),
            reference_type: Some("appointment".to_string()),
            wedding_party_id: None,
        });
    }

    for se in shipment_events {
        let body = {
            let m = se.message.trim();
            if m.is_empty() {
                se.kind.replace('_', " ")
            } else {
                m.to_string()
            }
        };
        let staff_suffix = se
            .staff_name
            .as_deref()
            .map(|n| {
                let t = n.trim();
                if t.is_empty() {
                    String::new()
                } else {
                    format!(" · {t}")
                }
            })
            .unwrap_or_default();
        events.push(CustomerTimelineEvent {
            at: se.at,
            kind: "shipping".to_string(),
            summary: format!(
                "{}: Shipment {} — {}{}",
                se.at.format("%m/%d/%y"),
                short_order_ref(se.shipment_id),
                body,
                staff_suffix
            ),
            reference_id: Some(se.shipment_id),
            reference_type: Some("shipment".to_string()),
            wedding_party_id: None,
        });
    }

    events.sort_by(|a, b| b.at.cmp(&a.at));
    events.truncate(90);
    Ok(events)
}

pub async fn get_customer_timeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerTimelineResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_TIMELINE).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let events = build_customer_timeline(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(CustomerTimelineResponse { events }))
}

pub async fn get_customer_transaction_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Query(q): Query<CustomerTransactionHistoryQuery>,
) -> Result<Json<CustomerTransactionHistoryResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, ORDERS_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let body = query_customer_transaction_history(&state.db, customer_id, &q)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(body))
}

pub async fn get_customer_measurement_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<MeasurementVaultResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_MEASUREMENTS).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let block = sqlx::query_as::<_, MeasurementRecord>(
        r#"
        SELECT
            id,
            neck, sleeve, chest, waist, seat, inseam, outseam, shoulder,
            retail_suit, retail_waist, retail_vest, retail_shirt, retail_shoe,
            measured_at,
            'current_block'::text AS source
        FROM customer_measurements
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(&state.db)
    .await?;

    let history = sqlx::query_as::<_, MeasurementRecord>(
        r#"
        SELECT
            id,
            neck, sleeve, chest, waist, seat, inseam, outseam, shoulder,
            NULL::text AS retail_suit,
            NULL::text AS retail_waist,
            NULL::text AS retail_vest,
            NULL::text AS retail_shirt,
            NULL::text AS retail_shoe,
            created_at AS measured_at,
            'archive'::text AS source
        FROM measurements
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 40
        "#,
    )
    .bind(customer_id)
    .fetch_all(&state.db)
    .await?;

    let latest = block.or_else(|| history.first().cloned());

    Ok(Json(MeasurementVaultResponse { latest, history }))
}

pub async fn get_customer_open_deposit_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<customer_open_deposit::CustomerOpenDepositSummary>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let s = customer_open_deposit::fetch_summary(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(s))
}

pub async fn get_customer_store_credit_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<store_credit::StoreCreditSummary>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let s = store_credit::fetch_summary(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(s))
}

pub async fn get_customer_hub(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerHubResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let row = load_customer_profile_row(&state.db, customer_id).await?;

    let weddings = list_wedding_rows(&state.db, customer_id).await?;
    let hub = fetch_hub_stats(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;

    let profile_complete = is_profile_complete(ProfileFields {
        phone: row.phone.as_deref(),
        email: row.email.as_deref(),
    });

    let marketing_needs_attention =
        !row.marketing_email_opt_in && !row.marketing_sms_opt_in && !row.transactional_sms_opt_in;

    let partner = if let Some(cid) = row.couple_id {
        sqlx::query_as::<_, CoupleMemberPreview>(
            "SELECT id, first_name, last_name, email FROM customers WHERE couple_id = $1 AND id != $2"
        )
        .bind(cid)
        .bind(customer_id)
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };

    Ok(Json(CustomerHubResponse {
        stats: CustomerHubStats {
            lifetime_spend_usd: hub.lifetime_spend_usd,
            balance_due_usd: hub.balance_due_usd,
            wedding_party_count: hub.wedding_party_count,
            last_activity_at: hub.last_activity_at,
            days_since_last_visit: days_since_last_visit(hub.last_activity_at),
            marketing_needs_attention,
            loyalty_points: hub.loyalty_points,
        },
        customer: row,
        profile_complete,
        weddings,
        partner,
    }))
}

pub async fn get_customer_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerProfileResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    let weddings = list_wedding_rows(&state.db, customer_id).await?;
    let profile_complete = is_profile_complete(ProfileFields {
        phone: row.phone.as_deref(),
        email: row.email.as_deref(),
    });

    Ok(Json(CustomerProfileResponse {
        customer: row,
        profile_complete,
        weddings,
    }))
}

pub async fn get_customer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerProfileRow>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    Ok(Json(row))
}

pub async fn list_customer_weddings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<WeddingMembershipRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let rows = list_wedding_rows(&state.db, customer_id).await?;
    Ok(Json(rows))
}

pub async fn get_customer_podium_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<podium_messaging::PodiumMessageApiRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let rows = podium_messaging::list_messages_for_customer(&state.db, customer_id).await?;
    Ok(Json(rows))
}

pub async fn list_podium_messaging_inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListPodiumInboxQuery>,
) -> Result<Json<Vec<podium_messaging::PodiumInboxRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let rows = podium_messaging::list_messaging_inbox(&state.db, q.limit.unwrap_or(50)).await?;
    Ok(Json(rows))
}
