import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import html2canvas from "html2canvas";
import { Bug, X } from "lucide-react";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  buildClientErrorCaptureMeta,
  getClientDiagnosticLogText,
} from "../../lib/clientDiagnostics";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";

const baseUrl = getBaseUrl();

/** 1×1 transparent PNG — used when screenshot skipped or capture fails. */
const PLACEHOLDER_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Phase = "capture" | "form";

export function BugReportTriggerButton({
  onOpen,
  className = "",
}: {
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="bug-report-trigger"
      className={`relative inline-flex touch-manipulation items-center justify-center rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text shadow-sm transition-colors hover:bg-app-border/20 ${className}`.trim()}
      aria-label="Report a bug"
    >
      <Bug size={18} strokeWidth={2} aria-hidden />
    </button>
  );
}

export default function BugReportFlow({
  isOpen,
  onClose,
  navigationContext,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** ROS navigation snapshot for triage (tab, subsection, register session, shell mode). */
  navigationContext?: Record<string, unknown>;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  useShellBackdropLayer(isOpen);
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, { onEscape: onClose });

  const [phase, setPhase] = useState<Phase>("capture");
  const [captureErr, setCaptureErr] = useState<string | null>(null);
  const [screenshotPngBase64, setScreenshotPngBase64] = useState<string | null>(null);
  const [includeCapture, setIncludeCapture] = useState(true);
  const [summary, setSummary] = useState("");
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setPhase("capture");
    setCaptureErr(null);
    setScreenshotPngBase64(null);
    setIncludeCapture(true);
    setSummary("");
    setSteps("");
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      reset();
      return;
    }
    let cancelled = false;
    setPhase("capture");
    setCaptureErr(null);

    if (!includeCapture) {
      setScreenshotPngBase64(PLACEHOLDER_PNG_B64);
      setPhase("form");
      return;
    }

    void (async () => {
      try {
        const target = document.getElementById("root");
        if (!target) {
          if (!cancelled) {
            setCaptureErr("Could not find app root for screenshot.");
            setScreenshotPngBase64(PLACEHOLDER_PNG_B64);
            setPhase("form");
          }
          return;
        }
        const canvas = await html2canvas(target, {
          scale: typeof window !== "undefined" && window.devicePixelRatio >= 2 ? 0.5 : 0.55,
          useCORS: true,
          allowTaint: true,
          logging: false,
          backgroundColor: null,
          scrollX: 0,
          scrollY: typeof window !== "undefined" ? -window.scrollY : 0,
          windowWidth:
            typeof document !== "undefined"
              ? document.documentElement.clientWidth
              : undefined,
          windowHeight:
            typeof document !== "undefined"
              ? document.documentElement.clientHeight
              : undefined,
        });
        const dataUrl = canvas.toDataURL("image/png");
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        if (cancelled) return;
        setScreenshotPngBase64(b64);
        setPhase("form");
      } catch (e) {
        if (!cancelled) {
          setCaptureErr(e instanceof Error ? e.message : "Screenshot failed");
          setScreenshotPngBase64(PLACEHOLDER_PNG_B64);
          setPhase("form");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, includeCapture, reset]);

  const submit = async () => {
    const summ = summary.trim();
    const st = steps.trim();
    if (!summ || !st) {
      toast("Describe the issue and what you were doing", "error");
      return;
    }
    setBusy(true);
    try {
      const consoleLog = getClientDiagnosticLogText();
      const meta = await buildClientErrorCaptureMeta({
        captureType: "manual_bug_report",
        message: summ,
        extra: {
          client_semver: CLIENT_SEMVER,
          git_short: GIT_SHORT,
          ros_navigation: navigationContext ?? null,
          include_capture: includeCapture,
          steps_context: st,
          summary: summ,
        },
      });
      const res = await fetch(`${baseUrl}/api/bug-reports`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(mergedPosStaffHeaders(backofficeHeaders) as Record<string, string>),
        },
        body: JSON.stringify({
          summary: summ,
          steps_context: st,
          client_console_log: consoleLog,
          client_meta: meta,
          include_screenshot: includeCapture,
          screenshot_png_base64: screenshotPngBase64 ?? PLACEHOLDER_PNG_B64,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (import.meta.env.VITE_SENTRY_DSN?.trim()) {
          try {
            const Sentry = await import("@sentry/react");
            Sentry.captureMessage(`bug_report_submit_${res.status}`, {
              level: "warning",
              extra: { error: j.error, status: res.status },
            });
          } catch {
            /* optional dependency */
          }
        }
        if (res.status === 429) {
          toast(j.error ?? "Too many bug reports — try again in a few minutes", "error");
        } else {
          toast(j.error ?? "Could not submit bug report", "error");
        }
        return;
      }
      const ok = (await res.json()) as { id?: string; correlation_id?: string };
      const ref = ok.correlation_id?.slice(0, 8);
      toast(
        ref
          ? `Report sent. Reference ${ref}… (full id in Settings if you are admin).`
          : "Bug report sent. Thank you.",
        "success",
      );
      onClose();
    } catch (e) {
      if (import.meta.env.VITE_SENTRY_DSN?.trim()) {
        try {
          const Sentry = await import("@sentry/react");
          Sentry.captureException(e);
        } catch {
          /* optional */
        }
      }
      toast("Network error submitting report", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="ui-overlay-backdrop !z-[300]"
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ui-modal flex max-h-[min(92vh,900px)] max-w-2xl flex-col [-webkit-overflow-scrolling:touch]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="ui-modal-header flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-black tracking-tight text-app-text">
            Report a bug
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text-muted hover:text-app-text"
            aria-label="Close"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="ui-modal-body min-h-0 flex-1 overflow-y-auto">
          {phase === "capture" ? (
            <div className="space-y-3">
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-sm text-app-text">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={includeCapture}
                  onChange={(e) => setIncludeCapture(e.target.checked)}
                />
                <span>
                  <span className="font-semibold">Attach screenshot</span>
                  <span className="mt-0.5 block text-xs text-app-text-muted">
                    Uncheck on slow networks or if the screen may contain sensitive customer data you
                    prefer not to capture.
                  </span>
                </span>
              </label>
              {includeCapture ? (
                <p className="text-sm text-app-text-muted">Capturing the current screen…</p>
              ) : (
                <p className="text-sm text-app-text-muted">
                  Screenshot skipped — only a placeholder image is sent.
                </p>
              )}
            </div>
          ) : null}
          {captureErr ? (
            <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-app-text">
              Screenshot not captured: {captureErr}. You can still describe the issue; admins may
              ask for a manual screen photo.
            </p>
          ) : null}
          {phase === "form" ? (
            <div className="space-y-4">
              {screenshotPngBase64 ? (
                <div>
                  <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {includeCapture && screenshotPngBase64.length > 100
                      ? `Screen capture (${screenshotPngBase64.length > 50_000 ? "large" : "ok"})`
                      : "No screen capture (placeholder only)"}
                  </p>
                  <img
                    src={`data:image/png;base64,${screenshotPngBase64}`}
                    alt="Captured screen preview"
                    className="max-h-40 w-full rounded-xl border border-app-border object-contain object-top bg-app-surface-2"
                  />
                </div>
              ) : null}
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  What went wrong?
                </span>
                <textarea
                  className="ui-input mt-1 min-h-[88px] w-full text-sm"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="e.g. Save button on customer hub did nothing after I edited the phone field."
                  disabled={busy}
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  What were you doing right before it happened?
                </span>
                <textarea
                  className="ui-input mt-1 min-h-[100px] w-full text-sm"
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                  placeholder="Screen, tab, customer/order if any, and the last things you clicked or typed."
                  disabled={busy}
                />
              </label>
              <p className="text-[10px] leading-relaxed text-app-text-muted">
                We attach recent console output, page URL, device/runtime info (Tauri desktop,
                installed PWA, or browser — including iPad), ROS tab/subsection/session when
                available, and a snapshot of the API server in-memory log buffer at submit time (not a
                full disk log file).
              </p>
            </div>
          ) : null}
        </div>
        <div className="ui-modal-footer">
          <button type="button" className="ui-btn-secondary px-4" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn-primary px-4"
            onClick={() => void submit()}
            disabled={busy || phase !== "form"}
          >
            {busy ? "Sending…" : "Submit report"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
