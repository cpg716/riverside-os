//! Wedding API SQL: party list, members, activity, actions, ledger, appointments.

use meilisearch_sdk::client::Client as MeilisearchClient;
use rust_decimal::Decimal;
use sqlx::{PgPool, QueryBuilder};
use uuid::Uuid;

use crate::logic::wedding_api_types::{
    ActionRow, ActivityFeedRow, AppointmentRow, PartyListQuery, SuitSelectionStat, WeddingActions,
    WeddingLedgerLine, WeddingLedgerResponse, WeddingLedgerSummary, WeddingMemberApi,
    WeddingMemberFinancialRow, WeddingPartyAnalytics, WeddingPartyFinancialContext,
    WeddingPartyRow,
};
use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;

pub fn digits_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn party_select_sql() -> &'static str {
    r#"
        SELECT
            wp.id,
            wp.party_name,
            wp.groom_name,
            wp.event_date,
            wp.venue,
            wp.notes,
            wp.party_type,
            wp.sign_up_date,
            wp.salesperson,
            wp.style_info,
            wp.price_info,
            wp.groom_phone,
            wp.groom_email,
            wp.bride_name,
            wp.bride_phone,
            wp.bride_email,
            wp.accessories,
            wp.groom_phone_clean,
            wp.bride_phone_clean,
            wp.is_deleted,
            wp.suit_variant_id,
            CASE WHEN wp.suit_variant_id IS NULL THEN NULL
                 WHEN EXISTS(SELECT 1 FROM product_variants pv JOIN products p ON pv.product_id = p.id WHERE pv.id = wp.suit_variant_id AND p.is_active = TRUE) THEN TRUE
                 ELSE FALSE
            END AS suit_inventory_verified
        FROM wedding_parties wp
    "#
}

pub async fn load_members_for_party(
    pool: &PgPool,
    party_id: uuid::Uuid,
) -> Result<Vec<WeddingMemberApi>, sqlx::Error> {
    sqlx::query_as::<_, WeddingMemberApi>(
        r#"
        SELECT
            wm.id,
            wm.wedding_party_id,
            wm.customer_id,
            c.first_name,
            c.last_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            wm.role,
            wm.status,
            wm.transaction_id,
            wm.notes,
            wm.member_index,
            wm.oot,
            wm.suit,
            wm.waist,
            wm.vest,
            wm.shirt,
            wm.shoe,
            wm.measured,
            wm.suit_ordered,
            wm.received,
            wm.fitting,
            wm.pickup_status,
            wm.measure_date,
            wm.ordered_date,
            wm.received_date,
            wm.fitting_date,
            wm.pickup_date,
            wm.ordered_items,
            wm.member_accessories,
            wm.contact_history,
            wm.pin_note,
            wm.ordered_po,
            wm.stock_info,
            wm.suit_variant_id,
            wm.is_free_suit_promo,
            wm.customer_verified,
            wm.import_customer_name,
            wm.import_customer_phone
        FROM wedding_members wm
        JOIN customers c ON c.id = wm.customer_id
        WHERE wm.wedding_party_id = $1
        ORDER BY wm.member_index ASC, wm.created_at ASC
        "#,
    )
    .bind(party_id)
    .fetch_all(pool)
    .await
}

pub async fn fetch_party_row_optional(
    pool: &PgPool,
    party_id: uuid::Uuid,
) -> Result<Option<WeddingPartyRow>, sqlx::Error> {
    sqlx::query_as(&format!("{} WHERE wp.id = $1", party_select_sql()))
        .bind(party_id)
        .fetch_optional(pool)
        .await
}

