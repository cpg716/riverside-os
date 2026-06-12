import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import { getBaseUrl } from "./apiConfig";
import { sessionPollAuthHeaders } from "./posRegisterAuth";

export type PrintDocType = "receipt" | "tag" | "report";
export type ThermalPrinterLanguage = "zpl" | "epl";
export type PrintHubFormat = "text" | "raw_text" | "raw_base64" | "raw_escpos_base64";

export const TAG_PRINTER_LANGUAGE_KEY = "ros.hardware.printer.tag.language";

export interface HardwareAddress {
  ip: string;
  port: number;
}

export type SystemPrinter = {
  name: string;
  is_default: boolean;
};

export type HardwarePrinterTarget =
  | {
      mode: "network";
      ip: string;
      port: number;
    }
  | {
      mode: "system";
      printerName: string;
    };

export type PrintHubResult = {
  status: string;
  station: PrintDocType;
  route: "network" | "system";
  target: string;
  bytes?: number;
};

const printerModeKey = (type: PrintDocType) => `ros.hardware.printer.${type}.mode`;
const printerSystemNameKey = (type: PrintDocType) =>
  `ros.hardware.printer.${type}.systemName`;
const printerPortKey = (type: PrintDocType) => `ros.hardware.printer.${type}.port`;

function readPrinterPort(type: PrintDocType, fallback = 9100) {
  const stored = window.localStorage.getItem(printerPortKey(type));
  const parsed = Number.parseInt(stored || String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function normalizeNetworkTarget(
  target: Extract<HardwarePrinterTarget, { mode: "network" }>,
): Extract<HardwarePrinterTarget, { mode: "network" }> {
  const ip = target.ip.trim();
  if (!ip) {
    throw new Error("Printer address is not configured for this station.");
  }
  if (!Number.isFinite(target.port) || target.port <= 0 || target.port > 65535) {
    throw new Error("Printer port is invalid for this station.");
  }
  return { ...target, ip };
}

/** Resolves the local station's configured address for a specific document type. */
export function resolvePrinterAddress(type: PrintDocType): HardwareAddress {
  if (type === "receipt") {
    return {
      ip: window.localStorage.getItem("ros.hardware.printer.receipt.ip") || "127.0.0.1",
      port: readPrinterPort("receipt"),
    };
  }
  if (type === "tag") {
    return {
      ip: window.localStorage.getItem("ros.hardware.printer.tag.ip") || "127.0.0.1",
      port: readPrinterPort("tag"),
    };
  }
  // Default to report / system
  return {
    ip: window.localStorage.getItem("ros.hardware.printer.report.ip") || "",
    port: readPrinterPort("report"),
  };
}

export function resolvePrinterTarget(type: PrintDocType): HardwarePrinterTarget {
  const mode =
    type === "report" || window.localStorage.getItem(printerModeKey(type)) === "system"
      ? "system"
      : "network";
  if (mode === "system") {
    return {
      mode,
      printerName: window.localStorage.getItem(printerSystemNameKey(type))?.trim() || "",
    };
  }
  return {
    mode,
    ...resolvePrinterAddress(type),
  };
}

function targetFromAddress(
  targetOrIp: HardwarePrinterTarget | string | undefined,
  port: number,
): HardwarePrinterTarget {
  if (!targetOrIp) {
    return resolvePrinterTarget("receipt");
  }
  if (typeof targetOrIp === "string") {
    return { mode: "network", ip: targetOrIp, port };
  }
  return targetOrIp;
}

function asciiToBase64(value: string) {
  let binary = "";
  for (const ch of value) {
    binary += String.fromCharCode(ch.charCodeAt(0) & 0xff);
  }
  return btoa(binary);
}

export async function listSystemPrinters(): Promise<SystemPrinter[]> {
  if (!isTauri()) {
    return [];
  }
  return invoke<SystemPrinter[]>("list_system_printers");
}

export function describePrinterTarget(target: HardwarePrinterTarget) {
  if (target.mode === "system") {
    return target.printerName ? target.printerName : "No installed printer selected";
  }
  return `${target.ip}:${target.port}`;
}

function stationPrintBody(
  station: PrintDocType,
  target: HardwarePrinterTarget,
  payload: string,
  format: PrintHubFormat,
) {
  if (station === "tag" && isLoopbackNetworkTarget(target)) {
    return {
      station,
      payload,
      format,
    };
  }

  if (target.mode === "system") {
    return {
      station,
      mode: "system",
      printer_name: requireSystemPrinterName(target),
      payload,
      format,
    };
  }

  const networkTarget = normalizeNetworkTarget(target);
  return {
    station,
    mode: "network",
    ip: networkTarget.ip,
    port: networkTarget.port,
    payload,
    format,
  };
}

function isLoopbackNetworkTarget(target: HardwarePrinterTarget) {
  return (
    target.mode === "network" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.ip.trim())
  );
}

export async function printViaMainHubPrintServer(
  station: PrintDocType,
  payload: string,
  target: HardwarePrinterTarget = resolvePrinterTarget(station),
  format: PrintHubFormat = "text",
): Promise<PrintHubResult> {
  const headers = sessionPollAuthHeaders();
  if (!hasStationPrintAuth(headers)) {
    throw new Error("Sign in before sending a print job to the Main Hub print server.");
  }

  const res = await fetch(`${getBaseUrl()}/api/hardware/print-station`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(stationPrintBody(station, target, payload, format)),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<PrintHubResult> & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `Main Hub print server rejected the ${station} job.`);
  }
  if (!body.target || !body.route || !body.status) {
    throw new Error("Main Hub print server returned an invalid print response.");
  }
  return body as PrintHubResult;
}

