//! Gemini API client for ROSIE LLM integration.
//!
//! Provides an alternative to the local Gemma 4 model using Google's Gemini API.
//! Supports chat completions, text-to-speech, and speech-to-text.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// Gemini API client configuration
#[derive(Debug, Clone)]
pub struct GeminiConfig {
    pub api_key: String,
    pub model: String,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub base_url: String,
}

impl Default for GeminiConfig {
    fn default() -> Self {
        Self {
            api_key: std::env::var("GEMINI_API_KEY").unwrap_or_default(),
            model: std::env::var("ROSIE_GEMINI_MODEL")
                .or_else(|_| std::env::var("GEMINI_MODEL"))
                .unwrap_or_else(|_| "gemini-2.5-pro".to_string()),
            stt_model: std::env::var("ROSIE_GEMINI_STT_MODEL")
                .unwrap_or_else(|_| "gemini-2.5-flash".to_string()),
            tts_model: std::env::var("ROSIE_GEMINI_TTS_MODEL")
                .unwrap_or_else(|_| "gemini-2.5-flash-preview-tts".to_string()),
            tts_voice: std::env::var("ROSIE_GEMINI_TTS_VOICE")
                .unwrap_or_else(|_| "Kore".to_string()),
            base_url: std::env::var("ROSIE_GEMINI_BASE_URL")
                .unwrap_or_else(|_| "https://generativelanguage.googleapis.com".to_string())
                .trim_end_matches('/')
                .to_string(),
        }
    }
}

/// Gemini API client
#[derive(Debug, Clone)]
pub struct GeminiClient {
    config: GeminiConfig,
    client: Client,
}

impl GeminiClient {
    pub fn new(config: GeminiConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to create Gemini HTTP client");

        Self { config, client }
    }

    pub fn from_env() -> Result<Self, String> {
        let config = GeminiConfig::default();
        if config.api_key.is_empty() {
            return Err(
                "Gemini API key is not configured in Settings or GEMINI_API_KEY".to_string(),
            );
        }
        if config.model.trim().is_empty() {
            return Err("ROSIE_GEMINI_MODEL is empty".to_string());
        }
        if config.stt_model.trim().is_empty() {
            return Err("ROSIE_GEMINI_STT_MODEL is empty".to_string());
        }
        if config.tts_model.trim().is_empty() {
            return Err("ROSIE_GEMINI_TTS_MODEL is empty".to_string());
        }
        Ok(Self::new(config))
    }

    pub fn model_name(&self) -> &str {
        &self.config.model
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

    /// Send a chat completion request to Gemini API
    pub async fn chat_completion(
        &self,
        messages: Vec<Value>,
        temperature: f32,
        stream: bool,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            self.config.base_url, self.config.model, self.config.api_key
        );

        let body = json!({
            "contents": messages,
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": 2048,
            }
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!(
                "Gemini API returned HTTP {}: {}",
                status, error_text
            ));
        }

        response
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse Gemini API response: {}", e))
    }

    /// Send a text-to-speech request to Gemini API
    pub async fn text_to_speech(&self, text: &str, voice: &str) -> Result<Vec<u8>, String> {
        let url = format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            self.config.base_url, self.config.tts_model, self.config.api_key
        );

        let selected_voice =
            if voice.trim().is_empty() || voice.trim().chars().all(|ch| ch.is_ascii_digit()) {
                self.config.tts_voice.as_str()
            } else {
                voice.trim()
            };

        let body = json!({
            "contents": [{
                "parts": [{
                    "text": text
                }]
            }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": selected_voice
                        }
                    }
                }
            }
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini TTS request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!(
                "Gemini TTS returned HTTP {}: {}",
                status, error_text
            ));
        }

        let raw = response
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse Gemini TTS response: {}", e))?;
        let encoded = raw["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            .as_str()
            .ok_or_else(|| "Gemini TTS response did not include audio data".to_string())?;
        let pcm = BASE64_STANDARD
            .decode(encoded)
            .map_err(|error| format!("Gemini TTS audio payload was invalid: {error}"))?;
        Ok(wav_from_pcm_24khz_mono(&pcm))
    }

    /// Send a speech-to-text request to Gemini API
    pub async fn speech_to_text(&self, audio_data: &[u8]) -> Result<String, String> {
        let url = format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            self.config.base_url, self.config.stt_model, self.config.api_key
        );

        let audio_base64 = BASE64_STANDARD.encode(audio_data);

        let body = json!({
            "contents": [{
                "parts": [{
                    "text": "Transcribe this audio for a Riverside OS staff voice command. Return only the transcript text."
                }, {
                    "inline_data": {
                        "mime_type": "audio/wav",
                        "data": audio_base64
                    }
                }]
            }]
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini STT request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!(
                "Gemini STT returned HTTP {}: {}",
                status, error_text
            ));
        }

        let result: Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Gemini STT response: {}", e))?;

        result["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Failed to extract transcription from Gemini response".to_string())
    }

    /// Check if the Gemini API is available
    pub async fn health_check(&self) -> bool {
        let url = format!(
            "{}/v1beta/models?key={}",
            self.config.base_url, self.config.api_key
        );

        self.client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

fn wav_from_pcm_24khz_mono(pcm: &[u8]) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&24_000u32.to_le_bytes());
    wav.extend_from_slice(&(24_000u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gemini_config_default() {
        let config = GeminiConfig::default();
        assert_eq!(config.base_url, "https://generativelanguage.googleapis.com");
        assert_eq!(config.model, "gemini-2.5-pro");
        assert_eq!(config.stt_model, "gemini-2.5-flash");
        assert_eq!(config.tts_model, "gemini-2.5-flash-preview-tts");
    }

    #[test]
    fn test_gemini_client_from_env_fails_without_key() {
        std::env::remove_var("GEMINI_API_KEY");
        let result = GeminiClient::from_env();
        assert!(result.is_err());
    }
}
