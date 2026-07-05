use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Child;
use tokio::sync::Mutex;
use url::Url;

use crate::logic::rosie_gemini::{GeminiClient, GeminiConfig};
use crate::logic::rosie_openai::{OpenAiClient, OpenAiConfig};
use crate::logic::rosie_provider_selection::{
    stt_provider_mode, tts_provider_mode, RosieProviderConfig, RosieProviderMode,
    RosieSpeechProviderMode,
};

pub type RosieSpeechState = Arc<Mutex<Option<Child>>>;

#[derive(Debug, Serialize)]
pub struct RosieHostRuntimeStatus {
    pub llm: RosieHostLlmStatus,
    pub stt: RosieHostSttStatus,
    pub tts: RosieHostTtsStatus,
}

#[derive(Debug, Serialize)]
pub struct RosieHostLlmStatus {
    pub runtime_name: String,
    pub provider: String,
    pub deployment_kind: String,
    pub base_url: String,
    pub host: String,
    pub port: String,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub sidecar_binary_present: bool,
    pub running: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub context_hint: Option<String>,
    pub api_key_configured: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct RosieHostSttStatus {
    pub engine_name: String,
    pub provider: String,
    pub deployment_kind: String,
    pub active_engine: String,
    pub cli_path: String,
    pub cli_present: bool,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub api_key_configured: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct RosieHostTtsStatus {
    pub engine_name: String,
    pub provider: String,
    pub deployment_kind: String,
    pub active_engine: String,
    pub command_path: String,
    pub command_present: bool,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub speaking: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub api_key_configured: Option<bool>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn rosie_host_dir() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join("Library")
            .join("Application Support")
            .join("riverside-os")
            .join("rosie")
    })
}

fn default_rosie_root_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(program_data) = std::env::var_os("ProgramData") {
            let path = PathBuf::from(program_data)
                .join("riverside-os")
                .join("rosie");
            if path.exists() {
                return Some(path);
            }
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let path = PathBuf::from(local_app_data)
                .join("riverside-os")
                .join("rosie");
            if path.exists() {
                return Some(path);
            }
        }
    }
    rosie_host_dir()
}

fn default_rosie_llm_model_path() -> Option<PathBuf> {
    default_rosie_root_dir().map(|root| {
        root.join("models")
            .join("gemma-4-e4b")
            .join("google_gemma-4-E4B-it-Q4_K_M.gguf")
    })
}

fn resolve_llama_model_path() -> Option<PathBuf> {
    std::env::var("RIVERSIDE_LLAMA_MODEL_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| default_rosie_llm_model_path().filter(|path| path.exists()))
}

fn resolve_sensevoice_model_dir() -> Option<PathBuf> {
    default_rosie_root_dir().map(|root| {
        root.join("stt")
            .join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17")
    })
}

fn resolve_sensevoice_model_path() -> Option<PathBuf> {
    resolve_sensevoice_model_dir()
        .map(|dir| dir.join("model.int8.onnx"))
        .filter(|path| path.exists())
}

fn resolve_sensevoice_tokens_path() -> Option<PathBuf> {
    resolve_sensevoice_model_dir()
        .map(|dir| dir.join("tokens.txt"))
        .filter(|path| path.exists())
}

fn resolve_asr_binary_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(root) = default_rosie_root_dir() {
            let path = root.join("bin").join("sherpa-onnx-offline.exe");
            if path.exists() {
                return path;
            }
        }
        PathBuf::from(r"C:\RiversideOS\rosie\bin\sherpa-onnx-offline.exe")
    }
    #[cfg(not(windows))]
    {
        if let Some(root) = default_rosie_root_dir() {
            let path = root.join("bin").join("sherpa-onnx-offline");
            if path.exists() {
                return path;
            }
        }
        PathBuf::from("/nonexistent/sherpa-onnx-offline")
    }
}

fn resolve_tts_binary_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(root) = default_rosie_root_dir() {
            let path = root.join("bin").join("sherpa-onnx-offline-tts.exe");
            if path.exists() {
                return path;
            }
        }
        PathBuf::from(r"C:\RiversideOS\rosie\bin\sherpa-onnx-offline-tts.exe")
    }
    #[cfg(not(windows))]
    {
        if let Some(root) = default_rosie_root_dir() {
            let path = root.join("bin").join("sherpa-onnx-offline-tts");
            if path.exists() {
                return path;
            }
        }
        PathBuf::from("/nonexistent/sherpa-onnx-offline-tts")
    }
}

fn resolve_kokoro_model_dir() -> Option<PathBuf> {
    default_rosie_root_dir().map(|root| root.join("tts").join("kokoro-multi-lang-v1_0"))
}

fn resolve_kokoro_model_path() -> Option<PathBuf> {
    resolve_kokoro_model_dir()
        .map(|dir| dir.join("model.onnx"))
        .filter(|path| path.exists())
}

