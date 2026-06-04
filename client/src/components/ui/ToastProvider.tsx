import { useState, useCallback, useRef, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { ToastContext, type Toast, type ToastType } from "./ToastProviderLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { sessionPollAuthHeaders } from "../../lib/posRegisterAuth";
import {
  buildClientErrorCaptureMeta,
  redactDiagnosticText,
} from "../../lib/clientDiagnostics";

const baseUrl = getBaseUrl();
const recentErrorEventKeys = new Map<string, number>();
const TOAST_DEDUPE_WINDOW_MS = 5_000;
const TOAST_DISMISS_MS = 4_000;
const MAX_VISIBLE_TOASTS = 5;

function recordErrorToastEvent(message: string) {
  const trimmed = redactDiagnosticText(message).trim();
  if (!trimmed) return;
  const now = Date.now();
  const key = trimmed.toLowerCase().slice(0, 240);
  const last = recentErrorEventKeys.get(key) ?? 0;
  if (now - last < 30_000) return;
  recentErrorEventKeys.set(key, now);

  const headers = sessionPollAuthHeaders();
  if (!headers["x-riverside-staff-code"]) return;

  const route = redactDiagnosticText(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  void (async () => {
    const clientMeta = await buildClientErrorCaptureMeta({
      captureType: "toast_error_event",
      message,
      route,
      extra: { toast_source: "client" },
    });

    try {
      const res = await fetch(`${baseUrl}/api/bug-reports/error-events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          message: trimmed,
          event_source: "client_toast",
          severity: "error",
          route,
          client_meta: clientMeta,
        }),
      });
      if (!res.ok) {
        void res.text().catch(() => "");
      }
    } catch {
      /* best-effort telemetry; never create a second staff-facing error */
    }
  })().catch(() => {
    /* best-effort telemetry; never create a second staff-facing error */
  });
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const recentToastRef = useRef(
    new Map<string, { id: string; count: number; lastSeen: number }>(),
  );
  const dismissTimersRef = useRef(new Map<string, number>());

  const removeToast = useCallback((id: string) => {
    const timer = dismissTimersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    dismissTimersRef.current.delete(id);
    for (const [key, value] of recentToastRef.current.entries()) {
      if (value.id === id) {
        recentToastRef.current.delete(key);
      }
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const scheduleDismiss = useCallback((id: string) => {
    const existing = dismissTimersRef.current.get(id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      removeToast(id);
    }, TOAST_DISMISS_MS);
    dismissTimersRef.current.set(id, timer);
  }, [removeToast]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const key = `${type}:${redactDiagnosticText(trimmed).toLowerCase().slice(0, 240)}`;
    const now = Date.now();
    const existing = recentToastRef.current.get(key);
    if (existing && now - existing.lastSeen < TOAST_DEDUPE_WINDOW_MS) {
      existing.count += 1;
      existing.lastSeen = now;
      setToasts((prev) =>
        prev.map((t) =>
          t.id === existing.id ? { ...t, count: existing.count } : t,
        ),
      );
      scheduleDismiss(existing.id);
      if (type === "error") {
        recordErrorToastEvent(trimmed);
      }
      return;
    }

    const id = Math.random().toString(36).substring(2, 9);
    recentToastRef.current.set(key, { id, count: 1, lastSeen: now });
    setToasts((prev) => {
      const next = [...prev, { id, message: trimmed, type }];
      const overflow = next.slice(0, Math.max(0, next.length - MAX_VISIBLE_TOASTS));
      for (const oldToast of overflow) {
        const timer = dismissTimersRef.current.get(oldToast.id);
        if (timer) window.clearTimeout(timer);
        dismissTimersRef.current.delete(oldToast.id);
        for (const [recentKey, value] of recentToastRef.current.entries()) {
          if (value.id === oldToast.id) {
            recentToastRef.current.delete(recentKey);
          }
        }
      }
      return next.slice(-MAX_VISIBLE_TOASTS);
    });
    if (type === "error") {
      recordErrorToastEvent(trimmed);
    }

    scheduleDismiss(id);
  }, [scheduleDismiss]);

  return (
    <ToastContext.Provider value={{ toast, removeToast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-4 right-4 z-[9999] flex flex-col items-stretch gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto toast-slide-in flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-2xl border border-app-border bg-app-surface py-3 pl-4 pr-3 shadow-xl sm:max-w-sm"
          >
            {t.type === "success" && <CheckCircle2 className="h-5 w-5 shrink-0 text-app-success" />}
            {t.type === "error" && <AlertTriangle className="h-5 w-5 shrink-0 text-app-danger" />}
            {t.type === "info" && <Info className="h-5 w-5 shrink-0 text-app-accent" />}
            
            <p className="flex-1 text-sm font-medium text-app-text">
              {t.message}
              {t.count && t.count > 1 ? (
                <span className="ml-2 rounded-full border border-app-border bg-app-surface-2 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  ×{t.count}
                </span>
              ) : null}
            </p>
            
            <button
              type="button"
              onClick={() => removeToast(t.id)}
              className="ml-auto shrink-0 rounded-full p-1 text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
