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

fn rosie_llama_base_url() -> (String, String, String) {
    let host = std::env::var("RIVERSIDE_LLAMA_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("RIVERSIDE_LLAMA_PORT").unwrap_or_else(|_| "8080".into());
    (format!("http://{host}:{port}"), host, port)
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

    let asr_bin = resolve_asr_binary_path();
    let asr_native_present = command_exists(&asr_bin);
    let sensevoice_python_script = resolve_sensevoice_python_script();
    let sensevoice_python_present =
        resolve_speech_python_path().is_some() && sensevoice_python_script.is_some();
    let asr_present = asr_native_present || sensevoice_python_present;
    let sensevoice_model_path = resolve_sensevoice_model_path();
    let sensevoice_tokens_path = resolve_sensevoice_tokens_path();
    let sensevoice_ready =
        asr_present && sensevoice_model_path.is_some() && sensevoice_tokens_path.is_some();

    let tts_bin = resolve_tts_binary_path();
    let tts_native_present = command_exists(&tts_bin);
    let kokoro_python_script = resolve_kokoro_python_script();
    let kokoro_python_present =
        resolve_speech_python_path().is_some() && kokoro_python_script.is_some();
    let tts_present = tts_native_present || kokoro_python_present;
    let kokoro_model_path = resolve_kokoro_model_path();
    let kokoro_ready = tts_present && kokoro_model_path.is_some();

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
            provider: "sherpa-onnx".to_string(),
            active_engine: if sensevoice_ready {
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
            model_present: sensevoice_model_path.is_some() && sensevoice_tokens_path.is_some(),
        },
        tts: RosieLocalTtsStatus {
            engine_name: "Kokoro-82M via Sherpa-ONNX".to_string(),
            provider: "sherpa-onnx".to_string(),
            active_engine: if kokoro_ready {
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
            model_present: kokoro_model_path.is_some(),
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

#[tauri::command]
pub async fn rosie_tts_speak(
    state: tauri::State<'_, RosieSpeechState>,
    text: String,
    rate: Option<f32>,
    voice: Option<String>,
) -> Result<String, String> {
    let rate_multiplier = rate.unwrap_or(1.0).clamp(0.8, 1.2);

    let existing_child = {
        state
            .0
            .lock()
            .map_err(|_| "ROSIE speech state lock poisoned".to_string())?
            .take()
    };

    if let Some(mut child) = existing_child {
        let _ = child.kill().await;
    }

    let temp_wav = temp_voice_prefix("tts-speak", "wav");
    synthesize_kokoro_to_wav(&text, rate_multiplier, voice.as_deref(), &temp_wav).await?;

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

    *state
        .0
        .lock()
        .map_err(|_| "ROSIE speech state lock poisoned".to_string())? = Some(child);

    Ok("ROSIE TTS started".to_string())
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
