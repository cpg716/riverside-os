//! Provider abstraction for ROSIE LLM, TTS, and STT.
//!
//! Allows switching between local Gemma 4 and Gemini API providers.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::logic::rosie_gemini::GeminiClient;

/// LLM provider trait
#[async_trait]
pub trait RosieLLMProvider: Send + Sync {
    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String>;
}

/// STT provider trait
#[async_trait]
pub trait RosieSTTProvider: Send + Sync {
    async fn transcribe(&self, audio: &[u8]) -> Result<String, String>;
}

/// TTS provider trait
#[async_trait]
pub trait RosieTTSProvider: Send + Sync {
    async fn synthesize(&self, text: &str, voice: &str) -> Result<Vec<u8>, String>;
}

/// Local Gemma provider (via llama-server)
pub struct LocalGemmaProvider {
    upstream_url: String,
    client: reqwest::Client,
}

impl LocalGemmaProvider {
    pub fn new(upstream_url: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .http1_only()
            .build()
            .expect("Failed to create Gemma HTTP client");

        Self {
            upstream_url,
            client,
        }
    }

    pub fn from_env() -> Result<Self, String> {
        let upstream_url = std::env::var("RIVERSIDE_LLAMA_UPSTREAM")
            .map_err(|_| "RIVERSIDE_LLAMA_UPSTREAM not set".to_string())?;
        Ok(Self::new(upstream_url))
    }
}

#[async_trait]
impl RosieLLMProvider for LocalGemmaProvider {
    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String> {
        let url = format!("{}/v1/chat/completions", self.upstream_url);

        let body = json!({
            "model": "local",
            "messages": messages,
            "stream": false,
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemma API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Gemma API returned HTTP {}: {}", status, error_text));
        }

        response
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse Gemma API response: {}", e))
    }
}

/// Gemini API provider
pub struct GeminiProvider {
    client: GeminiClient,
}

impl GeminiProvider {
    pub fn new(client: GeminiClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self, String> {
        let client = GeminiClient::from_env()?;
        Ok(Self::new(client))
    }
}

#[async_trait]
impl RosieLLMProvider for GeminiProvider {
    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String> {
        // Convert OpenAI-style messages to Gemini format
        let gemini_messages: Vec<Value> = messages
            .iter()
            .map(|msg| {
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");

                json!({
                    "role": if role == "system" { "user" } else { role },
                    "parts": [{
                        "text": content
                    }]
                })
            })
            .collect();

        self.client.chat_completion(gemini_messages, 0.7, false).await
    }
}

#[async_trait]
impl RosieSTTProvider for GeminiProvider {
    async fn transcribe(&self, audio: &[u8]) -> Result<String, String> {
        self.client.speech_to_text(audio).await
    }
}

#[async_trait]
impl RosieTTSProvider for GeminiProvider {
    async fn synthesize(&self, text: &str, voice: &str) -> Result<Vec<u8>, String> {
        self.client.text_to_speech(text, voice).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_gemma_provider_requires_upstream() {
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        let result = LocalGemmaProvider::from_env();
        assert!(result.is_err());
    }

    #[test]
    fn test_gemini_provider_requires_api_key() {
        std::env::remove_var("GEMINI_API_KEY");
        let result = GeminiProvider::from_env();
        assert!(result.is_err());
    }
}