/// Returns `(party_rows, total_count, page, limit)`.
pub async fn query_party_list_page(
    pool: &PgPool,
    q: &PartyListQuery,
    meilisearch: Option<&MeilisearchClient>,
) -> Result<(Vec<WeddingPartyRow>, i64, i64, i64), sqlx::Error> {
    let page = q.page.unwrap_or(1).max(1);
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * limit;

    let search = q.search.as_deref().unwrap_or("").trim().to_string();
    let search_pat = if search.is_empty() {
        None
    } else {
        Some(format!("%{search}%"))
    };
    let digits = digits_only(&search);
    let phone_pat = if digits.len() >= 2 {
        Some(format!("%{digits}%"))
    } else {
        None
    };

    let meili_party_ids: Option<Vec<Uuid>> = if search_pat.is_some() {
        if let Some(c) = meilisearch {
            if !search.is_empty() {
                match crate::logic::meilisearch_search::wedding_party_search_ids(
                    c,
                    &search,
                    q.show_deleted,
                )
                .await
                {
                    Ok(ids) => Some(ids),
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "Meilisearch wedding party search failed; using PostgreSQL ILIKE"
                        );
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let mut count_qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new(
        "SELECT COUNT(DISTINCT wp.id) FROM wedding_parties wp \
         LEFT JOIN wedding_members wm ON wm.wedding_party_id = wp.id \
         LEFT JOIN customers c ON c.id = wm.customer_id WHERE 1=1 ",
    );

    if q.show_deleted {
        count_qb.push(" AND wp.is_deleted = TRUE ");
    } else {
        count_qb.push(" AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE) ");
    }
    if let Some(sd) = q.start_date {
        count_qb.push(" AND wp.event_date >= ");
        count_qb.push_bind(sd);
    }
    if let Some(ed) = q.end_date {
        count_qb.push(" AND wp.event_date <= ");
        count_qb.push_bind(ed);
    }
    if let Some(ref sp) = q.salesperson {
        let sp = sp.trim();
        if !sp.is_empty() {
            count_qb.push(" AND wp.salesperson = ");
            count_qb.push_bind(sp.to_string());
        }
    }
    if let Some(ref ids) = meili_party_ids {
        if ids.is_empty() {
            count_qb.push(" AND FALSE ");
        } else {
            count_qb.push(" AND wp.id = ANY(");
            count_qb.push_bind(ids.clone());
            count_qb.push(") ");
        }
    } else if let Some(ref pat) = search_pat {
        count_qb.push(" AND (wp.party_name ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR wp.groom_name ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR wp.notes ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR wp.groom_email ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR wp.bride_name ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR wp.bride_email ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR c.first_name ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb.push(" OR c.last_name ILIKE ");
        count_qb.push_bind(pat.clone());
        count_qb
            .push(" OR CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) ILIKE ");
        count_qb.push_bind(pat.clone());
        if let Some(ref ph) = phone_pat {
            count_qb
                .push(" OR regexp_replace(COALESCE(wp.groom_phone,''), '[^0-9]', '', 'g') LIKE ");
            count_qb.push_bind(ph.clone());
            count_qb
                .push(" OR regexp_replace(COALESCE(wp.bride_phone,''), '[^0-9]', '', 'g') LIKE ");
            count_qb.push_bind(ph.clone());
            count_qb.push(" OR regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') LIKE ");
            count_qb.push_bind(ph.clone());
        }
        count_qb.push(") ");
    }

    let total: i64 = count_qb.build_query_scalar().fetch_one(pool).await?;

    let mut data_qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new(party_select_sql());
    data_qb.push(" LEFT JOIN wedding_members wm ON wm.wedding_party_id = wp.id ");
    data_qb.push(" LEFT JOIN customers c ON c.id = wm.customer_id WHERE 1=1 ");

    if q.show_deleted {
        data_qb.push(" AND wp.is_deleted = TRUE ");
    } else {
        data_qb.push(" AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE) ");
    }
    if let Some(sd) = q.start_date {
        data_qb.push(" AND wp.event_date >= ");
        data_qb.push_bind(sd);
    }
    if let Some(ed) = q.end_date {
        data_qb.push(" AND wp.event_date <= ");
        data_qb.push_bind(ed);
    }
    if let Some(ref sp) = q.salesperson {
        let sp = sp.trim();
        if !sp.is_empty() {
            data_qb.push(" AND wp.salesperson = ");
            data_qb.push_bind(sp.to_string());
        }
    }
    if let Some(ref ids) = meili_party_ids {
        if ids.is_empty() {
            data_qb.push(" AND FALSE ");
        } else {
            data_qb.push(" AND wp.id = ANY(");
            data_qb.push_bind(ids.clone());
            data_qb.push(") ");
        }
    } else if let Some(ref pat) = search_pat {
        data_qb.push(" AND (wp.party_name ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR wp.groom_name ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR wp.notes ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR wp.groom_email ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR wp.bride_name ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR wp.bride_email ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR c.first_name ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR c.last_name ILIKE ");
        data_qb.push_bind(pat.clone());
        data_qb.push(" OR CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) ILIKE ");
        data_qb.push_bind(pat.clone());
        if let Some(ref ph) = phone_pat {
            data_qb
                .push(" OR regexp_replace(COALESCE(wp.groom_phone,''), '[^0-9]', '', 'g') LIKE ");
            data_qb.push_bind(ph.clone());
            data_qb
                .push(" OR regexp_replace(COALESCE(wp.bride_phone,''), '[^0-9]', '', 'g') LIKE ");
            data_qb.push_bind(ph.clone());
            data_qb.push(" OR regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') LIKE ");
            data_qb.push_bind(ph.clone());
        }
        data_qb.push(") ");
    }

    data_qb.push(
        " GROUP BY wp.id, wp.party_name, wp.groom_name, wp.event_date, wp.venue, wp.notes, \
        wp.party_type, wp.sign_up_date, wp.salesperson, wp.style_info, wp.price_info, \
        wp.groom_phone, wp.groom_email, wp.bride_name, wp.bride_phone, wp.bride_email, \
        wp.accessories, wp.groom_phone_clean, wp.bride_phone_clean, wp.is_deleted ",
    );
    data_qb.push(" ORDER BY wp.event_date ASC ");
    data_qb.push(" LIMIT ");
    data_qb.push_bind(limit);
    data_qb.push(" OFFSET ");
    data_qb.push_bind(offset);

    let parties: Vec<WeddingPartyRow> = data_qb.build_query_as().fetch_all(pool).await?;

    Ok((parties, total, page, limit))
}

pub async fn query_activity_feed(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<ActivityFeedRow>, sqlx::Error> {
    sqlx::query_as::<_, ActivityFeedRow>(&format!(
        r#"
        SELECT
            l.id,
            l.actor_name,
            l.action_type,
            l.description,
            l.created_at,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            NULLIF(
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')),
                ''
            ) AS member_name
        FROM wedding_activity_log l
        JOIN wedding_parties wp ON l.wedding_party_id = wp.id
        LEFT JOIN wedding_members wm ON l.wedding_member_id = wm.id
        LEFT JOIN customers c ON wm.customer_id = c.id
        ORDER BY l.created_at DESC
        LIMIT $1 OFFSET $2
        "#
    ))
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn query_wedding_actions(
    pool: &PgPool,
    day_window: i64,
) -> Result<WeddingActions, sqlx::Error> {
    let needs_measure = sqlx::query_as::<_, ActionRow>(&format!(
        r#"
        SELECT
            wp.id AS wedding_party_id,
            wm.id AS wedding_member_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.role,
            wm.status,
            wp.event_date,
            COALESCE((
                SELECT SUM(o.balance_due)
                FROM transactions o
                JOIN wedding_members wm2 ON wm2.id = o.wedding_member_id
                WHERE wm2.wedding_party_id = wp.id
            ), 0)::numeric AS party_balance_due
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        LEFT JOIN customer_measurements cm ON cm.customer_id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date <= (CURRENT_DATE + make_interval(days => $1::int))
          AND cm.customer_id IS NULL
          AND wm.measured IS NOT TRUE
        ORDER BY wp.event_date ASC, customer_name ASC
        "#
    ))
    .bind(day_window as i32)
    .fetch_all(pool)
    .await?;

    let needs_order = sqlx::query_as::<_, ActionRow>(&format!(
        r#"
        SELECT
            wp.id AS wedding_party_id,
            wm.id AS wedding_member_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.role,
            wm.status,
            wp.event_date,
            COALESCE((
                SELECT SUM(o2.balance_due)
                FROM transactions o2
                JOIN wedding_members wm2 ON wm2.id = o2.wedding_member_id
                WHERE wm2.wedding_party_id = wp.id
            ), 0)::numeric AS party_balance_due
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        LEFT JOIN customer_measurements cm ON cm.customer_id = wm.customer_id
        LEFT JOIN transactions o ON o.wedding_member_id = wm.id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date <= (CURRENT_DATE + make_interval(days => $1::int))
          AND (cm.customer_id IS NOT NULL OR wm.measured = TRUE)
          AND o.id IS NULL
        ORDER BY wp.event_date ASC, customer_name ASC
        "#
    ))
    .bind(day_window as i32)
    .fetch_all(pool)
    .await?;

    Ok(WeddingActions {
        needs_measure,
        needs_order,
    })
}

pub async fn try_load_party_ledger(
    pool: &PgPool,
    party_id: uuid::Uuid,
) -> Result<Option<WeddingLedgerResponse>, sqlx::Error> {
    let party_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
            .bind(party_id)
            .fetch_one(pool)
            .await?;
    if !party_exists {
        return Ok(None);
    }

    let summary = sqlx::query_as::<_, WeddingLedgerSummary>(
        r#"
        SELECT
            $1::uuid AS wedding_party_id,
            COALESCE((
                SELECT SUM(o.total_price)
                FROM transactions o
                JOIN wedding_members wm ON wm.id = o.wedding_member_id
                WHERE wm.wedding_party_id = $1
            ), 0) AS total_order_value,
            COALESCE((
                SELECT SUM(pt.amount)
                FROM payment_transactions pt
                JOIN wedding_members wm ON wm.id = pt.wedding_member_id
                WHERE wm.wedding_party_id = $1
            ), 0) AS total_paid,
            COALESCE((
                SELECT SUM(o.balance_due)
                FROM transactions o
                JOIN wedding_members wm ON wm.id = o.wedding_member_id
                WHERE wm.wedding_party_id = $1
            ), 0) AS balance_due
        "#,
    )
    .bind(party_id)
    .fetch_one(pool)
    .await?;

    let lines = sqlx::query_as::<_, WeddingLedgerLine>(
        r#"
        SELECT
            o.id AS transaction_id,
            NULL::uuid AS payment_tx_id,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.id AS wedding_member_id,
            'order'::text AS kind,
            o.total_price AS amount,
            o.booked_at AS created_at,
            (
                SELECT CASE
                    WHEN NOT EXISTS (SELECT 1 FROM transaction_lines oi2 WHERE oi2.transaction_id = o.id) THEN NULL::text
                    WHEN NOT EXISTS (
                        SELECT 1 FROM transaction_lines oi2
                        WHERE oi2.transaction_id = o.id AND oi2.fulfillment::text <> 'takeaway'
                    ) THEN 'takeaway'
                    WHEN EXISTS (
                        SELECT 1 FROM transaction_lines oi2
                        WHERE oi2.transaction_id = o.id AND oi2.fulfillment::text = 'takeaway'
                    ) AND EXISTS (
                        SELECT 1 FROM transaction_lines oi2
                        WHERE oi2.transaction_id = o.id AND oi2.fulfillment::text <> 'takeaway'
                    ) THEN 'mixed'
                    WHEN (
                        SELECT COUNT(DISTINCT oi2.fulfillment)
                        FROM transaction_lines oi2
                        WHERE oi2.transaction_id = o.id AND oi2.fulfillment::text <> 'takeaway'
                    ) > 1 THEN 'mixed'
                    WHEN EXISTS (
                        SELECT 1 FROM transaction_lines oi2
                        WHERE oi2.transaction_id = o.id AND oi2.fulfillment::text = 'wedding_order'
                    ) THEN 'wedding_order'
                    WHEN EXISTS (
                        SELECT 1 FROM transaction_lines oi2
                        WHERE oi2.transaction_id = o.id AND oi2.fulfillment::text IN ('special_order', 'custom')
                    ) THEN 'special_order'
                    ELSE 'other'
                END
            ) AS fulfillment_profile
        FROM transactions o
        JOIN wedding_members wm ON wm.id = o.wedding_member_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE wm.wedding_party_id = $1

        UNION ALL

        SELECT
            NULL::uuid AS transaction_id,
            pt.id AS payment_tx_id,
            'Group Payout'::text AS customer_name,
            pa.target_transaction_id AS wedding_member_id,
            'payment'::text AS kind,
            pa.amount_allocated AS amount,
            pt.created_at AS created_at,
            NULL::text AS fulfillment_profile
        FROM payment_allocations pa
        JOIN payment_transactions pt ON pt.id = pa.transaction_id
        JOIN transactions o ON o.id = pa.target_transaction_id
        JOIN wedding_members wm ON wm.id = o.wedding_member_id
        WHERE wm.wedding_party_id = $1
          AND pa.metadata->>'kind' = 'wedding_group_disbursement'

        UNION ALL

        SELECT
            NULL::uuid AS transaction_id,
            pt.id AS payment_tx_id,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.id AS wedding_member_id,
            'payment'::text AS kind,
            pt.amount AS amount,
            pt.created_at AS created_at,
            NULL::text AS fulfillment_profile
        FROM payment_transactions pt
        JOIN wedding_members wm ON wm.id = pt.wedding_member_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE wm.wedding_party_id = $1
          AND pt.id NOT IN (
              SELECT transaction_id FROM payment_allocations WHERE metadata->>'kind' = 'wedding_group_disbursement'
          )
        ORDER BY created_at DESC
        "#,
    )
    .bind(party_id)
    .fetch_all(pool)
    .await?;

    Ok(Some(WeddingLedgerResponse { summary, lines }))
}

pub async fn try_load_party_financial_context(
    pool: &PgPool,
    party_id: uuid::Uuid,
) -> Result<Option<WeddingPartyFinancialContext>, sqlx::Error> {
    let Some(ledger) = try_load_party_ledger(pool, party_id).await? else {
        return Ok(None);
    };

    let members = sqlx::query_as::<_, WeddingMemberFinancialRow>(
        r#"
        SELECT
            wm.id AS wedding_member_id,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            COALESCE((SELECT COUNT(*) FROM transactions o WHERE o.wedding_member_id = wm.id), 0) AS order_count,
            COALESCE((SELECT COUNT(*) FROM payment_transactions pt WHERE pt.wedding_member_id = wm.id), 0) AS payment_count,
            COALESCE((SELECT SUM(o.total_price) FROM transactions o WHERE o.wedding_member_id = wm.id), 0) AS order_total,
            COALESCE((SELECT SUM(pt.amount) FROM payment_transactions pt WHERE pt.wedding_member_id = wm.id), 0) AS paid_total,
            COALESCE((SELECT SUM(o.balance_due) FROM transactions o WHERE o.wedding_member_id = wm.id), 0) AS balance_due,
            wm.is_free_suit_promo
        FROM wedding_members wm
        JOIN customers c ON c.id = wm.customer_id
        WHERE wm.wedding_party_id = $1
        GROUP BY wm.id, c.first_name, c.last_name, wm.is_free_suit_promo
        ORDER BY customer_name ASC
        "#,
    )
    .bind(party_id)
    .fetch_all(pool)
    .await?;

    let WeddingLedgerResponse { summary, lines } = ledger;

    // Analytics: Profit, Margin, Promo
    let econ = sqlx::query_as::<_, (Decimal, Decimal, Decimal, Decimal, i32, i32)>(
        r#"
        SELECT
            total_profit,
            total_cost,
            total_revenue,
            margin_percent,
            free_suits_marked,
            -- Qualification Count: Number of members in this party who have an order with a suit fulfillment
            -- used as a proxy for the "5 suits" buy-in.
            (
              SELECT COUNT(DISTINCT wm2.id)::int
              FROM wedding_members wm2
              JOIN transactions o2 ON o2.wedding_member_id = wm2.id
              JOIN transaction_lines oi2 ON oi2.transaction_id = o2.id
              WHERE wm2.wedding_party_id = $1
                AND o2.status <> 'cancelled'
                AND oi2.fulfillment::text = 'wedding_order'
            ) AS qualification_count
        FROM reporting.wedding_party_economics
        WHERE wedding_party_id = $1
        "#
    )
    .bind(party_id)
    .fetch_optional(pool)
    .await?;

    let (profit, cost, rev, margin, free_marked, qual_count) = econ.unwrap_or((
        Decimal::ZERO,
        Decimal::ZERO,
        Decimal::ZERO,
        Decimal::ZERO,
        0,
        0,
    ));

    // Common Suits
    let common_suits = sqlx::query_as::<_, SuitSelectionStat>(
        r#"
        SELECT
            wm.suit_variant_id AS variant_id,
            p.name AS product_name,
            pv.variation_label,
            COUNT(*) AS count
        FROM wedding_members wm
        LEFT JOIN product_variants pv ON pv.id = wm.suit_variant_id
        LEFT JOIN products p ON p.id = pv.product_id
        WHERE wm.wedding_party_id = $1
          AND wm.suit_variant_id IS NOT NULL
        GROUP BY wm.suit_variant_id, p.name, pv.variation_label
        ORDER BY count DESC
        "#,
    )
    .bind(party_id)
    .fetch_all(pool)
    .await?;

    Ok(Some(WeddingPartyFinancialContext {
        summary,
        lines,
        members,
        analytics: WeddingPartyAnalytics {
            total_profit: profit,
            total_cost: cost,
            total_revenue: rev,
            average_margin: margin,
            free_suits_marked: free_marked,
            qualification_count: qual_count,
            common_suits,
        },
    }))
}

pub async fn fetch_member_optional(
    pool: &PgPool,
    member_id: uuid::Uuid,
) -> Result<Option<WeddingMemberApi>, sqlx::Error> {
    sqlx::query_as::<_, WeddingMemberApi>(
        r#"
        SELECT
            wm.id,
            wm.wedding_party_id,
            wm.customer_id,
            c.first_name,
            c.last_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            wm.role,
            wm.status,
            wm.transaction_id,
            wm.notes,
            wm.member_index,
            wm.oot,
            wm.suit,
            wm.waist,
            wm.vest,
            wm.shirt,
            wm.shoe,
            wm.measured,
            wm.suit_ordered,
            wm.received,
            wm.fitting,
            wm.pickup_status,
            wm.measure_date,
            wm.ordered_date,
            wm.received_date,
            wm.fitting_date,
            wm.pickup_date,
            wm.ordered_items,
            wm.member_accessories,
            wm.contact_history,
            wm.pin_note,
            wm.ordered_po,
            wm.stock_info,
            wm.suit_variant_id,
            wm.is_free_suit_promo
        FROM wedding_members wm
        JOIN customers c ON c.id = wm.customer_id
        WHERE wm.id = $1
        "#,
    )
    .bind(member_id)
    .fetch_optional(pool)
    .await
}

pub async fn list_appointments_filtered(
    pool: &PgPool,
    from: Option<chrono::DateTime<chrono::Utc>>,
    to: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<Vec<AppointmentRow>, sqlx::Error> {
    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone, \
         appointment_type, starts_at, notes, status, salesperson \
         FROM wedding_appointments WHERE 1=1 ",
    );
    if let Some(from) = from {
        qb.push(" AND starts_at >= ").push_bind(from);
    }
    if let Some(to) = to {
        qb.push(" AND starts_at <= ").push_bind(to);
    }
    qb.push(" ORDER BY starts_at ASC ");

    qb.build_query_as::<AppointmentRow>().fetch_all(pool).await
}

pub async fn search_appointments_hybrid(
    pool: &PgPool,
    meili: Option<&MeilisearchClient>,
    q: &str,
    limit: i64,
) -> Result<Vec<AppointmentRow>, sqlx::Error> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let mut search_ids: Option<Vec<Uuid>> = None;
    if let Some(c) = meili {
        if let Ok(ids) = crate::logic::meilisearch_search::appointment_search_ids(c, q).await {
            search_ids = Some(ids);
        }
    }

    if let Some(ids) = search_ids {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let rows = sqlx::query_as::<_, AppointmentRow>(
            r#"
            SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
                   appointment_type, starts_at, notes, status, salesperson
            FROM UNNEST($1::uuid[]) WITH ORDINALITY AS t(id, ord)
            JOIN wedding_appointments wa ON wa.id = t.id
            ORDER BY t.ord
            LIMIT $2
            "#,
        )
        .bind(&ids)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    } else {
        let pat = format!("%{}%", q.to_lowercase());
        let rows = sqlx::query_as::<_, AppointmentRow>(
            r#"
            SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
                   appointment_type, starts_at, notes, status, salesperson
            FROM wedding_appointments
            WHERE (
                LOWER(customer_display_name) LIKE $1
                OR LOWER(notes) LIKE $1
                OR LOWER(salesperson) LIKE $1
                OR phone LIKE $1
            )
            ORDER BY starts_at DESC
            LIMIT $2
            "#,
        )
        .bind(pat)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}