export async function checkMainHubPrintServerTarget(
  station: PrintDocType,
  target: HardwarePrinterTarget = resolvePrinterTarget(station),
): Promise<PrintHubResult> {
  const headers = sessionPollAuthHeaders();
  if (!hasStationPrintAuth(headers)) {
    throw new Error("Sign in before checking the Main Hub print server.");
  }

  const body = stationPrintBody(station, target, "", "text");
  const res = await fetch(`${getBaseUrl()}/api/hardware/check-station-printer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<PrintHubResult> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Main Hub print server could not reach the ${station} printer.`);
  }
  if (!data.target || !data.route || !data.status) {
    throw new Error("Main Hub print server returned an invalid printer check response.");
  }
  return data as PrintHubResult;
}

function hasStationPrintAuth(headers: Record<string, string>) {
  return Boolean(
    ((headers["x-riverside-staff-code"] ?? "").trim() &&
      (headers["x-riverside-staff-pin"] ?? "").trim()) ||
      ((headers["x-riverside-pos-session-id"] ?? "").trim() &&
        (headers["x-riverside-pos-session-token"] ?? "").trim()),
  );
}

function requireSystemPrinterName(target: Extract<HardwarePrinterTarget, { mode: "system" }>) {
  const printerName = typeof target.printerName === "string" ? target.printerName.trim() : "";
  if (!printerName) {
    throw new Error("Choose an installed printer for this station.");
  }
  return printerName;
}

/**
 * Thermal print bridge: Tauri uses native TCP; browser/PWA uses the ROS server
 * `/api/hardware/print` path so receipt/tag hardware bypasses browser printing.
 */
