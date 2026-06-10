//! Provider selection logic for ROSIE.
//!
//! Selects between local Gemma and explicitly configured cloud providers.
//! Production defaults to local Gemma and fails closed when the Host stack is unhealthy.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::logic::rosie_provider::{
    GeminiProvider, LocalGemmaProvider, OpenAiProvider, RemoteLmStudioProvider, RosieLLMProvider,
};

/// Provider selection mode
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RosieProviderMode {
    LocalGemma,
    RemoteLmStudio,
    GeminiApi,
    OpenAiApi,
    Auto,
}

impl Default for RosieProviderMode {
    fn default() -> Self {
        RosieProviderMode::LocalGemma
    }
}

impl RosieProviderMode {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "local" | "local-gemma" | "local_gemma" | "local-llm" | "local_llm" | "llama.cpp" => {
                RosieProviderMode::LocalGemma
            }
            "remote-lmstudio" | "remote_lmstudio" | "lmstudio" | "lmstudio-remote"
            | "lmstudio_remote" => RosieProviderMode::RemoteLmStudio,
            "gemini" | "gemini-api" | "gemini_api" => RosieProviderMode::GeminiApi,
            "openai" | "openai-api" | "cloud-openai" | "cloud_openai" => {
                RosieProviderMode::OpenAiApi
            }
            "auto" => RosieProviderMode::Auto,
            _ => RosieProviderMode::LocalGemma,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            RosieProviderMode::LocalGemma => "local_llm",
            RosieProviderMode::RemoteLmStudio => "remote_lmstudio",
            RosieProviderMode::GeminiApi => "gemini",
            RosieProviderMode::OpenAiApi => "openai",
            RosieProviderMode::Auto => "auto",
        }
    }
}

/// Provider selection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieProviderConfig {
    pub mode: RosieProviderMode,
    pub force_local_for_sensitive: bool,
    pub allow_cloud_for_sensitive: bool,
    pub gemini_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub preferred_cloud_provider: Option<RosieProviderMode>,
}

