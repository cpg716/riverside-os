import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBaseUrl } from "../../lib/apiConfig";
import {
  HELCIM_PAY_SCRIPT_URL,
  helcimPayRuntimeBlocker,
} from "../../lib/helcimPayRuntime";

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string, allowExit?: boolean) => void;
  }
}

type HandoffState = "idle" | "loading" | "ready" | "approved" | "canceled" | "error";
type HandoffOutcome = "approved" | "failed" | "canceled";

interface HelcimPayMessage {
  eventName?: string;
  eventStatus?: "SUCCESS" | "ABORTED" | "HIDE" | string;
  eventMessage?: unknown;
}

const HELCIM_DOMAIN_ERROR_MESSAGE =
  "Helcim secure card entry could not open. Confirm ros.riversidemens.com is added to the Helcim API Access Configuration for this API token.";
const HELCIM_IFRAME_DIAGNOSTIC_MS = 6000;

function logHelcimDiagnostic(message: string, details?: Record<string, unknown>) {
  console.info("[ROS HelcimPay]", message, {
    origin: window.location.origin,
    hostname: window.location.hostname,
    scriptUrl: HELCIM_PAY_SCRIPT_URL,
    ...details,
  });
}

function loadHelcimPayScript(): Promise<void> {
  if (window.appendHelcimPayIframe) {
    logHelcimDiagnostic("HelcimPay.js already loaded");
    return Promise.resolve();
  }
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-ros-helcim-pay="true"]',
  );
  if (existing) {
    logHelcimDiagnostic("Waiting for existing HelcimPay.js script tag");
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => {
        logHelcimDiagnostic("Existing HelcimPay.js script loaded");
        resolve();
      }, { once: true });
      existing.addEventListener(
        "error",
        () => {
          console.error("[ROS HelcimPay] HelcimPay.js script failed to load", {
            origin: window.location.origin,
            hostname: window.location.hostname,
            scriptUrl: HELCIM_PAY_SCRIPT_URL,
          });
          reject(new Error("HelcimPay.js could not be loaded."));
        },
        { once: true },
      );
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HELCIM_PAY_SCRIPT_URL;
    script.async = true;
    script.dataset.rosHelcimPay = "true";
    logHelcimDiagnostic("Appending HelcimPay.js script tag");
    script.addEventListener("load", () => {
      logHelcimDiagnostic("HelcimPay.js script loaded");
      resolve();
    }, { once: true });
    script.addEventListener(
      "error",
      () => {
        console.error("[ROS HelcimPay] HelcimPay.js script failed to load", {
          origin: window.location.origin,
          hostname: window.location.hostname,
          scriptUrl: HELCIM_PAY_SCRIPT_URL,
        });
        reject(new Error("HelcimPay.js could not be loaded."));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
}

function parseHelcimPayEventMessage(message: unknown): { data?: unknown; hash?: string } {
  if (typeof message === "string") {
    return JSON.parse(message) as { data?: unknown; hash?: string };
  }
  if (message && typeof message === "object") {
    return message as { data?: unknown; hash?: string };
  }
  return {};
}

function hasHelcimPayIframe(): boolean {
  return document.getElementById("helcimPayIframe") instanceof HTMLIFrameElement;
}

function postHandoffOutcome(attemptId: string, outcome: HandoffOutcome) {
  const message = {
    source: "riverside-os",
    type: "helcim-card-not-present-outcome",
    outcome,
    attempt_id: attemptId,
  };
  window.parent?.postMessage(message, "*");
  window.opener?.postMessage(message, "*");
}

export default function HelcimManualCardHandoff() {
  const baseUrl = getBaseUrl();
  const iframeLaunchedRef = useRef(false);
  const diagnosticTimerRef = useRef<number | null>(null);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const attemptId = params.get("attempt_id")?.trim() ?? "";
  const checkoutToken = params.get("checkout_token")?.trim() ?? "";
  const eventName = checkoutToken ? `helcim-pay-js-${checkoutToken}` : "";
  const [state, setState] = useState<HandoffState>("idle");
  const [message, setMessage] = useState("Ready to open secure Card Not Present entry in Helcim.");

  useEffect(() => {
    if (!attemptId || !checkoutToken || !eventName) {
      setState("error");
      setMessage("Card Not Present link is missing payment details. Start Card Not Present again from the register.");
      return;
    }

    const runtimeBlocker = helcimPayRuntimeBlocker();
    if (runtimeBlocker) {
      setState("error");
      setMessage(runtimeBlocker);
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as HelcimPayMessage | undefined;
      if (!data || data.eventName !== eventName) return;
      logHelcimDiagnostic("Received HelcimPay.js iframe event", {
        eventStatus: data.eventStatus,
      });
      if (diagnosticTimerRef.current) {
        window.clearTimeout(diagnosticTimerRef.current);
        diagnosticTimerRef.current = null;
      }

      if (data.eventStatus === "ABORTED" || data.eventStatus === "HIDE") {
        iframeLaunchedRef.current = false;
        setState("canceled");
        setMessage("Card entry canceled. Return to the register or retry.");
        postHandoffOutcome(attemptId, "canceled");
        return;
      }
      if (data.eventStatus !== "SUCCESS") {
        iframeLaunchedRef.current = false;
        setState("error");
        setMessage("Helcim did not approve this payment.");
        postHandoffOutcome(attemptId, "failed");
        return;
      }

      void (async () => {
        try {
          const payload = parseHelcimPayEventMessage(data.eventMessage);
          if (!payload.data || !payload.hash) {
            throw new Error("Helcim response was incomplete.");
          }
          const res = await fetch(`${baseUrl}/api/payments/providers/helcim/helcim-pay/public-confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              attempt_id: attemptId,
              checkout_token: checkoutToken,
              data: payload.data,
              hash: payload.hash,
            }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string; error_message?: string | null; safe_message?: string | null };
          if (!res.ok) {
            throw new Error(body.error ?? "ROS could not confirm the Helcim payment.");
          }
          if (body.status === "approved" || body.status === "captured") {
            setState("approved");
            setMessage("Approved. Return to the register to complete the sale.");
            postHandoffOutcome(attemptId, "approved");
            return;
          }
          if (body.status === "canceled") {
            setState("canceled");
            setMessage("Card entry canceled. Return to the register or retry.");
            postHandoffOutcome(attemptId, "canceled");
            return;
          }
          setState("error");
          setMessage(body.safe_message ?? body.error_message ?? "Helcim did not approve this payment.");
          postHandoffOutcome(attemptId, "failed");
        } catch (error) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "ROS could not confirm the Helcim payment.");
          postHandoffOutcome(attemptId, "failed");
        }
      })();
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      if (diagnosticTimerRef.current) {
        window.clearTimeout(diagnosticTimerRef.current);
        diagnosticTimerRef.current = null;
      }
    };
  }, [attemptId, baseUrl, checkoutToken, eventName]);

  const openHelcimEntry = useCallback(() => {
    if (state === "approved" || iframeLaunchedRef.current) return;
    if (!attemptId || !checkoutToken || !eventName) {
      setState("error");
      setMessage("Card Not Present link is missing payment details. Start Card Not Present again from the register.");
      return;
    }
    const runtimeBlocker = helcimPayRuntimeBlocker();
    if (runtimeBlocker) {
      setState("error");
      setMessage(runtimeBlocker);
      return;
    }
    iframeLaunchedRef.current = true;
    setState("loading");
    setMessage("Opening secure Card Not Present entry...");
    logHelcimDiagnostic("Starting HelcimPay.js card entry", {
      attemptId,
      checkoutTokenLength: checkoutToken.length,
    });
    void loadHelcimPayScript()
      .then(() => {
        if (!window.appendHelcimPayIframe) {
          throw new Error("HelcimPay.js could not be loaded.");
        }
        logHelcimDiagnostic("Calling appendHelcimPayIframe", {
          checkoutTokenLength: checkoutToken.length,
          allowExit: true,
        });
        window.appendHelcimPayIframe(checkoutToken, true);
        if (!hasHelcimPayIframe()) {
          console.error("[ROS HelcimPay] HelcimPay iframe was not attached", {
            origin: window.location.origin,
            hostname: window.location.hostname,
            scriptUrl: HELCIM_PAY_SCRIPT_URL,
            checkoutTokenLength: checkoutToken.length,
          });
          throw new Error(
            HELCIM_DOMAIN_ERROR_MESSAGE,
          );
        }
        logHelcimDiagnostic("HelcimPay iframe attached", {
          iframePresent: true,
        });
        if (diagnosticTimerRef.current) {
          window.clearTimeout(diagnosticTimerRef.current);
        }
        diagnosticTimerRef.current = window.setTimeout(() => {
          console.warn("[ROS HelcimPay] HelcimPay iframe produced no event yet", {
            origin: window.location.origin,
            hostname: window.location.hostname,
            scriptUrl: HELCIM_PAY_SCRIPT_URL,
            checkoutTokenLength: checkoutToken.length,
            iframePresent: hasHelcimPayIframe(),
            help: HELCIM_DOMAIN_ERROR_MESSAGE,
          });
        }, HELCIM_IFRAME_DIAGNOSTIC_MS);
        setState("ready");
        setMessage("Enter the card in Helcim.");
      })
      .catch((error) => {
        iframeLaunchedRef.current = false;
        console.error("[ROS HelcimPay] HelcimPay launch failed", {
          origin: window.location.origin,
          hostname: window.location.hostname,
          scriptUrl: HELCIM_PAY_SCRIPT_URL,
          error,
        });
        setState("error");
        setMessage(error instanceof Error ? error.message : HELCIM_DOMAIN_ERROR_MESSAGE);
      });
  }, [attemptId, checkoutToken, eventName, state]);

  const statusTone =
    state === "approved"
      ? "text-app-success"
      : state === "error"
        ? "text-app-danger"
        : state === "canceled"
          ? "text-app-warning"
          : "text-app-text";

  return (
    <main className="flex min-h-screen items-center justify-center bg-app-bg px-6 py-10 text-app-text">
      <section className="ui-card w-full max-w-xl p-8 text-center">
        <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">
          Riverside OS
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight">
          Secure Card Not Present
        </h1>
        <p className={`mt-5 text-base font-bold leading-relaxed ${statusTone}`}>
          {message}
        </p>
        <p className="mt-4 text-sm leading-relaxed text-app-text-muted">
          Keep checkout open. ROS attaches approved Helcim payments automatically.
        </p>
        {state === "idle" || state === "loading" || state === "ready" ? (
          <p className="mt-3 text-xs font-semibold leading-relaxed text-app-text-muted">
            Helcim may ask for billing ZIP and street address for card verification.
          </p>
        ) : null}
        {state === "error" ? (
          <p className="mt-4 text-xs font-semibold leading-relaxed text-app-text-muted">
            {HELCIM_DOMAIN_ERROR_MESSAGE}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <button
            type="button"
            className="ui-btn-primary px-5 py-2"
            disabled={state === "loading" || state === "ready" || state === "approved" || state === "error"}
            onClick={openHelcimEntry}
          >
            {state === "loading" || state === "ready" ? "Waiting for Helcim" : "Open Helcim Card Entry"}
          </button>
          <button
            type="button"
            className="ui-btn-secondary px-5 py-2"
            onClick={() => {
              window.close();
              if (!window.closed) {
                window.location.assign("/pos");
              }
            }}
          >
            Return to ROS
          </button>
        </div>
      </section>
    </main>
  );
}
