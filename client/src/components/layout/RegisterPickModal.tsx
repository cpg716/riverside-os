import { useCallback, useMemo, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { setPosRegisterAuth } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProvider";
import { useShellBackdropLayer } from "./ShellBackdropContext";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

export type OpenRegisterOption = {
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  cashier_name: string;
  opened_at: string;
  till_close_group_id?: string;
};

type CurrentSessionJson = {
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  cashier_name: string;
  cashier_avatar_key?: string;
  cashier_code: string;
  lifecycle_status: string;
  role: string;
};

type RegisterPickModalProps = {
  open: boolean;
  sessions: OpenRegisterOption[];
  baseUrl: string;
  onDismiss: () => void;
  onSuccess: (data: CurrentSessionJson, token: string) => void;
};

function headersFromBackoffice(backofficeHeaders: () => HeadersInit): Headers {
  const sh = backofficeHeaders();
  const h = new Headers(
    typeof sh === "object" && sh !== null && !(sh instanceof Headers)
      ? (sh as Record<string, string>)
      : sh instanceof Headers
        ? Object.fromEntries(sh.entries())
        : {},
  );
  h.set("Content-Type", "application/json");
  return h;
}

export default function RegisterPickModal({
  open,
  sessions,
  baseUrl,
  onDismiss,
  onSuccess,
}: RegisterPickModalProps) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } = useBackofficeAuth();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  useShellBackdropLayer(open);
  const { dialogRef, titleId } = useDialogAccessibility(open, {});

  const canAttach = useMemo(
    () => permissionsLoaded && hasPermission("register.session_attach"),
    [permissionsLoaded, hasPermission],
  );

  const attach = useCallback(
    async (sessionId: string) => {
      if (!canAttach) {
        toast("You do not have permission to join an open register.", "error");
        return;
      }
      setBusyId(sessionId);
      try {
        const headers = headersFromBackoffice(backofficeHeaders);
        const attachRes = await fetch(
          `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/attach`,
          { method: "POST", headers, body: "{}" },
        );
        if (!attachRes.ok) {
          const b = (await attachRes.json().catch(() => ({}))) as { error?: string };
          toast(b.error ?? "Could not join that register.", "error");
          return;
        }
        const tokJson = (await attachRes.json()) as { pos_api_token?: string };
        const token = tokJson.pos_api_token?.trim();
        if (!token) {
          toast("Server did not return a register token.", "error");
          return;
        }
        setPosRegisterAuth({ sessionId, token });
        const curHeaders = headersFromBackoffice(backofficeHeaders);
        curHeaders.set("x-riverside-pos-session-id", sessionId);
        curHeaders.set("x-riverside-pos-session-token", token);
        const cur = await fetch(`${baseUrl}/api/sessions/current`, { headers: curHeaders });
        if (!cur.ok) {
          const b = (await cur.json().catch(() => ({}))) as { error?: string };
          toast(b.error ?? "Could not load register session after joining.", "error");
          return;
        }
        const data = (await cur.json()) as CurrentSessionJson;
        onSuccess(data, token);
      } catch {
        toast("Network error while joining the register.", "error");
      } finally {
        setBusyId(null);
      }
    },
    [baseUrl, backofficeHeaders, canAttach, onSuccess, toast],
  );

  if (!open) return null;

  return (
    <div className="ui-overlay-backdrop z-[200]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal max-w-md overflow-hidden rounded-[32px] border border-app-border/40 shadow-2xl outline-none"
      >
        <div className="ui-modal-body space-y-4 p-6 sm:p-8">
          <div className="text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
              Multiple registers open
            </p>
            <h2 id={titleId} className="mt-1 text-xl font-black text-app-text">
              Choose a register
            </h2>
            <p className="mt-2 ui-type-instruction text-xs">
              Sales and checkout post to the register you select. Pick the physical terminal you are
              working on.
            </p>
          </div>

          {!canAttach ? (
            <p className="rounded-2xl border border-app-danger/20 bg-app-danger/5 p-4 text-center text-xs font-bold text-app-danger">
              Your role does not allow joining an open register. Ask a manager to adjust permissions
              or use a profile that can use the till.
            </p>
          ) : (
            <ul className="max-h-[min(50vh,320px)] space-y-2 overflow-auto">
              {sessions.map((s) => (
                <li key={s.session_id}>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void attach(s.session_id)}
                    className="flex w-full flex-col items-start rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-left transition-colors hover:border-app-accent/40 hover:bg-app-accent/5 disabled:opacity-50"
                  >
                    <span className="text-sm font-black text-app-text">
                      Register #{s.register_lane}
                    </span>
                    <span className="text-[11px] text-app-text-muted">
                      Session #{s.register_ordinal} · {s.cashier_name}
                    </span>
                    {busyId === s.session_id ? (
                      <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-accent">
                        Joining…
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className="ui-btn-secondary w-full py-3 text-xs font-black uppercase tracking-widest"
            onClick={onDismiss}
            disabled={busyId !== null}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