fn parse_sherpa_onnx_offline_output(stdout: &str) -> String {
    if let Some(start) = stdout.find('{') {
        if let Some(end) = stdout.rfind('}') {
            if end > start {
                let json_str = &stdout[start..=end];
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(text) = val.get("text").and_then(|t| t.as_str()) {
                        return text.trim().to_string();
                    }
                }
            }
        }
    }

    for line in stdout.lines() {
        if line.contains("Recognition result for") {
            if let Some(pos) = line.find(':') {
                let text = line[pos + 1..].trim();
                if text.starts_with('{') {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                        if let Some(t) = val.get("text").and_then(|t| t.as_str()) {
                            return t.trim().to_string();
                        }
                    }
                }
                let text = text.trim_matches('"');
                return text.trim().to_string();
            }
        }
    }

    if let Some(last_line) = stdout.lines().filter(|l| !l.trim().is_empty()).next_back() {
        if let Some(pos) = last_line.find("]:") {
            return last_line[pos + 2..]
                .trim()
                .trim_matches('"')
                .trim()
                .to_string();
        }
        return last_line.trim().trim_matches('"').trim().to_string();
    }

    stdout.trim().to_string()
}

fn resolve_llama_upstream_url() -> Option<String> {
    std::env::var("RIVERSIDE_LLAMA_UPSTREAM")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_local_llm_base_url() -> String {
    std::env::var("ROSIE_LOCAL_LLM_BASE_URL")
        .or_else(|_| std::env::var("RIVERSIDE_LLAMA_UPSTREAM"))
        .unwrap_or_else(|_| "http://127.0.0.1:8080".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn resolve_local_llm_model_name() -> String {
    std::env::var("ROSIE_LOCAL_LLM_MODEL").unwrap_or_else(|_| "Gemma 4 E4B".to_string())
}

fn resolve_remote_lmstudio_base_url() -> String {
    std::env::var("ROSIE_REMOTE_LMSTUDIO_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:1234/v1".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn resolve_remote_lmstudio_model_name() -> String {
    std::env::var("ROSIE_REMOTE_LMSTUDIO_MODEL")
        .unwrap_or_else(|_| "gemma-4-12B-it-q5_k_m.gguf".to_string())
}

fn parsed_host_port(base_url: &str, fallback_host: &str, fallback_port: &str) -> (String, String) {
    let parsed = Url::parse(base_url).ok();
    let host = parsed
        .as_ref()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| fallback_host.to_string());
    let port = parsed
        .as_ref()
        .and_then(Url::port_or_known_default)
        .map(|value| value.to_string())
        .unwrap_or_else(|| fallback_port.to_string());
    (host, port)
}

fn openai_compatible_models_url(base_url: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with("/v1") {
        format!("{base_url}/models")
    } else {
        format!("{base_url}/v1/models")
    }
}

fn command_exists(path: &Path) -> bool {
    path.exists() && path.is_file()
}

fn resolve_speech_python_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        std::env::var("RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH")
            .ok()
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .or_else(|| {
                home_dir().map(|home| {
                    home.join(".local")
                        .join("share")
                        .join("uv")
                        .join("tools")
                        .join("sherpa-onnx")
                        .join("bin")
                        .join("python")
                })
            })
            .filter(|path| command_exists(path))
    }
}

fn resolve_sherpa_provider() -> String {
    std::env::var("RIVERSIDE_SHERPA_PROVIDER").unwrap_or_else(|_| "cpu".to_string())
}

fn bundled_script_path(name: &str) -> Option<PathBuf> {
    let repo_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join(name);
    if repo_script.exists() {
        return Some(repo_script);
    }
    None
}

fn resolve_sensevoice_python_script() -> Option<PathBuf> {
    bundled_script_path("rosie_sensevoice_transcribe.py")
}

fn resolve_kokoro_python_script() -> Option<PathBuf> {
    bundled_script_path("rosie_kokoro_tts.py")
}

fn speech_command_label(binary: &Path, script: Option<&Path>) -> String {
    if command_exists(binary) {
        return binary.display().to_string();
    }

    match (resolve_speech_python_path(), script) {
        (Some(python), Some(script)) => format!("{} {}", python.display(), script.display()),
        _ => binary.display().to_string(),
    }
}

fn temp_voice_prefix(stem: &str, extension: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    std::env::temp_dir().join(format!(
        "rosie-{stem}-{}-{now}.{extension}",
        std::process::id()
    ))
}

async fn resolve_llm_running(upstream: &str) -> bool {
    let upstream = upstream.trim_end_matches('/');
    let candidates = [
        format!("{upstream}/health"),
        openai_compatible_models_url(upstream),
    ];

    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    for url in candidates {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => return true,
            Ok(_) => {}
            Err(_) => {}
        }
    }

    false
}

async fn resolve_openai_compatible_running(base_url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    client
        .get(openai_compatible_models_url(base_url))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

async fn speech_state_speaking(state: &RosieSpeechState) -> Result<bool, String> {
    let mut guard = state.lock().await;
    let Some(child) = guard.as_mut() else {
        return Ok(false);
    };
    match child.try_wait() {
        Ok(Some(_)) => {
            *guard = None;
            Ok(false)
        }
        Ok(None) => Ok(true),
        Err(error) => {
            *guard = None;
            Err(format!("failed to inspect ROSIE speech state: {error}"))
        }
    }
}

async fn local_llm_status() -> RosieHostLlmStatus {
    let upstream_url = resolve_local_llm_base_url();
    let (host, port) = parsed_host_port(&upstream_url, "127.0.0.1", "8080");
    let model_path = resolve_llama_model_path();
    let model_present = model_path
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let running = resolve_llm_running(&upstream_url).await;
    let available = model_present && running;
    let unavailable_reason = if available {
        None
    } else if !model_present {
        Some("Local Gemma model file is missing".to_string())
    } else {
        Some("Local llama-server is not reachable".to_string())
    };

    RosieHostLlmStatus {
        runtime_name: "Local Gemma E4B via llama-server".to_string(),
        provider: RosieProviderMode::LocalGemma.as_str().to_string(),
        deployment_kind: "local".to_string(),
        base_url: upstream_url,
        host,
        port,
        model_name: resolve_local_llm_model_name(),
        model_path: model_path.map(|path| path.display().to_string()),
        model_present,
        sidecar_binary_present: resolve_llama_upstream_url().is_some(),
        running,
        available,
        unavailable_reason,
        context_hint: Some("Uses the approved local Gemma Host runtime.".to_string()),
        api_key_configured: None,
    }
}

async fn remote_lmstudio_llm_status() -> RosieHostLlmStatus {
    let base_url = resolve_remote_lmstudio_base_url();
    let (host, port) = parsed_host_port(&base_url, "127.0.0.1", "1234");
    let model_name = resolve_remote_lmstudio_model_name();
    let context_hint = std::env::var("ROSIE_REMOTE_LMSTUDIO_CONTEXT_HINT")
        .ok()
        .map(|value| format!("LM Studio context hint: {}", value.trim()))
        .filter(|value| !value.ends_with(": "));
    let model_present = !model_name.trim().is_empty();
    let running = resolve_openai_compatible_running(&base_url).await;
    let available = model_present && running;
    let unavailable_reason = if available {
        None
    } else if !model_present {
        Some("ROSIE_REMOTE_LMSTUDIO_MODEL is empty".to_string())
    } else {
        Some("Remote LM Studio OpenAI-compatible endpoint is not reachable".to_string())
    };

    RosieHostLlmStatus {
        runtime_name: "Remote LM Studio OpenAI-compatible endpoint".to_string(),
        provider: RosieProviderMode::RemoteLmStudio.as_str().to_string(),
        deployment_kind: "private_remote".to_string(),
        base_url,
        host,
        port,
        model_name,
        model_path: None,
        model_present,
        sidecar_binary_present: false,
        running,
        available,
        unavailable_reason,
        context_hint: context_hint.or_else(|| {
            Some(
                "ROSIE does not start LM Studio; start it on the work hub and expose the local server."
                    .to_string(),
            )
        }),
        api_key_configured: None,
    }
}

async fn openai_llm_status() -> RosieHostLlmStatus {
    let config = OpenAiConfig::default();
    let api_key_configured = !config.api_key.trim().is_empty();
    let (host, port) = parsed_host_port(&config.base_url, "api.openai.com", "443");
    let running = if api_key_configured {
        OpenAiClient::new(config.clone()).health_check().await
    } else {
        false
    };
    let available = api_key_configured && running;
    let unavailable_reason = if available {
        None
    } else if !api_key_configured {
        Some("OpenAI API key is not configured in Settings or OPENAI_API_KEY".to_string())
    } else {
        Some("OpenAI API was not reachable or rejected the configured key".to_string())
    };

    RosieHostLlmStatus {
        runtime_name: "OpenAI cloud Responses API".to_string(),
        provider: RosieProviderMode::OpenAiApi.as_str().to_string(),
        deployment_kind: "cloud".to_string(),
        base_url: config.base_url,
        host,
        port,
        model_name: config.llm_model,
        model_path: None,
        model_present: api_key_configured,
        sidecar_binary_present: false,
        running,
        available,
        unavailable_reason,
        context_hint: Some("API key stays server-side; the client never receives it.".to_string()),
        api_key_configured: Some(api_key_configured),
    }
}

async fn gemini_llm_status() -> RosieHostLlmStatus {
    let config = GeminiConfig::default();
    let api_key_configured = !config.api_key.trim().is_empty();
    let (host, port) =
        parsed_host_port(&config.base_url, "generativelanguage.googleapis.com", "443");
    let running = if api_key_configured {
        GeminiClient::new(config.clone()).health_check().await
    } else {
        false
    };
    let available = api_key_configured && running;
    let unavailable_reason = if available {
        None
    } else if !api_key_configured {
        Some("Gemini API key is not configured in Settings or GEMINI_API_KEY".to_string())
    } else {
        Some("Gemini API was not reachable or rejected the configured key".to_string())
    };

    RosieHostLlmStatus {
        runtime_name: "Gemini cloud generateContent".to_string(),
        provider: RosieProviderMode::GeminiApi.as_str().to_string(),
        deployment_kind: "cloud".to_string(),
        base_url: config.base_url,
        host,
        port,
        model_name: config.model,
        model_path: None,
        model_present: api_key_configured,
        sidecar_binary_present: false,
        running,
        available,
        unavailable_reason,
        context_hint: Some("API key stays server-side; the client never receives it.".to_string()),
        api_key_configured: Some(api_key_configured),
    }
}

async fn auto_llm_status(config: &RosieProviderConfig) -> RosieHostLlmStatus {
    let local = local_llm_status().await;
    if local.available {
        return local;
    }
    let remote = remote_lmstudio_llm_status().await;
    if remote.available {
        return remote;
    }

    match config.preferred_cloud_provider {
        Some(RosieProviderMode::OpenAiApi) => openai_llm_status().await,
        Some(RosieProviderMode::GeminiApi) => gemini_llm_status().await,
        _ => RosieHostLlmStatus {
            provider: RosieProviderMode::Auto.as_str().to_string(),
            runtime_name: "ROSIE auto provider selection".to_string(),
            deployment_kind: "auto".to_string(),
            base_url: local.base_url,
            host: local.host,
            port: local.port,
            model_name: local.model_name,
            model_path: local.model_path,
            model_present: local.model_present,
            sidecar_binary_present: local.sidecar_binary_present,
            running: false,
            available: false,
            unavailable_reason: Some(
                "Auto mode found no available local/private provider and no explicit cloud provider"
                    .to_string(),
            ),
            context_hint: Some(
                "Configure ROSIE_PROVIDER=local_llm, remote_lmstudio, openai, or gemini."
                    .to_string(),
            ),
            api_key_configured: None,
        },
    }
}

async fn llm_status_for_config(config: &RosieProviderConfig) -> RosieHostLlmStatus {
    match config.mode {
        RosieProviderMode::LocalGemma => local_llm_status().await,
        RosieProviderMode::RemoteLmStudio => remote_lmstudio_llm_status().await,
        RosieProviderMode::OpenAiApi => openai_llm_status().await,
        RosieProviderMode::GeminiApi => gemini_llm_status().await,
        RosieProviderMode::Auto => auto_llm_status(config).await,
    }
}

fn local_stt_status() -> RosieHostSttStatus {
    let asr_bin = resolve_asr_binary_path();
    let asr_native_present = command_exists(&asr_bin);
    let sensevoice_python_script = resolve_sensevoice_python_script();
    let sensevoice_python_present =
        resolve_speech_python_path().is_some() && sensevoice_python_script.is_some();
    let asr_present = asr_native_present || sensevoice_python_present;
    let sensevoice_model_path = resolve_sensevoice_model_path();
    let sensevoice_tokens_path = resolve_sensevoice_tokens_path();
    let model_present = sensevoice_model_path.is_some() && sensevoice_tokens_path.is_some();
    let available = asr_present && model_present;
    let unavailable_reason = if available {
        None
    } else if !asr_present {
        Some("SenseVoice executable/helper is missing".to_string())
    } else {
        Some("SenseVoice model or tokens are missing".to_string())
    };

    RosieHostSttStatus {
        engine_name: "SenseVoice Small via Sherpa-ONNX".to_string(),
        provider: RosieSpeechProviderMode::Local.as_str().to_string(),
        deployment_kind: "local".to_string(),
        active_engine: if available {
            "sensevoice".to_string()
        } else {
            "unavailable".to_string()
        },
        cli_path: speech_command_label(&asr_bin, sensevoice_python_script.as_deref()),
        cli_present: asr_present,
        model_name: "SenseVoice Small".to_string(),
        model_path: sensevoice_model_path
            .as_ref()
            .map(|path| path.display().to_string()),
        model_present,
        available,
        unavailable_reason,
        api_key_configured: None,
    }
}

fn local_tts_status(speaking: bool) -> RosieHostTtsStatus {
    let tts_bin = resolve_tts_binary_path();
    let tts_native_present = command_exists(&tts_bin);
    let kokoro_python_script = resolve_kokoro_python_script();
    let kokoro_python_present =
        resolve_speech_python_path().is_some() && kokoro_python_script.is_some();
    let tts_present = tts_native_present || kokoro_python_present;
    let kokoro_model_path = resolve_kokoro_model_path();
    let model_present = kokoro_model_path.is_some();
    let available = tts_present && model_present;
    let unavailable_reason = if available {
        None
    } else if !tts_present {
        Some("Kokoro executable/helper is missing".to_string())
    } else {
        Some("Kokoro model assets are missing".to_string())
    };

    RosieHostTtsStatus {
        engine_name: "Kokoro-82M via Sherpa-ONNX".to_string(),
        provider: RosieSpeechProviderMode::Local.as_str().to_string(),
        deployment_kind: "local".to_string(),
        active_engine: if available {
            "kokoro".to_string()
        } else {
            "unavailable".to_string()
        },
        command_path: speech_command_label(&tts_bin, kokoro_python_script.as_deref()),
        command_present: tts_present,
        model_name: "Kokoro-82M".to_string(),
        model_path: kokoro_model_path
            .as_ref()
            .map(|path| path.display().to_string()),
        model_present,
        speaking,
        available,
        unavailable_reason,
        api_key_configured: None,
    }
}

async fn openai_stt_status() -> RosieHostSttStatus {
    let config = OpenAiConfig::default();
    let api_key_configured = !config.api_key.trim().is_empty();
    let available = api_key_configured && !config.stt_model.trim().is_empty();
    RosieHostSttStatus {
        engine_name: "OpenAI cloud speech-to-text".to_string(),
        provider: RosieSpeechProviderMode::OpenAi.as_str().to_string(),
        deployment_kind: "cloud".to_string(),
        active_engine: if available {
            "openai".to_string()
        } else {
            "unavailable".to_string()
        },
        cli_path: "server-side API".to_string(),
        cli_present: false,
        model_name: config.stt_model,
        model_path: None,
        model_present: available,
        available,
        unavailable_reason: if available {
            None
        } else {
            Some("OpenAI speech-to-text is not configured in Settings or OPENAI_API_KEY / ROSIE_OPENAI_STT_MODEL".to_string())
        },
        api_key_configured: Some(api_key_configured),
    }
}

async fn gemini_stt_status() -> RosieHostSttStatus {
    let config = GeminiConfig::default();
    let api_key_configured = !config.api_key.trim().is_empty();
    let available = api_key_configured && !config.stt_model.trim().is_empty();
    RosieHostSttStatus {
        engine_name: "Gemini cloud speech-to-text".to_string(),
        provider: RosieSpeechProviderMode::Gemini.as_str().to_string(),
        deployment_kind: "cloud".to_string(),
        active_engine: if available {
            "gemini".to_string()
        } else {
            "unavailable".to_string()
        },
        cli_path: "server-side API".to_string(),
        cli_present: false,
        model_name: config.stt_model,
        model_path: None,
        model_present: available,
        available,
        unavailable_reason: if available {
            None
        } else {
            Some("Gemini speech-to-text is not configured in Settings or GEMINI_API_KEY / ROSIE_GEMINI_STT_MODEL".to_string())
        },
        api_key_configured: Some(api_key_configured),
    }
}

async fn openai_tts_status(speaking: bool) -> RosieHostTtsStatus {
    let config = OpenAiConfig::default();
    let api_key_configured = !config.api_key.trim().is_empty();
    let available = api_key_configured
        && !config.tts_model.trim().is_empty()
        && !config.tts_voice.trim().is_empty();
    RosieHostTtsStatus {
        engine_name: "OpenAI cloud text-to-speech".to_string(),
        provider: RosieSpeechProviderMode::OpenAi.as_str().to_string(),
        deployment_kind: "cloud".to_string(),
        active_engine: if available {
            config.tts_voice.clone()
        } else {
            "unavailable".to_string()
        },
        command_path: "server-side API".to_string(),
        command_present: false,
        model_name: config.tts_model,
        model_path: None,
        model_present: available,
        speaking,
        available,
        unavailable_reason: if available {
            None
        } else {
            Some("OpenAI speech output is not configured in Settings or OPENAI_API_KEY / ROSIE_OPENAI_TTS_MODEL / ROSIE_OPENAI_TTS_VOICE".to_string())
        },
        api_key_configured: Some(api_key_configured),
    }
}

async fn gemini_tts_status(speaking: bool) -> RosieHostTtsStatus {
    let config = GeminiConfig::default();
    let api_key_configured = !config.api_key.trim().is_empty();
    let available = api_key_configured
        && !config.tts_model.trim().is_empty()
        && !config.tts_voice.trim().is_empty();
    RosieHostTtsStatus {
        engine_name: "Gemini cloud text-to-speech".to_string(),
        provider: RosieSpeechProviderMode::Gemini.as_str().to_string(),
        deployment_kind: "cloud".to_string(),
        active_engine: if available {
            config.tts_voice.clone()
        } else {
            "unavailable".to_string()
        },
        command_path: "server-side API".to_string(),
        command_present: false,
        model_name: config.tts_model,
        model_path: None,
        model_present: available,
        speaking,
        available,
        unavailable_reason: if available {
            None
        } else {
            Some("Gemini speech output is not configured in Settings or GEMINI_API_KEY / ROSIE_GEMINI_TTS_MODEL / ROSIE_GEMINI_TTS_VOICE".to_string())
        },
        api_key_configured: Some(api_key_configured),
    }
}

async fn stt_status_for_config() -> RosieHostSttStatus {
    match stt_provider_mode() {
        RosieSpeechProviderMode::Local => local_stt_status(),
        RosieSpeechProviderMode::OpenAi => openai_stt_status().await,
        RosieSpeechProviderMode::Gemini => gemini_stt_status().await,
    }
}

async fn tts_status_for_config(speaking: bool) -> RosieHostTtsStatus {
    match tts_provider_mode() {
        RosieSpeechProviderMode::Local => local_tts_status(speaking),
        RosieSpeechProviderMode::OpenAi => openai_tts_status(speaking).await,
        RosieSpeechProviderMode::Gemini => gemini_tts_status(speaking).await,
    }
}

pub async fn runtime_status(state: &RosieSpeechState) -> Result<RosieHostRuntimeStatus, String> {
    let config = RosieProviderConfig::default();
    let speaking = speech_state_speaking(state).await?;
    Ok(RosieHostRuntimeStatus {
        llm: llm_status_for_config(&config).await,
        stt: stt_status_for_config().await,
        tts: tts_status_for_config(speaking).await,
    })
}

pub async fn transcribe_wav(audio_base64: &str) -> Result<String, String> {
    let audio_bytes = BASE64_STANDARD
        .decode(audio_base64)
        .map_err(|error| format!("invalid audio payload for ROSIE STT: {error}"))?;

    match stt_provider_mode() {
        RosieSpeechProviderMode::OpenAi => {
            let openai = OpenAiClient::from_env()?;
            return openai.transcribe_wav(&audio_bytes).await;
        }
        RosieSpeechProviderMode::Gemini => {
            let gemini = GeminiClient::from_env()?;
            return gemini.speech_to_text(&audio_bytes).await;
        }
        RosieSpeechProviderMode::Local => {}
    }

    let wav_path = temp_voice_prefix("voice-input", "wav");
    tokio::fs::write(&wav_path, audio_bytes)
        .await
        .map_err(|error| format!("failed to write ROSIE voice capture: {error}"))?;

    let result = transcribe_with_active_engine(&wav_path).await;
    let _ = tokio::fs::remove_file(&wav_path).await;
    result
}

async fn transcribe_with_active_engine(wav_path: &Path) -> Result<String, String> {
    let binary_path = resolve_asr_binary_path();
    let model_path = resolve_sensevoice_model_path();
    let tokens_path = resolve_sensevoice_tokens_path();

    if command_exists(&binary_path) && model_path.is_some() && tokens_path.is_some() {
        let model = model_path.unwrap();
        let tokens = tokens_path.unwrap();
        let output = tokio::process::Command::new(&binary_path)
            .args([
                &format!("--sense-voice-model={}", model.to_string_lossy()),
                &format!("--tokens={}", tokens.to_string_lossy()),
                "--num-threads=2",
                "--decoding-method=greedy_search",
                wav_path
                    .to_str()
                    .ok_or_else(|| "invalid wav path".to_string())?,
            ])
            .output()
            .await
            .map_err(|e| format!("failed to start ROSIE SenseVoice STT: {e}"))?;

        if output.status.success() {
            let stdout_str = String::from_utf8_lossy(&output.stdout);
            let transcript = parse_sherpa_onnx_offline_output(&stdout_str);
            if !transcript.is_empty() {
                return Ok(transcript);
            }
            return Err("ROSIE STT did not detect any speech in the audio.".to_string());
        } else {
            let stderr_str = String::from_utf8_lossy(&output.stderr);
            return Err(format!("SenseVoice STT failed: {}", stderr_str.trim()));
        }
    }

    if let (Some(python), Some(script), Some(model), Some(tokens)) = (
        resolve_speech_python_path(),
        resolve_sensevoice_python_script(),
        model_path,
        tokens_path,
    ) {
        let output = tokio::process::Command::new(&python)
            .arg(&script)
            .arg("--model")
            .arg(&model)
            .arg("--tokens")
            .arg(&tokens)
            .arg("--input")
            .arg(wav_path)
            .arg("--provider")
            .arg(resolve_sherpa_provider())
            .arg("--language")
            .arg("auto")
            .arg("--use-itn")
            .output()
            .await
            .map_err(|e| format!("failed to start ROSIE SenseVoice STT helper: {e}"))?;

        if output.status.success() {
            let stdout_str = String::from_utf8_lossy(&output.stdout);
            let transcript = stdout_str.trim().to_string();
            if !transcript.is_empty() {
                return Ok(transcript);
            }
            return Err("ROSIE STT did not detect any speech in the audio.".to_string());
        }

        let stderr_str = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SenseVoice STT failed: {}", stderr_str.trim()));
    }

    Err("ROSIE SenseVoice STT is not configured or binary is missing.".to_string())
}

async fn synthesize_kokoro_to_wav(
    text: &str,
    rate_multiplier: f32,
    voice: Option<&str>,
    temp_wav: &Path,
) -> Result<(), String> {
    let binary = resolve_tts_binary_path();
    let model_dir = resolve_kokoro_model_dir()
        .ok_or_else(|| "ROSIE Kokoro model directory is not configured.".to_string())?;
    let model_path = model_dir.join("model.onnx");
    let voices_path = model_dir.join("voices.bin");
    let tokens_path = model_dir.join("tokens.txt");
    let data_dir = model_dir.join("espeak-ng-data");

    if !model_path.exists() || !voices_path.exists() || !tokens_path.exists() || !data_dir.exists()
    {
        return Err("ROSIE Kokoro TTS model assets are missing.".to_string());
    }

    if command_exists(&binary) {
        let sid = voice.and_then(|v| v.parse::<i32>().ok()).unwrap_or(5);
        let output = tokio::process::Command::new(&binary)
            .args([
                &format!("--kokoro-model={}", model_path.to_string_lossy()),
                &format!("--kokoro-voices={}", voices_path.to_string_lossy()),
                &format!("--kokoro-tokens={}", tokens_path.to_string_lossy()),
                &format!("--kokoro-data-dir={}", data_dir.to_string_lossy()),
                &format!("--output-filename={}", temp_wav.to_string_lossy()),
                &format!("--sid={sid}"),
                &format!("--speed={rate_multiplier}"),
                text,
            ])
            .output()
            .await
            .map_err(|error| format!("failed to synthesize ROSIE speech: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = tokio::fs::remove_file(temp_wav).await;
        return Err(format!("ROSIE Kokoro TTS failed: {}", stderr.trim()));
    }

    if let (Some(python), Some(script)) =
        (resolve_speech_python_path(), resolve_kokoro_python_script())
    {
        let output = tokio::process::Command::new(&python)
            .arg(&script)
            .arg("--model-dir")
            .arg(&model_dir)
            .arg("--voice")
            .arg(voice.unwrap_or("adam"))
            .arg("--speed")
            .arg(rate_multiplier.to_string())
            .arg("--provider")
            .arg(resolve_sherpa_provider())
            .arg("--text")
            .arg(text)
            .arg("--output")
            .arg(temp_wav)
            .arg("--no-play")
            .output()
            .await
            .map_err(|error| format!("failed to synthesize ROSIE speech helper: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = tokio::fs::remove_file(temp_wav).await;
        return Err(format!("ROSIE Kokoro TTS failed: {}", stderr.trim()));
    }

    Err("ROSIE Kokoro TTS is not configured or binary is missing.".to_string())
}

pub async fn start_tts(
    state: &RosieSpeechState,
    text: &str,
    rate: Option<f32>,
    voice: Option<&str>,
) -> Result<String, String> {
    if tts_provider_mode() == RosieSpeechProviderMode::OpenAi {
        let audio_bytes = OpenAiClient::from_env()?
            .synthesize_wav(text, voice, rate)
            .await?;
        let existing_child = {
            let mut guard = state.lock().await;
            guard.take()
        };
        if let Some(mut child) = existing_child {
            let _ = child.kill().await;
        }
        let temp_wav = temp_voice_prefix("tts-openai", "wav");
        tokio::fs::write(&temp_wav, audio_bytes)
            .await
            .map_err(|error| format!("failed to write OpenAI ROSIE speech: {error}"))?;
        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("powershell.exe");
            c.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$player = New-Object Media.SoundPlayer $args[0]; $player.PlaySync(); Remove-Item -LiteralPath $args[0] -ErrorAction SilentlyContinue",
            ]);
            c.arg(&temp_wav);
            c
        } else {
            let mut c = tokio::process::Command::new("afplay");
            c.arg(&temp_wav);
            c
        };
        let child = cmd
            .spawn()
            .map_err(|error| format!("failed to spawn OpenAI ROSIE speech playback: {error}"))?;
        *state.lock().await = Some(child);
        return Ok("ROSIE OpenAI TTS started".to_string());
    }
    if tts_provider_mode() == RosieSpeechProviderMode::Gemini {
        let audio_bytes = GeminiClient::from_env()?
            .text_to_speech(text, voice.unwrap_or(""))
            .await?;
        let existing_child = {
            let mut guard = state.lock().await;
            guard.take()
        };
        if let Some(mut child) = existing_child {
            let _ = child.kill().await;
        }
        let temp_wav = temp_voice_prefix("tts-gemini", "wav");
        tokio::fs::write(&temp_wav, audio_bytes)
            .await
            .map_err(|error| format!("failed to write Gemini ROSIE speech: {error}"))?;
        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("powershell.exe");
            c.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$player = New-Object Media.SoundPlayer $args[0]; $player.PlaySync(); Remove-Item -LiteralPath $args[0] -ErrorAction SilentlyContinue",
            ]);
            c.arg(&temp_wav);
            c
        } else {
            let mut c = tokio::process::Command::new("afplay");
            c.arg(&temp_wav);
            c
        };
        let child = cmd
            .spawn()
            .map_err(|error| format!("failed to spawn Gemini ROSIE speech playback: {error}"))?;
        *state.lock().await = Some(child);
        return Ok("ROSIE Gemini TTS started".to_string());
    }

    let rate_multiplier = rate.unwrap_or(1.0).clamp(0.8, 1.2);

    let existing_child = {
        let mut guard = state.lock().await;
        guard.take()
    };
    if let Some(mut child) = existing_child {
        let _ = child.kill().await;
    }

    let temp_wav = temp_voice_prefix("tts-speak", "wav");
    synthesize_kokoro_to_wav(text, rate_multiplier, voice, &temp_wav).await?;

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$player = New-Object Media.SoundPlayer $args[0]; $player.PlaySync(); Remove-Item -LiteralPath $args[0] -ErrorAction SilentlyContinue",
        ]);
        c.arg(&temp_wav);
        c
    } else {
        let mut c = tokio::process::Command::new("afplay");
        c.arg(&temp_wav);
        c
    };

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn TTS process: {e}"))?;

    *state.lock().await = Some(child);
    Ok("ROSIE TTS started".to_string())
}

