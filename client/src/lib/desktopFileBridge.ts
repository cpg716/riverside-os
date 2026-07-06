import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

type DesktopSaveResult = "unsupported" | "saved" | "cancelled";

async function saveDesktopTextFileWithResult(
  filename: string,
  content: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<DesktopSaveResult> {
  if (!isTauri()) return "unsupported";
  const filePath = await save({
    defaultPath: filename,
    filters,
  });
  if (!filePath) return "cancelled";
  await writeTextFile(filePath, content);
  return "saved";
}

async function saveDesktopBinaryFileWithResult(
  filename: string,
  bytes: Uint8Array,
  filters?: { name: string; extensions: string[] }[],
): Promise<DesktopSaveResult> {
  if (!isTauri()) return "unsupported";
  const filePath = await save({
    defaultPath: filename,
    filters,
  });
  if (!filePath) return "cancelled";
  await writeFile(filePath, bytes);
  return "saved";
}

export async function saveDesktopTextFile(
  filename: string,
  content: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  return (await saveDesktopTextFileWithResult(filename, content, filters)) === "saved";
}

export async function saveDesktopBinaryFile(
  filename: string,
  bytes: Uint8Array,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  return (await saveDesktopBinaryFileWithResult(filename, bytes, filters)) === "saved";
}

export async function openDesktopTextPreview(
  filename: string,
  content: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  const path = await invoke<string>("write_temp_preview_file", {
    filename,
    content,
  });
  await openPath(path);
  return true;
}

export async function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  const desktopResult = await saveDesktopTextFileWithResult(filename, content, filters);
  if (desktopResult === "saved") {
    return true;
  }
  if (desktopResult === "cancelled") {
    return false;
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
  return true;
}

export async function downloadBinaryFile(
  filename: string,
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  const desktopResult = await saveDesktopBinaryFileWithResult(filename, bytes, filters);
  if (desktopResult === "saved") {
    return true;
  }
  if (desktopResult === "cancelled") {
    return false;
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
  return true;
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
