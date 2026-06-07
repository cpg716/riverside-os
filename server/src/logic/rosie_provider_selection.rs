//! Provider selection logic for ROSIE.
//!
//! Selects between local Gemma and explicitly configured cloud providers.
//! Production defaults to local Gemma and fails closed when the Host stack is unhealthy.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::logic::rosie_gemini::GeminiClient;
use crate::logic::rosie_provider::{
    GeminiProvider, LocalGemmaProvider, OpenAiProvider, RosieLLMProvider,
};

/// Provider selection mode
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RosieProviderMode {
    LocalGemma,
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
            "local" | "local-gemma" => RosieProviderMode::LocalGemma,
            "gemini" | "gemini-api" => RosieProviderMode::GeminiApi,
            "openai" | "openai-api" | "cloud-openai" | "cloud_openai" => {
                RosieProviderMode::OpenAiApi
            }
            "auto" => RosieProviderMode::Auto,
            _ => RosieProviderMode::LocalGemma,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            RosieProviderMode::LocalGemma => "local",
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
    pub gemini_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub preferred_cloud_provider: Option<RosieProviderMode>,
}

impl Default for RosieProviderConfig {
    fn default() -> Self {
        Self {
            mode: std::env::var("ROSIE_PROVIDER_MODE")
                .map(|s| RosieProviderMode::from_str(&s))
                .unwrap_or_default(),
            force_local_for_sensitive: std::env::var("ROSIE_FORCE_LOCAL_FOR_SENSITIVE")
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(true),
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
        RosieProviderMode::GeminiApi => {
            tracing::info!("Using Gemini API provider (forced by configuration)");
            GeminiProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
        }
        RosieProviderMode::OpenAiApi => {
            tracing::info!("Using OpenAI API provider (forced by configuration)");
            OpenAiProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
        }
        RosieProviderMode::Auto => {
            // Auto selection logic
            if config.preferred_cloud_provider == Some(RosieProviderMode::OpenAiApi) {
                if config.force_local_for_sensitive && query_type == QueryType::Sensitive {
                    tracing::info!("Auto mode forced local provider for sensitive query");
                } else {
                    tracing::info!("Auto-selected OpenAI API provider from ROSIE_CLOUD_PROVIDER");
                    return OpenAiProvider::from_env()
                        .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>);
                }
            }
            if config.preferred_cloud_provider == Some(RosieProviderMode::GeminiApi) {
                if config.force_local_for_sensitive && query_type == QueryType::Sensitive {
                    tracing::info!("Auto mode forced local provider for sensitive query");
                } else {
                    tracing::info!("Auto-selected Gemini API provider from ROSIE_CLOUD_PROVIDER");
                    return GeminiProvider::from_env()
                        .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>);
                }
            }

            let use_gemini = should_use_gemini(config, &query_type).await;

            if use_gemini {
                tracing::info!("Auto-selected Gemini API provider");
                GeminiProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                    .or_else(|_| {
                        tracing::warn!("Gemini API unavailable, using local Gemma");
                        LocalGemmaProvider::from_env()
                            .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                    })
            } else {
                tracing::info!("Auto-selected local Gemma provider");
                LocalGemmaProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                    .or_else(|_| {
                        tracing::error!("Local Gemma unavailable; ROSIE is blocked until the Host stack is healthy");
                        Err("Local Gemma is unavailable; ROSIE requires the Host stack to be running".to_string())
                    })
            }
        }
    }
}

/// Determine if Gemini API should be used for a given query type
async fn should_use_gemini(config: &RosieProviderConfig, query_type: &QueryType) -> bool {
    // Force local for sensitive queries
    if config.force_local_for_sensitive && *query_type == QueryType::Sensitive {
        tracing::debug!("Forcing local provider for sensitive query");
        return false;
    }

    // Check if Gemini API key is configured
    if config.gemini_api_key.is_none() {
        tracing::debug!("Gemini API key not configured, using local provider");
        return false;
    }

    // Check if Gemini API is available and responsive
    let gemini_available = check_gemini_availability(config).await;
    if !gemini_available {
        tracing::debug!("Gemini API not available, using local provider");
        return false;
    }

    // Check if local Gemma is available
    let local_available = check_local_gemma_availability().await;

    // If both are available in explicit auto mode, prefer Gemini for non-sensitive queries.
    if gemini_available && local_available {
        match query_type {
            QueryType::Sensitive => false,
            QueryType::Help => true, // Gemini is faster for help queries
            QueryType::Conversation => true, // Better for conversational AI
            QueryType::Analysis => true, // Better reasoning capabilities
        }
    } else if gemini_available {
        true
    } else {
        false
    }
}

/// Check if Gemini API is available and responsive
async fn check_gemini_availability(config: &RosieProviderConfig) -> bool {
    if config.gemini_api_key.is_none() {
        return false;
    }

    let client = match GeminiClient::from_env() {
        Ok(c) => c,
        Err(_) => return false,
    };

    tokio::time::timeout(Duration::from_secs(5), client.health_check())
        .await
        .unwrap_or(false)
}

/// Check if local Gemma is available
async fn check_local_gemma_availability() -> bool {
    let upstream_url = match std::env::var("RIVERSIDE_LLAMA_UPSTREAM") {
        Ok(url) => url,
        Err(_) => return false,
    };

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_mode_from_str() {
        assert_eq!(
            RosieProviderMode::from_str("local"),
            RosieProviderMode::LocalGemma
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
        std::env::remove_var("ROSIE_PROVIDER_MODE");
        let config = RosieProviderConfig::default();
        assert_eq!(config.mode, RosieProviderMode::LocalGemma);
        assert!(config.force_local_for_sensitive);
    }

    #[tokio::test]
    async fn explicit_openai_provider_fails_without_openai_key() {
        std::env::set_var("ROSIE_PROVIDER_MODE", "openai");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");

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
        std::env::set_var("ROSIE_PROVIDER_MODE", "gemini");
        std::env::remove_var("GEMINI_API_KEY");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        match result {
            Err(error) => assert!(error.contains("GEMINI_API_KEY")),
            Ok(_) => panic!("Gemini provider should fail without GEMINI_API_KEY"),
        }
        std::env::remove_var("ROSIE_PROVIDER_MODE");
    }

    #[tokio::test]
    async fn auto_with_openai_preference_fails_closed_without_key() {
        std::env::set_var("ROSIE_PROVIDER_MODE", "auto");
        std::env::set_var("ROSIE_CLOUD_PROVIDER", "openai");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");

        let config = RosieProviderConfig::default();
        let result = select_llm_provider(&config, QueryType::Conversation).await;

        match result {
            Err(error) => assert!(error.contains("OPENAI_API_KEY")),
            Ok(_) => panic!("OpenAI auto preference should fail without OPENAI_API_KEY"),
        }
        std::env::remove_var("ROSIE_PROVIDER_MODE");
        std::env::remove_var("ROSIE_CLOUD_PROVIDER");
    }
}
