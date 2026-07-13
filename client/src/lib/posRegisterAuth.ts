import { readPersistedBackofficeSession } from "./backofficeSessionPersistence";
import {
  getConnectionKey,
  getStableStationKey,
  stationKeyHeader,
} from "./stationIdentity";

/**
 * Opaque register-session token from `POST /api/sessions/open` (or re-issue).
 * Sent as headers for POS-protected routes (customers, checkout, inventory scan/control-board)
 * while the register session is open.
 */
const STORAGE_KEY = "ros.posRegisterAuth.v1";

export type PosRegisterAuth = {
  sessionId: string;
  token: string;
  stationKey: string;
};

export function setPosRegisterAuth(
  auth: Omit<PosRegisterAuth, "stationKey"> & { stationKey?: string },
): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...auth,
        stationKey: auth.stationKey?.trim() || getStableStationKey(),
      }),
    );
  } catch {
    /* ignore quota */
  }
}

export function clearPosRegisterAuth(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function getPosRegisterAuth(): PosRegisterAuth | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<PosRegisterAuth>;
    if (o?.sessionId && o?.token) {
      return {
        sessionId: o.sessionId,
        token: o.token,
        stationKey: getStableStationKey(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Drop stored token if the server session id no longer matches (e.g. another terminal opened the register). */
export function syncPosRegisterSessionId(serverSessionId: string): void {
  const a = getPosRegisterAuth();
  if (a && a.sessionId !== serverSessionId) {
    clearPosRegisterAuth();
  }
}

export function posRegisterAuthHeaders(): Record<string, string> {
  const a = getPosRegisterAuth();
  if (!a?.sessionId || !a?.token) return {};
  return {
    "x-riverside-pos-session-id": a.sessionId,
    "x-riverside-pos-session-token": a.token,
    "x-riverside-station-key": a.stationKey,
  };
}

/**
 * For `GET /api/sessions/current` and similar: server accepts **POS session** headers **or**
 * Back Office staff headers. Merge both so BO sign-in works without an open register (expect 404
 * when no till is open, not 401).
 */
export function sessionPollAuthHeaders(): Record<string, string> {
  const out: Record<string, string> = { ...posRegisterAuthHeaders() };
  const bo = readPersistedBackofficeSession();
  if (bo?.staffCode) {
    out["x-riverside-staff-code"] = bo.staffCode;
    out["x-riverside-staff-session"] = bo.sessionToken;
    out["x-riverside-connection-key"] = getConnectionKey();
  }
  Object.assign(out, stationKeyHeader());
  return out;
}

/** True when `GET /api/sessions/current` can authenticate (staff or open-register POS token). */
export function hasRegisterSessionPollCredentials(
  h: Record<string, string>,
): boolean {
  return Boolean(
    (h["x-riverside-staff-code"] ?? "").trim() ||
    (h["x-riverside-staff-session"] ?? "").trim() ||
    ((h["x-riverside-pos-session-id"] ?? "").trim() &&
      (h["x-riverside-station-key"] ?? "").trim()),
  );
}

export function hasStaffOrPosAuthHeaders(h: Record<string, string>): boolean {
  return Boolean(
    ((h["x-riverside-staff-session"] ?? "").trim() &&
      (h["x-riverside-station-key"] ?? "").trim() &&
      (h["x-riverside-connection-key"] ?? "").trim()) ||
    ((h["x-riverside-staff-code"] ?? "").trim() &&
      (h["x-riverside-staff-pin"] ?? "").trim()) ||
    ((h["x-riverside-pos-session-id"] ?? "").trim() &&
      (h["x-riverside-pos-session-token"] ?? "").trim() &&
      (h["x-riverside-station-key"] ?? "").trim()),
  );
}

/** Header names (case-insensitive) that must never be persisted (offline queue / IndexedDB). */
const NON_PERSISTABLE_HEADER_NAMES = new Set([
  "x-riverside-staff-pin",
  "x-riverside-staff-session",
  "x-riverside-pos-session-token",
  "authorization",
  "cookie",
]);

/** Strip secrets before storing auth header snapshots (see `offlineQueue`). */
export function headersSafeForOfflinePersist(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (NON_PERSISTABLE_HEADER_NAMES.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Merge Back Office staff headers with an open register session (POS token wins on key overlap; keys are disjoint today). */
export function mergedPosStaffHeaders(
  staffHeaders: (() => HeadersInit) | Record<string, string>,
): Record<string, string> {
  const sh = typeof staffHeaders === "function" ? staffHeaders() : staffHeaders;
  const base: Record<string, string> =
    typeof sh === "object" && sh !== null && !(sh instanceof Headers)
      ? { ...(sh as Record<string, string>) }
      : sh instanceof Headers
        ? Object.fromEntries(sh.entries())
        : {};
  return { ...base, ...stationKeyHeader(), ...posRegisterAuthHeaders() };
}

export type HydratePosRegisterAuthArgs = {
  baseUrl: string;
  sessionId: string;
  /** Usually `mergedPosStaffHeaders(backofficeHeaders)` before POS keys are merged in storage. */
  authHeaders: Record<string, string>;
  /**
   * For `POST /sessions/:id/pos-api-token` when attach is not allowed: must match the staff member
   * who opened this session (`opened_by`).
   */
  openerCashierCode?: string;
  openerPin?: string;
};

/**
 * Checkout and other POS-scoped routes require `x-riverside-pos-session-id` + token. After a full page
 * load, Back Office bootstrap may know the session from staff auth alone — this mints or copies a
 * token into sessionStorage.
 *
 * 1. `POST .../attach` — staff with `register.session_attach` receives the live session token.
 * 2. `POST .../pos-api-token` — the opener may re-issue when attach is not permitted.
 */
export async function hydratePosRegisterAuthIfNeeded(
  args: HydratePosRegisterAuthArgs,
): Promise<boolean> {
  const sid = args.sessionId.trim();
  if (!sid) return false;

  const existing = getPosRegisterAuth();
  if (existing?.sessionId === sid && existing?.token?.trim()) {
    return true;
  }

  const root = args.baseUrl.replace(/\/+$/, "");
  const headersBase = { ...args.authHeaders };

  const attachRes = await fetch(
    `${root}/api/sessions/${encodeURIComponent(sid)}/attach`,
    {
      method: "POST",
      headers: {
        ...headersBase,
        ...stationKeyHeader(),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (attachRes.ok) {
    const j = (await attachRes.json()) as { pos_api_token?: string };
    const tok = j.pos_api_token?.trim();
    if (tok) {
      setPosRegisterAuth({ sessionId: sid, token: tok });
      return true;
    }
  }

  const code = args.openerCashierCode?.trim();
  if (code?.length === 4) {
    const pinRaw = (args.openerPin ?? "").trim();
    const issueRes = await fetch(
      `${root}/api/sessions/${encodeURIComponent(sid)}/pos-api-token`,
      {
        method: "POST",
        headers: {
          ...headersBase,
          ...stationKeyHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cashier_code: code,
          pin: pinRaw.length > 0 ? pinRaw : code,
          station_key: getStableStationKey(),
        }),
      },
    );
    if (issueRes.ok) {
      const j = (await issueRes.json()) as { pos_api_token?: string };
      const tok = j.pos_api_token?.trim();
      if (tok) {
        setPosRegisterAuth({ sessionId: sid, token: tok });
        return true;
      }
    }
  }

  return false;
}
