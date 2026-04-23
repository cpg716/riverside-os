//! Inbound Podium webhook → CRM conversation rows, customer match/create, optional welcome SMS.

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::auth::permissions::NOTIFICATIONS_VIEW;
use crate::logic::customers::{insert_customer, CustomerCreatedSource, InsertCustomerParams};
use crate::logic::notifications::staff_ids_with_permission;
use crate::logic::podium::{
    load_store_podium_config, normalize_phone_e164, send_podium_sms_message, PodiumTokenCache,
};
use crate::logic::podium_messaging;

fn extract_text(value: &Value, paths: &[&str]) -> Option<String> {
    for p in paths {
        if let Some(s) = value.pointer(p).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn extract_message_uid(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/uid",
            "/data/id",
            "/uid",
            "/id",
            "/message/uid",
            "/data/message/uid",
        ],
    )
}

fn extract_conversation_uid(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/conversationUid",
            "/conversationUid",
            "/data/conversation/uid",
            "/conversation/uid",
        ],
    )
}

fn extract_phone_raw(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/from/phoneNumber",
            "/data/phoneNumber",
            "/fromPhone",
            "/phoneNumber",
            "/data/contact/phoneNumber",
            "/sender/phoneNumber",
        ],
    )
}

fn extract_email_raw(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/from/email",
            "/data/email",
            "/fromEmail",
            "/email",
            "/data/contact/email",
            "/sender/email",
        ],
    )
}

fn detect_channel(value: &Value, has_phone: bool, has_email: bool) -> &'static str {
    let ch = extract_text(value, &["/channel", "/data/channel", "/type"]).unwrap_or_default();
    let c = ch.to_ascii_lowercase();
    if c.contains("email") || (!has_phone && has_email) {
        "email"
    } else {
        "sms"
    }
}

/// `true` when Podium indicates a staff/system outbound message (e.g. `message.sent`), not the customer.
fn podium_webhook_is_outbound(value: &Value) -> bool {
    let classify = |s: &str| -> Option<bool> {
        let l = s.to_ascii_lowercase();
        if l.contains("message.sent") || l == "sent" {
            return Some(true);
        }
        if l.contains("message.received") {
            return Some(false);
        }
        None
    };
    for ptr in [
        "/type",
        "/event",
        "/eventType",
        "/data/type",
        "/data/event",
        "/data/eventType",
    ] {
        if let Some(s) = value.pointer(ptr).and_then(|v| v.as_str()) {
            if let Some(out) = classify(s) {
                return out;
            }
        }
    }
    if let Some(s) = value
        .pointer("/data/items/0/sourceType")
        .and_then(|v| v.as_str())
    {
        match s.to_ascii_lowercase().as_str() {
            "outbound" => return true,
            "inbound" => return false,
            _ => {}
        }
    }
    for ptr in ["/data/direction", "/data/message/direction", "/direction"] {
        if let Some(s) = value.pointer(ptr).and_then(|v| v.as_str()) {
            match s.to_ascii_lowercase().as_str() {
                "outbound" => return true,
                "inbound" => return false,
                _ => {}
            }
        }
    }
    false
}

/// Display name for Podium Web / app senders (not ROS `staff` rows).
fn extract_podium_outbound_sender_name(value: &Value) -> Option<String> {
    let paths = [
        "/data/sender/name",
        "/data/sender/displayName",
        "/data/user/name",
        "/data/user/displayName",
        "/data/author/name",
        "/data/employee/name",
        "/data/agent/name",
        "/data/staffMember/name",
        "/data/staff/name",
        "/data/fromUser/name",
        "/data/createdBy/name",
        "/sender/name",
        "/data/message/sender/name",
    ];
    for p in paths {
        if let Some(s) = extract_text(value, &[p]) {
            let t = s.trim();
            if (2..=200).contains(&t.len()) {
                return Some(t.to_string());
            }
        }
    }
    if let (Some(a), Some(b)) = (
        extract_text(value, &["/data/sender/firstName"]),
        extract_text(value, &["/data/sender/lastName"]),
    ) {
        let n = format!("{} {}", a.trim(), b.trim()).trim().to_string();
        if n.len() >= 2 {
            return Some(n);
        }
    }
    None
}

