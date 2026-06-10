//! OpenAI cloud provider for ROSIE LLM, STT, and TTS.
//!
//! All calls stay server-side. Secrets are read from environment only and are
//! never exposed to the browser/Tauri client.

use reqwest::{multipart, Client};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct OpenAiConfig {
    pub api_key: String,
    pub base_url: String,
    pub llm_model: String,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
}

impl Default for OpenAiConfig {
    fn default() -> Self {
        Self {
            api_key: std::env::var("OPENAI_API_KEY").unwrap_or_default(),
            base_url: std::env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            llm_model: std::env::var("ROSIE_OPENAI_LLM_MODEL")
                .or_else(|_| std::env::var("ROSIE_OPENAI_MODEL"))
                .unwrap_or_else(|_| "gpt-4.1-mini".to_string()),
            stt_model: std::env::var("ROSIE_OPENAI_STT_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-transcribe".to_string()),
            tts_model: std::env::var("ROSIE_OPENAI_TTS_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-tts".to_string()),
            tts_voice: std::env::var("ROSIE_OPENAI_TTS_VOICE")
                .unwrap_or_else(|_| "alloy".to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenAiClient {
    config: OpenAiConfig,
    client: Client,
}

impl OpenAiClient {
    pub fn new(config: OpenAiConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to create OpenAI HTTP client");
        Self { config, client }
    }

    pub fn from_env() -> Result<Self, String> {
        let config = OpenAiConfig::default();
        if config.api_key.trim().is_empty() {
            return Err("OPENAI_API_KEY environment variable is not set".to_string());
        }
        if config.llm_model.trim().is_empty() {
            return Err("ROSIE_OPENAI_LLM_MODEL is empty".to_string());
        }
        if config.stt_model.trim().is_empty() {
            return Err("ROSIE_OPENAI_STT_MODEL is empty".to_string());
        }
        if config.tts_model.trim().is_empty() {
            return Err("ROSIE_OPENAI_TTS_MODEL is empty".to_string());
        }
        if config.tts_voice.trim().is_empty() {
            return Err("ROSIE_OPENAI_TTS_VOICE is empty".to_string());
        }
        Ok(Self::new(config))
    }

    pub fn llm_model(&self) -> &str {
        &self.config.llm_model
    }

    pub fn stt_model(&self) -> &str {
        &self.config.stt_model
    }

    pub fn tts_model(&self) -> &str {
        &self.config.tts_model
    }

    pub fn tts_voice(&self) -> &str {
        &self.config.tts_voice
    }

    pub async fn chat_completion_payload(&self, payload: Value) -> Result<Value, String> {
        let url = format!("{}/v1/responses", self.config.base_url);
        let temperature = payload
            .get("temperature")
            .and_then(Value::as_f64)
            .unwrap_or(0.2)
            .clamp(0.0, 2.0);
        let max_tokens = payload
            .get("max_tokens")
            .or_else(|| payload.get("max_completion_tokens"))
            .and_then(Value::as_u64);
        let messages = payload
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(|| "OpenAI LLM request missing messages array".to_string())?;
        let input = messages
            .iter()
            .filter_map(openai_input_message)
            .collect::<Vec<_>>();

        if input.is_empty() {
            return Err("OpenAI LLM request has no usable messages".to_string());
        }

        let mut body = json!({
            "model": self.config.llm_model,
            "input": input,
            "temperature": temperature,
        });
        if let Some(max_tokens) = max_tokens {
            if let Some(object) = body.as_object_mut() {
                object.insert("max_output_tokens".to_string(), json!(max_tokens));
            }
        }

        tracing::info!(
            provider = "openai",
            operation = "llm",
            model = %self.config.llm_model,
            "ROSIE cloud provider request"
        );

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("OpenAI LLM request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown OpenAI error".to_string());
            return Err(format!("OpenAI LLM returned HTTP {status}: {error_text}"));
        }

        let raw = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Failed to parse OpenAI LLM response: {error}"))?;
        normalize_responses_payload(&raw, &self.config.llm_model)
    }

    pub async fn transcribe_wav(&self, audio: &[u8]) -> Result<String, String> {
        tracing::info!(
            provider = "openai",
            operation = "stt",
            model = %self.config.stt_model,
            "ROSIE cloud provider request"
        );

        let url = format!("{}/v1/audio/transcriptions", self.config.base_url);
        let audio_part = multipart::Part::bytes(audio.to_vec())
            .file_name("rosie-input.wav")
            .mime_str("audio/wav")
            .map_err(|error| format!("failed to prepare OpenAI STT audio payload: {error}"))?;
        let form = multipart::Form::new()
            .text("model", self.config.stt_model.clone())
            .text("response_format", "json")
            .part("file", audio_part);

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.config.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("OpenAI STT request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown OpenAI STT error".to_string());
            return Err(format!("OpenAI STT returned HTTP {status}: {error_text}"));
        }

        let raw = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Failed to parse OpenAI STT response: {error}"))?;
        let transcript = raw
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if transcript.is_empty() {
            return Err("OpenAI STT returned an empty transcript".to_string());
        }
        Ok(transcript)
    }

    pub async fn synthesize_wav(
        &self,
        text: &str,
        voice: Option<&str>,
        rate: Option<f32>,
    ) -> Result<Vec<u8>, String> {
        let input = text.trim();
        if input.is_empty() {
            return Err("OpenAI TTS text is required".to_string());
        }
        tracing::info!(
            provider = "openai",
            operation = "tts",
            model = %self.config.tts_model,
            "ROSIE cloud provider request"
        );

        let voice = voice
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| !value.chars().all(|ch| ch.is_ascii_digit()))
            .unwrap_or(&self.config.tts_voice);
        let url = format!("{}/v1/audio/speech", self.config.base_url);
        let body = json!({
            "model": self.config.tts_model,
            "voice": voice,
            "input": input,
            "response_format": "wav",
            "speed": rate.unwrap_or(1.0).clamp(0.8, 1.2),
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("OpenAI TTS request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown OpenAI TTS error".to_string());
            return Err(format!("OpenAI TTS returned HTTP {status}: {error_text}"));
        }

        let audio = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read OpenAI TTS response: {error}"))?
            .to_vec();
        if audio.is_empty() {
            return Err("OpenAI TTS returned empty audio".to_string());
        }
        Ok(audio)
    }

    pub async fn health_check(&self) -> bool {
        let url = format!("{}/v1/models", self.config.base_url);
        self.client
            .get(&url)
            .bearer_auth(&self.config.api_key)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    }
}

fn openai_input_message(message: &Value) -> Option<Value> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .trim();
    let role = match role {
        "system" | "developer" => "developer",
        "assistant" => "assistant",
        _ => "user",
    };
    let content = message.get("content")?;
    let text = match content {
        Value::String(value) => value.trim().to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(json!({ "role": role, "content": text }))
}

fn normalize_responses_payload(raw: &Value, fallback_model: &str) -> Result<Value, String> {
    let content = extract_response_text(raw)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OpenAI LLM response did not include assistant text".to_string())?;
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(fallback_model);

    let usage = raw.get("usage").cloned().unwrap_or_else(|| json!({}));
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    Ok(json!({
        "id": raw.get("id").cloned().unwrap_or_else(|| json!(null)),
        "object": "chat.completion",
        "created": raw.get("created_at").cloned().unwrap_or_else(|| json!(null)),
        "model": model,
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": content,
            }
        }],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        }
    }))
}

fn extract_response_text(raw: &Value) -> Option<String> {
    if let Some(text) = raw.get("output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let mut chunks = Vec::new();
    for item in raw.get("output")?.as_array()? {
        let Some(content) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for part in content {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                chunks.push(text);
            }
        }
    }
    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_client_from_env_requires_key() {
        std::env::remove_var("OPENAI_API_KEY");
        let result = OpenAiClient::from_env();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("OPENAI_API_KEY"));
    }

    #[test]
    fn normalizes_responses_output_text_to_chat_shape() {
        let raw = json!({
            "id": "resp_1",
            "model": "gpt-test",
            "output_text": "Hello from ROSIE",
            "usage": { "input_tokens": 3, "output_tokens": 4 }
        });
        let normalized = normalize_responses_payload(&raw, "fallback").unwrap();
        assert_eq!(
            normalized["choices"][0]["message"]["content"],
            "Hello from ROSIE"
        );
        assert_eq!(normalized["usage"]["prompt_tokens"], 3);
        assert_eq!(normalized["usage"]["completion_tokens"], 4);
    }
}
