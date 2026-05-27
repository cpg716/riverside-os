use crate::logic::integration_alerts::{record_integration_failure, record_integration_success};
use crate::logic::integration_credentials::{
    load_integration_credentials, save_integration_credentials,
};
use chrono::{DateTime, Duration, Utc};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use std::env;
use thiserror::Error;
use uuid::Uuid;

const CC_CREDENTIAL_KEYS: &[&str] = &[
    "client_id",
    "client_secret",
    "access_token",
    "refresh_token",
    "token_expires_at",
    "target_list_id",
    "list_mappings",
];

const CC_AUTHORIZE_URL: &str = "https://authz.constantcontact.com/oauth2/default/v1/authorize";
const CC_TOKEN_URL: &str = "https://authz.constantcontact.com/oauth2/default/v1/token";
const CC_API_BASE_URL: &str = "https://api.cc.email/v3";

#[derive(Debug, Error)]
pub enum ConstantContactError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Credential error: {0}")]
    Credential(#[from] crate::logic::integration_credentials::IntegrationCredentialError),
    #[error("API error ({status}): {message}")]
    Api { status: StatusCode, message: String },
    #[error("Config error: {0}")]
    Config(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantContactList {
    pub list_id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantContactListResponse {
    pub lists: Vec<ConstantContactList>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub created_count: i32,
    pub updated_count: i32,
    pub deleted_count: i32,
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Debug, FromRow)]
struct CustomerSyncRow {
    id: Uuid,
    first_name: Option<String>,
    last_name: Option<String>,
    email: Option<String>,
    phone: Option<String>,
    is_vip: bool,
    group_codes: Vec<String>,
}

fn get_redirect_uri() -> String {
    env::var("RIVERSIDE_CC_REDIRECT_URI").unwrap_or_else(|_| {
        "http://127.0.0.1:3000/api/settings/constant-contact/oauth/callback".to_string()
    })
}

/// Builds the OAuth redirect authorization URL.
pub async fn get_authorize_url(pool: &PgPool) -> Result<String, ConstantContactError> {
    let credentials =
        load_integration_credentials(pool, "constant_contact", &["client_id"]).await?;
    let client_id = credentials
        .get("client_id")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_CLIENT_ID").ok())
        .ok_or_else(|| ConstantContactError::Config("client_id is not set".to_string()))?;

    let redirect = get_redirect_uri();
    let encoded_redirect = urlencoding::encode(&redirect);
    let scope = urlencoding::encode("contact_data campaign_data offline_access");

    let url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state=cc_auth",
        CC_AUTHORIZE_URL, client_id, encoded_redirect, scope
    );
    Ok(url)
}

/// Exchange code for tokens and save them.
pub async fn exchange_code(pool: &PgPool, code: &str) -> Result<(), ConstantContactError> {
    let credentials =
        load_integration_credentials(pool, "constant_contact", &["client_id", "client_secret"])
            .await?;
    let client_id = credentials
        .get("client_id")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_CLIENT_ID").ok())
        .ok_or_else(|| ConstantContactError::Config("client_id is not set".to_string()))?;
    let client_secret = credentials
        .get("client_secret")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_CLIENT_SECRET").ok())
        .ok_or_else(|| ConstantContactError::Config("client_secret is not set".to_string()))?;

    let basic = base64::Engine::encode(
        &base64::prelude::BASE64_STANDARD,
        format!("{}:{}", client_id, client_secret).as_bytes(),
    );

    let client = Client::new();
    let redirect = get_redirect_uri();
    let params = [
        ("code", code),
        ("redirect_uri", &redirect),
        ("grant_type", "authorization_code"),
    ];

    let res = client
        .post(CC_TOKEN_URL)
        .header("Authorization", format!("Basic {}", basic))
        .form(&params)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(ConstantContactError::Api {
            status,
            message: text,
        });
    }

    let token_resp: OAuthTokenResponse = res.json().await?;
    let expires_at = Utc::now() + Duration::seconds(token_resp.expires_in);

    save_integration_credentials(
        pool,
        "constant_contact",
        vec![
            ("access_token", token_resp.access_token),
            (
                "refresh_token",
                token_resp.refresh_token.unwrap_or_default(),
            ),
            ("token_expires_at", expires_at.to_rfc3339()),
        ],
        None,
    )
    .await?;

    let _ = record_integration_success(pool, "constant_contact_oauth_exchange").await;
    Ok(())
}