async fn find_customer_by_phone(pool: &PgPool, e164: &str) -> Result<Option<Uuid>, sqlx::Error> {
    let digits: String = e164.chars().filter(|c| c.is_ascii_digit()).collect();
    let tail_rev: String = digits
        .chars()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if tail_rev.len() < 10 {
        return Ok(None);
    }
    sqlx::query_scalar(
        r#"
        SELECT id FROM customers
        WHERE phone IS NOT NULL
          AND length(trim(phone)) > 0
          AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || $1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(&tail_rev)
    .fetch_optional(pool)
    .await
}

async fn find_customer_by_email(pool: &PgPool, email: &str) -> Result<Option<Uuid>, sqlx::Error> {
    let e = email.trim().to_lowercase();
    if e.is_empty() {
        return Ok(None);
    }
    sqlx::query_scalar(
        r#"
        SELECT id FROM customers
        WHERE lower(trim(email)) = $1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(&e)
    .fetch_optional(pool)
    .await
}

async fn message_uid_exists(pool: &PgPool, uid: &str) -> Result<bool, sqlx::Error> {
    let v: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM podium_message WHERE podium_message_uid = $1)"#,
    )
    .bind(uid)
    .fetch_one(pool)
    .await?;
    Ok(v)
}

async fn insert_conversation_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    customer_id: Uuid,
    channel: &str,
    podium_uid: Option<String>,
    phone: Option<String>,
    email: Option<String>,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        INSERT INTO podium_conversation (
            customer_id, channel, podium_conversation_uid, contact_phone_e164, contact_email
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(channel)
    .bind(podium_uid.as_ref())
    .bind(phone.as_ref())
    .bind(email.as_ref())
    .fetch_one(&mut **tx)
    .await
}

async fn try_apply_name_capture(pool: &PgPool, customer_id: Uuid, body: &str) {
    let pending: Option<bool> =
        sqlx::query_scalar("SELECT podium_name_capture_pending FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    if pending != Some(true) {
        return;
    }

    let words: Vec<&str> = body
        .split_whitespace()
        .filter(|w| w.len() < 80)
        .take(6)
        .collect();
    if words.len() >= 2 {
        let first = words[0].trim();
        let last = words[1].trim();
        if first.len() >= 2 && last.len() >= 2 {
            let _ = sqlx::query(
                r#"
                UPDATE customers SET
                    first_name = $2,
                    last_name = $3,
                    podium_name_capture_pending = false
                WHERE id = $1
                "#,
            )
            .bind(customer_id)
            .bind(first)
            .bind(last)
            .execute(pool)
            .await;
        }
    }
}

fn truncate_body_preview(body: &str) -> String {
    let mut s = body.trim().to_string();
    if s.len() > 280 {
        s.truncate(280);
        s.push('…');
    }
    s
}

