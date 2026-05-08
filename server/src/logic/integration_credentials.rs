use base64::{engine::general_purpose, Engine as _};
use ring::aead::{self, Aad, LessSafeKey, UnboundKey};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_DEV_CREDENTIAL_KEY: &str = "riverside-dev-credential-key-change-me";
const DEFAULT_LEGACY_QBO_CREDENTIAL_KEY: &str = "riverside-dev-token-key-change-me";
const CREDENTIAL_KEY_MIN_LEN: usize = 32;
const CREDENTIAL_AEAD_PREFIX: &str = "v1:";

#[derive(Debug, Clone, Copy)]
pub struct IntegrationCredentialMapping {
    pub integration_key: &'static str,
    pub credential_key: &'static str,
    pub env_key: &'static str,
}

pub const INTEGRATION_CREDENTIAL_MAPPINGS: &[IntegrationCredentialMapping] = &[
    IntegrationCredentialMapping {
        integration_key: "helcim",
        credential_key: "api_token",
        env_key: "HELCIM_API_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "helcim",
        credential_key: "terminal_1_device_code",
        env_key: "HELCIM_TERMINAL_1_DEVICE_CODE",
    },
    IntegrationCredentialMapping {
        integration_key: "helcim",
        credential_key: "terminal_2_device_code",
        env_key: "HELCIM_TERMINAL_2_DEVICE_CODE",
    },
    IntegrationCredentialMapping {
        integration_key: "helcim",
        credential_key: "webhook_secret",
        env_key: "HELCIM_WEBHOOK_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "helcim",
        credential_key: "api_base_url",
        env_key: "HELCIM_API_BASE_URL",
    },
    IntegrationCredentialMapping {
        integration_key: "helcim",
        credential_key: "simulator_enabled",
        env_key: "HELCIM_SIMULATOR_ENABLED",
    },
    IntegrationCredentialMapping {
        integration_key: "shippo",
        credential_key: "api_token",
        env_key: "SHIPPO_API_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "shippo",
        credential_key: "webhook_secret",
        env_key: "SHIPPO_WEBHOOK_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "podium",
        credential_key: "client_id",
        env_key: "RIVERSIDE_PODIUM_CLIENT_ID",
    },
    IntegrationCredentialMapping {
        integration_key: "podium",
        credential_key: "client_secret",
        env_key: "RIVERSIDE_PODIUM_CLIENT_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "podium",
        credential_key: "refresh_token",
        env_key: "RIVERSIDE_PODIUM_REFRESH_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "podium",
        credential_key: "oauth_token_url",
        env_key: "RIVERSIDE_PODIUM_OAUTH_TOKEN_URL",
    },
    IntegrationCredentialMapping {
        integration_key: "podium",
        credential_key: "api_base_url",
        env_key: "RIVERSIDE_PODIUM_API_BASE",
    },
    IntegrationCredentialMapping {
        integration_key: "podium",
        credential_key: "webhook_secret",
        env_key: "RIVERSIDE_PODIUM_WEBHOOK_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "meilisearch",
        credential_key: "url",
        env_key: "RIVERSIDE_MEILISEARCH_URL",
    },
    IntegrationCredentialMapping {
        integration_key: "meilisearch",
        credential_key: "api_key",
        env_key: "RIVERSIDE_MEILISEARCH_API_KEY",
    },
    IntegrationCredentialMapping {
        integration_key: "insights",
        credential_key: "metabase_jwt_secret",
        env_key: "RIVERSIDE_METABASE_JWT_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "qbo",
        credential_key: "client_id",
        env_key: "RIVERSIDE_QBO_CLIENT_ID",
    },
    IntegrationCredentialMapping {
        integration_key: "qbo",
        credential_key: "client_secret",
        env_key: "RIVERSIDE_QBO_CLIENT_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "qbo",
        credential_key: "access_token",
        env_key: "RIVERSIDE_QBO_ACCESS_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "qbo",
        credential_key: "refresh_token",
        env_key: "RIVERSIDE_QBO_REFRESH_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "counterpoint",
        credential_key: "sync_token",
        env_key: "COUNTERPOINT_SYNC_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "base_url",
        env_key: "RIVERSIDE_CORECARD_BASE_URL",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "client_id",
        env_key: "RIVERSIDE_CORECARD_CLIENT_ID",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "client_secret",
        env_key: "RIVERSIDE_CORECARD_CLIENT_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "webhook_secret",
        env_key: "RIVERSIDE_CORECARD_WEBHOOK_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "merchant_number",
        env_key: "RIVERSIDE_CORECARD_MERCHANT_NUMBER",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "merchant_id",
        env_key: "RIVERSIDE_CORECARD_MERCHANT_ID",
    },
    IntegrationCredentialMapping {
        integration_key: "corecard",
        credential_key: "tenant_probe_path",
        env_key: "RIVERSIDE_CORECARD_TENANT_PROBE_PATH",
    },
    IntegrationCredentialMapping {
        integration_key: "weather",
        credential_key: "api_key",
        env_key: "RIVERSIDE_VISUAL_CROSSING_API_KEY",
    },
    IntegrationCredentialMapping {
        integration_key: "backups",
        credential_key: "s3_access_key",
        env_key: "BACKUP_S3_ACCESS_KEY",
    },
    IntegrationCredentialMapping {
        integration_key: "backups",
        credential_key: "s3_secret_key",
        env_key: "BACKUP_S3_SECRET_KEY",
    },
    IntegrationCredentialMapping {
        integration_key: "nuorder",
        credential_key: "consumer_key",
        env_key: "RIVERSIDE_NUORDER_CONSUMER_KEY",
    },
    IntegrationCredentialMapping {
        integration_key: "nuorder",
        credential_key: "consumer_secret",
        env_key: "RIVERSIDE_NUORDER_CONSUMER_SECRET",
    },
    IntegrationCredentialMapping {
        integration_key: "nuorder",
        credential_key: "user_token",
        env_key: "RIVERSIDE_NUORDER_USER_TOKEN",
    },
    IntegrationCredentialMapping {
        integration_key: "nuorder",
        credential_key: "user_secret",
        env_key: "RIVERSIDE_NUORDER_USER_SECRET",
    },
];