impl Default for RosieProviderConfig {
    fn default() -> Self {
        let provider_env = std::env::var("ROSIE_PROVIDER")
            .or_else(|_| std::env::var("ROSIE_PROVIDER_MODE"))
            .or_else(|_| std::env::var("RIVERSIDE_LLAMA_PROVIDER"));
        Self {
            mode: provider_env
                .map(|s| RosieProviderMode::from_str(&s))
                .unwrap_or_default(),
            force_local_for_sensitive: std::env::var("ROSIE_FORCE_LOCAL_FOR_SENSITIVE")
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(true),
            allow_cloud_for_sensitive: std::env::var("ROSIE_ALLOW_CLOUD_FOR_SENSITIVE")
                .map(|s| matches!(s.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(false),
            gemini_api_key: std::env::var("GEMINI_API_KEY").ok(),
            openai_api_key: std::env::var("OPENAI_API_KEY").ok(),
            preferred_cloud_provider: std::env::var("ROSIE_CLOUD_PROVIDER")
                .ok()
                .map(|value| RosieProviderMode::from_str(&value))
                .filter(|mode| {
                    matches!(
                        mode,
                        RosieProviderMode::GeminiApi | RosieProviderMode::OpenAiApi
                    )
                }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RosieSpeechProviderMode {
    Local,
    OpenAi,
    Gemini,
}

impl RosieSpeechProviderMode {
    pub fn from_str(value: &str) -> Self {
        match value.to_lowercase().as_str() {
            "openai" | "openai-api" | "openai_api" => Self::OpenAi,
            "gemini" | "gemini-api" | "gemini_api" => Self::Gemini,
            _ => Self::Local,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
        }
    }
}

pub fn stt_provider_mode() -> RosieSpeechProviderMode {
    std::env::var("ROSIE_STT_PROVIDER")
        .map(|value| RosieSpeechProviderMode::from_str(&value))
        .unwrap_or(RosieSpeechProviderMode::Local)
}

pub fn tts_provider_mode() -> RosieSpeechProviderMode {
    std::env::var("ROSIE_TTS_PROVIDER")
        .map(|value| RosieSpeechProviderMode::from_str(&value))
        .unwrap_or(RosieSpeechProviderMode::Local)
}

/// Query type for provider selection
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryType {
    Help,
    Conversation,
    Analysis,
    Sensitive,
}

/// Select the appropriate LLM provider based on configuration and query type
pub async fn select_llm_provider(
    config: &RosieProviderConfig,
    query_type: QueryType,
) -> Result<Box<dyn RosieLLMProvider>, String> {
    match config.mode {
        RosieProviderMode::LocalGemma => {
            tracing::info!("Using local Gemma provider (forced by configuration)");
            LocalGemmaProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
        }
        RosieProviderMode::RemoteLmStudio => {
            tracing::info!("Using Remote LM Studio provider (forced by configuration)");
            RemoteLmStudioProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
        }
        RosieProviderMode::GeminiApi => {
            ensure_cloud_allowed_for_query(config, &query_type)?;
            tracing::info!("Using Gemini API provider (forced by configuration)");
            GeminiProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
        }
        RosieProviderMode::OpenAiApi => {
            ensure_cloud_allowed_for_query(config, &query_type)?;
            tracing::info!("Using OpenAI API provider (forced by configuration)");
            OpenAiProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
        }
        RosieProviderMode::Auto => {
            if check_local_gemma_availability().await {
                tracing::info!("Auto-selected local Gemma provider");
                return LocalGemmaProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>);
            }
            if check_remote_lmstudio_availability().await {
                tracing::info!("Auto-selected Remote LM Studio provider");
                return RemoteLmStudioProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>);
            }

            if config.force_local_for_sensitive && query_type == QueryType::Sensitive {
                return Err("ROSIE local/private providers are unavailable and cloud providers are blocked for sensitive requests".to_string());
            }
            if !config.allow_cloud_for_sensitive && query_type == QueryType::Sensitive {
                return Err(
                    "ROSIE cloud providers are not allowed for sensitive requests".to_string(),
                );
            }
            if !config.allow_cloud_for_sensitive {
                return Err("ROSIE auto mode found no local/private provider. Cloud fallback is disabled; configure ROSIE_ALLOW_CLOUD_FOR_SENSITIVE=true and ROSIE_CLOUD_PROVIDER to permit cloud fallback.".to_string());
            }
            if config.preferred_cloud_provider.is_none() {
                return Err("ROSIE auto mode found no available local/private provider and no explicit cloud fallback provider.".to_string());
            }

            match config.preferred_cloud_provider {
                Some(RosieProviderMode::OpenAiApi) => OpenAiProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>),
                Some(RosieProviderMode::GeminiApi) => GeminiProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>),
                _ => Err("ROSIE auto mode found no available local/private provider and no explicit cloud fallback provider.".to_string()),
            }
        }
    }
}

fn ensure_cloud_allowed_for_query(
    config: &RosieProviderConfig,
    query_type: &QueryType,
) -> Result<(), String> {
    if *query_type == QueryType::Sensitive
        && (config.force_local_for_sensitive || !config.allow_cloud_for_sensitive)
    {
        return Err(
            "ROSIE cloud providers are blocked for sensitive requests by policy".to_string(),
        );
    }
    Ok(())
}

/// Check if local Gemma is available
async fn check_local_gemma_availability() -> bool {
    let upstream_url = std::env::var("ROSIE_LOCAL_LLM_BASE_URL")
        .or_else(|_| std::env::var("RIVERSIDE_LLAMA_UPSTREAM"))
        .unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());

    let url = format!("{}/health", upstream_url);

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "ROSIE local Gemma health client init failed");
            return false;
        }
    };

    tokio::time::timeout(Duration::from_secs(5), client.get(&url).send())
        .await
        .map(|r| r.map(|resp| resp.status().is_success()).unwrap_or(false))
        .unwrap_or(false)
}

