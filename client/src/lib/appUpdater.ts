import { isTauri, invoke } from "@tauri-apps/api/core";

const LAST_UPDATE_CHECK_AT_KEY = "ros_last_update_check_at";
const LAST_UPDATE_INSTALL_AT_KEY = "ros_last_update_install_at";

function recordUpdateTelemetry(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Update checks and installs remain authoritative even if local telemetry storage is blocked.
  }
}

function readTelemetryTimestamp(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key)?.trim() ?? "";
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export type AppUpdateInstallObservationStatus =
  | "none"
  | "pending"
  | "confirmed"
  | "failed"
  | "unavailable"
  | "legacy_local";

export interface AppUpdateTelemetry {
  lastUpdateCheckAt: string | null;
  lastUpdateInstallAt: string | null;
  installObservationStatus: AppUpdateInstallObservationStatus;
  pendingTargetVersion: string | null;
  pendingTargetBuild: string | null;
  pendingStartedAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}

interface NativeAppUpdateTelemetryResult {
  observation_status: "none" | "pending" | "confirmed" | "failed";
  last_update_install_observed_at_unix_ms: number | null;
  pending_target_version: string | null;
  pending_target_build: string | null;
  pending_started_at_unix_ms: number | null;
  last_failure_at_unix_ms: number | null;
  last_failure_reason: string | null;
  current_version: string;
  current_build: string | null;
}

function unixMsToIso(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function readAppUpdateTelemetry(): Promise<AppUpdateTelemetry> {
  const lastUpdateCheckAt = readTelemetryTimestamp(LAST_UPDATE_CHECK_AT_KEY);
  if (!isTauri()) {
    const lastUpdateInstallAt = readTelemetryTimestamp(LAST_UPDATE_INSTALL_AT_KEY);
    return {
      lastUpdateCheckAt,
      lastUpdateInstallAt,
      installObservationStatus: lastUpdateInstallAt ? "legacy_local" : "none",
      pendingTargetVersion: null,
      pendingTargetBuild: null,
      pendingStartedAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
    };
  }

  try {
    const native = await invoke<NativeAppUpdateTelemetryResult>("read_app_update_telemetry");
    return {
      lastUpdateCheckAt,
      lastUpdateInstallAt: unixMsToIso(native.last_update_install_observed_at_unix_ms),
      installObservationStatus: native.observation_status,
      pendingTargetVersion: native.pending_target_version,
      pendingTargetBuild: native.pending_target_build,
      pendingStartedAt: unixMsToIso(native.pending_started_at_unix_ms),
      lastFailureAt: unixMsToIso(native.last_failure_at_unix_ms),
      lastFailureReason: native.last_failure_reason,
    };
  } catch {
    return {
      lastUpdateCheckAt,
      lastUpdateInstallAt: null,
      installObservationStatus: "unavailable",
      pendingTargetVersion: null,
      pendingTargetBuild: null,
      pendingStartedAt: null,
      lastFailureAt: null,
      lastFailureReason: "Native updater install telemetry could not be read.",
    };
  }
}

export interface UpdateCheckResult {
  enabled: boolean;
  available: boolean;
  version: string | null;
  date: string | null;
  notes: string | null;
  message: string | null;
  current_build: string | null;
  available_build: string | null;
}

export interface InstallUpdateResult {
  enabled: boolean;
  installed: boolean;
  version: string | null;
  message: string | null;
  current_build: string | null;
  installed_build: string | null;
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
      current_build: null,
      available_build: null,
    };
  }

  const result = await invoke<UpdateCheckResult>("check_app_update");
  recordUpdateTelemetry(LAST_UPDATE_CHECK_AT_KEY);
  return result;
}

export async function installAppUpdate(): Promise<InstallUpdateResult> {
  if (!isTauri()) {
    return {
      enabled: false,
      installed: false,
      version: null,
      message: "Updater is available only in the desktop app.",
      current_build: null,
      installed_build: null,
    };
  }

  const result = await invoke<InstallUpdateResult>("install_app_update");
  return result;
}

export interface ServerLocalStatus {
  is_local: boolean;
  install_root: string;
  config_exists: boolean;
  server_binary_exists: boolean;
}

export interface RiversideStationConfig {
  releaseVersion?: string;
  register?: {
    apiBase?: string;
    stationLabel?: string;
  };
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

export async function loadLocalStationConfig(): Promise<RiversideStationConfig | null> {
  if (!isTauri()) return null;
  return invoke<RiversideStationConfig | null>("load_station_config");
}

export async function downloadAndRunServerInstaller(
  version: string,
  buildSha?: string | null,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Server installer can only be run from the desktop app.");
  }
  return invoke<string>("download_and_run_server_installer", { version, buildSha });
}