#[derive(Debug, Error)]
pub enum IntegrationCredentialError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    InvalidPayload(String),
}

fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn validate_key_material() -> Result<String, IntegrationCredentialError> {
    let key = std::env::var("RIVERSIDE_CREDENTIALS_KEY")
        .or_else(|_| std::env::var("QBO_TOKEN_ENC_KEY"))
        .unwrap_or_default();
    let trimmed = key.trim();
    if trimmed.len() < CREDENTIAL_KEY_MIN_LEN
        || trimmed == DEFAULT_DEV_CREDENTIAL_KEY
        || trimmed == DEFAULT_LEGACY_QBO_CREDENTIAL_KEY
    {
        return Err(IntegrationCredentialError::InvalidPayload(format!(
            "RIVERSIDE_CREDENTIALS_KEY must be set to a non-default secret at least {CREDENTIAL_KEY_MIN_LEN} characters long before integration credentials can be saved."
        )));
    }
    Ok(trimmed.to_string())
}

pub fn validate_credentials_key_for_startup() -> Result<(), IntegrationCredentialError> {
    if env_truthy("RIVERSIDE_STRICT_PRODUCTION") {
        validate_key_material()?;
    }
    Ok(())
}

fn key_material() -> Result<Vec<u8>, IntegrationCredentialError> {
    let key = validate_key_material()?;
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    Ok(hasher.finalize().to_vec())
}

fn aad_for(integration_key: &str, credential_key: &str) -> String {
    format!("riverside-os-integration-credential-v1:{integration_key}:{credential_key}")
}

fn validate_identifier(value: &str, label: &str) -> Result<String, IntegrationCredentialError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(IntegrationCredentialError::InvalidPayload(format!(
            "{label} cannot be blank."
        )));
    }
    if trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.'))
    {
        return Err(IntegrationCredentialError::InvalidPayload(format!(
            "{label} contains unsupported characters."
        )));
    }
    Ok(trimmed.to_string())
}

fn value_hint(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(format!("...{suffix}"))
}

fn encrypt_value(
    integration_key: &str,
    credential_key: &str,
    value: &str,
) -> Result<String, IntegrationCredentialError> {
    let material = key_material()?;
    let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &material).map_err(|_| {
        IntegrationCredentialError::InvalidPayload(
            "failed to initialize integration credential encryption".to_string(),
        )
    })?;
    let key = LessSafeKey::new(unbound);
    let nonce_uuid = Uuid::new_v4();
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&nonce_uuid.as_bytes()[..12]);
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);
    let aad = aad_for(integration_key, credential_key);
    let mut in_out = value.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::from(aad.as_bytes()), &mut in_out)
        .map_err(|_| {
            IntegrationCredentialError::InvalidPayload(
                "failed to encrypt integration credential".to_string(),
            )
        })?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&in_out);
    Ok(format!(
        "{CREDENTIAL_AEAD_PREFIX}{}",
        general_purpose::STANDARD.encode(packed)
    ))
}