/// Refreshes the token if needed and returns the active access token.
pub async fn get_valid_access_token(pool: &PgPool) -> Result<String, ConstantContactError> {
    let credentials =
        load_integration_credentials(pool, "constant_contact", CC_CREDENTIAL_KEYS).await?;

    let client_id = credentials
        .get("client_id")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_CLIENT_ID").ok())
        .ok_or_else(|| ConstantContactError::Config("client_id is not set".to_string()))?;

    let client_secret = credentials
        .get("client_secret")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_CLIENT_SECRET").ok())
        .ok_or_else(|| ConstantContactError::Config("client_secret is not set".to_string()))?;

    let access_token = credentials
        .get("access_token")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_ACCESS_TOKEN").ok())
        .ok_or_else(|| {
            ConstantContactError::Config(
                "No access token found. Please authenticate first.".to_string(),
            )
        })?;

    let refresh_token = credentials
        .get("refresh_token")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| env::var("RIVERSIDE_CC_REFRESH_TOKEN").ok());

    let token_expires_at = credentials
        .get("token_expires_at")
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc));

    let due = match token_expires_at {
        Some(expiry) => expiry <= Utc::now() + Duration::minutes(10),
        None => false,
    };

    if !due {
        return Ok(access_token);
    }

    // Refresh token flow
    let rtok = refresh_token.ok_or_else(|| {
        ConstantContactError::Config(
            "Access token expired but no refresh token available.".to_string(),
        )
    })?;
    let basic = base64::Engine::encode(
        &base64::prelude::BASE64_STANDARD,
        format!("{}:{}", client_id, client_secret).as_bytes(),
    );

    let client = Client::new();
    let params = [("grant_type", "refresh_token"), ("refresh_token", &rtok)];

    let res = client
        .post(CC_TOKEN_URL)
        .header("Authorization", format!("Basic {}", basic))
        .form(&params)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let _ = record_integration_failure(pool, "constant_contact_token_refresh", &text).await;
        return Err(ConstantContactError::Api {
            status,
            message: text,
        });
    }

    let token_resp: OAuthTokenResponse = res.json().await?;
    let new_expires_at = Utc::now() + Duration::seconds(token_resp.expires_in);

    save_integration_credentials(
        pool,
        "constant_contact",
        vec![
            ("access_token", token_resp.access_token.clone()),
            ("refresh_token", token_resp.refresh_token.unwrap_or(rtok)),
            ("token_expires_at", new_expires_at.to_rfc3339()),
        ],
        None,
    )
    .await?;

    let _ = record_integration_success(pool, "constant_contact_token_refresh").await;
    Ok(token_resp.access_token)
}

/// Fetch lists from Constant Contact.
pub async fn fetch_lists(pool: &PgPool) -> Result<Vec<ConstantContactList>, ConstantContactError> {
    let access_token = get_valid_access_token(pool).await?;

    let client = Client::new();
    let url = format!("{}/contact_lists?limit=100", CC_API_BASE_URL);

    let res = client
        .get(&url)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(ConstantContactError::Api {
            status,
            message: text,
        });
    }

    let resp: ConstantContactListResponse = res.json().await?;
    Ok(resp.lists)
}

