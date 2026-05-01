import { invoke, isTauri } from "@tauri-apps/api/core";

type PrinterStationConfig = {
  mode?: string;
  ip?: string;
  port?: number | string;
  systemName?: string;
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

function applyPrinter(prefix: string, printer: PrinterStationConfig | undefined) {
  if (!printer) return false;
  let changed = false;
  const mode = printer.mode === "system" ? "system" : printer.mode === "network" ? "network" : "";
  changed = setIfChanged(`${prefix}.mode`, mode) || changed;
  changed = setIfChanged(`${prefix}.ip`, printer.ip) || changed;
  changed = setIfChanged(`${prefix}.systemName`, printer.systemName) || changed;
  if (printer.port !== undefined && printer.port !== null) {
    changed = setIfChanged(`${prefix}.port`, String(printer.port)) || changed;
  }
  return changed;
}

export async function applyInstallerStationConfig() {
  if (!isTauri() || typeof window === "undefined") return;

  const config = await invoke<RiversideStationConfig | null>("load_station_config").catch(
    () => null,
  );
  if (!config?.register) return;

  const hash = JSON.stringify(config.register);
  if (window.localStorage.getItem(APPLIED_HASH_KEY) === hash) return;

  let changed = false;
  changed = setIfChanged("ros_api_base_override", config.register.apiBase) || changed;
  changed = setIfChanged("ros.station.label", config.register.stationLabel) || changed;
  changed =
    setBoolIfChanged("ros.hardware.cashDrawer.enabled", config.register.cashDrawerEnabled) ||
    changed;
  changed =
    applyPrinter("ros.hardware.printer.receipt", config.register.receiptPrinter) || changed;
  changed = applyPrinter("ros.hardware.printer.tag", config.register.tagPrinter) || changed;
  changed = applyPrinter("ros.hardware.printer.report", config.register.reportPrinter) || changed;

  window.localStorage.setItem(APPLIED_HASH_KEY, hash);

  if (changed && !window.sessionStorage.getItem("ros.stationConfig.reloaded")) {
    window.sessionStorage.setItem("ros.stationConfig.reloaded", "true");
    window.location.reload();
  }
}
