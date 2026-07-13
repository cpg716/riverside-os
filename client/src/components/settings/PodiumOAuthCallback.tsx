import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useState } from "react";
import { readPersistedBackofficeSession } from "../../lib/backofficeSessionPersistence";
import { getConnectionKey, stationKeyHeader } from "../../lib/stationIdentity";
import {
  getPodiumOAuthRedirectUri,
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY,
  PODIUM_OAUTH_STATE_STORAGE_KEY,
} from "../../lib/podiumOAuth";

const apiBase = getBaseUrl();

type ExchangeOk = { refresh_token: string; expires_in?: number | null };

export default function PodiumOAuthCallback() {
  const [status, setStatus] = useState<
    "working" | "success" | "error"
  >("working");
  const [message, setMessage] = useState("Completing Podium sign-in…");

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
        "Could not finish the Podium connection. Start Connect Podium again from Settings.",
      );
      return;
    }

    void (async () => {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-riverside-staff-code": session.staffCode,
          "x-riverside-staff-session": session.sessionToken,
          "x-riverside-connection-key": getConnectionKey(),
          ...stationKeyHeader(),
        };

        const res = await fetch(`${apiBase}/api/settings/podium-oauth/exchange`, {
          method: "POST",
          headers,
          body: JSON.stringify({ code, redirect_uri: redirectUri }),
        });
        const j = (await res.json()) as { error?: string } & Partial<ExchangeOk>;
        if (!res.ok) {
          setStatus("error");
          setMessage("Podium connection failed. Try again from Settings.");
          return;
        }
        if (!j.refresh_token) {
          setStatus("error");
          setMessage("Podium connection finished without a refresh token.");
          return;
        }
        const saveResp = await fetch(
          `${apiBase}/api/settings/integration-credentials/podium`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              credentials: {
                refresh_token: j.refresh_token,
              },
            }),
          },
        );
        if (!saveResp.ok) {
          setStatus("error");
          setMessage(
            "Podium approved the connection, but Riverside could not save it. Return to Settings and try again.",
          );
          return;
        }
        try {
          sessionStorage.removeItem(PODIUM_OAUTH_STATE_STORAGE_KEY);
          sessionStorage.removeItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        setStatus("success");
        setMessage(
          "Podium approved the connection and Riverside saved it securely.",
        );
      } catch (e) {
        console.error("Podium connection failed", e);
        setStatus("error");
        setMessage("Podium connection failed. Try again from Settings.");
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-app-bg text-app-text flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg ui-card p-8 space-y-4">
        <h1 className="text-sm font-black uppercase tracking-widest text-app-text">
          Podium Connection
        </h1>
        <p className="text-sm text-app-text-muted leading-relaxed">{message}</p>
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