/// Push opted-in customers to Constant Contact using bulk activities API.
pub async fn sync_contacts(
    pool: &PgPool,
    actor_staff_id: Option<Uuid>,
) -> Result<SyncResult, ConstantContactError> {
    let sync_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO constant_contact_sync_logs (id, sync_type, status) VALUES ($1, 'contacts_push', 'running')"
    )
    .bind(sync_id)
    .execute(pool)
    .await?;

    match run_sync_contacts_flow(pool).await {
        Ok(stats) => {
            sqlx::query(
                r#"
                UPDATE constant_contact_sync_logs
                SET status = 'success', finished_at = NOW(), created_count = $1, updated_count = $2, deleted_count = $3
                WHERE id = $4
                "#
            )
            .bind(stats.created_count)
            .bind(stats.updated_count)
            .bind(stats.deleted_count)
            .bind(sync_id)
            .execute(pool)
            .await?;
            Ok(stats)
        }
        Err(e) => {
            let error_summary = e.to_string();
            sqlx::query(
                r#"
                UPDATE constant_contact_sync_logs
                SET status = 'failed', finished_at = NOW(), error_summary = $1
                WHERE id = $2
                "#,
            )
            .bind(&error_summary)
            .bind(sync_id)
            .execute(pool)
            .await?;
            Err(e)
        }
    }
}

async fn run_sync_contacts_flow(pool: &PgPool) -> Result<SyncResult, ConstantContactError> {
    let credentials =
        load_integration_credentials(pool, "constant_contact", CC_CREDENTIAL_KEYS).await?;
    let access_token = get_valid_access_token(pool).await?;

    let default_list_id = credentials
        .get("target_list_id")
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            ConstantContactError::Config(
                "Default Contact List is not configured in settings".to_string(),
            )
        })?;

    // Parse list mappings: e.g. {"VIP": "list-uuid", "group_code": "list-uuid"}
    let list_mappings_str = credentials
        .get("list_mappings")
        .map(|v| v.as_str())
        .unwrap_or("{}");
    let list_mappings: HashMap<String, String> =
        serde_json::from_str(list_mappings_str).unwrap_or_default();

    // Fetch opted-in customers
    let customers = sqlx::query_as::<_, CustomerSyncRow>(
        r#"
        SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.is_vip,
               COALESCE(
                   ARRAY(
                       SELECT cg.code
                       FROM customer_group_members cgm
                       JOIN customer_groups cg ON cg.id = cgm.group_id
                       WHERE cgm.customer_id = c.id
                   ),
                   '{}'::text[]
               ) AS group_codes
        FROM customers c
        WHERE c.marketing_email_opt_in = true
          AND c.email IS NOT NULL
          AND c.email <> ''
        "#,
    )
    .fetch_all(pool)
    .await?;

    if customers.is_empty() {
        return Ok(SyncResult {
            created_count: 0,
            updated_count: 0,
            deleted_count: 0,
            errors: vec![],
        });
    }

    // Group customers by the lists they belong to
    // list_id -> List of contact objects
    let mut list_buckets: HashMap<String, Vec<Value>> = HashMap::new();

    for c in &customers {
        let email = match &c.email {
            Some(e) if !e.trim().is_empty() => e.trim().to_string(),
            _ => continue,
        };

        let mut contact_obj = json!({
            "email_addresses": [email],
            "first_name": c.first_name.as_deref().unwrap_or("").trim(),
            "last_name": c.last_name.as_deref().unwrap_or("").trim(),
        });

        if let Some(p) = &c.phone {
            if !p.trim().is_empty() {
                contact_obj
                    .as_object_mut()
                    .unwrap()
                    .insert("phone_numbers".to_string(), json!([p.trim()]));
            }
        }

        // Add to default list bucket
        list_buckets
            .entry(default_list_id.clone())
            .or_default()
            .push(contact_obj.clone());

        // Add to VIP list if mapped and customer is VIP
        if c.is_vip {
            if let Some(vip_list_id) = list_mappings.get("VIP") {
                list_buckets
                    .entry(vip_list_id.clone())
                    .or_default()
                    .push(contact_obj.clone());
            }
        }

        // Add to group list mappings
        for code in &c.group_codes {
            if let Some(group_list_id) = list_mappings.get(code) {
                list_buckets
                    .entry(group_list_id.clone())
                    .or_default()
                    .push(contact_obj.clone());
            }
        }
    }

    let client = Client::new();
    let mut errors = Vec::new();
    let mut success_count = 0i32;

    // Send a bulk import activity for each list bucket
    for (list_id, contacts) in list_buckets {
        if contacts.is_empty() {
            continue;
        }

        // Constant Contact bulk imports API: POST /v3/activities/contact_imports
        let url = format!("{}/activities/contact_imports", CC_API_BASE_URL);
        let payload = json!({
            "import_data": contacts,
            "list_ids": [list_id]
        });

        let res = client
            .post(&url)
            .bearer_auth(&access_token)
            .json(&payload)
            .send()
            .await;

        match res {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    success_count += contacts.len() as i32;
                } else {
                    let text = resp.text().await.unwrap_or_default();
                    errors.push(format!(
                        "List {} bulk import rejected ({}): {}",
                        list_id, status, text
                    ));
                }
            }
            Err(e) => {
                errors.push(format!("List {} bulk import network error: {}", list_id, e));
            }
        }
    }

    if !errors.is_empty() && success_count == 0 {
        return Err(ConstantContactError::Config(errors.join("; ")));
    }

    Ok(SyncResult {
        created_count: success_count,
        updated_count: 0, // bulk activity is async and we just know how many we pushed
        deleted_count: 0,
        errors,
    })
}