fn decrypt_value(
    integration_key: &str,
    credential_key: &str,
    encrypted_value: &str,
) -> Result<String, IntegrationCredentialError> {
    let encoded = encrypted_value
        .trim()
        .strip_prefix(CREDENTIAL_AEAD_PREFIX)
        .ok_or_else(|| {
            IntegrationCredentialError::InvalidPayload(
                "unsupported integration credential format".to_string(),
            )
        })?;
    let decoded = general_purpose::STANDARD.decode(encoded).map_err(|_| {
        IntegrationCredentialError::InvalidPayload(
            "integration credential payload is not valid base64".to_string(),
        )
    })?;
    if decoded.len() <= 12 {
        return Err(IntegrationCredentialError::InvalidPayload(
            "integration credential payload is incomplete".to_string(),
        ));
    }
    let material = key_material()?;
    let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &material).map_err(|_| {
        IntegrationCredentialError::InvalidPayload(
            "failed to initialize integration credential decryption".to_string(),
        )
    })?;
    let key = LessSafeKey::new(unbound);
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&decoded[..12]);
    let mut in_out = decoded[12..].to_vec();
    let aad = aad_for(integration_key, credential_key);
    let plain = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(aad.as_bytes()),
            &mut in_out,
        )
        .map_err(|_| {
            IntegrationCredentialError::InvalidPayload(
                "failed to decrypt integration credential".to_string(),
            )
        })?;
    String::from_utf8(plain.to_vec()).map_err(|_| {
        IntegrationCredentialError::InvalidPayload(
            "integration credential is not valid UTF-8".to_string(),
        )
    })
}

