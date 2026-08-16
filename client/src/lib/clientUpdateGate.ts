import { CLIENT_SEMVER, GIT_SHA } from "../clientBuildMeta";

export const CLIENT_UPDATE_REQUIRED_EVENT = "riverside:client-update-required";

const CLIENT_UPDATE_CHECK_TIMEOUT_MS = 4_000;
const CLIENT_UPDATE_CHECK_CACHE_MS = 5_000;
const UNKNOWN_BUILD_IDENTITIES = new Set(["", "dev", "unknown"]);
let cachedCheck:
  | { baseUrl: string; checkedAt: number; result: ClientUpdateCheckResult }
  | null = null;

export interface ServerVersionIdentity {
  version: string;
  build_sha?: string | null;
  component?: string;
}

export type ClientUpdateCheckResult =
  | {
      status: "current";
      server: ServerVersionIdentity;
    }
  | {
      status: "required";
      server: ServerVersionIdentity;
      reason: "build" | "version";
    }
  | {
      status: "unavailable";
    };

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function usableBuildSha(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return UNKNOWN_BUILD_IDENTITIES.has(normalized.toLowerCase())
    ? null
    : normalized;
}

export function evaluateClientUpdateRequirement(
  server: ServerVersionIdentity,
): ClientUpdateCheckResult {
  const serverBuildSha = usableBuildSha(server.build_sha);
  const clientBuildSha = usableBuildSha(GIT_SHA);
  if (
    (serverBuildSha || clientBuildSha) &&
    serverBuildSha !== clientBuildSha
  ) {
    return { status: "required", server, reason: "build" };
  }

  if (normalizeVersion(server.version) !== normalizeVersion(CLIENT_SEMVER)) {
    return { status: "required", server, reason: "version" };
  }

  return { status: "current", server };
}

export async function checkClientUpdateRequirement(
  baseUrl: string,
  options: { force?: boolean } = {},
): Promise<ClientUpdateCheckResult> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  if (
    !options.force &&
    cachedCheck?.baseUrl === normalizedBaseUrl &&
    Date.now() - cachedCheck.checkedAt < CLIENT_UPDATE_CHECK_CACHE_MS
  ) {
    return cachedCheck.result;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    CLIENT_UPDATE_CHECK_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${normalizedBaseUrl}/api/version`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const result = { status: "unavailable" } as const;
      cachedCheck = { baseUrl: normalizedBaseUrl, checkedAt: Date.now(), result };
      return result;
    }
    const server = (await response.json()) as ServerVersionIdentity;
    const result = server.version
      ? evaluateClientUpdateRequirement(server)
      : ({ status: "unavailable" } as const);
    cachedCheck = { baseUrl: normalizedBaseUrl, checkedAt: Date.now(), result };
    return result;
  } catch {
    const result = { status: "unavailable" } as const;
    cachedCheck = { baseUrl: normalizedBaseUrl, checkedAt: Date.now(), result };
    return result;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function announceClientUpdateRequired(
  result: Extract<ClientUpdateCheckResult, { status: "required" }>,
): void {
  window.dispatchEvent(
    new CustomEvent(CLIENT_UPDATE_REQUIRED_EVENT, { detail: result }),
  );
}

export async function resyncPwaClient(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const cacheNames = await window.caches.keys();
    await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)));
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("ros_pwa_resync", Date.now().toString());
  window.location.replace(nextUrl.toString());
}