pub async fn synthesize_tts_wav_base64(
    text: &str,
    rate: Option<f32>,
    voice: Option<&str>,
) -> Result<String, String> {
    if tts_provider_mode() == RosieSpeechProviderMode::OpenAi {
        let audio_bytes = OpenAiClient::from_env()?
            .synthesize_wav(text, voice, rate)
            .await?;
        return Ok(BASE64_STANDARD.encode(audio_bytes));
    }
    if tts_provider_mode() == RosieSpeechProviderMode::Gemini {
        let audio_bytes = GeminiClient::from_env()?
            .text_to_speech(text, voice.unwrap_or(""))
            .await?;
        return Ok(BASE64_STANDARD.encode(audio_bytes));
    }

    let rate_multiplier = rate.unwrap_or(1.0).clamp(0.8, 1.2);
    let temp_wav = temp_voice_prefix("tts-synth", "wav");
    synthesize_kokoro_to_wav(text, rate_multiplier, voice, &temp_wav).await?;

    let audio_bytes = tokio::fs::read(&temp_wav)
        .await
        .map_err(|error| format!("failed to read ROSIE synthesized speech: {error}"))?;
    let _ = tokio::fs::remove_file(&temp_wav).await;

    Ok(BASE64_STANDARD.encode(audio_bytes))
}

