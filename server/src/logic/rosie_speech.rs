use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Child;
use tokio::sync::Mutex;
use url::Url;

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
    pub base_url: String,
    pub host: String,
    pub port: String,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub sidecar_binary_present: bool,
    pub running: bool,
}

#[derive(Debug, Serialize)]
pub struct RosieHostSttStatus {
    pub engine_name: String,
    pub provider: String,
    pub active_engine: String,
    pub cli_path: String,
    pub cli_present: bool,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
}

#[derive(Debug, Serialize)]
pub struct RosieHostTtsStatus {
    pub engine_name: String,
    pub provider: String,
    pub active_engine: String,
    pub command_path: String,
    pub command_present: bool,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub speaking: bool,
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

fn resolve_llama_provider() -> String {
    std::env::var("RIVERSIDE_LLAMA_PROVIDER").unwrap_or_else(|_| "llama.cpp".into())
}

fn resolve_llama_upstream_url() -> Option<String> {
    std::env::var("RIVERSIDE_LLAMA_UPSTREAM")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn command_exists(path: &Path) -> bool {
    path.exists() && path.is_file()
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
    let candidates = [
        format!("{upstream}/health"),
        format!("{upstream}/v1/models"),
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

pub async fn runtime_status(state: &RosieSpeechState) -> Result<RosieHostRuntimeStatus, String> {
    let upstream_url =
        resolve_llama_upstream_url().unwrap_or_else(|| "http://127.0.0.1:8080".to_string());
    let parsed_upstream = Url::parse(&upstream_url).ok();
    let host = parsed_upstream
        .as_ref()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = parsed_upstream
        .as_ref()
        .and_then(Url::port)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "8080".to_string());

    let asr_bin = resolve_asr_binary_path();
    let asr_present = command_exists(&asr_bin);
    let sensevoice_model_path = resolve_sensevoice_model_path();
    let sensevoice_tokens_path = resolve_sensevoice_tokens_path();
    let sensevoice_ready =
        asr_present && sensevoice_model_path.is_some() && sensevoice_tokens_path.is_some();

    let tts_bin = resolve_tts_binary_path();
    let tts_present = command_exists(&tts_bin);
    let kokoro_model_path = resolve_kokoro_model_path();
    let kokoro_ready = tts_present && kokoro_model_path.is_some();

    let speaking = speech_state_speaking(state).await?;

    Ok(RosieHostRuntimeStatus {
        llm: RosieHostLlmStatus {
            runtime_name: "Host llama-server upstream".to_string(),
            provider: resolve_llama_provider(),
            base_url: upstream_url.clone(),
            host,
            port,
            model_name: "Gemma 4 E4B".to_string(),
            model_path: resolve_llama_model_path().map(|path| path.display().to_string()),
            model_present: resolve_llama_model_path()
                .map(|path| path.exists())
                .unwrap_or(false),
            sidecar_binary_present: resolve_llama_upstream_url().is_some(),
            running: resolve_llm_running(&upstream_url).await,
        },
        stt: RosieHostSttStatus {
            engine_name: "SenseVoice Small via Sherpa-ONNX".to_string(),
            provider: "sherpa-onnx".to_string(),
            active_engine: if sensevoice_ready {
                "sensevoice".to_string()
            } else {
                "unavailable".to_string()
            },
            cli_path: asr_bin.display().to_string(),
            cli_present: asr_present,
            model_name: "SenseVoice Small".to_string(),
            model_path: sensevoice_model_path
                .as_ref()
                .map(|path| path.display().to_string()),
            model_present: sensevoice_model_path.is_some() && sensevoice_tokens_path.is_some(),
        },
        tts: RosieHostTtsStatus {
            engine_name: "Kokoro-82M via Sherpa-ONNX".to_string(),
            provider: "sherpa-onnx".to_string(),
            active_engine: if kokoro_ready {
                "kokoro".to_string()
            } else {
                "unavailable".to_string()
            },
            command_path: tts_bin.display().to_string(),
            command_present: tts_present,
            model_name: "Kokoro-82M".to_string(),
            model_path: kokoro_model_path
                .as_ref()
                .map(|path| path.display().to_string()),
            model_present: kokoro_model_path.is_some(),
            speaking,
        },
    })
}

pub async fn transcribe_wav(audio_base64: &str) -> Result<String, String> {
    let audio_bytes = BASE64_STANDARD
        .decode(audio_base64)
        .map_err(|error| format!("invalid audio payload for ROSIE STT: {error}"))?;

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

    Err("ROSIE SenseVoice STT is not configured or binary is missing.".to_string())
}

pub async fn start_tts(
    state: &RosieSpeechState,
    text: &str,
    rate: Option<f32>,
    voice: Option<&str>,
) -> Result<String, String> {
    let rate_multiplier = rate.unwrap_or(1.0).clamp(0.8, 1.2);

    let mut guard = state.lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }

    let binary = resolve_tts_binary_path();
    let model_dir = resolve_kokoro_model_dir().ok_or("Kokoro model dir not found")?;
    let model_path = model_dir.join("model.onnx");
    let voices_path = model_dir.join("voices.bin");
    let tokens_path = model_dir.join("tokens.txt");
    let data_dir = model_dir.join("espeak-ng-data");

    if !command_exists(&binary) || !model_path.exists() {
        return Err("ROSIE Kokoro TTS is not configured or binary is missing.".to_string());
    }

    let temp_wav = temp_voice_prefix("tts-speak", "wav");
    let sid = voice.and_then(|v| v.parse::<i32>().ok()).unwrap_or(5);

    let sid_str = sid.to_string();
    let speed_str = rate_multiplier.to_string();

    let mut cmd = if cfg!(windows) {
        let cmd_str = format!(
            "\"{}\" --kokoro-model=\"{}\" --kokoro-voices=\"{}\" --kokoro-tokens=\"{}\" --kokoro-data-dir=\"{}\" --output-filename=\"{}\" --sid={} --speed={} \"{}\" && powershell -c \"(New-Object Media.SoundPlayer '{}').PlaySync()\"",
            binary.to_string_lossy(),
            model_path.to_string_lossy(),
            voices_path.to_string_lossy(),
            tokens_path.to_string_lossy(),
            data_dir.to_string_lossy(),
            temp_wav.to_string_lossy(),
            sid_str,
            speed_str,
            text.replace('"', "\\\""),
            temp_wav.to_string_lossy()
        );
        let mut c = tokio::process::Command::new("cmd.exe");
        c.args(["/C", &cmd_str]);
        c
    } else {
        let cmd_str = format!(
            "\"{}\" --kokoro-model=\"{}\" --kokoro-voices=\"{}\" --kokoro-tokens=\"{}\" --kokoro-data-dir=\"{}\" --output-filename=\"{}\" --sid={} --speed={} \"{}\" && afplay \"{}\"",
            binary.to_string_lossy(),
            model_path.to_string_lossy(),
            voices_path.to_string_lossy(),
            tokens_path.to_string_lossy(),
            data_dir.to_string_lossy(),
            temp_wav.to_string_lossy(),
            sid_str,
            speed_str,
            text.replace('"', "\\\""),
            temp_wav.to_string_lossy()
        );
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &cmd_str]);
        c
    };

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn TTS process: {e}"))?;

