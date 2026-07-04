import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";

export async function saveDesktopTextFile(
  filename: string,
  content: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  if (!isTauri()) return false;
  const filePath = await save({
    defaultPath: filename,
    filters,
  });
  if (!filePath) return true;
  await writeTextFile(filePath, content);
  return true;
}

export async function saveDesktopBinaryFile(
  filename: string,
  bytes: Uint8Array,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  if (!isTauri()) return false;
  const filePath = await save({
    defaultPath: filename,
    filters,
  });
  if (!filePath) return true;
  await writeFile(filePath, bytes);
  return true;
}

export async function openDesktopTextPreview(
  filename: string,
  content: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke<string>("open_temp_preview_file", {
    filename,
    content,
  });
  return true;
}

export async function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
  filters?: { name: string; extensions: string[] }[],
): Promise<void> {
  if (await saveDesktopTextFile(filename, content, filters)) {
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function downloadBinaryFile(
  filename: string,
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
  filters?: { name: string; extensions: string[] }[],
): Promise<void> {
  if (await saveDesktopBinaryFile(filename, bytes, filters)) {
    return;
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function openExternalUrl(
  url: string,
  browserTarget = "_blank",
  features?: string,
): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, browserTarget, features);
}
