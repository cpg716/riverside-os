//! Provider abstraction for ROSIE LLM, TTS, and STT.
//!
//! Allows switching between local Gemma 4 and cloud API providers.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::logic::rosie_gemini::GeminiClient;
use crate::logic::rosie_openai::OpenAiClient;

/// LLM provider trait
#[async_trait]
pub trait RosieLLMProvider: Send + Sync {
    async fn chat_completion_payload(&self, payload: Value) -> Result<Value, String>;

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
    model: String,
    client: reqwest::Client,
}

impl LocalGemmaProvider {
    pub fn new(upstream_url: String) -> Self {
        let model = std::env::var("ROSIE_LOCAL_LLM_MODEL").unwrap_or_else(|_| "local".to_string());
        Self::new_with_model(upstream_url, model)
    }

    fn new_with_model(upstream_url: String, model: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .http1_only()
            .build()
            .expect("Failed to create Gemma HTTP client");

        Self {
            upstream_url: upstream_url.trim_end_matches('/').to_string(),
            model,
            client,
        }
    }

    pub fn from_env() -> Result<Self, String> {
        let upstream_url = std::env::var("ROSIE_LOCAL_LLM_BASE_URL")
            .or_else(|_| std::env::var("RIVERSIDE_LLAMA_UPSTREAM"))
            .unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
        let model = std::env::var("ROSIE_LOCAL_LLM_MODEL").unwrap_or_else(|_| "local".to_string());
        Ok(Self::new_with_model(upstream_url, model))
    }
}

#[async_trait]
impl RosieLLMProvider for LocalGemmaProvider {
    async fn chat_completion_payload(&self, payload: Value) -> Result<Value, String> {
        let url = format!("{}/v1/chat/completions", self.upstream_url);

        let response = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Gemma API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!(
                "Gemma API returned HTTP {}: {}",
                status, error_text
            ));
        }

        response
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse Gemma API response: {}", e))
    }

    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String> {
        self.chat_completion_payload(json!({
            "model": self.model.clone(),
            "messages": messages,
            "stream": false,
        }))
        .await
    }
}

/// Remote LM Studio provider.
///
/// LM Studio Remote / LM Link is exposed to ROS as an OpenAI-compatible
/// localhost endpoint on the work hub. ROS never starts or supervises that
/// process.
pub struct RemoteLmStudioProvider {
    base_url: String,
    model: String,
    client: reqwest::Client,
}

impl RemoteLmStudioProvider {
    pub fn from_env() -> Result<Self, String> {
        let base_url = std::env::var("ROSIE_REMOTE_LMSTUDIO_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:1234/v1".to_string());
        let model = std::env::var("ROSIE_REMOTE_LMSTUDIO_MODEL")
            .unwrap_or_else(|_| "gemma-4-12B-it-q5_k_m.gguf".to_string());
        if base_url.trim().is_empty() {
            return Err("ROSIE_REMOTE_LMSTUDIO_BASE_URL is empty".to_string());
        }
        if model.trim().is_empty() {
            return Err("ROSIE_REMOTE_LMSTUDIO_MODEL is empty".to_string());
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .http1_only()
            .build()
            .map_err(|error| format!("Failed to create LM Studio HTTP client: {error}"))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
            client,
        })
    }

    fn chat_url(&self) -> String {
        if self.base_url.ends_with("/v1") {
            format!("{}/chat/completions", self.base_url)
        } else {
            format!("{}/v1/chat/completions", self.base_url)
        }
    }
}

#[async_trait]
impl RosieLLMProvider for RemoteLmStudioProvider {
    async fn chat_completion_payload(&self, payload: Value) -> Result<Value, String> {
        let mut body = payload;
        if let Some(object) = body.as_object_mut() {
            object.insert("model".to_string(), json!(self.model.clone()));
            object.insert("stream".to_string(), json!(false));
        }

        let response = self
            .client
            .post(self.chat_url())
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Remote LM Studio request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown Remote LM Studio error".to_string());
            return Err(format!(
                "Remote LM Studio returned HTTP {status}: {error_text}"
            ));
        }

        response
            .json::<Value>()
            .await
            .map_err(|error| format!("Failed to parse Remote LM Studio response: {error}"))
    }

    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String> {
        self.chat_completion_payload(json!({
            "model": self.model.clone(),
            "messages": messages,
            "stream": false,
        }))
        .await
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
    async fn chat_completion_payload(&self, payload: Value) -> Result<Value, String> {
        let messages = payload
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let temperature = payload
            .get("temperature")
            .and_then(Value::as_f64)
            .unwrap_or(0.2)
            .clamp(0.0, 2.0) as f32;
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

        let raw = self
            .client
            .chat_completion(gemini_messages, temperature, false)
            .await?;
        let content = raw["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();

        if content.is_empty() {
            return Err("Gemini response did not include assistant text".to_string());
        }

        Ok(json!({
            "model": "gemini",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": content,
                }
            }]
        }))
    }

    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String> {
        self.chat_completion_payload(json!({
            "model": "gemini",
            "messages": messages,
            "stream": false,
        }))
        .await
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

/// OpenAI API provider.
pub struct OpenAiProvider {
    client: OpenAiClient,
}

impl OpenAiProvider {
    pub fn new(client: OpenAiClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self, String> {
        let client = OpenAiClient::from_env()?;
        Ok(Self::new(client))
    }
}

#[async_trait]
impl RosieLLMProvider for OpenAiProvider {
    async fn chat_completion_payload(&self, payload: Value) -> Result<Value, String> {
        self.client.chat_completion_payload(payload).await
    }

    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String> {
        self.chat_completion_payload(json!({
            "model": self.client.llm_model(),
            "messages": messages,
            "stream": false,
        }))
        .await
    }
}

#[async_trait]
impl RosieSTTProvider for OpenAiProvider {
    async fn transcribe(&self, audio: &[u8]) -> Result<String, String> {
        self.client.transcribe_wav(audio).await
    }
}

#[async_trait]
impl RosieTTSProvider for OpenAiProvider {
    async fn synthesize(&self, text: &str, voice: &str) -> Result<Vec<u8>, String> {
        self.client.synthesize_wav(text, Some(voice), None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_gemma_provider_uses_default_upstream() {
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        std::env::remove_var("ROSIE_LOCAL_LLM_BASE_URL");
        let result = LocalGemmaProvider::from_env();
        assert!(result.is_ok());
    }

    #[test]
    fn remote_lmstudio_provider_uses_default_endpoint_without_local_model() {
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL");
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_MODEL");
        std::env::remove_var("RIVERSIDE_LLAMA_MODEL_PATH");
        let result = RemoteLmStudioProvider::from_env();
        assert!(result.is_ok());
    }

    #[test]
    fn test_gemini_provider_requires_api_key() {
        std::env::remove_var("GEMINI_API_KEY");
        let result = GeminiProvider::from_env();
        assert!(result.is_err());
    }

    #[test]
    fn test_openai_provider_requires_api_key() {
        std::env::remove_var("OPENAI_API_KEY");
        let result = OpenAiProvider::from_env();
        assert!(result.is_err());
    }
}
