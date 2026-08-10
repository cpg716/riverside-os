//! Collision-safe Podium contact identity, durable ROS pushes, and provider reconciliation.

use chrono::{DateTime, Utc};
use meilisearch_sdk::client::Client as MeilisearchClient;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::postgres::PgConnection;
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::customers::{insert_customer_in_tx, CustomerCreatedSource, InsertCustomerParams};
use crate::logic::podium::{self, PodiumTokenCache};

const CONTACT_SYNC_MAX_ATTEMPTS: i32 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomerIdentityMatch {
    None,
    Unique(Uuid),
    Ambiguous(Vec<Uuid>),
}

fn sorted_unique(ids: impl IntoIterator<Item = Uuid>) -> Vec<Uuid> {
    let mut values = ids
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    values.sort_unstable();
    values
}

fn classify_candidate_sets(
    phone_ids: &[Uuid],
    email_ids: &[Uuid],
    has_phone: bool,
    has_email: bool,
) -> CustomerIdentityMatch {
    if has_phone && has_email {
        let phone = phone_ids.iter().copied().collect::<HashSet<_>>();
        let email = email_ids.iter().copied().collect::<HashSet<_>>();
        let intersection = sorted_unique(phone.intersection(&email).copied());
        if intersection.len() == 1 {
            return CustomerIdentityMatch::Unique(intersection[0]);
        }
        let union = sorted_unique(phone.union(&email).copied());
        return match union.as_slice() {
            [] => CustomerIdentityMatch::None,
            [only] if phone_ids.is_empty() || email_ids.is_empty() => {
                CustomerIdentityMatch::Unique(*only)
            }
            _ => CustomerIdentityMatch::Ambiguous(union),
        };
    }

    let candidates = if has_phone { phone_ids } else { email_ids };
    match sorted_unique(candidates.iter().copied()).as_slice() {
        [] => CustomerIdentityMatch::None,
        [only] => CustomerIdentityMatch::Unique(*only),
        many => CustomerIdentityMatch::Ambiguous(many.to_vec()),
    }
}

pub async fn match_customer_identity(
    pool: &PgPool,
    phone: Option<&str>,
    email: Option<&str>,
) -> Result<CustomerIdentityMatch, sqlx::Error> {
    let phone_e164 = phone.and_then(podium::normalize_phone_e164);
    let email_normalized = email
        .map(str::trim)
        .filter(|value| podium::looks_like_email(value))
        .map(str::to_ascii_lowercase);

    let phone_ids = if let Some(phone) = phone_e164.as_deref() {
        let digits = phone
            .chars()
            .filter(|value| value.is_ascii_digit())
            .collect::<String>();
        if digits.len() >= 10 {
            let national_digits =
                (digits.len() == 11 && digits.starts_with('1')).then(|| digits[1..].to_string());
            sqlx::query_scalar::<_, Uuid>(
                r#"
                SELECT id
                FROM customers
                WHERE is_active = TRUE
                  AND phone IS NOT NULL
                  AND (
                      regexp_replace(phone, '[^0-9]', '', 'g') = $1
                      OR (
                          $2::text IS NOT NULL
                          AND regexp_replace(phone, '[^0-9]', '', 'g') = $2
                      )
                  )
                ORDER BY created_at DESC, id
                "#,
            )
            .bind(digits)
            .bind(national_digits)
            .fetch_all(pool)
            .await?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let email_ids = if let Some(email) = email_normalized.as_deref() {
        sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT id
            FROM customers
            WHERE is_active = TRUE
              AND email IS NOT NULL
              AND lower(trim(email)) = $1
            ORDER BY created_at DESC, id
            "#,
        )
        .bind(email)
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };

    Ok(classify_candidate_sets(
        &phone_ids,
        &email_ids,
        phone_e164.is_some(),
        email_normalized.is_some(),
    ))
}

fn text_at(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn identifier_array_at(value: &Value, paths: &[&str]) -> Vec<String> {
    paths
        .iter()
        .find_map(|path| value.pointer(path).and_then(Value::as_array))
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .map(ToOwned::to_owned)
                        .or_else(|| {
                            text_at(value, &["/identifier", "/value", "/phoneNumber", "/email"])
                        })
                })
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
struct ProviderContact {
    uid: String,
    first_name: Option<String>,
    last_name: Option<String>,
    display_name: Option<String>,
    phone_e164: Option<String>,
    phone_present: bool,
    email: Option<String>,
    email_present: bool,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    address_present: bool,
    provider_updated_at: Option<DateTime<Utc>>,
    transactional_sms_opted_out: bool,
    locations: Vec<String>,
    raw: Value,
}

fn contact_channel_identifier(value: &Value, want_email: bool) -> Option<String> {
    for path in ["/channels", "/data/channels"] {
        let Some(channels) = value.pointer(path).and_then(Value::as_array) else {
            continue;
        };
        for channel in channels {
            let kind = text_at(channel, &["/type"])
                .unwrap_or_default()
                .to_ascii_lowercase();
            let identifier = text_at(channel, &["/identifier"]);
            if want_email {
                if kind.contains("email")
                    || identifier.as_deref().is_some_and(|id| id.contains('@'))
                {
                    return identifier;
                }
            } else if kind.contains("phone") || kind.contains("sms") || kind.contains("text") {
                return identifier;
            }
        }
    }
    None
}

fn contact_transactional_sms_opted_out(value: &Value) -> bool {
    for path in ["/channels", "/data/channels"] {
        let Some(channels) = value.pointer(path).and_then(Value::as_array) else {
            continue;
        };
        for channel in channels {
            let kind = text_at(channel, &["/type"])
                .unwrap_or_default()
                .to_ascii_lowercase();
            let identifier = text_at(channel, &["/identifier"]);
            let is_phone = kind.contains("phone")
                || kind.contains("sms")
                || kind.contains("text")
                || identifier.as_deref().is_some_and(|id| !id.contains('@'));
            if is_phone
                && channel
                    .get("transactionalOptedOutAt")
                    .is_some_and(|value| !value.is_null())
            {
                return true;
            }
        }
    }
    false
}

fn parse_provider_contact(value: &Value) -> Option<ProviderContact> {
    let raw = value.get("data").cloned().unwrap_or_else(|| value.clone());
    let uid = text_at(&raw, &["/uid", "/id"])?;
    let display_name = text_at(&raw, &["/name", "/displayName"]);
    let explicit_first = text_at(&raw, &["/firstName"]);
    let explicit_last = text_at(&raw, &["/lastName"]);
    let (first_name, last_name) = if explicit_first.is_some() || explicit_last.is_some() {
        (explicit_first, explicit_last)
    } else if let Some(name) = display_name.as_deref() {
        let mut parts = name.split_whitespace();
        let first = parts.next().map(ToOwned::to_owned);
        let last = {
            let value = parts.collect::<Vec<_>>().join(" ");
            (!value.is_empty()).then_some(value)
        };
        (first, last)
    } else {
        (None, None)
    };
    let channels_present = raw.get("channels").is_some();
    let phone_present =
        raw.get("phoneNumber").is_some() || raw.get("phoneNumbers").is_some() || channels_present;
    let email_present =
        raw.get("email").is_some() || raw.get("emails").is_some() || channels_present;
    let address_present = raw.get("address").is_some();
    let phone_raw = text_at(&raw, &["/phoneNumber"])
        .or_else(|| {
            identifier_array_at(&raw, &["/phoneNumbers"])
                .into_iter()
                .next()
        })
        .or_else(|| contact_channel_identifier(&raw, false));
    let phone_e164 = phone_raw.as_deref().and_then(podium::normalize_phone_e164);
    let email = text_at(&raw, &["/email"])
        .or_else(|| identifier_array_at(&raw, &["/emails"]).into_iter().next())
        .or_else(|| contact_channel_identifier(&raw, true))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| podium::looks_like_email(value));
    let provider_updated_at = text_at(&raw, &["/updatedAt"])
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc));
    let locations = raw
        .get("locations")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    value
                        .as_str()
                        .map(ToOwned::to_owned)
                        .or_else(|| text_at(value, &["/uid"]))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ProviderContact {
        uid,
        first_name,
        last_name,
        display_name,
        phone_e164,
        phone_present,
        email,
        email_present,
        address_line1: text_at(
            &raw,
            &[
                "/address/addressLine1",
                "/address/line1",
                "/address/street1",
            ],
        ),
        address_line2: text_at(
            &raw,
            &[
                "/address/addressLine2",
                "/address/line2",
                "/address/street2",
            ],
        ),
        city: text_at(&raw, &["/address/city"]),
        state: text_at(&raw, &["/address/state"]),
        postal_code: text_at(&raw, &["/address/postalCode"]),
        address_present,
        provider_updated_at,
        transactional_sms_opted_out: contact_transactional_sms_opted_out(&raw),
        locations,
        raw,
    })
}