/// After `podium_webhook_delivery` ledger insert: thread rows + notification fan-out.
pub async fn ingest_from_webhook(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    value: &Value,
) {
    let body = match extract_text(
        value,
        &[
            "/body",
            "/text",
            "/data/body",
            "/message/body",
            "/data/message/body",
            "/data/text",
        ],
    ) {
        Some(b) => b,
        None => {
            tracing::debug!(target = "podium_inbound", event = "no_body_skipping_ingest");
            return;
        }
    };

    let is_outbound = podium_webhook_is_outbound(value);
    let podium_sender_name = if is_outbound {
        extract_podium_outbound_sender_name(value)
    } else {
        None
    };

    let phone_raw = extract_phone_raw(value);
    let email_raw = extract_email_raw(value);
    let e164 = phone_raw.as_deref().and_then(normalize_phone_e164);
    let email = email_raw
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    let channel = detect_channel(value, e164.is_some(), email.is_some());

    if e164.is_none() && email.is_none() {
        tracing::warn!(target = "podium_inbound", event = "no_contact_skipping");
        return;
    }

    let msg_uid = extract_message_uid(value);
    let conv_uid = extract_conversation_uid(value);

    if let Some(ref uid) = msg_uid {
        match message_uid_exists(pool, uid).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(e) => {
                tracing::error!(error = %e, "podium_inbound msg dedupe");
                return;
            }
        }
    }

    let mut customer_id: Option<Uuid> = None;
    let mut created_stub = false;

    if let Some(ref ph) = e164 {
        match find_customer_by_phone(pool, ph).await {
            Ok(c) => customer_id = c,
            Err(e) => {
                tracing::error!(error = %e, "find customer phone");
                return;
            }
        }
    }
    if customer_id.is_none() {
        if let Some(ref em) = email {
            match find_customer_by_email(pool, em).await {
                Ok(c) => customer_id = c,
                Err(e) => {
                    tracing::error!(error = %e, "find customer email");
                    return;
                }
            }
        }
    }

    if customer_id.is_none() && is_outbound {
        tracing::warn!(
            target = "podium_inbound",
            event = "outbound_no_matching_customer",
            uid = ?msg_uid,
            channel = %channel,
            "Skipping Podium outbound webhook: no matching customer by phone/email."
        );
        return;
    }

    if customer_id.is_none() {
        let phone_store = e164.clone().or_else(|| phone_raw.clone());
        let email_store = email.clone();
        match insert_customer(
            pool,
            InsertCustomerParams {
                customer_code: None,
                first_name: "New".into(),
                last_name: "Contact".into(),
                company_name: None,
                email: email_store.clone(),
                phone: phone_store.clone(),
                address_line1: None,
                address_line2: None,
                city: None,
                state: None,
                postal_code: None,
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: true,
                transactional_email_opt_in: email_store.is_some(),
                customer_created_source: CustomerCreatedSource::Podium,
            },
        )
        .await
        {
            Ok(id) => {
                customer_id = Some(id);
                created_stub = true;
                let _ = sqlx::query(
                    "UPDATE customers SET podium_name_capture_pending = true WHERE id = $1",
                )
                .bind(id)
                .execute(pool)
                .await;
            }
            Err(e) => {
                tracing::error!(error = %e, "insert podium stub customer");
                return;
            }
        }
    } else if let Some(cid) = customer_id {
        if !is_outbound {
            try_apply_name_capture(pool, cid, &body).await;
        }
    }

    let Some(cid) = customer_id else { return };

    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "podium_inbound tx begin");
            return;
        }
    };

    let conv_id = if let Some(ref cu) = conv_uid {
        let existing: Option<Uuid> = match sqlx::query_scalar(
            r#"SELECT id FROM podium_conversation WHERE podium_conversation_uid = $1"#,
        )
        .bind(cu)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "podium conversation lookup");
                let _ = tx.rollback().await;
                return;
            }
        };

        if let Some(id) = existing {
            if let Err(e) = sqlx::query(
                r#"UPDATE podium_conversation SET last_message_at = NOW(), customer_id = COALESCE(customer_id, $2) WHERE id = $1"#,
            )
            .bind(id)
            .bind(cid)
            .execute(&mut *tx)
            .await
            {
                tracing::error!(error = %e, "podium conversation touch");
                let _ = tx.rollback().await;
                return;
            }
            id
        } else {
            match insert_conversation_tx(
                &mut tx,
                cid,
                channel,
                Some(cu.clone()),
                e164.clone(),
                email.clone(),
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!(error = %e, "insert podium_conversation");
                    let _ = tx.rollback().await;
                    return;
                }
            }
        }
    } else {
        let existing: Option<Uuid> = match sqlx::query_scalar(
            r#"
            SELECT id FROM podium_conversation
            WHERE customer_id = $1 AND channel = $2
            ORDER BY last_message_at DESC
            LIMIT 1
            "#,
        )
        .bind(cid)
        .bind(channel)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "podium conversation by customer");
                let _ = tx.rollback().await;
                return;
            }
        };

        match existing {
            Some(id) => {
                if let Err(e) = sqlx::query(
                    r#"UPDATE podium_conversation SET last_message_at = NOW() WHERE id = $1"#,
                )
                .bind(id)
                .execute(&mut *tx)
                .await
                {
                    tracing::error!(error = %e, "podium conversation touch");
                    let _ = tx.rollback().await;
                    return;
                }
                id
            }
            None => match insert_conversation_tx(
                &mut tx,
                cid,
                channel,
                None,
                e164.clone(),
                email.clone(),
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!(error = %e, "insert podium_conversation");
                    let _ = tx.rollback().await;
                    return;
                }
            },
        }
    };

    let msg_direction = if is_outbound { "outbound" } else { "inbound" };

    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, podium_message_uid, raw_payload, podium_sender_name
        )
        VALUES ($1, $6, $2, $3, $4, $5, $7)
        "#,
    )
    .bind(conv_id)
    .bind(channel)
    .bind(&body)
    .bind(msg_uid.as_ref())
    .bind(value)
    .bind(msg_direction)
    .bind(podium_sender_name.as_deref())
    .execute(&mut *tx)
    .await
    {
        tracing::error!(error = %e, "insert podium_message");
        let _ = tx.rollback().await;
        return;
    }

    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "podium_inbound commit");
        return;
    }

    if created_stub {
        let pool_c = pool.clone();
        let http_c = http.clone();
        let cache_c = Arc::clone(token_cache);
        let to_phone = e164.clone().or_else(|| phone_raw.clone());
        let welcome_cid = cid;
        tokio::spawn(async move {
            if let Some(ref ph) = to_phone {
                let tpl = load_store_podium_config(&pool_c)
                    .await
                    .map(|c| c.templates.merged_defaults().unknown_sender_welcome)
                    .unwrap_or_default();
                let tpl_t = tpl.trim();
                if !tpl_t.is_empty() {
                    match send_podium_sms_message(&pool_c, &http_c, &cache_c, ph, tpl_t).await {
                        Ok(()) => {
                            let ph_e164 = normalize_phone_e164(ph);
                            if let Err(e) = podium_messaging::record_outbound_message(
                                &pool_c,
                                welcome_cid,
                                "sms",
                                tpl_t,
                                None,
                                ph_e164.as_deref(),
                                None,
                                "automated",
                            )
                            .await
                            {
                                tracing::error!(error = %e, customer_id = %welcome_cid, "record welcome SMS to podium_message");
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "podium welcome sms skipped"),
                    }
                }
            }
        });
    }

    if !is_outbound {
        let bundle_kind = if channel == "email" {
            "podium_email_bundle"
        } else {
            "podium_sms_bundle"
        };
        let bundle_prefix = if channel == "email" {
            "Podium Email"
        } else {
            "Podium SMS"
        };

        // Real-time bundle by customer: "podium_inbound:{cid}"
        let dedupe = format!("podium_inbound:{cid}");
        let item_deep = json!({
            "type": "customers",
            "subsection": "all",
            "customer_id": cid.to_string(),
            "hub_tab": "messages",
            "message_channel": channel,
        });

        if let Ok(nid) = crate::logic::notifications::upsert_bundle_item(
            pool,
            bundle_kind,
            bundle_prefix,
            &truncate_body_preview(&body),
            "Tap to open conversation",
            item_deep,
            "podium_inbound",
            json!({}),
            &dedupe,
        )
        .await
        {
            if let Ok(staff) = staff_ids_with_permission(pool, NOTIFICATIONS_VIEW).await {
                let _ = crate::logic::notifications::fan_out_notification_to_staff_ids(
                    pool, nid, &staff,
                )
                .await;
            }
        }
    }
}