export async function printZplReceipt(
  payload: string,
  targetOrIp: HardwarePrinterTarget | string,
  port = 9100,
) {
  const target = targetFromAddress(targetOrIp, port);
  if (target.mode === "system") {
    if (!isTauri()) {
      throw new Error("Installed printer selection is available only in the Riverside desktop app.");
    }
    const printerName = requireSystemPrinterName(target);
    return invoke("print_raw_to_system_printer_b64", {
      printerName,
      payloadB64: asciiToBase64(payload),
    });
  }
  const networkTarget = normalizeNetworkTarget(target);

  if (!isTauri()) {
    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}/api/hardware/print`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionPollAuthHeaders(),
      },
      body: JSON.stringify({ ip: networkTarget.ip, port: networkTarget.port, payload }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || "Server-side ZPL dispatch failed");
    }
    return;
  }

  try {
    await invoke("print_zpl_receipt", {
      ip: networkTarget.ip,
      port: networkTarget.port,
      payload,
    });
  } catch (err) {
    console.error("Hardware Bridge Error: ZPL Print Failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

export async function printRawThermal(
  payload: string,
  targetOrIp: HardwarePrinterTarget | string,
  port = 9100,
) {
  return printZplReceipt(payload, targetOrIp, port);
}

/** Pre-built ESC/POS binary as standard base64 (init/raster/cut already included). */
export async function printRawEscPosBase64(
  payloadB64: string,
  targetOrIp?: HardwarePrinterTarget | string,
  port = 9100,
) {
  const target = targetFromAddress(targetOrIp, port);
  if (target.mode === "system") {
    if (!isTauri()) {
      throw new Error("Installed printer selection is available only in the Riverside desktop app.");
    }
    const printerName = requireSystemPrinterName(target);
    await invoke("print_raw_to_system_printer_b64", {
      printerName,
      payloadB64: payloadB64,
    });
    return;
  }
  const networkTarget = normalizeNetworkTarget(target);

  if (!isTauri()) {
    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}/api/hardware/print`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionPollAuthHeaders(),
      },
      body: JSON.stringify({
        ip: networkTarget.ip,
        port: networkTarget.port,
        payload: payloadB64,
        format: "raw_escpos_base64",
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || "Server-side raw ESC/POS dispatch failed");
    }
    return;
  }

  try {
    await invoke("print_escpos_binary_b64", {
      ip: networkTarget.ip,
      port: networkTarget.port,
      payloadB64: payloadB64,
    });
  } catch (err) {
    console.error("Hardware Bridge Error: raw ESC/POS print failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

export async function printTextReport(content: string) {
  const target = resolvePrinterTarget("report");
  if (target.mode !== "system") {
    throw new Error("Choose an installed Reports printer for direct report printing.");
  }
  if (!isTauri()) {
    throw new Error("Direct report printing is available only in the Riverside desktop app.");
  }
  const printerName = requireSystemPrinterName(target);
  await invoke("print_text_to_system_printer", {
    printerName,
    content,
  });
}

export async function printEscPosReceipt(
  payload: string,
  targetOrIp: HardwarePrinterTarget | string,
  port = 9100,
) {
  const target = targetFromAddress(targetOrIp, port);
  if (target.mode === "system") {
    if (!isTauri()) {
      throw new Error("Installed printer selection is available only in the Riverside desktop app.");
    }
    const printerName = requireSystemPrinterName(target);
    const init = "\x1b@";
    const cut = "\x1dVA\0";
    return invoke("print_raw_to_system_printer_b64", {
      printerName,
      payloadB64: asciiToBase64(`${init}${payload}\n\n\n\n${cut}`),
    });
  }
  const networkTarget = normalizeNetworkTarget(target);

  if (!isTauri()) {
    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}/api/hardware/print`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionPollAuthHeaders(),
      },
      body: JSON.stringify({ ip: networkTarget.ip, port: networkTarget.port, payload }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || "Server-side ESC/POS dispatch failed");
    }
    return;
  }

  try {
    await invoke("print_escpos_receipt", {
      ip: networkTarget.ip,
      port: networkTarget.port,
      payload,
    });
  } catch (err) {
    console.error("Hardware Bridge Error: ESC/POS Print Failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

export async function checkReceiptPrinterConnection(
  target: HardwarePrinterTarget = resolvePrinterTarget("receipt"),
) {
  if (target.mode === "system") {
    const printerName = requireSystemPrinterName(target);
    if (!isTauri()) {
      throw new Error(
        "Installed printer checks are available only in the Riverside desktop app.",
      );
    }
    try {
      await invoke("check_system_printer", { printerName });
      return;
    } catch (err) {
      console.error("Hardware Bridge Error: installed printer check failed:", err);
      throw new Error(String(err), { cause: err });
    }
  }

  const networkTarget = normalizeNetworkTarget(target);
  if (!isTauri()) {
    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}/api/hardware/check-printer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionPollAuthHeaders(),
      },
      body: JSON.stringify({ ip: networkTarget.ip, port: networkTarget.port }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || "Server-side printer readiness check failed");
    }
    return;
  }
  try {
    await invoke("check_printer_connection", {
      ip: networkTarget.ip,
      port: networkTarget.port,
    });
  } catch (err) {
    console.error("Hardware Bridge Error: printer readiness check failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

/**
 * Automatically routes a document to the correct station printer based on type.
 * Ensures the right protocol (ZPL vs ESC/POS) is used for the destination.
 */
export async function autoRoutePrint(
  type: PrintDocType,
  payload: string,
  format: ThermalPrinterLanguage | "escpos" = "zpl",
  targetOverride?: HardwarePrinterTarget,
) {
  const target = targetOverride ?? resolvePrinterTarget(type);
  if (target.mode === "system" && !target.printerName) {
    throw new Error(`No installed printer selected for ${type} documents.`);
  }
  if (target.mode === "network" && !target.ip) {
    throw new Error(`No printer address configured for ${type} documents.`);
  }

  if (type === "tag") {
    // In the desktop app, an explicit Zebra target should be tested directly from the Tauri shell.
    // Keep the Main Hub route only for the unresolved/default loopback tag target so Back Office/PWA
    // still lets the hub-owned station settings decide where the Zebra job goes.
    if (isTauri() && !isLoopbackNetworkTarget(target)) {
      return printRawThermal(payload, target);
    }
    return printViaMainHubPrintServer(type, payload, target, "text");
  }

  if (format === "zpl" || format === "epl") {
    return printRawThermal(payload, target);
  } else {
    return printEscPosReceipt(payload, target);
  }
}

/** Serialize all printer settings from localStorage for server sync. */
function gatherPrinterSettings(): Record<string, string> {
  const keys = [
    "ros.hardware.printer.receipt.ip",
    "ros.hardware.printer.receipt.port",
    "ros.hardware.printer.receipt.mode",
    "ros.hardware.printer.receipt.systemName",
    "ros.hardware.printer.tag.ip",
    "ros.hardware.printer.tag.port",
    "ros.hardware.printer.tag.mode",
    "ros.hardware.printer.tag.systemName",
    TAG_PRINTER_LANGUAGE_KEY,
    "ros.hardware.printer.report.ip",
    "ros.hardware.printer.report.port",
    "ros.hardware.printer.report.mode",
    "ros.hardware.printer.report.systemName",
    "ros.hardware.cashDrawer.enabled",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = window.localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** Persist current station printer settings to the server by register lane. */
export async function syncPrinterConfigToServer(
  baseUrl: string,
  authHeaders: Record<string, string>,
  registerLane: number,
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/settings/printer-config/${registerLane}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(gatherPrinterSettings()),
    });
    if (!res.ok) {
      console.warn("Failed to sync printer config to server", res.status);
    }
  } catch (e) {
    console.warn("Printer config sync failed", e);
  }
}

/** Load printer settings from the server for a register lane into localStorage. */
export async function hydratePrinterConfigFromServer(
  baseUrl: string,
  registerLane: number,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/settings/printer-config/${registerLane}`);
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, string>;
    if (typeof data !== "object" || data === null) return false;
    let applied = false;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        window.localStorage.setItem(key, value);
        applied = true;
      }
    }
    return applied;
  } catch (e) {
    console.warn("Printer config hydration failed", e);
    return false;
  }
}
