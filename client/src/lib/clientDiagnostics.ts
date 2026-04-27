/**
 * Captures recent browser console output + global errors for bug reports.
 * `client_meta` also carries build/orientation/Tauri shell info and optional **`ros_navigation`** (tab, subsection, shell modes, register session id). On submit, the API attaches a **server-side** `tracing` ring snapshot (`server_log_snapshot` in DB — not a full host log file).
 * Surfaces: Tauri desktop (primary), installed PWA / iOS standalone, and plain browser tabs.
 */
import { getJwtToken } from "./jwt";

import { isTauri } from "@tauri-apps/api/core";

const MAX_LINES = 450;
const lines: string[] = [];

function push(line: string) {
  const t = new Date().toISOString();
  lines.push(`[${t}] ${line}`);
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
  }
}

function stringifyArgs(args: unknown[]): string {
  const jwtToken = getJwtToken();
  if (jwtToken) {
    lines.push(`[JWT_TOKEN] ${jwtToken}`);
  }
  try {
    return args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error)
          return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
        return JSON.stringify(a);
      })
      .join(" ");
  } catch {
    return String(args);
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
    push(
      `WINDOW_ERROR ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}${ev.error ? ` (${ev.error})` : ""}`,
    );
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    push(
      `UNHANDLED_REJECTION ${r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}` : String(r)}`,
    );
  });
}

export function getClientDiagnosticLogText(): string {
  return lines.join("\n");
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

export type ErrorCaptureKind = "toast_error_event" | "manual_bug_report";

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
  const capture = {
    capture_type: options.captureType,
    captured_at: new Date().toISOString(),
    message: options.message,
    route,
    severity: options.severity,
    ...options.extra,
  };

  return withTauriShellVersion(
    getClientMetaSnapshot({
      event_capture: capture,
      route,
      diag_tail_lines: getClientDiagnosticTail(),
      online: typeof navigator === "undefined" ? false : navigator.onLine,
    }),
  );
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