pub async fn stop_tts(state: &RosieSpeechState) -> Result<String, String> {
    let mut guard = state.lock().await;
    let Some(mut child) = guard.take() else {
        return Ok("ROSIE TTS was not speaking".to_string());
    };

    child
        .kill()
        .await
        .map_err(|error| format!("failed to stop ROSIE TTS: {error}"))?;

    Ok("ROSIE TTS stopped".to_string())
}

pub async fn tts_status(state: &RosieSpeechState) -> Result<bool, String> {
    speech_state_speaking(state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex as StdMutex, MutexGuard};

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    fn env_lock() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[tokio::test]
    async fn openai_transcribe_fails_on_missing_key_before_local_stt() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_STT_PROVIDER", "openai");
        std::env::remove_var("OPENAI_API_KEY");

        let result = transcribe_wav(&BASE64_STANDARD.encode(b"not-a-real-wav")).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("OPENAI_API_KEY"));
        std::env::remove_var("ROSIE_STT_PROVIDER");
    }

    #[tokio::test]
    async fn openai_tts_fails_on_missing_key_before_kokoro() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_TTS_PROVIDER", "openai");
        std::env::remove_var("OPENAI_API_KEY");

        let result = synthesize_tts_wav_base64("hello", None, None).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("OPENAI_API_KEY"));
        std::env::remove_var("ROSIE_TTS_PROVIDER");
    }

    #[tokio::test]
    async fn gemini_transcribe_fails_on_missing_key_before_local_stt() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_STT_PROVIDER", "gemini");
        std::env::remove_var("GEMINI_API_KEY");

        let result = transcribe_wav(&BASE64_STANDARD.encode(b"not-a-real-wav")).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("GEMINI_API_KEY"));
        std::env::remove_var("ROSIE_STT_PROVIDER");
    }

    #[tokio::test]
    async fn gemini_tts_fails_on_missing_key_before_kokoro() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_TTS_PROVIDER", "gemini");
        std::env::remove_var("GEMINI_API_KEY");

        let result = synthesize_tts_wav_base64("hello", None, None).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("GEMINI_API_KEY"));
        std::env::remove_var("ROSIE_TTS_PROVIDER");
    }

    #[tokio::test]
    async fn runtime_status_reports_unreachable_remote_lmstudio() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER", "remote_lmstudio");
        std::env::set_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL", "http://127.0.0.1:9/v1");
        std::env::set_var("ROSIE_REMOTE_LMSTUDIO_MODEL", "gemma-4-12B-it-q5_k_m.gguf");
        std::env::set_var("ROSIE_STT_PROVIDER", "local");
        std::env::set_var("ROSIE_TTS_PROVIDER", "local");

        let state = Arc::new(Mutex::new(None));
        let status = runtime_status(&state).await.expect("runtime status");

        assert_eq!(status.llm.provider, "remote_lmstudio");
        assert_eq!(status.llm.deployment_kind, "private_remote");
        assert!(!status.llm.available);
        assert!(status.llm.model_path.is_none());
        assert!(status
            .llm
            .unavailable_reason
            .unwrap_or_default()
            .contains("Remote LM Studio"));

        std::env::remove_var("ROSIE_PROVIDER");
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_BASE_URL");
        std::env::remove_var("ROSIE_REMOTE_LMSTUDIO_MODEL");
        std::env::remove_var("ROSIE_STT_PROVIDER");
        std::env::remove_var("ROSIE_TTS_PROVIDER");
    }

    #[tokio::test]
    async fn runtime_status_reports_openai_missing_key_without_secret() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_PROVIDER", "openai");
        std::env::remove_var("OPENAI_API_KEY");

        let state = Arc::new(Mutex::new(None));
        let status = runtime_status(&state).await.expect("runtime status");

        assert_eq!(status.llm.provider, "openai");
        assert_eq!(status.llm.api_key_configured, Some(false));
        assert!(!status.llm.available);
        assert_eq!(
            status.llm.unavailable_reason.as_deref(),
            Some("OpenAI API key is not configured in Settings or OPENAI_API_KEY")
        );

        std::env::remove_var("ROSIE_PROVIDER");
    }

    #[tokio::test]
    async fn runtime_status_reports_selected_speech_providers() {
        let _guard = env_lock();
        std::env::set_var("ROSIE_STT_PROVIDER", "openai");
        std::env::set_var("ROSIE_TTS_PROVIDER", "gemini");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("GEMINI_API_KEY");

        let state = Arc::new(Mutex::new(None));
        let status = runtime_status(&state).await.expect("runtime status");

        assert_eq!(status.stt.provider, "openai");
        assert_eq!(status.tts.provider, "gemini");
        assert_eq!(status.stt.api_key_configured, Some(false));
        assert_eq!(status.tts.api_key_configured, Some(false));

        std::env::remove_var("ROSIE_STT_PROVIDER");
        std::env::remove_var("ROSIE_TTS_PROVIDER");
    }
}
