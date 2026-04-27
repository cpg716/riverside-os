import { useState, useCallback, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { ToastContext, type Toast, type ToastType } from "./ToastProviderLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { sessionPollAuthHeaders } from "../../lib/posRegisterAuth";
import {
  buildClientErrorCaptureMeta,
} from "../../lib/clientDiagnostics";

const baseUrl = getBaseUrl();
const recentErrorEventKeys = new Map<string, number>();

function recordErrorToastEvent(message: string) {
  const trimmed = message.trim();
  if (!trimmed) return;
  const now = Date.now();
  const key = trimmed.toLowerCase().slice(0, 240);
  const last = recentErrorEventKeys.get(key) ?? 0;
  if (now - last < 30_000) return;
  recentErrorEventKeys.set(key, now);

  const headers = sessionPollAuthHeaders();
  if (!headers["x-riverside-staff-code"]) return;

  const route = `${window.location.pathname}${window.location.search}${window.location.hash}`;
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

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    if (type === "error") {
      recordErrorToastEvent(message);
    }

    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      removeToast(id);
    }, 4000);
  }, [removeToast]);

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
            
            <p className="flex-1 text-sm font-medium text-app-text">{t.message}</p>
            
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
