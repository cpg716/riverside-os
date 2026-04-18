import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import { sessionPollAuthHeaders } from "./posRegisterAuth";

export type PrintDocType = "receipt" | "tag" | "report";

export interface HardwareAddress {
  ip: string;
  port: number;
}

/** Resolves the local station's configured address for a specific document type. */
export function resolvePrinterAddress(type: PrintDocType): HardwareAddress {
  if (type === "receipt") {
    return {
      ip: window.localStorage.getItem("ros.hardware.printer.receipt.ip") || "127.0.0.1",
      port: parseInt(window.localStorage.getItem("ros.hardware.printer.receipt.port") || "9100", 10)
    };
  }
  if (type === "tag") {
    return {
      ip: window.localStorage.getItem("ros.hardware.printer.tag.ip") || "127.0.0.1",
      port: 9100 // Tag printers usually use standard ZPL port
    };
  }
  // Default to report / system
  return {
    ip: window.localStorage.getItem("ros.hardware.printer.report.ip") || "",
    port: 9100
  };
}

/**
 * Thermal print bridge: Tauri uses native TCP; browser/PWA tries server `/api/hardware/print`,
 * then `window.open` fallback. PWA note: popup blockers may block the blank window unless the
 * print action runs directly from a user gesture; prefer Tauri or server print on iPad/mobile.
 */
export async function printZplReceipt(payload: string, ip: string, port = 9100) {
  // If we're not running inside the Tauri shell (e.g. dev browser)
  // we must fallback to the classic window.open print method.
  if (!isTauri()) {
    const baseUrl = import.meta.env.VITE_API_BASE ?? "";
    try {
      const res = await fetch(`${baseUrl}/api/hardware/print`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...sessionPollAuthHeaders(),
        },
        body: JSON.stringify({ ip, port, payload })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Server-side print dispatch failed");
      }
      return;
    } catch (e) {
      console.warn("Server Print Fallback Failed, trying browser print:", e);
      return fallbackBrowserPrint(payload);
    }
  }

  try {
    await invoke("print_zpl_receipt", { ip, port, payload });
  } catch (err) {
    console.error("Hardware Bridge Error: ZPL Print Failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

/** Pre-built ESC/POS binary as standard base64 (init/raster/cut already included). */
export async function printRawEscPosBase64(payloadB64: string, ip: string, port = 9100) {
  if (!isTauri()) {
    const baseUrl = import.meta.env.VITE_API_BASE ?? "";
    const res = await fetch(`${baseUrl}/api/hardware/print`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sessionPollAuthHeaders(),
      },
      body: JSON.stringify({
        ip,
        port,
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
      ip,
      port,
      payload_b64: payloadB64,
    });
  } catch (err) {
    console.error("Hardware Bridge Error: raw ESC/POS print failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

export async function printEscPosReceipt(payload: string, ip: string, port = 9100) {
  if (!isTauri()) {
    const baseUrl = import.meta.env.VITE_API_BASE ?? "";
    try {
      const res = await fetch(`${baseUrl}/api/hardware/print`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...sessionPollAuthHeaders(),
        },
        body: JSON.stringify({ ip, port, payload })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Server-side print dispatch failed");
      }
      return;
    } catch (e) {
      console.warn("Server Print Fallback Failed, trying browser print:", e);
      return fallbackBrowserPrint(payload);
    }
  }

  try {
    await invoke("print_escpos_receipt", { ip, port, payload });
  } catch (err) {
    console.error("Hardware Bridge Error: ESC/POS Print Failed:", err);
    throw new Error(String(err), { cause: err });
  }
}

/** Legacy print method for Chrome/Safari Fallback */
function fallbackBrowserPrint(payload: string) {
  const w = window.open("", "_blank");
  if (w) {
    const pre = w.document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "11px";
    pre.style.padding = "12px";
    pre.textContent = payload;
    w.document.body.appendChild(pre);

    // Optional: auto-trigger browser print dialog
    // setTimeout(() => w.print(), 200);
  } else {
    throw new Error("Popup blocker blocked fallback receipt");
  }
}

/** 
 * Automatically routes a document to the correct station printer based on type.
 * Ensures the right protocol (ZPL vs ESC/POS) is used for the destination.
 */
export async function autoRoutePrint(type: PrintDocType, payload: string, format: "zpl" | "escpos" = "zpl") {
  const { ip, port } = resolvePrinterAddress(type);
  if (!ip) {
    throw new Error(`No printer IP configured for ${type} documents.`);
  }

  if (format === "zpl") {
    return printZplReceipt(payload, ip, port);
  } else {
    return printEscPosReceipt(payload, ip, port);
  }
}