pub async fn save_integration_credentials(
    pool: &PgPool,
    integration_key: &str,
    values: Vec<(&str, String)>,
    updated_by_staff_id: Option<Uuid>,
) -> Result<(), IntegrationCredentialError> {
    let integration_key = validate_identifier(integration_key, "integration key")?;
    let mut tx = pool.begin().await?;
    for (credential_key, value) in values {
        let credential_key = validate_identifier(credential_key, "credential key")?;
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > 4096 {
            return Err(IntegrationCredentialError::InvalidPayload(format!(
                "{credential_key} is too long."
            )));
        }
        let encrypted = encrypt_value(&integration_key, &credential_key, trimmed)?;
        let hint = value_hint(trimmed);
        sqlx::query(
            r#"
            INSERT INTO integration_credentials (
                integration_key,
                credential_key,
                encrypted_value,
                value_hint,
                updated_by_staff_id
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (integration_key, credential_key)
            DO UPDATE SET
                encrypted_value = EXCLUDED.encrypted_value,
                value_hint = EXCLUDED.value_hint,
                updated_by_staff_id = EXCLUDED.updated_by_staff_id,
                updated_at = now()
            "#,
        )
        .bind(&integration_key)
        .bind(&credential_key)
        .bind(&encrypted)
        .bind(&hint)
        .bind(updated_by_staff_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub fn credential_keys_for_integration(integration_key: &str) -> Vec<&'static str> {
    INTEGRATION_CREDENTIAL_MAPPINGS
        .iter()
        .filter(|mapping| mapping.integration_key == integration_key)
        .map(|mapping| mapping.credential_key)
        .collect()
}

pub fn is_supported_integration_credential(integration_key: &str, credential_key: &str) -> bool {
    INTEGRATION_CREDENTIAL_MAPPINGS.iter().any(|mapping| {
        mapping.integration_key == integration_key && mapping.credential_key == credential_key
    })
}

fn env_key_for(integration_key: &str, credential_key: &str) -> Option<&'static str> {
    INTEGRATION_CREDENTIAL_MAPPINGS
        .iter()
        .find(|mapping| {
            mapping.integration_key == integration_key && mapping.credential_key == credential_key
        })
        .map(|mapping| mapping.env_key)
}

pub async fn clear_integration_credential(
    pool: &PgPool,
    integration_key: &str,
    credential_key: &str,
) -> Result<(), IntegrationCredentialError> {
    let integration_key = validate_identifier(integration_key, "integration key")?;
    let credential_key = validate_identifier(credential_key, "credential key")?;
    if !is_supported_integration_credential(&integration_key, &credential_key) {
        return Err(IntegrationCredentialError::InvalidPayload(format!(
            "{credential_key} is not supported for {integration_key}."
        )));
    }
    sqlx::query(
        r#"
        DELETE FROM integration_credentials
        WHERE integration_key = $1
          AND credential_key = $2
        "#,
    )
    .bind(&integration_key)
    .bind(&credential_key)
    .execute(pool)
    .await?;
    if integration_key == "qbo" {
        match credential_key.as_str() {
            "client_id" => {
                sqlx::query("UPDATE qbo_integration SET client_id = NULL")
                    .execute(pool)
                    .await?;
            }
            "client_secret" => {
                sqlx::query("UPDATE qbo_integration SET client_secret = NULL")
                    .execute(pool)
                    .await?;
            }
            "access_token" => {
                sqlx::query("UPDATE qbo_integration SET access_token = NULL")
                    .execute(pool)
                    .await?;
            }
            "refresh_token" => {
                sqlx::query("UPDATE qbo_integration SET refresh_token = NULL")
                    .execute(pool)
                    .await?;
            }
            _ => {}
        }
    }
    if let Some(env_key) = env_key_for(&integration_key, &credential_key) {
        std::env::remove_var(env_key);
    }
    Ok(())
}

pub async fn apply_integration_credentials_to_env(
    pool: &PgPool,
    integration_key: &str,
) -> Result<(), IntegrationCredentialError> {
    let keys = credential_keys_for_integration(integration_key);
    let values = load_integration_credentials(pool, integration_key, &keys).await?;
    for mapping in INTEGRATION_CREDENTIAL_MAPPINGS
        .iter()
        .filter(|mapping| mapping.integration_key == integration_key)
    {
        if let Some(value) = values.get(mapping.credential_key) {
            std::env::set_var(mapping.env_key, value.trim());
        }
    }
    Ok(())
}

pub async fn apply_all_integration_credentials_to_env(
    pool: &PgPool,
) -> Result<(), IntegrationCredentialError> {
    let mut applied = HashSet::new();
    for mapping in INTEGRATION_CREDENTIAL_MAPPINGS {
        if applied.insert(mapping.integration_key) {
            apply_integration_credentials_to_env(pool, mapping.integration_key).await?;
        }
    }
    Ok(())
}

pub async fn load_integration_credentials(
    pool: &PgPool,
    integration_key: &str,
    credential_keys: &[&str],
) -> Result<HashMap<String, String>, IntegrationCredentialError> {
    let integration_key = validate_identifier(integration_key, "integration key")?;
    let keys: Vec<String> = credential_keys
        .iter()
        .map(|key| validate_identifier(key, "credential key"))
        .collect::<Result<Vec<_>, _>>()?;
    if keys.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query(
        r#"
        SELECT credential_key, encrypted_value
        FROM integration_credentials
        WHERE integration_key = $1
          AND credential_key = ANY($2)
        "#,
    )
    .bind(&integration_key)
    .bind(&keys)
    .fetch_all(pool)
    .await?;

    let mut values = HashMap::new();
    for row in rows {
        let credential_key: String = row.try_get("credential_key")?;
        let encrypted_value: String = row.try_get("encrypted_value")?;
        let decrypted = decrypt_value(&integration_key, &credential_key, &encrypted_value)?;
        values.insert(credential_key, decrypted);
    }
    Ok(values)
}

pub async fn configured_integration_credentials(
    pool: &PgPool,
    integration_key: &str,
    credential_keys: &[&str],
) -> Result<HashSet<String>, sqlx::Error> {
    let keys: Vec<String> = credential_keys.iter().map(|key| key.to_string()).collect();
    if keys.is_empty() {
        return Ok(HashSet::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT credential_key
        FROM integration_credentials
        WHERE integration_key = $1
          AND credential_key = ANY($2)
        "#,
    )
    .bind(integration_key)
    .bind(&keys)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("credential_key").ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        credential_keys_for_integration, env_key_for, is_supported_integration_credential,
    };

    #[test]
    fn helcim_terminal_device_code_credentials_are_supported() {
        let keys = credential_keys_for_integration("helcim");

        assert!(keys.contains(&"terminal_1_device_code"));
        assert!(keys.contains(&"terminal_2_device_code"));
        assert!(is_supported_integration_credential(
            "helcim",
            "terminal_1_device_code"
        ));
        assert!(is_supported_integration_credential(
            "helcim",
            "terminal_2_device_code"
        ));
        assert_eq!(
            env_key_for("helcim", "terminal_1_device_code"),
            Some("HELCIM_TERMINAL_1_DEVICE_CODE")
        );
        assert_eq!(
            env_key_for("helcim", "terminal_2_device_code"),
            Some("HELCIM_TERMINAL_2_DEVICE_CODE")
        );
    }
}
