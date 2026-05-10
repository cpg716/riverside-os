/**
 * Captures recent browser console output + global errors for bug reports.
 * `client_meta` also carries build/orientation/Tauri shell info and optional **`ros_navigation`** (tab, subsection, shell modes, register session id). On submit, the API attaches a **server-side** `tracing` ring snapshot (`server_log_snapshot` in DB — not a full host log file).
 * Surfaces: Tauri desktop (primary), installed PWA / iOS standalone, and plain browser tabs.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getBaseUrl } from "./apiConfig";
import { sessionPollAuthHeaders } from "./posRegisterAuth";

const MAX_LINES = 450;
const lines: string[] = [];
const REDACTED = "[redacted]";
const recentUnhandledEventKeys = new Map<string, number>();

const SENSITIVE_KEY_RE =
  /(^|[_-])(authorization|cookie|password|passwd|pwd|secret|token|api[_-]?key|session|pin|staff[_-]?pin|access[_-]?pin|pos[_-]?session)([_-]|$)/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi;
const AUTH_HEADER_RE =
  /\b(authorization|cookie|set-cookie|x-riverside-staff-pin|x-riverside-pos-session-token)\b\s*[:=]\s*([^\s,;}"']+)/gi;
const SENSITIVE_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|session|pin|staff[_-]?pin|access[_-]?pin)[A-Za-z0-9_-]*)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}"']+)/gi;

export function redactDiagnosticText(value: string): string {
  return value
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(AUTH_HEADER_RE, (_match, key: string) => `${key}: ${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}: ${REDACTED}`);
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return `${value.name}: ${redactDiagnosticText(value.message)}\n${redactDiagnosticText(value.stack ?? "")}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item));
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactDiagnosticValue(raw);
  }
  return out;
}

function push(line: string) {
  const t = new Date().toISOString();
  lines.push(`[${t}] ${redactDiagnosticText(line)}`);
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
  }
}

function stringifyArgs(args: unknown[]): string {
  try {
    return redactDiagnosticText(
      args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error)
            return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
          return JSON.stringify(redactDiagnosticValue(a));
        })
        .join(" "),
    );
  } catch {
    return redactDiagnosticText(String(args));
  }
}

let installed = false;

export function installClientDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...a: unknown[]) => {
    push(`LOG ${stringifyArgs(a)}`);
    origLog(...a);
  };
  console.info = (...a: unknown[]) => {
    push(`INFO ${stringifyArgs(a)}`);
    origInfo(...a);
  };
  console.warn = (...a: unknown[]) => {
    push(`WARN ${stringifyArgs(a)}`);
    origWarn(...a);
  };
  console.error = (...a: unknown[]) => {
    push(`ERROR ${stringifyArgs(a)}`);
    origError(...a);
  };

  window.addEventListener("error", (ev) => {
    const message = `WINDOW_ERROR ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}${ev.error ? ` (${ev.error})` : ""}`;
    push(
      message,
    );
    void recordUnhandledClientErrorEvent(message, "window_error");
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    const message = `UNHANDLED_REJECTION ${r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}` : String(r)}`;
    push(message);
    void recordUnhandledClientErrorEvent(message, "unhandled_rejection");
  });
}

export function getClientDiagnosticLogText(): string {
  return redactDiagnosticText(lines.join("\n"));
}

export function getClientDiagnosticTail(maxTailBytes = 24_000): string {
  const fullLog = getClientDiagnosticLogText();
  const tail = fullLog.split("\n").slice(-80).join("\n");
  return tail.length > maxTailBytes ? tail.slice(-maxTailBytes) : tail;
}

/** iPadOS 13+ reports a “Mac” platform with touch. */
function isLikelyIpados(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isLikelyIosFamily(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || isLikelyIpados();
}

function pwaStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* ignore */
  }
  try {
    // Safari “Add to Home Screen”
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((navigator as any).standalone === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export type ClientRuntimeSurface =
  | "tauri_desktop"
  | "pwa_standalone"
  | "browser_tab";

export function getClientRuntimeSurface(): ClientRuntimeSurface {
  if (typeof window === "undefined") return "browser_tab";
  if (isTauri()) return "tauri_desktop";
  if (pwaStandaloneDisplay()) return "pwa_standalone";
  return "browser_tab";
}

export function getClientMetaSnapshot(
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const dpr =
    typeof window !== "undefined" && typeof window.devicePixelRatio === "number"
      ? window.devicePixelRatio
      : null;
  const orient =
    typeof screen !== "undefined" ? (screen.orientation?.type ?? null) : null;

  return {
    href: typeof window !== "undefined" ? window.location.href : "",
    pathname: typeof window !== "undefined" ? window.location.pathname : "",
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    language: typeof navigator !== "undefined" ? navigator.language : "",
    languages:
      typeof navigator !== "undefined" && Array.isArray(navigator.languages)
        ? navigator.languages.slice(0, 6)
        : null,
    platform: typeof navigator !== "undefined" ? navigator.platform : "",
    max_touch_points:
      typeof navigator !== "undefined" ? (navigator.maxTouchPoints ?? 0) : 0,
    runtime_surface: getClientRuntimeSurface(),
    likely_ios_family: isLikelyIosFamily(),
    visibility_state:
      typeof document !== "undefined" ? document.visibilityState : null,
    viewport:
      typeof window !== "undefined"
        ? { w: window.innerWidth, h: window.innerHeight, dpr }
        : null,
    screen:
      typeof screen !== "undefined"
        ? {
            w: screen.width,
            h: screen.height,
            avail_w: screen.availWidth,
            avail_h: screen.availHeight,
            orient,
          }
        : null,
    note: "Recent Riverside API server tracing output is attached automatically on submit (in-process buffer). For external terminals or multi-instance deploys, note the time and host.",
    ...extra,
  };
}

export type ErrorCaptureKind =
  | "toast_error_event"
  | "unhandled_error_event"
  | "manual_bug_report";

export interface ErrorCapturePayloadOptions {
  captureType: ErrorCaptureKind;
  message?: string;
  route?: string;
  severity?: string;
  extra?: Record<string, unknown>;
}

export async function buildClientErrorCaptureMeta(
  options: ErrorCapturePayloadOptions,
): Promise<Record<string, unknown>> {
  const route =
    options.route ??
    `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const capture = redactDiagnosticValue({
    capture_type: options.captureType,
    captured_at: new Date().toISOString(),
    message: options.message,
    route,
    severity: options.severity,
    ...options.extra,
  }) as Record<string, unknown>;

  return withTauriShellVersion(
    redactDiagnosticValue(getClientMetaSnapshot({
      event_capture: capture,
      route,
      diag_tail_lines: getClientDiagnosticTail(),
      online: typeof navigator === "undefined" ? false : navigator.onLine,
    })) as Record<string, unknown>,
  );
}

async function recordUnhandledClientErrorEvent(
  message: string,
  source: "window_error" | "unhandled_rejection",
): Promise<void> {
  const trimmed = redactDiagnosticText(message).trim();
  if (!trimmed || typeof window === "undefined") return;
  const now = Date.now();
  const key = `${source}:${trimmed}`.toLowerCase().slice(0, 240);
  const last = recentUnhandledEventKeys.get(key) ?? 0;
  if (now - last < 30_000) return;
  recentUnhandledEventKeys.set(key, now);

  const headers = sessionPollAuthHeaders();
  if (!headers["x-riverside-staff-code"]) return;
  const route = redactDiagnosticText(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );

  try {
    const clientMeta = await buildClientErrorCaptureMeta({
      captureType: "unhandled_error_event",
      message: trimmed,
      route,
      severity: "error",
      extra: { event_source: source },
    });
    await fetch(`${getBaseUrl()}/api/bug-reports/error-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        message: trimmed,
        event_source: source,
        severity: "error",
        route,
        client_meta: clientMeta,
      }),
    }).catch(() => undefined);
  } catch {
    /* best-effort telemetry; never create user-facing noise */
  }
}

/** Adds Tauri shell version when running inside the desktop app (no-op on web/PWA). */
export async function withTauriShellVersion(
  meta: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof window === "undefined" || !isTauri()) return meta;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    return { ...meta, tauri_shell_version: v };
  } catch {
    return meta;
  }
}
