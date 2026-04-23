use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub struct RosieSpeechState(pub Mutex<Option<tokio::process::Child>>);

impl Default for RosieSpeechState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Serialize)]
pub struct RosieLocalRuntimeStatus {
    pub llm: RosieLocalLlmStatus,
    pub stt: RosieLocalSttStatus,
    pub tts: RosieLocalTtsStatus,
}

#[derive(Debug, Serialize)]
pub struct RosieLocalLlmStatus {
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
pub struct RosieLocalSttStatus {
    pub engine_name: String,
    pub provider: String,
    pub active_engine: String,
    pub cli_path: String,
    pub cli_present: bool,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub fallback_engine_name: String,
    pub fallback_cli_path: String,
    pub fallback_cli_present: bool,
    pub fallback_model_path: Option<String>,
    pub fallback_model_present: bool,
}

#[derive(Debug, Serialize)]
pub struct RosieLocalTtsStatus {
    pub engine_name: String,
    pub provider: String,
    pub active_engine: String,
    pub command_path: String,
    pub command_present: bool,
    pub model_name: String,
    pub model_path: Option<String>,
    pub model_present: bool,
    pub fallback_engine_name: String,
    pub fallback_command_path: String,
    pub fallback_command_present: bool,
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

fn default_rosie_llm_model_path() -> Option<PathBuf> {
    rosie_host_dir().map(|root| {
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
    std::env::var("RIVERSIDE_SENSEVOICE_MODEL_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            rosie_host_dir().map(|root| {
                root.join("stt")
                    .join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17")
            })
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

fn resolve_rosie_speech_python_path() -> PathBuf {
    std::env::var("RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/Users/cpg/.local/share/uv/tools/sherpa-onnx/bin/python"))
}

fn resolve_whisper_model_path() -> Option<PathBuf> {
    std::env::var("RIVERSIDE_WHISPER_MODEL_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| rosie_host_dir().map(|root| root.join("models").join("ggml-small.en.bin")))
        .filter(|path| path.exists())
        .or_else(|| {
            home_dir().map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("superwhisper")
                    .join("ggml-small.en.bin")
            })
        })
        .filter(|path| path.exists())
}

fn resolve_whisper_cli_path() -> PathBuf {
    std::env::var("RIVERSIDE_WHISPER_CLI_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/opt/homebrew/bin/whisper-cli"))
}

fn resolve_kokoro_model_dir() -> Option<PathBuf> {
    std::env::var("RIVERSIDE_KOKORO_MODEL_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| rosie_host_dir().map(|root| root.join("tts").join("kokoro-multi-lang-v1_0")))
}

fn resolve_kokoro_model_path() -> Option<PathBuf> {
    resolve_kokoro_model_dir()
        .map(|dir| dir.join("model.onnx"))
        .filter(|path| path.exists())
}

fn resolve_tts_fallback_command_path() -> PathBuf {
    std::env::var("RIVERSIDE_TTS_FALLBACK_COMMAND_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/usr/bin/say"))
}

fn resolve_sherpa_provider() -> String {
    std::env::var("RIVERSIDE_SHERPA_PROVIDER").unwrap_or_else(|_| "cpu".into())
}

fn resolve_llama_provider() -> String {
    std::env::var("RIVERSIDE_LLAMA_PROVIDER").unwrap_or_else(|_| "llama.cpp".into())
}

fn rosie_llama_base_url() -> (String, String, String) {
    let host = std::env::var("RIVERSIDE_LLAMA_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("RIVERSIDE_LLAMA_PORT").unwrap_or_else(|_| "8080".into());
    (format!("http://{host}:{port}"), host, port)
}

fn command_exists(path: &Path) -> bool {
    path.exists() && path.is_file()
}

fn bundled_script_path(name: &str) -> Option<PathBuf> {
    let repo_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
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

#[tauri::command]
pub fn rosie_local_runtime_status(
    app: AppHandle,
    llama_state: tauri::State<'_, crate::llama_server::LlamaSidecarState>,
    speech_state: tauri::State<'_, RosieSpeechState>,
) -> Result<RosieLocalRuntimeStatus, String> {
    let llama_running = crate::llama_server::rosie_llama_status(llama_state)?;
    let (base_url, host, port) = rosie_llama_base_url();
    let resource_binary = app.path().resource_dir().ok().and_then(|dir| {
        let candidates: Vec<PathBuf> = vec![
            dir.join("binaries").join(format!(
                "llama-server-{}-apple-darwin",
                std::env::consts::ARCH
            )),
            dir.join("llama-server"),
        ];
        candidates.into_iter().find(|path| path.exists())
    });
    let dev_candidates: Vec<PathBuf> = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "llama-server-{}-apple-darwin",
                std::env::consts::ARCH
            )),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("llama-server-aarch64-apple-darwin"),
    ];
    let dev_binary = dev_candidates.into_iter().find(|path| path.exists());
    let sidecar_binary_present = resource_binary.is_some() || dev_binary.is_some();