async fn record_event_conn(
    conn: &mut PgConnection,
    customer_id: Option<Uuid>,
    provider_contact_uid: Option<&str>,
    direction: &str,
    action: &str,
    status: &str,
    reason: Option<&str>,
    candidates: &[Uuid],
    payload: Option<&Value>,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO podium_contact_sync_event (
            customer_id, provider_contact_uid, direction, action, status, reason,
            candidate_customer_ids, payload, error
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(customer_id)
    .bind(provider_contact_uid)
    .bind(direction)
    .bind(action)
    .bind(status)
    .bind(reason)
    .bind(candidates)
    .bind(payload)
    .bind(error.map(|value| value.chars().take(4000).collect::<String>()))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn record_event(
    pool: &PgPool,
    customer_id: Option<Uuid>,
    provider_contact_uid: Option<&str>,
    direction: &str,
    action: &str,
    status: &str,
    reason: Option<&str>,
    candidates: &[Uuid],
    payload: Option<&Value>,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    record_event_conn(
        conn.as_mut(),
        customer_id,
        provider_contact_uid,
        direction,
        action,
        status,
        reason,
        candidates,
        payload,
        error,
    )
    .await
}

async fn record_issue(
    conn: &mut PgConnection,
    contact: &ProviderContact,
    reason: &str,
    candidates: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO podium_contact_reconciliation_issue (
            provider_contact_uid, provider_name, phone_e164, email, reason,
            candidate_customer_ids, raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider_contact_uid)
        DO UPDATE SET
            provider_name = EXCLUDED.provider_name,
            phone_e164 = EXCLUDED.phone_e164,
            email = EXCLUDED.email,
            reason = EXCLUDED.reason,
            candidate_customer_ids = EXCLUDED.candidate_customer_ids,
            raw_payload = EXCLUDED.raw_payload,
            last_seen_at = NOW(),
            resolved_customer_id = NULL,
            resolved_at = NULL,
            resolution_note = NULL
        "#,
    )
    .bind(&contact.uid)
    .bind(contact.display_name.as_deref())
    .bind(contact.phone_e164.as_deref())
    .bind(contact.email.as_deref())
    .bind(reason)
    .bind(candidates)
    .bind(&contact.raw)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn resolve_issue(
    conn: &mut PgConnection,
    provider_contact_uid: &str,
    customer_id: Uuid,
    note: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE podium_contact_reconciliation_issue
        SET resolved_customer_id = $2,
            resolved_at = NOW(),
            resolution_note = $3,
            last_seen_at = NOW()
        WHERE provider_contact_uid = $1 AND resolved_at IS NULL
        "#,
    )
    .bind(provider_contact_uid)
    .bind(customer_id)
    .bind(note)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderApplyOutcome {
    Matched(Uuid),
    Created(Uuid),
    Updated(Uuid),
    Conflict,
    Skipped,
}

async fn record_contact_conflict(
    pool: &PgPool,
    contact: &ProviderContact,
    action: &str,
    reason: &str,
    customer_id: Option<Uuid>,
    candidates: &[Uuid],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    if let Some(customer_id) = customer_id {
        sqlx::query(
            r#"
            UPDATE podium_contact_sync_state
            SET status = 'conflict', last_error = $2, updated_at = NOW()
            WHERE customer_id = $1
            "#,
        )
        .bind(customer_id)
        .bind(reason)
        .execute(&mut *tx)
        .await?;
    }
    record_issue(tx.as_mut(), contact, reason, candidates).await?;
    record_event_conn(
        tx.as_mut(),
        customer_id,
        Some(&contact.uid),
        "podium_to_ros",
        action,
        "conflict",
        Some(reason),
        candidates,
        Some(&contact.raw),
        None,
    )
    .await?;
    tx.commit().await
}

async fn apply_provider_contact(
    pool: &PgPool,
    meilisearch: Option<&MeilisearchClient>,
    contact: &ProviderContact,
    action: &str,
) -> Result<ProviderApplyOutcome, sqlx::Error> {
    let mapped_customer: Option<Uuid> = sqlx::query_scalar(
        "SELECT customer_id FROM podium_contact_sync_state WHERE provider_contact_uid = $1 LIMIT 1",
    )
    .bind(&contact.uid)
    .fetch_optional(pool)
    .await?;
    let identity_match = match_customer_identity(
        pool,
        contact.phone_e164.as_deref(),
        contact.email.as_deref(),
    )
    .await?;

    let customer_id = match (mapped_customer, identity_match) {
        (Some(mapped), CustomerIdentityMatch::None) => Some((mapped, false)),
        (Some(mapped), CustomerIdentityMatch::Unique(identity)) if mapped == identity => {
            Some((mapped, false))
        }
        (Some(mapped), CustomerIdentityMatch::Unique(other)) => {
            let candidates = sorted_unique([mapped, other]);
            record_contact_conflict(
                pool,
                contact,
                action,
                "provider_uid_identity_conflict",
                Some(mapped),
                &candidates,
            )
            .await?;
            return Ok(ProviderApplyOutcome::Conflict);
        }
        (Some(mapped), CustomerIdentityMatch::Ambiguous(mut candidates)) => {
            candidates.push(mapped);
            let candidates = sorted_unique(candidates);
            record_contact_conflict(
                pool,
                contact,
                action,
                "ambiguous_identity",
                Some(mapped),
                &candidates,
            )
            .await?;
            return Ok(ProviderApplyOutcome::Conflict);
        }
        (None, CustomerIdentityMatch::Unique(customer_id)) => Some((customer_id, false)),
        (None, CustomerIdentityMatch::Ambiguous(candidates)) => {
            record_contact_conflict(
                pool,
                contact,
                action,
                "ambiguous_identity",
                None,
                &candidates,
            )
            .await?;
            return Ok(ProviderApplyOutcome::Conflict);
        }
        (None, CustomerIdentityMatch::None) => None,
    };

    if mapped_customer.is_none() {
        if let Some((identity_customer_id, _)) = customer_id {
            let existing_provider_uid: Option<String> = sqlx::query_scalar(
                r#"
                SELECT NULLIF(TRIM(provider_contact_uid), '')
                FROM podium_contact_sync_state
                WHERE customer_id = $1
                "#,
            )
            .bind(identity_customer_id)
            .fetch_optional(pool)
            .await?
            .flatten();
            if existing_provider_uid
                .as_deref()
                .is_some_and(|uid| uid != contact.uid)
            {
                record_contact_conflict(
                    pool,
                    contact,
                    action,
                    "multiple_provider_contacts_match_customer",
                    Some(identity_customer_id),
                    &[identity_customer_id],
                )
                .await?;
                return Ok(ProviderApplyOutcome::Conflict);
            }
        }
    }

    if let Some((existing_customer_id, _)) = customer_id {
        let existing_status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM podium_contact_sync_state WHERE customer_id = $1",
        )
        .bind(existing_customer_id)
        .fetch_optional(pool)
        .await?;
        let preserve_local_fields = matches!(
            existing_status.as_deref(),
            Some("pending" | "processing" | "failed" | "conflict")
        );
        if preserve_local_fields {
            let is_conflict = existing_status.as_deref() == Some("conflict");
            let mut tx = pool.begin().await?;
            if contact.transactional_sms_opted_out {
                sqlx::query(
                    r#"
                    UPDATE customers
                    SET marketing_sms_opt_in = FALSE,
                        transactional_sms_opt_in = FALSE,
                        updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(existing_customer_id)
                .execute(&mut *tx)
                .await?;
            }
            sqlx::query(
                r#"
                UPDATE podium_contact_sync_state
                SET provider_contact_uid = $2,
                    provider_match_identifier = $3,
                    last_provider_payload = $4,
                    provider_updated_at = $5,
                    updated_at = NOW()
                WHERE customer_id = $1
                "#,
            )
            .bind(existing_customer_id)
            .bind(&contact.uid)
            .bind(podium::podium_contact_identifier_from_payload(&contact.raw))
            .bind(&contact.raw)
            .bind(contact.provider_updated_at)
            .execute(&mut *tx)
            .await?;
            if !is_conflict {
                resolve_issue(
                    tx.as_mut(),
                    &contact.uid,
                    existing_customer_id,
                    "provider mapping confirmed while pending ROS changes were preserved",
                )
                .await?;
            }
            record_event_conn(
                tx.as_mut(),
                Some(existing_customer_id),
                Some(&contact.uid),
                "podium_to_ros",
                action,
                if is_conflict { "conflict" } else { "skipped" },
                Some(if is_conflict {
                    "Open identity conflict preserved; provider fields were not applied"
                } else {
                    "Pending ROS contact changes preserved for durable outbound synchronization"
                }),
                &[],
                Some(&contact.raw),
                None,
            )
            .await?;
            tx.commit().await?;
            if contact.transactional_sms_opted_out {
                if let Some(client) = meilisearch {
                    crate::logic::meilisearch_sync::upsert_customer_document(
                        client,
                        pool,
                        existing_customer_id,
                    )
                    .await;
                }
            }
            return Ok(if is_conflict {
                ProviderApplyOutcome::Conflict
            } else {
                ProviderApplyOutcome::Skipped
            });
        }
    }

    if customer_id.is_none() && contact.phone_e164.is_none() && contact.email.is_none() {
        record_contact_conflict(
            pool,
            contact,
            action,
            "missing_matchable_identifier",
            None,
            &[],
        )
        .await?;
        return Ok(ProviderApplyOutcome::Conflict);
    }

    let mut tx = pool.begin().await?;
    let (customer_id, created) = if let Some((customer_id, created)) = customer_id {
        (customer_id, created)
    } else {
        let customer_id = insert_customer_in_tx(
            &mut tx,
            InsertCustomerParams {
                customer_code: None,
                first_name: contact
                    .first_name
                    .clone()
                    .unwrap_or_else(|| "Podium".to_string()),
                last_name: contact
                    .last_name
                    .clone()
                    .unwrap_or_else(|| "Contact".to_string()),
                company_name: None,
                email: contact.email.clone(),
                phone: contact.phone_e164.clone(),
                address_line1: contact.address_line1.clone(),
                address_line2: contact.address_line2.clone(),
                city: contact.city.clone(),
                state: contact.state.clone(),
                postal_code: contact.postal_code.clone(),
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: false,
                transactional_email_opt_in: false,
                customer_created_source: CustomerCreatedSource::Podium,
            },
        )
        .await?;
        (customer_id, true)
    };

    let updated = sqlx::query(
        r#"
        UPDATE customers
        SET first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            phone = CASE WHEN $12 THEN $4 ELSE phone END,
            email = CASE WHEN $13 THEN $5 ELSE email END,
            address_line1 = CASE WHEN $14 THEN $6 ELSE address_line1 END,
            address_line2 = CASE WHEN $14 THEN $7 ELSE address_line2 END,
            city = CASE WHEN $14 THEN $8 ELSE city END,
            state = CASE WHEN $14 THEN $9 ELSE state END,
            postal_code = CASE WHEN $14 THEN $10 ELSE postal_code END,
            marketing_sms_opt_in = CASE WHEN $11 THEN FALSE ELSE marketing_sms_opt_in END,
            transactional_sms_opt_in = CASE WHEN $11 THEN FALSE ELSE transactional_sms_opt_in END,
            updated_at = NOW()
        WHERE id = $1
          AND (
              ($2::text IS NOT NULL AND first_name IS DISTINCT FROM $2)
              OR ($3::text IS NOT NULL AND last_name IS DISTINCT FROM $3)
              OR ($12 AND phone IS DISTINCT FROM $4)
              OR ($13 AND email IS DISTINCT FROM $5)
              OR ($14 AND address_line1 IS DISTINCT FROM $6)
              OR ($14 AND address_line2 IS DISTINCT FROM $7)
              OR ($14 AND city IS DISTINCT FROM $8)
              OR ($14 AND state IS DISTINCT FROM $9)
              OR ($14 AND postal_code IS DISTINCT FROM $10)
              OR ($11 AND (marketing_sms_opt_in OR transactional_sms_opt_in))
          )
        "#,
    )
    .bind(customer_id)
    .bind(contact.first_name.as_deref())
    .bind(contact.last_name.as_deref())
    .bind(contact.phone_e164.as_deref())
    .bind(contact.email.as_deref())
    .bind(contact.address_line1.as_deref())
    .bind(contact.address_line2.as_deref())
    .bind(contact.city.as_deref())
    .bind(contact.state.as_deref())
    .bind(contact.postal_code.as_deref())
    .bind(contact.transactional_sms_opted_out)
    .bind(contact.phone_present)
    .bind(contact.email_present)
    .bind(contact.address_present)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;

    sqlx::query(
        r#"
        INSERT INTO podium_contact_sync_state (
            customer_id, provider_contact_uid, provider_match_identifier,
            status, attempts, last_attempt_at,
            last_success_at, last_error, last_provider_payload, provider_updated_at,
            sync_suppressed, updated_at
        )
        VALUES ($1, $2, $3, 'succeeded', 0, NOW(), NOW(), NULL, $4, $5, FALSE, NOW())
        ON CONFLICT (customer_id)
        DO UPDATE SET
            provider_contact_uid = EXCLUDED.provider_contact_uid,
            provider_match_identifier = EXCLUDED.provider_match_identifier,
            status = 'succeeded',
            attempts = 0,
            last_attempt_at = NOW(),
            last_success_at = NOW(),
            last_error = NULL,
            last_provider_payload = EXCLUDED.last_provider_payload,
            provider_updated_at = EXCLUDED.provider_updated_at,
            sync_suppressed = FALSE,
            updated_at = NOW()
        "#,
    )
    .bind(customer_id)
    .bind(&contact.uid)
    .bind(podium::podium_contact_identifier_from_payload(&contact.raw))
    .bind(&contact.raw)
    .bind(contact.provider_updated_at)
    .execute(&mut *tx)
    .await?;

    resolve_issue(
        tx.as_mut(),
        &contact.uid,
        customer_id,
        "matched during provider reconciliation",
    )
    .await?;
    sqlx::query(
        r#"
        UPDATE podium_contact_sync_state
        SET status = 'conflict',
            last_error = 'Another open Podium contact identity conflict includes this customer.',
            updated_at = NOW()
        WHERE customer_id = $1
          AND EXISTS (
              SELECT 1
              FROM podium_contact_reconciliation_issue issue
              WHERE issue.resolved_at IS NULL
                AND $1 = ANY(issue.candidate_customer_ids)
          )
        "#,
    )
    .bind(customer_id)
    .execute(&mut *tx)
    .await?;
    record_event_conn(
        tx.as_mut(),
        Some(customer_id),
        Some(&contact.uid),
        "podium_to_ros",
        action,
        "succeeded",
        None,
        &[],
        Some(&contact.raw),
        None,
    )
    .await?;
    tx.commit().await?;
    if let Some(client) = meilisearch {
        crate::logic::meilisearch_sync::upsert_customer_document(client, pool, customer_id).await;
    }

    Ok(if created {
        ProviderApplyOutcome::Created(customer_id)
    } else if updated {
        ProviderApplyOutcome::Updated(customer_id)
    } else {
        ProviderApplyOutcome::Matched(customer_id)
    })
}

pub async fn enqueue_customer_sync(
    pool: &PgPool,
    customer_id: Uuid,
    reason: &str,
    manual: bool,
) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        INSERT INTO podium_contact_sync_state (
            customer_id, status, pending_reason, attempts, next_attempt_at,
            sync_suppressed, updated_at
        )
        VALUES ($1, 'pending', $2, 0, NOW(), FALSE, NOW())
        ON CONFLICT (customer_id)
        DO UPDATE SET
            status = CASE
                WHEN podium_contact_sync_state.sync_suppressed AND NOT $3
                    THEN podium_contact_sync_state.status
                ELSE 'pending'
            END,
            pending_reason = CASE
                WHEN podium_contact_sync_state.sync_suppressed AND NOT $3
                    THEN podium_contact_sync_state.pending_reason
                ELSE EXCLUDED.pending_reason
            END,
            attempts = CASE
                WHEN podium_contact_sync_state.sync_suppressed AND NOT $3
                    THEN podium_contact_sync_state.attempts
                ELSE 0
            END,
            next_attempt_at = CASE
                WHEN podium_contact_sync_state.sync_suppressed AND NOT $3
                    THEN podium_contact_sync_state.next_attempt_at
                ELSE NOW()
            END,
            sync_suppressed = CASE WHEN $3 THEN FALSE ELSE podium_contact_sync_state.sync_suppressed END,
            updated_at = NOW()
        WHERE (
                NOT podium_contact_sync_state.sync_suppressed
                AND podium_contact_sync_state.status <> 'conflict'
              ) OR $3
        "#,
    )
    .bind(customer_id)
    .bind(reason.trim())
    .bind(manual)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(rows > 0)
}

