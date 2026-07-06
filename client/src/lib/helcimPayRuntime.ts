export const HELCIM_PAY_SCRIPT_URL = "https://secure.helcim.app/helcim-pay/services/start.js";

function currentOrigin() {
  if (typeof window === "undefined") return "";
  return window.location.origin || `${window.location.protocol}//${window.location.host}`;
}

function isLocalHelcimPayOrigin(protocol: string, hostname: string) {
  const normalizedHost = hostname.toLowerCase();
  return (
    protocol === "http:" &&
    (normalizedHost === "localhost" ||
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "::1" ||
      normalizedHost === "tauri.localhost")
  );
}

export function helcimPayCanRenderInline(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

export function helcimPayRuntimeBlocker(): string | null {
  if (typeof window === "undefined") {
    return "HelcimPay.js needs a browser or WebView session before manual card entry can open.";
  }
  const { protocol, hostname } = window.location;
  if (protocol === "https:") return null;
  if (isLocalHelcimPayOrigin(protocol, hostname)) {
    return `Manual Card cannot open HelcimPay.js from this local app origin. Open Riverside through the Helcim-whitelisted public HTTPS ROS/PWA URL, or use the Helcim terminal card path on this register. Current origin: ${currentOrigin()}.`;
  }
  if (protocol !== "https:") {
    return `HelcimPay.js requires a secure checkout origin. Open Riverside through the whitelisted HTTPS ROS/PWA URL before using Manual Card. Current origin: ${currentOrigin()}.`;
  }
  return null;
}

export function helcimPayWhitelistHint(): string {
  if (
    typeof window !== "undefined" &&
    isLocalHelcimPayOrigin(window.location.protocol, window.location.hostname)
  ) {
    return `This local app origin cannot host live HelcimPay.js. Use the public HTTPS ROS/PWA checkout origin saved in the Helcim API Access Configuration.`;
  }
  return `If HelcimPay.js does not render, verify this checkout origin is saved in the Helcim API Access Configuration: ${currentOrigin() || "current app origin"}.`;
}