    let sensevoice_python = resolve_rosie_speech_python_path();
    let sensevoice_script_present = bundled_script_path("rosie_sensevoice_transcribe.py").is_some();
    let sensevoice_model_path = resolve_sensevoice_model_path();
    let sensevoice_tokens_path = resolve_sensevoice_tokens_path();
    let sensevoice_ready = command_exists(&sensevoice_python)
        && sensevoice_script_present
        && sensevoice_model_path.is_some()
        && sensevoice_tokens_path.is_some();

    let whisper_cli_path = resolve_whisper_cli_path();
    let whisper_model_path = resolve_whisper_model_path();

    let kokoro_python = resolve_rosie_speech_python_path();
    let kokoro_script_present = bundled_script_path("rosie_kokoro_tts.py").is_some();
    let kokoro_model_path = resolve_kokoro_model_path();
    let kokoro_ready =
        command_exists(&kokoro_python) && kokoro_script_present && kokoro_model_path.is_some();

    let tts_fallback_command_path = resolve_tts_fallback_command_path();
    let speaking = speech_state
        .0
        .lock()
        .map_err(|_| "ROSIE speech state lock poisoned".to_string())?
        .is_some();

    Ok(RosieLocalRuntimeStatus {
        llm: RosieLocalLlmStatus {
            runtime_name: "llama.cpp llama-server".to_string(),
            provider: resolve_llama_provider(),
            base_url,
            host,
            port,
            model_name: "Gemma 4 E4B".to_string(),
            model_path: resolve_llama_model_path().map(|path| path.display().to_string()),
            model_present: resolve_llama_model_path()
                .map(|path| path.exists())
                .unwrap_or(false),
            sidecar_binary_present,
            running: llama_running,
        },
        stt: RosieLocalSttStatus {
            engine_name: "SenseVoice Small via Sherpa-ONNX".to_string(),
            provider: resolve_sherpa_provider(),
            active_engine: if sensevoice_ready {
                "sensevoice".to_string()
            } else if command_exists(&whisper_cli_path)
                && whisper_model_path
                    .as_ref()
                    .map(|path| path.exists())
                    .unwrap_or(false)
            {
                "whisper_fallback".to_string()
            } else {
                "unavailable".to_string()
            },
            cli_path: sensevoice_python.display().to_string(),
            cli_present: command_exists(&sensevoice_python) && sensevoice_script_present,
            model_name: "SenseVoice Small".to_string(),
            model_path: sensevoice_model_path
                .as_ref()
                .map(|path| path.display().to_string()),
            model_present: sensevoice_model_path.is_some() && sensevoice_tokens_path.is_some(),
            fallback_engine_name: "whisper.cpp".to_string(),
            fallback_cli_path: whisper_cli_path.display().to_string(),
            fallback_cli_present: command_exists(&whisper_cli_path),
            fallback_model_path: whisper_model_path.map(|path| path.display().to_string()),
            fallback_model_present: resolve_whisper_model_path()
                .map(|path| path.exists())
                .unwrap_or(false),
        },
        tts: RosieLocalTtsStatus {
            engine_name: "Kokoro-82M via Sherpa-ONNX".to_string(),
            provider: resolve_sherpa_provider(),
            active_engine: if kokoro_ready {
                "kokoro".to_string()
            } else if command_exists(&tts_fallback_command_path) {
                "host_fallback".to_string()
            } else {
                "unavailable".to_string()
            },
            command_path: kokoro_python.display().to_string(),
            command_present: command_exists(&kokoro_python) && kokoro_script_present,
            model_name: "Kokoro-82M".to_string(),
            model_path: kokoro_model_path
                .as_ref()
                .map(|path| path.display().to_string()),
            model_present: kokoro_model_path.is_some(),
            fallback_engine_name: "Host speech command".to_string(),
            fallback_command_path: tts_fallback_command_path.display().to_string(),
            fallback_command_present: command_exists(&tts_fallback_command_path),
            speaking,
        },
    })
}

