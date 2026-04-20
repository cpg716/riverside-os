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

export type ApiBaseSource =
  | "override"
  | "vite-env"
  | "same-origin"
  | "desktop-fallback";

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

export function getBaseUrlDiagnostics(): {
  resolved: string;
  source: ApiBaseSource;
} {
  if (typeof window === "undefined") {
    return {
      resolved: DEFAULT_BASE_URL,
      source: trimmedEnvBaseUrl()
        ? "vite-env"
        : browserOriginBaseUrl()
          ? "same-origin"
          : "desktop-fallback",
    };
  }

  const override = localStorage.getItem("ros_api_base_override");
  if (override && override.trim()) {
    return {
      resolved: override.trim().replace(/\/$/, ""),
      source: "override",
    };
  }

  const envBase = trimmedEnvBaseUrl();
  if (envBase) {
    return {
      resolved: envBase,
      source: "vite-env",
    };
  }

  const sameOrigin = browserOriginBaseUrl();
  if (sameOrigin) {
    return {
      resolved: sameOrigin,
      source: "same-origin",
    };
  }

  return {
    resolved: DEFAULT_BASE_URL,
    source: "desktop-fallback",
  };
}

export const API_BASE = getBaseUrl();
