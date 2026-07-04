use std::path::{Path, PathBuf};
use std::process::Command;

fn sanitize_filename(filename: &str) -> String {
    let cleaned: String = filename
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => ch,
            _ => '_',
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "riverside-preview.html".to_string()
    } else {
        trimmed.to_string()
    }
}

fn ensure_preview_extension(path: PathBuf) -> PathBuf {
    if path.extension().is_some() {
        path
    } else {
        path.with_extension("html")
    }
}

#[tauri::command]
pub async fn write_temp_preview_file(filename: String, content: String) -> Result<String, String> {
    write_preview_file(filename, content).await
}

#[tauri::command]
pub async fn open_temp_preview_file(filename: String, content: String) -> Result<String, String> {
    let path = write_preview_file(filename, content).await?;
    open_preview_file(&path)?;
    Ok(path)
}

async fn write_preview_file(filename: String, content: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("riverside-os-previews");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not prepare preview folder: {e}"))?;

    let safe_name = sanitize_filename(&filename);
    let path = ensure_preview_extension(dir.join(Path::new(&safe_name)));
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Could not write preview file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn open_preview_file(path: &str) -> Result<(), String> {
    let mut preview_dir = std::env::temp_dir();
    preview_dir.push("riverside-os-previews");
    let preview_dir = preview_dir
        .canonicalize()
        .map_err(|e| format!("Could not verify preview folder: {e}"))?;
    let preview_path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Could not verify preview file: {e}"))?;

    if !preview_path.starts_with(&preview_dir) {
        return Err("Preview file is outside the Riverside preview folder.".to_string());
    }

    #[cfg(target_os = "windows")]
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "& { param($Path) Start-Process -LiteralPath $Path }",
            preview_path
                .to_str()
                .ok_or_else(|| "Preview path is not valid UTF-8.".to_string())?,
        ])
        .status();

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&preview_path).status();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&preview_path).status();

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("Could not open preview file: exit status {status}")),
        Err(e) => Err(format!("Could not open preview file: {e}")),
    }
}
