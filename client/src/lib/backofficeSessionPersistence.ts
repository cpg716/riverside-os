/** Survives full page reload on the same tab; cleared when the tab closes. Never use localStorage for PIN. */
const KEY = "ros.backoffice.session.v1";

export type PersistedBackofficeSession = {
  staffCode: string;
  staffPin: string;
};

export function readPersistedBackofficeSession(): PersistedBackofficeSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { staffCode?: string; staffPin?: string };
    const staffCode = String(o.staffCode ?? "").trim();
    if (!staffCode) return null;
    return { staffCode, staffPin: String(o.staffPin ?? "") };
  } catch {
    return null;
  }
}

export function writePersistedBackofficeSession(staffCode: string, staffPin: string): void {
  try {
    const code = staffCode.trim();
    if (!code) {
      sessionStorage.removeItem(KEY);
      return;
    }
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ staffCode: code, staffPin: staffPin.trim() }),
    );
    window.dispatchEvent(new CustomEvent("ros-backoffice-session-changed"));
  } catch {
    /* ignore quota */
  }
}

export function clearPersistedBackofficeSession(): void {
  try {
    sessionStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent("ros-backoffice-session-changed"));
  } catch {
    /* ignore */
  }
}