/// Ingest webhooks from Constant Contact to record marketing timeline events.
pub async fn ingest_webhook_event(
    pool: &PgPool,
    payload: &Value,
) -> Result<(), ConstantContactError> {
    // Standard event array or object
    let events = if let Some(arr) = payload.as_array() {
        arr.clone()
    } else {
        vec![payload.clone()]
    };

    for event in events {
        let event_type = match event.get("event_type").and_then(|v| v.as_str()) {
            Some(t) => t.to_string(),
            None => continue,
        };

        // Extract email and metadata
        let data = match event.get("data") {
            Some(d) => d,
            None => continue,
        };

        let email = match data.get("email_address").and_then(|v| v.as_str()) {
            Some(e) if !e.trim().is_empty() => e.trim().to_string(),
            _ => continue,
        };

        let external_event_id = event
            .get("event_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                // fallback unique digest from event data
                let digest = format!("{}_{}", email, Utc::now().to_rfc3339());
                Some(digest)
            });

        let occurred_at = event
            .get("occurred_at")
            .and_then(|v| v.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);

        let campaign_id = data
            .get("campaign_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let campaign_name = data
            .get("campaign_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let message_id = data
            .get("message_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Resolve customer
        let customer_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1",
        )
        .bind(&email)
        .fetch_optional(pool)
        .await?;

        let Some(cid) = customer_id else {
            continue;
        };

        // Normalize event type: e.g. "contact.optout" -> "unsubscribed", "campaign.delivery.bounce" -> "bounced", "campaign.delivery.send" -> "sent"
        let norm_event = match event_type.as_str() {
            "contact.optout" | "unsubscribed" => "unsubscribed",
            "campaign.delivery.bounce" | "bounced" => "bounced",
            "campaign.delivery.send" | "sent" => "sent",
            "campaign.activity.open" | "opened" => "opened",
            "campaign.activity.click" | "clicked" => "clicked",
            other => other,
        };

        // Insert event
        sqlx::query(
            r#"
            INSERT INTO customer_marketing_email_event (
                customer_id, provider, event_type, occurred_at, campaign_id, campaign_name, message_id, external_event_id
            )
            VALUES ($1, 'constant_contact', $2, $3, $4, $5, $6, $7)
            ON CONFLICT (external_event_id) DO NOTHING
            "#
        )
        .bind(cid)
        .bind(norm_event)
        .bind(occurred_at)
        .bind(campaign_id)
        .bind(campaign_name)
        .bind(message_id)
        .bind(external_event_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}
