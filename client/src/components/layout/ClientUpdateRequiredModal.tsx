import { useState } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { checkForAppUpdate, installAppUpdate } from "../../lib/appUpdater";
import { resyncPwaClient, type ServerVersionIdentity } from "../../lib/clientUpdateGate";
import { useShellBackdropLayer } from "./ShellBackdropContextLogic";

export default function ClientUpdateRequiredModal({
  open,
  server,
  onRecheck,
}: {
  open: boolean;
  server: ServerVersionIdentity | null;
  onRecheck: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useShellBackdropLayer(open);
  const { dialogRef, titleId } = useDialogAccessibility(open);

  if (!open || !server) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const performUpdate = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!isTauri()) {
        await resyncPwaClient();
        return;
      }

      const check = await checkForAppUpdate();
      if (!check.available) {
        throw new Error(
          "The required desktop installer is not available yet. Ask a manager to confirm the Riverside release assets, then recheck.",
        );
      }
      const install = await installAppUpdate();
      if (!install.installed) {
        throw new Error(
          install.message || "The desktop updater did not install the required build.",
        );
      }
      setInstalled(true);
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Riverside could not complete the update.",
      );
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="ui-overlay-backdrop !z-[300] flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="client-update-required-modal"
        className="ui-modal w-full max-w-lg animate-workspace-snap outline-none shadow-2xl"
      >
        <div className="ui-modal-header flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-700">
            <ShieldAlert className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-700">
              Update required
            </p>
            <h2 id={titleId} className="text-xl font-black text-app-text">
              Update Riverside to continue
            </h2>
          </div>
        </div>
        <div className="ui-modal-body space-y-4">
          <p className="ui-type-instruction-muted">
            This station and the Main Hub are running different Riverside builds.
            Your open cart is preserved, but a transaction cannot be started or
            continued to Payment until this station is current.
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-3">
              <p className="font-black uppercase tracking-wider text-app-text-muted">This station</p>
              <p className="mt-1 font-bold text-app-text">v{CLIENT_SEMVER} · {GIT_SHORT}</p>
            </div>
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-3">
              <p className="font-black uppercase tracking-wider text-app-text-muted">Main Hub</p>
              <p className="mt-1 font-bold text-app-text">
                v{server.version} · {server.build_sha?.slice(0, 8) || "not reported"}
              </p>
            </div>
          </div>
          {installed ? (
            <p className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
              Update installed. Relaunch Riverside to continue.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-2xl border border-app-danger/25 bg-app-danger/10 px-4 py-3 text-sm font-bold text-app-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="ui-modal-footer flex flex-col-reverse gap-3 sm:flex-row">
          <button
            type="button"
            disabled={busy || rechecking}
            onClick={async () => {
              setRechecking(true);
              setError(null);
              try {
                await onRecheck();
              } finally {
                setRechecking(false);
              }
            }}
            className="ui-btn-secondary flex-1 py-3"
          >
            {rechecking ? "Checking..." : "Recheck Main Hub"}
          </button>
          {!installed ? (
            <button
              type="button"
              disabled={busy || rechecking}
              onClick={() => void performUpdate()}
              className="ui-btn-primary flex flex-1 items-center justify-center gap-2 py-3 text-sm font-black"
            >
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {busy
                ? "Updating..."
                : isTauri()
                  ? "Install update"
                  : "Resync and reopen"}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    root,
  );
}
