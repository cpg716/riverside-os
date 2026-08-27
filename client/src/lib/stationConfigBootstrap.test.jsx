import { afterEach, describe, expect, it } from "vitest";
import { applyStationHardwareDefaults } from "./stationConfigBootstrap";

function installLocalStorage(values = {}) {
  const data = new Map(Object.entries(values));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
      },
    },
  });
  return data;
}

describe("station hardware defaults", () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it("does not replace printer choices already saved on the workstation", () => {
    const storage = installLocalStorage({
      "ros.hardware.cashDrawer.enabled": "true",
      "ros.hardware.printer.receipt.mode": "system",
      "ros.hardware.printer.receipt.systemName": "Lightspeed Printer 1",
      "ros.hardware.printer.report.systemName": "RMS COUNTER",
    });

    applyStationHardwareDefaults({
      cashDrawerEnabled: false,
      receiptPrinter: {
        mode: "network",
        ip: "192.168.1.50",
        port: 9100,
        systemName: "",
      },
      reportPrinter: { mode: "system", systemName: "Brother Printer" },
    });

    expect(storage.get("ros.hardware.cashDrawer.enabled")).toBe("true");
    expect(storage.get("ros.hardware.printer.receipt.mode")).toBe("system");
    expect(storage.get("ros.hardware.printer.receipt.systemName")).toBe(
      "Lightspeed Printer 1",
    );
    expect(storage.get("ros.hardware.printer.report.systemName")).toBe("RMS COUNTER");
    expect(storage.get("ros.hardware.printer.receipt.ip")).toBe("192.168.1.50");
  });
});