#[derive(Debug, sqlx::FromRow)]
struct ClaimedContactSync {
    customer_id: Uuid,
    attempts: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContactSyncFinishOutcome {
    Succeeded,
    Conflict,
}

async fn claim_contact_sync(pool: &PgPool) -> Result<Option<ClaimedContactSync>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH candidate AS (
            SELECT customer_id
            FROM podium_contact_sync_state
            WHERE sync_suppressed = FALSE
              AND attempts < $1
              AND (
                  (status = 'pending' AND next_attempt_at <= NOW())
                  OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes')
              )
            ORDER BY next_attempt_at, updated_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE podium_contact_sync_state state
        SET status = 'processing',
            attempts = attempts + 1,
            claimed_at = NOW(),
            last_attempt_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
        FROM candidate
        WHERE state.customer_id = candidate.customer_id
        RETURNING state.customer_id, state.attempts
        "#,
    )
    .bind(CONTACT_SYNC_MAX_ATTEMPTS)
    .fetch_optional(pool)
    .await
}

async fn finish_contact_sync(
    pool: &PgPool,
    claim: &ClaimedContactSync,
    result: &podium::PodiumContactUpsertResult,
) -> Result<ContactSyncFinishOutcome, sqlx::Error> {
    let provider_uid = result.provider_contact_uid.as_str();
    let payload = &result.provider_response;
    let mut tx = pool.begin().await?;
    {
        let other_customer_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT customer_id
            FROM podium_contact_sync_state
            WHERE provider_contact_uid = $1
              AND customer_id <> $2
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(provider_uid)
        .bind(claim.customer_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(other_customer_id) = other_customer_id {
            let candidates = sorted_unique([claim.customer_id, other_customer_id]);
            sqlx::query(
                r#"
                UPDATE podium_contact_sync_state
                SET status = 'conflict', claimed_at = NULL,
                    last_error = 'Podium returned a provider contact UID already mapped to another Riverside customer.',
                    last_provider_payload = $2, updated_at = NOW()
                WHERE customer_id = ANY($1)
                "#,
            )
            .bind(&candidates)
            .bind(payload)
            .execute(&mut *tx)
            .await?;
            if let Some(contact) = parse_provider_contact(payload) {
                record_issue(
                    tx.as_mut(),
                    &contact,
                    "provider_contact_uid_mapped_to_multiple_customers",
                    &candidates,
                )
                .await?;
            }
            record_event_conn(
                tx.as_mut(),
                Some(claim.customer_id),
                Some(provider_uid),
                "ros_to_podium",
                "upsert",
                "conflict",
                Some("Provider contact UID is already mapped to another Riverside customer"),
                &candidates,
                Some(payload),
                None,
            )
            .await?;
            tx.commit().await?;
            return Ok(ContactSyncFinishOutcome::Conflict);
        }
    }
    sqlx::query(
        r#"
        UPDATE podium_contact_sync_state
        SET provider_contact_uid = $2,
            provider_match_identifier = $3,
            status = 'succeeded',
            claimed_at = NULL,
            last_success_at = NOW(),
            last_error = NULL,
            last_provider_payload = $4,
            sync_suppressed = FALSE,
            updated_at = NOW()
        WHERE customer_id = $1
        "#,
    )
    .bind(claim.customer_id)
    .bind(provider_uid)
    .bind(&result.provider_match_identifier)
    .bind(payload)
    .execute(&mut *tx)
    .await?;
    record_event_conn(
        tx.as_mut(),
        Some(claim.customer_id),
        Some(provider_uid),
        "ros_to_podium",
        "upsert",
        "succeeded",
        None,
        &[],
        Some(payload),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(ContactSyncFinishOutcome::Succeeded)
}

async fn retry_contact_sync(
    pool: &PgPool,
    claim: &ClaimedContactSync,
    error: &str,
) -> Result<(), sqlx::Error> {
    let terminal = claim.attempts >= CONTACT_SYNC_MAX_ATTEMPTS;
    let retry_seconds = 2_i64.pow(claim.attempts.clamp(1, 8) as u32).min(900);
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE podium_contact_sync_state
        SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE WHEN $2 THEN next_attempt_at ELSE NOW() + ($3 * INTERVAL '1 second') END,
            claimed_at = NULL,
            last_error = LEFT($4, 4000),
            updated_at = NOW()
        WHERE customer_id = $1
        "#,
    )
    .bind(claim.customer_id)
    .bind(terminal)
    .bind(retry_seconds)
    .bind(error)
    .execute(&mut *tx)
    .await?;
    record_event_conn(
        tx.as_mut(),
        Some(claim.customer_id),
        None,
        "ros_to_podium",
        "upsert",
        "failed",
        None,
        &[],
        None,
        Some(error),
    )
    .await?;
    tx.commit().await?;
    if terminal {
        let message = format!(
            "Podium contact sync for customer {} failed after {} attempts and requires review.",
            claim.customer_id, claim.attempts
        );
        let _ = crate::logic::notifications::broadcast_system_alert_with_key(
            pool,
            &message,
            &format!("podium_contact_sync_failed:{}", claim.customer_id),
        )
        .await;
    }
    Ok(())
}

pub async fn process_pending_contact_syncs(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: usize,
) -> Result<u32, sqlx::Error> {
    if podium::PodiumEnvCredentials::load(pool).await.is_none() {
        return Ok(0);
    }
    if podium::load_store_podium_config(pool)
        .await?
        .location_uid
        .trim()
        .is_empty()
    {
        return Ok(0);
    }
    let mut processed = 0;
    for _ in 0..limit.clamp(1, 100) {
        let Some(claim) = claim_contact_sync(pool).await? else {
            break;
        };
        match podium::upsert_podium_contact(pool, http, token_cache, claim.customer_id).await {
            Ok(result) => {
                let outcome = finish_contact_sync(pool, &claim, &result).await?;
                if outcome == ContactSyncFinishOutcome::Conflict {
                    tracing::warn!(
                        target: "podium",
                        customer_id = %claim.customer_id,
                        "Podium contact sync stopped on an exact provider identity conflict"
                    );
                }
                processed += 1;
            }
            Err(error) => retry_contact_sync(pool, &claim, &error.to_string()).await?,
        }
    }
    Ok(processed)
}

pub async fn sync_customer_now(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    customer_id: Uuid,
) -> Result<Value, String> {
    let existing_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM podium_contact_sync_state WHERE customer_id = $1")
            .bind(customer_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| error.to_string())?;
    if existing_status.as_deref() == Some("conflict") {
        return Err(
            "Resolve the Podium contact identity conflict and run reconciliation before syncing this customer."
                .to_string(),
        );
    }
    enqueue_customer_sync(pool, customer_id, "manual", true)
        .await
        .map_err(|error| error.to_string())?;
    let claim = sqlx::query_as::<_, ClaimedContactSync>(
        r#"
        UPDATE podium_contact_sync_state
        SET status = 'processing', attempts = attempts + 1, claimed_at = NOW(),
            last_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE customer_id = $1 AND status = 'pending'
        RETURNING customer_id, attempts
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Podium contact sync is already processing.".to_string())?;
    match podium::upsert_podium_contact(pool, http, token_cache, customer_id).await {
        Ok(result) => {
            let outcome = finish_contact_sync(pool, &claim, &result)
                .await
                .map_err(|error| error.to_string())?;
            match outcome {
                ContactSyncFinishOutcome::Succeeded => Ok(result.provider_response),
                ContactSyncFinishOutcome::Conflict => Err(
                    "Podium returned a provider contact already mapped to another Riverside customer. Review the contact reconciliation conflict."
                        .to_string(),
                ),
            }
        }
        Err(error) => {
            retry_contact_sync(pool, &claim, &error.to_string())
                .await
                .map_err(|db_error| db_error.to_string())?;
            Err(error.to_string())
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PodiumContactReconciliationResult {
    pub contacts_seen: usize,
    pub contacts_matched: usize,
    pub customers_created: usize,
    pub customers_updated: usize,
    pub conflicts: usize,
    pub outbound_queued: u64,
}

async fn fail_reconciliation_run(pool: &PgPool, run_id: Uuid, error: &str) {
    let _ = sqlx::query(
        r#"
        UPDATE podium_contact_reconciliation_run
        SET status = 'failed', completed_at = NOW(), error = LEFT($2, 4000)
        WHERE id = $1 AND status = 'running'
        "#,
    )
    .bind(run_id)
    .bind(error)
    .execute(pool)
    .await;
}

pub const RECONCILIATION_ALREADY_RUNNING: &str =
    "A Podium contact reconciliation is already running.";

pub async fn recover_interrupted_reconciliation_runs(pool: &PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        r#"
        UPDATE podium_contact_reconciliation_run
        SET status = 'failed', completed_at = NOW(),
            error = 'Riverside restarted before reconciliation recorded completion.'
        WHERE status = 'running'
        "#,
    )
    .execute(pool)
    .await?
    .rows_affected())
}

pub async fn reconcile_all_contacts(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    meilisearch: Option<&MeilisearchClient>,
) -> Result<PodiumContactReconciliationResult, String> {
    sqlx::query(
        r#"
        UPDATE podium_contact_reconciliation_run
        SET status = 'failed', completed_at = NOW(),
            error = 'Reconciliation worker stopped before recording completion.'
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '2 hours'
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| error.to_string())?;
    let run_id: Uuid = match sqlx::query_scalar(
        "INSERT INTO podium_contact_reconciliation_run DEFAULT VALUES RETURNING id",
    )
    .fetch_one(pool)
    .await
    {
        Ok(run_id) => run_id,
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|db| db.is_unique_violation()) =>
        {
            return Err(RECONCILIATION_ALREADY_RUNNING.to_string());
        }
        Err(error) => return Err(error.to_string()),
    };
    let reconciliation_result: Result<PodiumContactReconciliationResult, String> = async {
        let config = podium::load_store_podium_config(pool)
            .await
            .map_err(|error| error.to_string())?;
        let location_uid = config.location_uid.trim();
        if location_uid.is_empty() {
            return Err(
                "Podium location UID is required before contact reconciliation.".to_string(),
            );
        }
        let contacts = podium::fetch_all_podium_contacts(pool, http, token_cache)
            .await
            .map_err(|error| error.to_string())?;
        let mut provider_contacts = Vec::new();
        let mut provider_uids = HashSet::new();
        for value in contacts {
            let Some(contact) = parse_provider_contact(&value) else {
                return Err("Podium returned a contact without a usable provider UID; reconciliation stopped before absence checks.".to_string());
            };
            if !provider_uids.insert(contact.uid.clone()) {
                return Err(format!(
                    "Podium returned contact {} more than once; reconciliation stopped before absence checks.",
                    contact.uid
                ));
            }
            if !contact.locations.is_empty()
                && !contact.locations.iter().any(|uid| uid == location_uid)
            {
                continue;
            }
            provider_contacts.push(contact);
        }
        let mut result = PodiumContactReconciliationResult::default();
        let mut seen_uids = Vec::new();
        for contact in provider_contacts {
            result.contacts_seen += 1;
            seen_uids.push(contact.uid.clone());
            match apply_provider_contact(pool, meilisearch, &contact, "reconcile")
                .await
                .map_err(|error| error.to_string())?
            {
                ProviderApplyOutcome::Matched(_) => result.contacts_matched += 1,
                ProviderApplyOutcome::Created(_) => result.customers_created += 1,
                ProviderApplyOutcome::Updated(_) => result.customers_updated += 1,
                ProviderApplyOutcome::Conflict => result.conflicts += 1,
                ProviderApplyOutcome::Skipped => {}
            }
        }

        let absent_mappings = sqlx::query_as::<_, (Uuid, String)>(
            r#"
            SELECT customer_id, provider_contact_uid
            FROM podium_contact_sync_state
            WHERE provider_contact_uid IS NOT NULL
              AND NOT (provider_contact_uid = ANY($1))
              AND NOT (status = 'provider_deleted' AND sync_suppressed = TRUE)
            "#,
        )
        .bind(&seen_uids)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
        for (customer_id, provider_contact_uid) in absent_mappings {
            let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
            sqlx::query(
                r#"
                UPDATE podium_contact_sync_state
                SET status = 'provider_deleted', sync_suppressed = TRUE,
                    last_error = 'Provider contact was absent from the latest complete Podium contact list.',
                    updated_at = NOW()
                WHERE customer_id = $1
                "#,
            )
            .bind(customer_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            record_event_conn(
                tx.as_mut(),
                Some(customer_id),
                Some(&provider_contact_uid),
                "podium_to_ros",
                "absent_from_full_reconciliation",
                "succeeded",
                Some("ROS customer preserved; automatic recreation suppressed"),
                &[],
                None,
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
            tx.commit().await.map_err(|error| error.to_string())?;
        }

        result.outbound_queued = sqlx::query(
            r#"
            INSERT INTO podium_contact_sync_state (customer_id, status, pending_reason, next_attempt_at)
            SELECT id, 'pending', 'full_reconciliation', NOW()
            FROM customers
            WHERE is_active = TRUE
              AND (NULLIF(TRIM(phone), '') IS NOT NULL OR NULLIF(TRIM(email), '') IS NOT NULL)
            ON CONFLICT (customer_id)
            DO UPDATE SET status = 'pending', pending_reason = 'full_reconciliation',
                attempts = 0, next_attempt_at = NOW(), updated_at = NOW()
            WHERE podium_contact_sync_state.sync_suppressed = FALSE
              AND podium_contact_sync_state.status <> 'conflict'
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?
        .rows_affected();

        sqlx::query(
            r#"
            UPDATE podium_contact_reconciliation_run
            SET status = 'succeeded', completed_at = NOW(), contacts_seen = $2,
                contacts_matched = $3, customers_created = $4, customers_updated = $5,
                conflicts = $6, outbound_queued = $7
            WHERE id = $1
            "#,
        )
        .bind(run_id)
        .bind(result.contacts_seen as i32)
        .bind(result.contacts_matched as i32)
        .bind(result.customers_created as i32)
        .bind(result.customers_updated as i32)
        .bind(result.conflicts as i32)
        .bind(result.outbound_queued as i32)
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?;
        Ok(result)
    }
    .await;
    if let Err(error) = &reconciliation_result {
        fail_reconciliation_run(pool, run_id, error).await;
    }
    reconciliation_result
}

fn webhook_event_type(value: &Value) -> String {
    text_at(
        value,
        &[
            "/metadata/eventType",
            "/metadata/event_type",
            "/eventType",
            "/event_type",
            "/event",
            "/type",
            "/data/eventType",
            "/data/event_type",
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PodiumContactWebhookOutcome {
    NotContact,
    Processed(Option<Uuid>),
}

pub async fn apply_contact_webhook(
    pool: &PgPool,
    meilisearch: Option<&MeilisearchClient>,
    value: &Value,
) -> Result<PodiumContactWebhookOutcome, sqlx::Error> {
    let event = webhook_event_type(value);
    if !event.starts_with("contact.") {
        return Ok(PodiumContactWebhookOutcome::NotContact);
    }
    let after = value.pointer("/data/after").or_else(|| value.get("after"));
    let before = value
        .pointer("/data/before")
        .or_else(|| value.get("before"));

    if event == "contact.deleted" {
        let Some(contact) = before.and_then(parse_provider_contact) else {
            return Err(sqlx::Error::Protocol(
                "Podium contact.deleted webhook did not include a valid data.before contact"
                    .to_string(),
            ));
        };
        let customer_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT customer_id FROM podium_contact_sync_state WHERE provider_contact_uid = $1",
        )
        .bind(&contact.uid)
        .fetch_optional(pool)
        .await?;
        if let Some(customer_id) = customer_id {
            let mut tx = pool.begin().await?;
            sqlx::query(
                r#"
                UPDATE podium_contact_sync_state
                SET status = 'provider_deleted', sync_suppressed = TRUE,
                    last_provider_payload = $2, provider_contact_uid = NULL,
                    last_error = 'Contact deleted in Podium; ROS customer preserved.', updated_at = NOW()
                WHERE customer_id = $1
                "#,
            )
            .bind(customer_id)
            .bind(&contact.raw)
            .execute(&mut *tx)
            .await?;
            record_event_conn(
                tx.as_mut(),
                Some(customer_id),
                Some(&contact.uid),
                "podium_to_ros",
                "delete",
                "succeeded",
                Some("ROS customer preserved; automatic recreation suppressed"),
                &[],
                Some(&contact.raw),
                None,
            )
            .await?;
            tx.commit().await?;
            return Ok(PodiumContactWebhookOutcome::Processed(Some(customer_id)));
        }
        record_event(
            pool,
            None,
            Some(&contact.uid),
            "podium_to_ros",
            "delete",
            "skipped",
            Some("No ROS mapping existed"),
            &[],
            Some(&contact.raw),
            None,
        )
        .await?;
        return Ok(PodiumContactWebhookOutcome::Processed(None));
    }

    let Some(contact) = after.and_then(parse_provider_contact) else {
        return Err(sqlx::Error::Protocol(format!(
            "Podium {event} webhook did not include a valid data.after contact"
        )));
    };
    if event == "contact.merged" {
        if let Some(old_contact) = before.and_then(parse_provider_contact) {
            if old_contact.uid != contact.uid {
                let mut tx = pool.begin().await?;
                let merged_customer_id: Option<Uuid> = sqlx::query_scalar(
                    r#"
                    UPDATE podium_contact_sync_state
                    SET provider_contact_uid = NULL, status = 'merged', sync_suppressed = TRUE,
                        last_error = 'Podium merged this provider contact into another contact.',
                        last_provider_payload = $2, updated_at = NOW()
                    WHERE provider_contact_uid = $1
                    RETURNING customer_id
                    "#,
                )
                .bind(&old_contact.uid)
                .bind(&old_contact.raw)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some(customer_id) = merged_customer_id {
                    record_event_conn(
                        tx.as_mut(),
                        Some(customer_id),
                        Some(&old_contact.uid),
                        "podium_to_ros",
                        "merge_source",
                        "succeeded",
                        Some("Provider contact merged into another Podium contact"),
                        &[],
                        Some(&old_contact.raw),
                        None,
                    )
                    .await?;
                }
                tx.commit().await?;
            }
        }
    }
    match apply_provider_contact(pool, meilisearch, &contact, &event).await? {
        ProviderApplyOutcome::Matched(customer_id)
        | ProviderApplyOutcome::Created(customer_id)
        | ProviderApplyOutcome::Updated(customer_id) => {
            Ok(PodiumContactWebhookOutcome::Processed(Some(customer_id)))
        }
        ProviderApplyOutcome::Conflict | ProviderApplyOutcome::Skipped => {
            Ok(PodiumContactWebhookOutcome::Processed(None))
        }
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumContactIssueRow {
    pub id: Uuid,
    pub provider_contact_uid: String,
    pub provider_name: Option<String>,
    pub phone_e164: Option<String>,
    pub email: Option<String>,
    pub reason: String,
    pub candidate_customer_ids: Vec<Uuid>,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

pub async fn list_contact_issues(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<PodiumContactIssueRow>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT id, provider_contact_uid, provider_name, phone_e164, email, reason,
            candidate_customer_ids, first_seen_at, last_seen_at
        FROM podium_contact_reconciliation_issue
        WHERE resolved_at IS NULL
        ORDER BY last_seen_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumCustomerContactSyncStatus {
    pub customer_id: Uuid,
    pub provider_contact_uid: Option<String>,
    pub status: String,
    pub pending_reason: Option<String>,
    pub attempts: i32,
    pub next_attempt_at: DateTime<Utc>,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub provider_updated_at: Option<DateTime<Utc>>,
    pub sync_suppressed: bool,
    pub updated_at: DateTime<Utc>,
}

pub async fn customer_sync_status(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Option<PodiumCustomerContactSyncStatus>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT customer_id, provider_contact_uid, status, pending_reason, attempts,
            next_attempt_at, last_attempt_at, last_success_at, last_error,
            provider_updated_at, sync_suppressed, updated_at
        FROM podium_contact_sync_state
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
}

pub async fn contact_reconciliation_due(pool: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT NOT EXISTS (
            SELECT 1
            FROM podium_contact_reconciliation_run
            WHERE status = 'succeeded'
              AND completed_at >= NOW() - INTERVAL '24 hours'
        )
        "#,
    )
    .fetch_one(pool)
    .await
}

pub(crate) async fn apply_sms_opt_out_conn(
    conn: &mut PgConnection,
    customer_id: Uuid,
    provider_message_uid: Option<&str>,
    payload: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE customers
        SET marketing_sms_opt_in = FALSE,
            transactional_sms_opt_in = FALSE,
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .execute(&mut *conn)
    .await?;
    record_event_conn(
        conn,
        Some(customer_id),
        provider_message_uid,
        "podium_to_ros",
        "sms_opt_out",
        "succeeded",
        Some("Exact inbound carrier opt-out command"),
        &[],
        Some(payload),
        None,
    )
    .await
}

pub async fn apply_sms_opt_out(
    pool: &PgPool,
    customer_id: Uuid,
    provider_message_uid: Option<&str>,
    payload: &Value,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    apply_sms_opt_out_conn(tx.as_mut(), customer_id, provider_message_uid, payload).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    #[test]
    fn single_identifier_collision_is_ambiguous() {
        assert_eq!(
            classify_candidate_sets(&[id(1), id(2)], &[], true, false),
            CustomerIdentityMatch::Ambiguous(vec![id(1), id(2)])
        );
    }

    #[test]
    fn phone_and_email_intersection_can_prove_one_customer() {
        assert_eq!(
            classify_candidate_sets(&[id(1), id(2)], &[id(2)], true, true),
            CustomerIdentityMatch::Unique(id(2))
        );
    }

    #[test]
    fn conflicting_phone_and_email_are_ambiguous() {
        assert_eq!(
            classify_candidate_sets(&[id(1)], &[id(2)], true, true),
            CustomerIdentityMatch::Ambiguous(vec![id(1), id(2)])
        );
    }

    #[test]
    fn contact_parser_reads_documented_arrays_and_opt_out() {
        let value = json!({
            "uid": "contact-1",
            "name": "Alex Rivera",
            "phoneNumbers": [{"identifier": "+17165551212"}],
            "emails": [{"identifier": "Alex@example.com"}],
            "channels": [{
                "type": "phone",
                "identifier": "+17165551212",
                "transactionalOptedOutAt": "2026-08-07T12:00:00Z"
            }]
        });
        let parsed = parse_provider_contact(&value).expect("contact");
        assert_eq!(parsed.phone_e164.as_deref(), Some("+17165551212"));
        assert_eq!(parsed.email.as_deref(), Some("alex@example.com"));
        assert!(parsed.transactional_sms_opted_out);
    }

    #[test]
    fn contact_webhook_accepts_snake_case_metadata() {
        let value = json!({
            "metadata": { "event_type": "contact.updated" }
        });

        assert_eq!(webhook_event_type(&value), "contact.updated");
    }

    #[test]
    fn contact_parser_distinguishes_cleared_fields_from_omitted_fields() {
        let cleared = parse_provider_contact(&json!({
            "uid": "contact-cleared",
            "phoneNumbers": [],
            "emails": [],
            "address": null
        }))
        .expect("cleared contact");
        assert!(cleared.phone_present);
        assert!(cleared.email_present);
        assert!(cleared.address_present);
        assert_eq!(cleared.phone_e164, None);
        assert_eq!(cleared.email, None);

        let partial = parse_provider_contact(&json!({
            "uid": "contact-partial",
            "name": "Alex Rivera"
        }))
        .expect("partial contact");
        assert!(!partial.phone_present);
        assert!(!partial.email_present);
        assert!(!partial.address_present);
    }
}
