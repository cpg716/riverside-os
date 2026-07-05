export const HELCIM_PAY_SCRIPT_URL = "https://secure.helcim.app/helcim-pay/services/start.js";

function currentOrigin() {
  if (typeof window === "undefined") return "";
  return window.location.origin || `${window.location.protocol}//${window.location.host}`;
}

export function helcimPayRuntimeBlocker(): string | null {
  if (typeof window === "undefined") {
    return "HelcimPay.js needs a browser or WebView session before manual card entry can open.";
  }
  const { protocol, hostname } = window.location;
  const normalizedHost = hostname.toLowerCase();
  const tauriLocalhost = normalizedHost === "tauri.localhost";
  if (protocol === "https:" || tauriLocalhost) return null;
  if (
    protocol === "http:" &&
    (normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1")
  ) {
    return `HelcimPay.js requires a public HTTPS checkout origin. Open Riverside through the whitelisted HTTPS ROS/PWA URL or a secure tunnel before using Manual Card. Current origin: ${currentOrigin()}.`;
  }
  if (protocol !== "https:") {
    return `HelcimPay.js requires a secure checkout origin. Open Riverside through the whitelisted HTTPS ROS/PWA URL before using Manual Card. Current origin: ${currentOrigin()}.`;
  }
  return null;
}

export function helcimPayWhitelistHint(): string {
  return `If HelcimPay.js does not render, verify this checkout origin is saved in the Helcim API Access Configuration: ${currentOrigin() || "current app origin"}.`;
}
