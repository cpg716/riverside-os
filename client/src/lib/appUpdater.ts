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

export interface ServerLocalStatus {
  is_local: boolean;
  install_root: string;
  config_exists: boolean;
  server_binary_exists: boolean;
}

export async function checkServerLocalStatus(): Promise<ServerLocalStatus> {
  if (!isTauri()) {
    return {
      is_local: false,
      install_root: "",
      config_exists: false,
      server_binary_exists: false,
    };
  }
  return invoke<ServerLocalStatus>("check_server_local_status");
}

export async function downloadAndRunServerInstaller(version: string): Promise<string> {
  if (!isTauri()) {
    throw new Error("Server installer can only be run from the desktop app.");
  }
  return invoke<string>("download_and_run_server_installer", { version });
}

