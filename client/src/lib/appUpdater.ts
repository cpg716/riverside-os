import { isTauri, invoke } from "@tauri-apps/api/core";

export interface UpdateCheckResult {
  enabled: boolean;
  available: boolean;
  version: string | null;
  date: string | null;
  notes: string | null;
  message: string | null;
}

export interface InstallUpdateResult {
  enabled: boolean;
  installed: boolean;
  version: string | null;
  message: string | null;
}

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    return {
      enabled: false,
      available: false,
      version: null,
      date: null,
      notes: null,
      message: "Updater is available only in the desktop app.",
    };
  }

  return invoke<UpdateCheckResult>("check_app_update");
}

export async function installAppUpdate(): Promise<InstallUpdateResult> {
  if (!isTauri()) {
    return {
      enabled: false,
      installed: false,
      version: null,
      message: "Updater is available only in the desktop app.",
    };
  }

  return invoke<InstallUpdateResult>("install_app_update");
}