#[tauri::command]
pub async fn rosie_transcribe_wav(audio_base64: String) -> Result<String, String> {
    let audio_bytes = BASE64_STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("invalid audio payload for ROSIE STT: {e}"))?;

    let wav_path = temp_voice_prefix("voice-input", "wav");
    tokio::fs::write(&wav_path, audio_bytes)
        .await
        .map_err(|e| format!("failed to write ROSIE voice capture: {e}"))?;

    let result = transcribe_with_active_engine(&wav_path).await;

    let _ = tokio::fs::remove_file(&wav_path).await;
    result
}

async fn transcribe_with_active_engine(wav_path: &Path) -> Result<String, String> {
    if let (Some(script_path), Some(model_path), Some(tokens_path)) = (
        bundled_script_path("rosie_sensevoice_transcribe.py"),
        resolve_sensevoice_model_path(),
        resolve_sensevoice_tokens_path(),
    ) {
        let python_path = resolve_rosie_speech_python_path();
        if command_exists(&python_path) {
            let provider = resolve_sherpa_provider();
            let output = tokio::process::Command::new(&python_path)
                .arg(script_path)
                .args([
                    "--model",
                    model_path
                        .to_str()
                        .ok_or_else(|| "invalid SenseVoice model path".to_string())?,
                    "--tokens",
                    tokens_path
                        .to_str()
                        .ok_or_else(|| "invalid SenseVoice tokens path".to_string())?,
                    "--input",
                    wav_path
                        .to_str()
                        .ok_or_else(|| "invalid ROSIE voice capture path".to_string())?,
                    "--provider",
                    provider.as_str(),
                    "--language",
                    "en",
                    "--use-itn",
                ])
                .output()
                .await
                .map_err(|e| format!("failed to start ROSIE SenseVoice STT: {e}"))?;

            if output.status.success() {
                let transcript = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !transcript.is_empty() {
                    return Ok(transcript);
                }
            } else {
                log::warn!(
                    target: "rosie_voice",
                    "SenseVoice STT failed, trying whisper fallback: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
        }
    }

    let whisper_cli = resolve_whisper_cli_path();
    if !command_exists(&whisper_cli) {
        return Err(format!(
            "ROSIE STT engine is not installed at {}",
            whisper_cli.display()
        ));
    }

    let whisper_model = resolve_whisper_model_path().ok_or_else(|| {
        "SenseVoice is not configured and no whisper fallback model was found".to_string()
    })?;
    if !whisper_model.exists() {
        return Err(format!(
            "ROSIE whisper fallback model is missing at {}",
            whisper_model.display()
        ));
    }

    let output_prefix = temp_voice_prefix("voice-output", "txt");
    let output_stem = output_prefix.with_extension("");

    let output = tokio::process::Command::new(&whisper_cli)
        .args([
            "-m",
            whisper_model
                .to_str()
                .ok_or_else(|| "invalid whisper model path".to_string())?,
            "-f",
            wav_path
                .to_str()
                .ok_or_else(|| "invalid voice capture path".to_string())?,
            "-l",
            "en",
            "-otxt",
            "-of",
            output_stem
                .to_str()
                .ok_or_else(|| "invalid whisper output path".to_string())?,
            "-np",
            "-nt",
        ])
        .output()
        .await
        .map_err(|e| format!("failed to start ROSIE whisper fallback: {e}"))?;

    let transcript_path = output_stem.with_extension("txt");
    let transcript = tokio::fs::read_to_string(&transcript_path)
        .await
        .map_err(|e| format!("failed to read ROSIE whisper transcript: {e}"))?;
    let _ = tokio::fs::remove_file(&transcript_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ROSIE whisper fallback failed: {}", stderr.trim()));
    }

    let normalized = transcript.trim().to_string();
    if normalized.is_empty() {
        return Err("ROSIE STT did not detect any speech.".to_string());
    }

    Ok(normalized)
}

#[tauri::command]
pub async fn rosie_tts_speak(
    state: tauri::State<'_, RosieSpeechState>,
    text: String,
    rate: Option<f32>,
    voice: Option<String>,
) -> Result<String, String> {
    let rate_multiplier = rate.unwrap_or(1.0).clamp(0.8, 1.2);

    let existing_child = state
        .0
        .lock()
        .map_err(|_| "ROSIE speech state lock poisoned".to_string())?
        .take();

    if let Some(mut child) = existing_child {
        let _ = child.kill().await;
    }

    let child = if let (Some(script_path), Some(model_dir)) = (
        bundled_script_path("rosie_kokoro_tts.py"),
        resolve_kokoro_model_dir(),
    ) {
        let python_path = resolve_rosie_speech_python_path();
        if command_exists(&python_path) && resolve_kokoro_model_path().is_some() {
            let voice_name = voice
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("adam")
                .to_string();
            let speed = rate_multiplier.to_string();
            let provider = resolve_sherpa_provider();
            tokio::process::Command::new(&python_path)
                .arg(script_path)
                .args([
                    "--model-dir",
                    model_dir
                        .to_str()
                        .ok_or_else(|| "invalid Kokoro model directory".to_string())?,
                    "--voice",
                    voice_name.as_str(),
                    "--speed",
                    speed.as_str(),
                    "--provider",
                    provider.as_str(),
                    "--text",
                    text.as_str(),
                ])
                .spawn()
                .map_err(|e| format!("failed to start ROSIE Kokoro TTS: {e}"))?
        } else {
            let command_path = resolve_tts_fallback_command_path();
            fallback_tts_process(&command_path, &text, rate_multiplier)?
        }
    } else {
        let command_path = resolve_tts_fallback_command_path();
        fallback_tts_process(&command_path, &text, rate_multiplier)?
    };

    *state
        .0
        .lock()
        .map_err(|_| "ROSIE speech state lock poisoned".to_string())? = Some(child);

    Ok("ROSIE TTS started".to_string())
}

fn fallback_tts_process(
    command_path: &Path,
    text: &str,
    rate_multiplier: f32,
) -> Result<tokio::process::Child, String> {
    if !command_exists(command_path) {
        return Err(format!(
            "ROSIE TTS engine is not available at {}",
            command_path.display()
        ));
    }

    let words_per_minute = (175.0 * rate_multiplier).round().to_string();

    tokio::process::Command::new(command_path)
        .args(["-r", &words_per_minute, text])
        .spawn()
        .map_err(|e| format!("failed to start ROSIE TTS fallback: {e}"))
}

#[tauri::command]
pub async fn rosie_tts_stop(state: tauri::State<'_, RosieSpeechState>) -> Result<String, String> {
    let child = state
        .0
        .lock()
        .map_err(|_| "ROSIE speech state lock poisoned".to_string())?
        .take();

    let Some(mut child) = child else {
        return Ok("ROSIE TTS was not speaking".to_string());
    };

    child
        .kill()
        .await
        .map_err(|e| format!("failed to stop ROSIE TTS: {e}"))?;

    Ok("ROSIE TTS stopped".to_string())
}

#[tauri::command]
pub fn rosie_tts_status(state: tauri::State<'_, RosieSpeechState>) -> Result<bool, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "ROSIE speech state lock poisoned".to_string())?;
    Ok(guard.is_some())
}
