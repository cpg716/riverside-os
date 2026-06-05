//! Provider selection logic for ROSIE.
//!
//! Automatically selects between local Gemma and Gemini API based on availability,
//! latency, privacy requirements, and user configuration.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::logic::rosie_gemini::GeminiClient;
use crate::logic::rosie_provider::{GeminiProvider, LocalGemmaProvider, RosieLLMProvider};

/// Provider selection mode
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RosieProviderMode {
    LocalGemma,
    GeminiApi,
    Auto,
}

impl Default for RosieProviderMode {
    fn default() -> Self {
        // Default to auto selection
        RosieProviderMode::Auto
    }
}

impl RosieProviderMode {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "local" | "local-gemma" => RosieProviderMode::LocalGemma,
            "gemini" | "gemini-api" => RosieProviderMode::GeminiApi,
            "auto" => RosieProviderMode::Auto,
            _ => RosieProviderMode::Auto,
        }
    }
}

/// Provider selection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieProviderConfig {
    pub mode: RosieProviderMode,
    pub force_local_for_sensitive: bool,
    pub gemini_api_key: Option<String>,
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
            GeminiProvider::from_env()
                .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                .or_else(|_| {
                    tracing::warn!("Gemini API provider unavailable, falling back to local Gemma");
                    LocalGemmaProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                })
        }
        RosieProviderMode::Auto => {
            // Auto selection logic
            let use_gemini = should_use_gemini(config, &query_type).await;

            if use_gemini {
                tracing::info!("Auto-selected Gemini API provider");
                GeminiProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                    .or_else(|_| {
                        tracing::warn!("Gemini API unavailable, falling back to local Gemma");
                        LocalGemmaProvider::from_env()
                            .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                    })
            } else {
                tracing::info!("Auto-selected local Gemma provider");
                LocalGemmaProvider::from_env()
                    .map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
                    .or_else(|_| {
                        tracing::warn!("Local Gemma unavailable, trying Gemini API");
                        GeminiProvider::from_env().map(|p| Box::new(p) as Box<dyn RosieLLMProvider>)
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

    // If both are available, prefer Gemini for non-sensitive queries
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
        assert_eq!(RosieProviderMode::from_str("auto"), RosieProviderMode::Auto);
        assert_eq!(
            RosieProviderMode::from_str("unknown"),
            RosieProviderMode::Auto
        );
    }

    #[test]
    fn test_provider_config_default() {
        let config = RosieProviderConfig::default();
        assert_eq!(config.mode, RosieProviderMode::Auto);
        assert!(config.force_local_for_sensitive);
    }
}