async fn check_remote_lmstudio_availability() -> bool {
    let base_url = std::env::var("ROSIE_REMOTE_LMSTUDIO_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:1234/v1".to_string())
        .trim_end_matches('/')
        .to_string();
    let models_url = if base_url.ends_with("/v1") {
        format!("{base_url}/models")
    } else {
        format!("{base_url}/v1/models")
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "ROSIE Remote LM Studio health client init failed");
            return false;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), client.get(models_url).send())
        .await
        .map(|r| r.map(|resp| resp.status().is_success()).unwrap_or(false))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_lock() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn test_provider_mode_from_str() {
        assert_eq!(
            RosieProviderMode::from_str("local"),
            RosieProviderMode::LocalGemma
        );
        assert_eq!(
            RosieProviderMode::from_str("local_llm"),
            RosieProviderMode::LocalGemma
        );
        assert_eq!(
            RosieProviderMode::from_str("remote_lmstudio"),
            RosieProviderMode::RemoteLmStudio
        );
        assert_eq!(
            RosieProviderMode::from_str("gemini"),
            RosieProviderMode::GeminiApi
        );
        assert_eq!(
            RosieProviderMode::from_str("openai"),
            RosieProviderMode::OpenAiApi
        );
        assert_eq!(
            RosieProviderMode::from_str("cloud_openai"),
            RosieProviderMode::OpenAiApi
        );
        assert_eq!(RosieProviderMode::from_str("auto"), RosieProviderMode::Auto);
        assert_eq!(
            RosieProviderMode::from_str("unknown"),
            RosieProviderMode::LocalGemma
        );
    }

    #[test]
    fn test_provider_config_default() {
        let _guard = env_lock();
        std::env::remove_var("ROSIE_PROVIDER");
        std::env::remove_var("ROSIE_PROVIDER_MODE");
        std::env::remove_var("RIVERSIDE_LLAMA_PROVIDER");
        let config = RosieProviderConfig::default();
        assert_eq!(config.mode, RosieProviderMode::LocalGemma);
        assert!(config.force_local_for_sensitive);
        assert!(!config.allow_cloud_for_sensitive);
    }

    #[test]
    fn rosie_provider_env_takes_precedence() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER", "remote_lmstudio");
        std::env::set_var("ROSIE_PROVIDER_MODE", "openai");
        std::env::set_var("RIVERSIDE_LLAMA_PROVIDER", "gemini");
        let config = RosieProviderConfig::default();
        assert_eq!(config.mode, RosieProviderMode::RemoteLmStudio);
        std::env::remove_var("ROSIE_PROVIDER");
        std::env::remove_var("ROSIE_PROVIDER_MODE");
        std::env::remove_var("RIVERSIDE_LLAMA_PROVIDER");
    }

    #[tokio::test]
    async fn explicit_openai_provider_fails_without_openai_key() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER_MODE", "openai");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        std::env::remove_var("ROSIE_PROVIDER");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        match result {
            Err(error) => assert!(error.contains("OPENAI_API_KEY")),
            Ok(_) => panic!("OpenAI provider should fail without OPENAI_API_KEY"),
        }
        std::env::remove_var("ROSIE_PROVIDER_MODE");
    }

    #[tokio::test]
    async fn explicit_gemini_provider_fails_without_gemini_key() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER_MODE", "gemini");
        std::env::remove_var("GEMINI_API_KEY");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        std::env::remove_var("ROSIE_PROVIDER");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        match result {
            Err(error) => assert!(error.contains("GEMINI_API_KEY")),
            Ok(_) => panic!("Gemini provider should fail without GEMINI_API_KEY"),
        }
        std::env::remove_var("ROSIE_PROVIDER_MODE");
    }

    #[tokio::test]
    async fn explicit_remote_lmstudio_does_not_require_local_model_path() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER", "remote_lmstudio");
        std::env::set_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL", "http://127.0.0.1:9/v1");
        std::env::set_var("RIVERSIDE_LLAMA_MODEL_PATH", "/missing/local/model.gguf");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        assert!(result.is_ok());
        std::env::remove_var("ROSIE_PROVIDER");
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL");
        std::env::remove_var("RIVERSIDE_LLAMA_MODEL_PATH");
    }

    #[tokio::test]
    async fn explicit_cloud_provider_is_blocked_for_sensitive_by_default() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER", "openai");
        std::env::remove_var("ROSIE_ALLOW_CLOUD_FOR_SENSITIVE");
        std::env::remove_var("OPENAI_API_KEY");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Sensitive).await;

        match result {
            Err(error) => assert!(error.contains("blocked for sensitive")),
            Ok(_) => panic!("OpenAI provider should be blocked for sensitive requests by default"),
        }
        std::env::remove_var("ROSIE_PROVIDER");
    }

    #[test]
    fn speech_provider_modes_default_local_and_map_cloud() {
        let _guard = env_lock();
        std::env::remove_var("ROSIE_STT_PROVIDER");
        std::env::remove_var("ROSIE_TTS_PROVIDER");
        assert_eq!(stt_provider_mode(), RosieSpeechProviderMode::Local);
        assert_eq!(tts_provider_mode(), RosieSpeechProviderMode::Local);

        std::env::set_var("ROSIE_STT_PROVIDER", "openai");
        std::env::set_var("ROSIE_TTS_PROVIDER", "gemini");
        assert_eq!(stt_provider_mode(), RosieSpeechProviderMode::OpenAi);
        assert_eq!(tts_provider_mode(), RosieSpeechProviderMode::Gemini);

        std::env::remove_var("ROSIE_STT_PROVIDER");
        std::env::remove_var("ROSIE_TTS_PROVIDER");
    }

    #[tokio::test]
    async fn auto_with_openai_preference_fails_closed_when_cloud_fallback_disabled() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER_MODE", "auto");
        std::env::set_var("ROSIE_CLOUD_PROVIDER", "openai");
        std::env::set_var("ROSIE_LOCAL_LLM_BASE_URL", "http://127.0.0.1:9");
        std::env::set_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL", "http://127.0.0.1:9/v1");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("ROSIE_ALLOW_CLOUD_FOR_SENSITIVE");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        std::env::remove_var("ROSIE_PROVIDER");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        match result {
            Err(error) => assert!(error.contains("Cloud fallback is disabled")),
            Ok(_) => panic!("OpenAI auto preference should not bypass cloud fallback policy"),
        }
        std::env::remove_var("ROSIE_PROVIDER_MODE");
        std::env::remove_var("ROSIE_CLOUD_PROVIDER");
        std::env::remove_var("ROSIE_LOCAL_LLM_BASE_URL");
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL");
    }

    #[tokio::test]
    async fn auto_with_openai_preference_and_cloud_allowed_fails_without_key() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER_MODE", "auto");
        std::env::set_var("ROSIE_CLOUD_PROVIDER", "openai");
        std::env::set_var("ROSIE_ALLOW_CLOUD_FOR_SENSITIVE", "true");
        std::env::set_var("ROSIE_LOCAL_LLM_BASE_URL", "http://127.0.0.1:9");
        std::env::set_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL", "http://127.0.0.1:9/v1");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        std::env::remove_var("ROSIE_PROVIDER");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        match result {
            Err(error) => assert!(error.contains("OPENAI_API_KEY")),
            Ok(_) => panic!("OpenAI auto preference should fail without OPENAI_API_KEY"),
        }
        std::env::remove_var("ROSIE_PROVIDER_MODE");
        std::env::remove_var("ROSIE_CLOUD_PROVIDER");
        std::env::remove_var("ROSIE_ALLOW_CLOUD_FOR_SENSITIVE");
        std::env::remove_var("ROSIE_LOCAL_LLM_BASE_URL");
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL");
    }
}
