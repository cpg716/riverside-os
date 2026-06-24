import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { getBaseUrl, getBaseUrlDiagnostics } from "../../lib/apiConfig";
import {
  redactDiagnosticText,
  submitClientErrorEvent,
} from "../../lib/clientDiagnostics";
import { dispatchAppToast } from "../ui/ToastProviderLogic";

type ServerConnectionState = "checking" | "online" | "offline";

interface QueuedServerConnectionEvent {
  id: string;
  message: string;
  route: string;
  baseUrl: string;
  baseUrlSource: string;
  startedAt: string;
  reason: string;
}

const QUEUE_KEY = "ros.serverConnection.errorQueue.v1";
const ACTIVE_EVENT_KEY = "ros.serverConnection.activeEvent.v1";
const HEALTH_INTERVAL_ONLINE_MS = 15_000;
const HEALTH_INTERVAL_OFFLINE_MS = 5_000;
const HEALTH_TIMEOUT_MS = 3_500;

function safeRoute(): string {
  if (typeof window === "undefined") return "/";
  return redactDiagnosticText(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
}

function readQueuedEvents(): QueuedServerConnectionEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function writeQueuedEvents(events: QueuedServerConnectionEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(events.slice(-20)));
  } catch {
    /* local diagnostic queue only */
  }
}

function queueServerConnectionEvent(reason: string): QueuedServerConnectionEvent {
  const diagnostics = getBaseUrlDiagnostics();
  const existingId =
    typeof window === "undefined" ? "" : window.localStorage.getItem(ACTIVE_EVENT_KEY);
  const existing = readQueuedEvents().find((event) => event.id === existingId);
  if (existing) return existing;

  const event: QueuedServerConnectionEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    message: "Riverside OS lost connection to the Main Hub server.",
    route: safeRoute(),
    baseUrl: diagnostics.resolved,
    baseUrlSource: diagnostics.source,
    startedAt: new Date().toISOString(),
    reason,
  };
  writeQueuedEvents([...readQueuedEvents(), event]);
  try {
    window.localStorage.setItem(ACTIVE_EVENT_KEY, event.id);
  } catch {
    /* local diagnostic queue only */
  }
  return event;
}

async function flushQueuedServerConnectionEvents(): Promise<void> {
  const queued = readQueuedEvents();
  if (queued.length === 0) return;

  const remaining: QueuedServerConnectionEvent[] = [];
  for (const event of queued) {
    const reported = await submitClientErrorEvent({
      message: event.message,
      eventSource: "server_connection",
      severity: "error",
      route: event.route,
      captureType: "server_connection_lost",
      extra: {
        base_url: event.baseUrl,
        base_url_source: event.baseUrlSource,
        outage_started_at: event.startedAt,
        outage_detected_reason: event.reason,
        outage_reported_at: new Date().toISOString(),
      },
    });
    if (!reported) remaining.push(event);
  }
  writeQueuedEvents(remaining);
  if (remaining.length === 0) {
    try {
      window.localStorage.removeItem(ACTIVE_EVENT_KEY);
    } catch {
      /* local diagnostic queue only */
    }
  }
}

async function probeServer(): Promise<{ ok: boolean; reason: string }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, reason: "device_offline" };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${getBaseUrl()}/api/health/`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "x-riverside-client-check": "server-connection-monitor",
      },
    });
    return {
      ok: res.ok,
      reason: res.ok ? "ok" : `http_${res.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.name : "network_error",
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function ServerConnectionMonitor() {
  const [state, setState] = useState<ServerConnectionState>("checking");
  const [lastOfflineAt, setLastOfflineAt] = useState<string | null>(null);
  const [lastReason, setLastReason] = useState<string | null>(null);
  const stateRef = useRef<ServerConnectionState>("checking");
  const inFlightRef = useRef(false);

  const serverLabel = useMemo(() => getBaseUrlDiagnostics().resolved, []);

  const runProbe = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await probeServer();
      if (result.ok) {
        if (stateRef.current === "offline") {
          dispatchAppToast("Main Hub server connection restored.", "success");
        }
        stateRef.current = "online";
        setState("online");
        setLastReason(null);
        await flushQueuedServerConnectionEvents();
        return;
      }

      if (stateRef.current !== "offline") {
        queueServerConnectionEvent(result.reason);
        dispatchAppToast(
          "Connection to the Main Hub server has been lost. ROS will retry automatically.",
          "error",
        );
        setLastOfflineAt(new Date().toLocaleTimeString());
      }
      stateRef.current = "offline";
      setState("offline");
      setLastReason(result.reason);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void runProbe();
    const timer = window.setInterval(
      () => void runProbe(),
      state === "offline" ? HEALTH_INTERVAL_OFFLINE_MS : HEALTH_INTERVAL_ONLINE_MS,
    );

    const handleOnline = () => {
      void runProbe();
    };
    const handleOffline = () => {
      void runProbe();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [runProbe, state]);

  if (state !== "offline") return null;

  const reason =
    lastReason === "device_offline"
      ? "This device is offline."
      : "ROS cannot reach the Main Hub server.";

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="server-connection-lost-banner"
      className="fixed left-0 right-0 top-0 z-[9998] border-b border-app-danger/30 bg-app-danger px-4 py-3 text-white shadow-2xl"
    >
      <div className="mx-auto flex max-w-screen-2xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
            <WifiOff className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-black uppercase tracking-[0.18em]">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Server connection lost
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug text-white/95">
              {reason} Do not start new sales, payments, receiving, or closing work
              until this clears.
            </p>
            <p className="mt-1 break-all text-xs font-medium text-white/80">
              Main Hub: {serverLabel}
              {lastOfflineAt ? ` · Detected ${lastOfflineAt}` : ""}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-white/30 bg-white/15 px-3 text-xs font-black uppercase tracking-widest text-white hover:bg-white/25"
          onClick={() => void runProbe()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Recheck
        </button>
      </div>
    </div>
  );
}
