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

function isLocalhost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Resolve the effective API base URL from localStorage override or window.location. */
function resolvedApiBase(): string {
  if (typeof window === "undefined") return "";
  return (
    localStorage.getItem("ros_api_base_override")?.trim() ||
    window.location.origin
  );
}

export async function checkServerLocalStatus(): Promise<ServerLocalStatus> {
  if (!isTauri()) {
    // In a plain browser context the only reliable locality signal is whether
    // the API base points to this machine.
    const local = isLocalhost(resolvedApiBase());
    return {
      is_local: local,
      install_root: "",
      config_exists: false,
      server_binary_exists: false,
    };
  }

  // Ask Tauri to probe the install directory. On Windows this checks:
  //   {installRoot}\server\riverside-server.exe  (binary)
  //   {installRoot}\riverside-deployment.config.json  (config)
  //   {installRoot}\deployment-summary.txt  (install marker)
  const status = await invoke<ServerLocalStatus>("check_server_local_status");

  // If the file-system probe didn't find anything (e.g. custom install path),
  // fall back to the URL locality check so the Main Hub is never misidentified.
  if (!status.is_local) {
    status.is_local = isLocalhost(resolvedApiBase());
  }

  return status;
}

export async function downloadAndRunServerInstaller(version: string): Promise<string> {
  if (!isTauri()) {
    throw new Error("Server installer can only be run from the desktop app.");
  }
  return invoke<string>("download_and_run_server_installer", { version });
}