    *guard = Some(child);
    Ok("ROSIE TTS started".to_string())
}

pub async fn synthesize_tts_wav_base64(
    text: &str,
    rate: Option<f32>,
    voice: Option<&str>,
) -> Result<String, String> {
    let rate_multiplier = rate.unwrap_or(1.0).clamp(0.8, 1.2);
    let binary = resolve_tts_binary_path();
    let model_dir = resolve_kokoro_model_dir()
        .ok_or_else(|| "ROSIE Kokoro model directory is not configured.".to_string())?;

    if !command_exists(&binary) || resolve_kokoro_model_path().is_none() {
        return Err("ROSIE Kokoro TTS is not available.".to_string());
    }

    let model_path = model_dir.join("model.onnx");
    let voices_path = model_dir.join("voices.bin");
    let tokens_path = model_dir.join("tokens.txt");
    let data_dir = model_dir.join("espeak-ng-data");

    let sid = voice.and_then(|v| v.parse::<i32>().ok()).unwrap_or(5);

    let temp_wav = temp_voice_prefix("tts-synth", "wav");

    let output = tokio::process::Command::new(&binary)
        .args([
            &format!("--kokoro-model={}", model_path.to_string_lossy()),
            &format!("--kokoro-voices={}", voices_path.to_string_lossy()),
            &format!("--kokoro-tokens={}", tokens_path.to_string_lossy()),
            &format!("--kokoro-data-dir={}", data_dir.to_string_lossy()),
            &format!("--output-filename={}", temp_wav.to_string_lossy()),
            &format!("--sid={}", sid),
            &format!("--speed={}", rate_multiplier),
            text,
        ])
        .output()
        .await
        .map_err(|error| format!("failed to synthesize ROSIE speech: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = tokio::fs::remove_file(&temp_wav).await;
        return Err(format!("ROSIE Kokoro TTS failed: {}", stderr.trim()));
    }

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
