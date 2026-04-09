import { useCallback, useEffect, useState } from "react";
import { readPersistedBackofficeSession } from "../../lib/backofficeSessionPersistence";
import {
  getPodiumOAuthRedirectUri,
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY,
  PODIUM_OAUTH_STATE_STORAGE_KEY,
} from "../../lib/podiumOAuth";
import { useToast } from "../ui/ToastProvider";

const apiBase = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type ExchangeOk = { refresh_token: string; expires_in?: number | null };

export default function PodiumOAuthCallback() {
  const { toast } = useToast();
  const [status, setStatus] = useState<
    "working" | "success" | "error"
  >("working");
  const [message, setMessage] = useState("Completing Podium sign-in…");
  const [envLine, setEnvLine] = useState<string | null>(null);

  const copyLine = useCallback(async () => {
    if (!envLine) return;
    try {
      await navigator.clipboard.writeText(envLine);
      toast("Copied to clipboard", "success");
    } catch {
      toast("Could not copy — select the line and copy manually", "error");
    }
  }, [envLine, toast]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const errDesc = params.get("error_description");
    if (err) {
      const detail = errDesc ? `${err}: ${errDesc}` : err;
      setStatus("error");
      setMessage(`Podium returned an error: ${detail}`);
      return;
    }

    const code = params.get("code");
    const state = params.get("state");
    const expectedState = (() => {
      try {
        return sessionStorage.getItem(PODIUM_OAUTH_STATE_STORAGE_KEY);
      } catch {
        return null;
      }
    })();

    if (!code || !state) {
      setStatus("error");
      setMessage("Missing authorization code or state. Start again from Settings → Integrations → Podium.");
      return;
    }
    if (!expectedState || state !== expectedState) {
      setStatus("error");
      setMessage(
        "State did not match (browser tab may have changed). Start again from Settings → Podium.",
      );
      return;
    }

    const session = readPersistedBackofficeSession();
    if (!session?.staffCode) {
      setStatus("error");
      setMessage(
        "Back Office session not found. Open Riverside in this tab, sign in to Back Office, then run Connect Podium again.",
      );
      return;
    }

    let redirectUri: string | null = null;
    try {
      const t = sessionStorage.getItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY)?.trim();
      redirectUri = t && t.length > 0 ? t : null;
    } catch {
      redirectUri = null;
    }
    if (!redirectUri) {
      redirectUri = getPodiumOAuthRedirectUri();
    }
    if (!redirectUri) {
      setStatus("error");
      setMessage(
        "Could not resolve redirect URI. Start Connect Podium again from Settings, or set VITE_PODIUM_OAUTH_REDIRECT_URI if your callback URL differs from this page’s origin.",
      );
      return;
    }

    void (async () => {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-riverside-staff-code": session.staffCode,
        };
        if (session.staffPin) {
          headers["x-riverside-staff-pin"] = session.staffPin;
        }

        const res = await fetch(`${apiBase}/api/settings/podium-oauth/exchange`, {
          method: "POST",
          headers,
          body: JSON.stringify({ code, redirect_uri: redirectUri }),
        });
        const j = (await res.json()) as { error?: string } & Partial<ExchangeOk>;
        if (!res.ok) {
          setStatus("error");
          setMessage(j.error ?? `Token exchange failed (HTTP ${res.status})`);
          return;
        }
        if (!j.refresh_token) {
          setStatus("error");
          setMessage("Server response did not include a refresh token.");
          return;
        }
        try {
          sessionStorage.removeItem(PODIUM_OAUTH_STATE_STORAGE_KEY);
          sessionStorage.removeItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        setEnvLine(`RIVERSIDE_PODIUM_REFRESH_TOKEN=${j.refresh_token}`);
        setStatus("success");
        setMessage(
          "Add this line to server .env and restart the API. Keep the client secret on the server only.",
        );
      } catch (e) {
        setStatus("error");
        setMessage(
          e instanceof Error ? e.message : "Network error during token exchange.",
        );
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-app-bg text-app-text flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg ui-card p-8 space-y-4">
        <h1 className="text-sm font-black uppercase tracking-widest text-app-text">
          Podium OAuth
        </h1>
        <p className="text-sm text-app-text-muted leading-relaxed">{message}</p>
        {envLine ? (
          <div className="space-y-2">
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all rounded-lg border border-app-border bg-app-surface-2 p-3">
              {envLine}
            </pre>
            <button
              type="button"
              className="ui-btn-primary px-4 py-2 text-[10px] font-black uppercase tracking-widest"
              onClick={() => void copyLine()}
            >
              Copy env line
            </button>
          </div>
        ) : null}
        {status === "working" ? (
          <p className="text-[10px] font-mono text-app-text-muted">Please wait…</p>
        ) : null}
        <a
          href="/"
          className="inline-block text-xs font-bold text-violet-600 underline decoration-violet-500/40"
        >
          Back to Riverside
        </a>
      </div>
    </div>
  );
}
