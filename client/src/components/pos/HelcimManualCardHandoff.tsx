import { useEffect, useMemo, useRef, useState } from "react";
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

type HandoffState = "loading" | "ready" | "approved" | "canceled" | "error";

interface HelcimPayMessage {
  eventName?: string;
  eventStatus?: "SUCCESS" | "ABORTED" | "HIDE" | string;
  eventMessage?: unknown;
}

function loadHelcimPayScript(): Promise<void> {
  if (window.appendHelcimPayIframe) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-ros-helcim-pay="true"]',
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("HelcimPay.js could not be loaded.")),
        { once: true },
      );
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HELCIM_PAY_SCRIPT_URL;
    script.async = true;
    script.dataset.rosHelcimPay = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("HelcimPay.js could not be loaded.")),
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

export default function HelcimManualCardHandoff() {
  const baseUrl = getBaseUrl();
  const launchedRef = useRef(false);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const attemptId = params.get("attempt_id")?.trim() ?? "";
  const checkoutToken = params.get("checkout_token")?.trim() ?? "";
  const eventName = checkoutToken ? `helcim-pay-js-${checkoutToken}` : "";
  const [state, setState] = useState<HandoffState>("loading");
  const [message, setMessage] = useState("Opening secure Manual Card entry...");

  useEffect(() => {
    if (launchedRef.current) return;
    launchedRef.current = true;

    if (!attemptId || !checkoutToken || !eventName) {
      setState("error");
      setMessage("Manual Card link is missing payment details. Start Manual Card again from the register.");
      return () => {
        launchedRef.current = false;
      };
    }

    const runtimeBlocker = helcimPayRuntimeBlocker();
    if (runtimeBlocker) {
      setState("error");
      setMessage(runtimeBlocker);
      return () => {
        launchedRef.current = false;
      };
    }

    let stopped = false;
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as HelcimPayMessage | undefined;
      if (!data || data.eventName !== eventName) return;
      window.removeEventListener("message", handleMessage);

      if (data.eventStatus === "ABORTED" || data.eventStatus === "HIDE") {
        setState("canceled");
        setMessage("Manual Card entry was canceled. Return to the register to retry or use the terminal.");
        return;
      }
      if (data.eventStatus !== "SUCCESS") {
        setState("error");
        setMessage("Helcim did not approve this Manual Card payment.");
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
          const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
          if (!res.ok) {
            throw new Error(body.error ?? "ROS could not confirm the Helcim payment.");
          }
          setState("approved");
          setMessage("Manual Card approved. Return to the register to complete the sale.");
        } catch (error) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "ROS could not confirm the Helcim payment.");
        }
      })();
    };

    window.addEventListener("message", handleMessage);
    void loadHelcimPayScript()
      .then(() => {
        if (stopped) return;
        if (!window.appendHelcimPayIframe) {
          throw new Error("HelcimPay.js could not be loaded.");
        }
        window.appendHelcimPayIframe(checkoutToken, true);
        if (!hasHelcimPayIframe()) {
          throw new Error(
            "HelcimPay.js did not attach secure card entry. Verify the public HTTPS ROS origin is saved in Helcim API Access Configuration, then start Manual Card again.",
          );
        }
        setState("ready");
        setMessage("Enter the card securely in Helcim.");
      })
      .catch((error) => {
        if (stopped) return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "HelcimPay.js could not be loaded.");
      });

    return () => {
      stopped = true;
      launchedRef.current = false;
      window.removeEventListener("message", handleMessage);
    };
  }, [attemptId, baseUrl, checkoutToken, eventName]);

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
          Secure Manual Card
        </h1>
        <p className={`mt-5 text-base font-bold leading-relaxed ${statusTone}`}>
          {message}
        </p>
        <p className="mt-4 text-sm leading-relaxed text-app-text-muted">
          Keep the register checkout drawer open. Riverside will attach the approved Helcim payment
          to that sale automatically after confirmation.
        </p>
        <div className="mt-6 flex justify-center">
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
