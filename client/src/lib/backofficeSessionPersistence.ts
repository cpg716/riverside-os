/** Survives reload in this tab only. The raw Access PIN is never persisted. */
const KEY = "ros.backoffice.session.v2";
const LEGACY_PIN_KEY = "ros.backoffice.session.v1";

export type PersistedBackofficeSession = {
  /** Authenticated staff UUID; never the entered Access PIN. */
  staffCode: string;
  sessionToken: string;
  sessionExpiresAt: string;
};

export function readPersistedBackofficeSession(): PersistedBackofficeSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as {
      staffCode?: string;
      sessionToken?: string;
      sessionExpiresAt?: string;
    };
    const staffCode = String(o.staffCode ?? "").trim();
    const sessionToken = String(o.sessionToken ?? "").trim();
    const sessionExpiresAt = String(o.sessionExpiresAt ?? "").trim();
    if (!staffCode || !sessionToken || !sessionExpiresAt) return null;
    const expiry = Date.parse(sessionExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      clearPersistedBackofficeSession();
      return null;
    }
    return { staffCode, sessionToken, sessionExpiresAt };
  } catch {
    return null;
  }
}

export function writePersistedBackofficeSession(
  staffCode: string,
  sessionToken: string,
  sessionExpiresAt: string,
): void {
  try {
    const code = staffCode.trim();
    const token = sessionToken.trim();
    const expiresAt = sessionExpiresAt.trim();
    if (!code || !token || !expiresAt) {
      clearPersistedBackofficeSession();
      return;
    }
    sessionStorage.removeItem(LEGACY_PIN_KEY);
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        staffCode: code,
        sessionToken: token,
        sessionExpiresAt: expiresAt,
      }),
    );
    window.dispatchEvent(new CustomEvent("ros-backoffice-session-changed"));
  } catch {
    /* ignore quota */
  }
}

export function clearPersistedBackofficeSession(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(LEGACY_PIN_KEY);
    window.dispatchEvent(new CustomEvent("ros-backoffice-session-changed"));
  } catch {
    /* ignore */
  }
}
