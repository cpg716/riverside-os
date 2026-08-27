import { invoke, isTauri } from "@tauri-apps/api/core";

type PrinterStationConfig = {
  mode?: string;
  ip?: string;
  port?: number | string;
  systemName?: string;
  language?: string;
};

type RiversideStationConfig = {
  register?: {
    apiBase?: string;
    stationLabel?: string;
    cashDrawerEnabled?: boolean;
    receiptPrinter?: PrinterStationConfig;
    tagPrinter?: PrinterStationConfig;
    reportPrinter?: PrinterStationConfig;
  };
};

const APPLIED_HASH_KEY = "ros.stationConfig.appliedHash";
let hardwareSaveQueue = Promise.resolve();

function setIfChanged(key: string, value: string | null | undefined) {
  const cleaned = value?.trim();
  if (!cleaned) return false;
  if (window.localStorage.getItem(key) === cleaned) return false;
  window.localStorage.setItem(key, cleaned);
  return true;
}

function setBoolIfChanged(key: string, value: boolean | null | undefined) {
  if (typeof value !== "boolean") return false;
  const next = value ? "true" : "false";
  if (window.localStorage.getItem(key) === next) return false;
  window.localStorage.setItem(key, next);
  return true;
}

function setIfMissing(key: string, value: string | null | undefined) {
  if (window.localStorage.getItem(key) !== null) return false;
  return setIfChanged(key, value);
}

function setBoolIfMissing(key: string, value: boolean | null | undefined) {
  if (window.localStorage.getItem(key) !== null) return false;
  return setBoolIfChanged(key, value);
}

function applyPrinter(prefix: string, printer: PrinterStationConfig | undefined) {
  if (!printer) return false;
  let changed = false;
  const mode = printer.mode === "system" ? "system" : printer.mode === "network" ? "network" : "";
  changed = setIfMissing(`${prefix}.mode`, mode) || changed;
  changed = setIfMissing(`${prefix}.ip`, printer.ip) || changed;
  changed = setIfMissing(`${prefix}.systemName`, printer.systemName) || changed;
  changed = setIfMissing(`${prefix}.language`, printer.language) || changed;
  if (printer.port !== undefined && printer.port !== null) {
    changed = setIfMissing(`${prefix}.port`, String(printer.port)) || changed;
  }
  return changed;
}

function storedPrinter(type: "receipt" | "tag" | "report") {
  const prefix = `ros.hardware.printer.${type}`;
  const parsedPort = Number.parseInt(window.localStorage.getItem(`${prefix}.port`) ?? "9100", 10);
  return {
    mode: window.localStorage.getItem(`${prefix}.mode`) === "network" ? "network" : "system",
    ip: window.localStorage.getItem(`${prefix}.ip`)?.trim() ?? "",
    port: Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 9100,
    systemName: window.localStorage.getItem(`${prefix}.systemName`)?.trim() ?? "",
    language: window.localStorage.getItem(`${prefix}.language`)?.trim() ?? "",
  };
}

export function persistInstallerStationHardwareConfig() {
  if (!isTauri() || typeof window === "undefined") return Promise.resolve();
  hardwareSaveQueue = hardwareSaveQueue.catch(() => undefined).then(() =>
    invoke("save_station_hardware_config", {
      hardware: {
        cashDrawerEnabled:
          window.localStorage.getItem("ros.hardware.cashDrawer.enabled") !== "false",
        receiptPrinter: storedPrinter("receipt"),
        tagPrinter: storedPrinter("tag"),
        reportPrinter: storedPrinter("report"),
      },
    }).then(() => undefined),
  );
  return hardwareSaveQueue;
}

export function applyStationHardwareDefaults(
  register: NonNullable<RiversideStationConfig["register"]>,
) {
  let changed = false;
  changed =
    setBoolIfMissing("ros.hardware.cashDrawer.enabled", register.cashDrawerEnabled) || changed;
  changed = applyPrinter("ros.hardware.printer.receipt", register.receiptPrinter) || changed;
  changed = applyPrinter("ros.hardware.printer.tag", register.tagPrinter) || changed;
  changed = applyPrinter("ros.hardware.printer.report", register.reportPrinter) || changed;
  return changed;
}

function isLoopbackApiBase(value: string | null | undefined) {
  const cleaned = value?.trim();
  if (!cleaned) return false;
  try {
    const parsed = new URL(cleaned);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeApiBase(value: string | null | undefined) {
  let cleaned = value?.trim() ?? "";
  if (!cleaned) return "";
  if (!cleaned.startsWith("http")) {
    cleaned = `http://${cleaned}`;
  }
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === "http:" && !parsed.port) {
      parsed.port = "3000";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return cleaned.replace(/\/$/, "");
  }
}

export async function applyInstallerStationConfig() {
  if (!isTauri() || typeof window === "undefined") return;

  const config = await invoke<RiversideStationConfig | null>("load_station_config").catch(
    () => null,
  );
  if (!config?.register) return;

  const hash = JSON.stringify(config.register);
  const appliedHash = window.localStorage.getItem(APPLIED_HASH_KEY);
  if (appliedHash === hash) {
    // Configuration matches the already applied version. 
    // Do not overwrite the user's manual overrides.
    return;
  }

  let changed = false;
  const stationLabel = config.register.stationLabel?.trim();
  const apiBase = normalizeApiBase(config.register.apiBase);
  const shouldApplyApiBase =
    stationLabel === "Main Hub" ||
    stationLabel === "Backoffice / Server" ||
    !isLoopbackApiBase(apiBase);
  if (shouldApplyApiBase) {
    changed = setIfChanged("ros_api_base_override", apiBase) || changed;
  }
  changed = setIfChanged("ros.station.label", config.register.stationLabel) || changed;
  changed = applyStationHardwareDefaults(config.register) || changed;

  window.localStorage.setItem(APPLIED_HASH_KEY, hash);

  if (changed && !window.sessionStorage.getItem("ros.stationConfig.reloaded")) {
    window.sessionStorage.setItem("ros.stationConfig.reloaded", "true");
    window.location.reload();
  }
}
