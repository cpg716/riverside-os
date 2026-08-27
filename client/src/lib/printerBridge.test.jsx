import { afterEach, describe, expect, it } from "vitest";
import {
  RIVERSIDE_TAG_PRINTER_NAME,
  hydratePrinterConfigFromServer,
  resolvePrinterTarget,
} from "./printerBridge";

function installLocalStorage(values = {}) {
  const data = new Map(Object.entries(values));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
        clear: () => data.clear(),
      },
    },
  });
  return data;
}

describe("printerBridge tag target resolution", () => {
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it("respects the configured tag system printer name", () => {
    installLocalStorage({
      "ros.hardware.printer.tag.mode": "system",
      "ros.hardware.printer.tag.systemName": "ZDesigner LP 2844",
    });

    expect(resolvePrinterTarget("tag")).toEqual({
      mode: "system",
      printerName: "ZDesigner LP 2844",
    });
  });

  it("does not force the suggested Zebra LP 2844 name as the runtime target", () => {
    installLocalStorage({
      "ros.hardware.printer.tag.mode": "system",
      "ros.hardware.printer.tag.systemName": "ZDesigner LP 2844",
    });

    const target = resolvePrinterTarget("tag");

    expect(target.mode).toBe("system");
    expect(target.printerName).not.toBe(RIVERSIDE_TAG_PRINTER_NAME);
  });

  it("respects configured non-loopback network tag settings", () => {
    installLocalStorage({
      "ros.hardware.printer.tag.mode": "network",
      "ros.hardware.printer.tag.ip": "192.168.1.44",
      "ros.hardware.printer.tag.port": "9101",
    });

    expect(resolvePrinterTarget("tag")).toEqual({
      mode: "network",
      ip: "192.168.1.44",
      port: 9101,
    });
  });

  it("hydrates missing server values without replacing workstation choices", async () => {
    const data = installLocalStorage({
      "ros.hardware.printer.receipt.mode": "system",
      "ros.hardware.printer.receipt.systemName": "Lightspeed Printer 1",
    });
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        "ros.hardware.printer.receipt.mode": "network",
        "ros.hardware.printer.receipt.systemName": "Old Receipt Printer",
        "ros.hardware.printer.report.systemName": "RMS COUNTER",
      }),
    });

    await hydratePrinterConfigFromServer("http://main-hub:3000", 1);

    expect(data.get("ros.hardware.printer.receipt.mode")).toBe("system");
    expect(data.get("ros.hardware.printer.receipt.systemName")).toBe(
      "Lightspeed Printer 1",
    );
    expect(data.get("ros.hardware.printer.report.systemName")).toBe("RMS COUNTER");
  });
});
