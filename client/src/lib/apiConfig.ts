function trimmedEnvBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE;
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\/$/, "");
}

function browserOriginBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const { origin, protocol } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    return origin.replace(/\/$/, "");
  }
  return "";
}

export const DEFAULT_BASE_URL =
  trimmedEnvBaseUrl() || browserOriginBaseUrl() || "http://127.0.0.1:3000";

/**
 * Centrally manages the API Base URL, supporting runtime overrides for secondary registers
 * connecting to a main server PC.
 */
export function getBaseUrl(): string {
  if (typeof window === "undefined") return DEFAULT_BASE_URL;
  const override = localStorage.getItem("ros_api_base_override");
  if (override && override.trim()) {
    return override.trim().replace(/\/$/, "");
  }
  return DEFAULT_BASE_URL;
}

export const API_BASE = getBaseUrl();
