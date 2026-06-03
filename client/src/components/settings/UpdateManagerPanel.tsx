import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Monitor,
  RefreshCw,
  Server,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { getBaseUrl } from "../../lib/apiConfig";
import {
  checkForAppUpdate,
  installAppUpdate,
  type UpdateCheckResult,
  checkServerLocalStatus,
  downloadAndRunServerInstaller,
  type ServerLocalStatus,
} from "../../lib/appUpdater";
import { useToast } from "../ui/ToastProviderLogic";

type PwaUpdateStatus = {
  supported: boolean;
  controlled: boolean;
  waiting: boolean;
  scope: string | null;
  message: string;
};

type ServerVersionStatus = {
  version: string;
  component: string;
};

type ServerUpdateCheck = {
  current_version: string;
  current_build_sha: string;
  latest_version: string;
  latest_build_sha: string | null;
  update_available: boolean;
  rebuild_available: boolean;
  release_notes: string | null;
  published_at: string | null;
  safe_window: boolean;
  safe_window_hint: string;
};

type UpdateStep =
  | "idle"
  | "downloading"
  | "extracting"
  | "running_installer"
  | "done"
  | "error";

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* ignore */
  }
  try {
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

async function readPwaStatus(): Promise<PwaUpdateStatus> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return {
      supported: false,
      controlled: false,
      waiting: false,
      scope: null,
      message: "PWA updates are not available in this browser.",
    };
  }

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    return {
      supported: true,
      controlled: false,
      waiting: false,
      scope: null,
      message: "No PWA updater is registered for this page.",
    };
  }

  return {
    supported: true,
    controlled: navigator.serviceWorker.controller != null,
    waiting: registration.waiting != null,
    scope: registration.scope,
    message:
      registration.waiting != null
        ? "A refreshed app is ready. Reload when the station is idle."
        : "PWA updater is installed. Riverside will prompt when a refreshed app is ready.",
  };
}

export default function UpdateManagerPanel() {
  const baseUrl = getBaseUrl();
  const { toast } = useToast();
  const [tauriShellVersion, setTauriShellVersion] = useState<string | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [pwaBusy, setPwaBusy] = useState(false);
  const [pwaStatus, setPwaStatus] = useState<PwaUpdateStatus | null>(null);
  const [serverVersion, setServerVersion] = useState<ServerVersionStatus | null>(null);
  const [serverVersionError, setServerVersionError] = useState(false);
  const [serverLocalStatus, setServerLocalStatus] = useState<ServerLocalStatus | null>(null);
  const [serverUpdateBusy, setServerUpdateBusy] = useState(false);
  const [serverUpdateCheck, setServerUpdateCheck] = useState<ServerUpdateCheck | null>(null);
  const [serverUpdateCheckBusy, setServerUpdateCheckBusy] = useState(false);
  const [updateStep, setUpdateStep] = useState<UpdateStep>("idle");
  const [updateLog, setUpdateLog] = useState<string[]>([]);

  const fetchServerUpdateCheck = useCallback(async () => {
    setServerUpdateCheckBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/ops/update-check`, { cache: "no-store" });
      if (res.ok) setServerUpdateCheck(await res.json() as ServerUpdateCheck);
    } catch { /* silent */ } finally {
      setServerUpdateCheckBusy(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setTauriShellVersion(await getVersion());
      } catch {
        setTauriShellVersion(null);
      }
    })();
    void refreshPwaStatus();
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/version`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setServerVersion((await res.json()) as ServerVersionStatus);
        setServerVersionError(false);
      } catch {
        setServerVersion(null);
        setServerVersionError(true);
      }
    })();
    void (async () => {
      try {
        const status = await checkServerLocalStatus();
        setServerLocalStatus(status);
      } catch {
        setServerLocalStatus(null);
      }
    })();
    void fetchServerUpdateCheck();
  }, [baseUrl, fetchServerUpdateCheck]);

  const handleRunServerInstaller = async () => {
    const targetVersion = serverUpdateCheck?.latest_version || updateCheck?.version || CLIENT_SEMVER;
    setServerUpdateBusy(true);
    setUpdateStep("downloading");
    setUpdateLog([`Starting update to v${targetVersion}...`]);
    try {
      setUpdateLog(l => [...l, "Downloading deployment package from GitHub..."]);
      setUpdateStep("extracting");
      const msg = await downloadAndRunServerInstaller(targetVersion);
      setUpdateStep("running_installer");
      setUpdateLog(l => [...l, "Installer launched in elevated PowerShell window.", msg]);
      setUpdateStep("done");
      toast("Server update launched — monitor the PowerShell window.", "success");
    } catch (e) {
      setUpdateStep("error");
      setUpdateLog(l => [...l, `Error: ${String(e)}`]);
      toast(String(e) || "Failed to trigger server update.", "error");
    } finally {
      setServerUpdateBusy(false);
    }
  };

  const surfaceLabel = useMemo(
    () =>
      tauriShellVersion != null
        ? "Windows desktop app"
        : isStandaloneDisplay()
          ? "Installed PWA"
          : "Web browser",
    [tauriShellVersion],
  );
  const desktopVersionMismatch =
    tauriShellVersion != null && tauriShellVersion !== CLIENT_SEMVER;
  const serverVersionMismatch =
    serverVersion != null && serverVersion.version !== CLIENT_SEMVER;
  const releaseMismatch = desktopVersionMismatch || serverVersionMismatch;

  // On a satellite station (not the Main Hub), block client updates until the
  // server has been updated first. This prevents clients from running a newer
  // version than the server, which would break API compatibility.
  const serverNeedsUpdateFirst =
    !serverLocalStatus?.is_local &&         // not the Main Hub
    serverUpdateCheck?.update_available === true; // server is behind latest
  const releaseDiagnostic = [
    `app files ${CLIENT_SEMVER}`,
    tauriShellVersion != null ? `Windows app ${tauriShellVersion}` : null,
    serverVersion != null
      ? `server ${serverVersion.version}`
      : serverVersionError
        ? "server unavailable"
        : "server checking",
  ]
    .filter(Boolean)
    .join(", ");

  const refreshPwaStatus = async () => {
    try {
      setPwaStatus(await readPwaStatus());
    } catch {
      setPwaStatus({
        supported: false,
        controlled: false,
        waiting: false,
        scope: null,
        message: "Could not read PWA update status.",
      });
    }
  };

  const handleCheckForUpdates = async () => {
    setDesktopBusy(true);
    try {
      const result = await checkForAppUpdate();
      setUpdateCheck(result);
      if (!result.enabled && result.message) {
        toast(result.message, "error");
        return;
      }
      if (result.available) {
        toast(`Update ${result.version ?? ""} is available`, "success");
      } else {
        toast(result.message ?? "No update available", "success");
      }
    } catch {
      toast("Failed to check for updates", "error");
    } finally {
      setDesktopBusy(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (serverNeedsUpdateFirst) {
      toast("Update the Main Hub server first before updating this station.", "error");
      return;
    }
    setDesktopBusy(true);
    try {
      const result = await installAppUpdate();
      if (!result.enabled && result.message) {
        toast(result.message, "error");
        return;
      }
      if (result.installed) {
        toast(
          result.message ??
            "Update installed. Relaunch the desktop app when prompted.",
          "success",
        );
      } else {
        toast(result.message ?? "No update available", "success");
      }
    } catch {
      toast("Failed to install update", "error");
    } finally {
      setDesktopBusy(false);
    }
  };

  const handleCheckPwaFiles = async () => {
    setPwaBusy(true);
    try {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        toast("PWA updates are not available in this browser.", "error");
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        toast("No PWA updater is registered for this page.", "error");
        await refreshPwaStatus();
        return;
      }
      await registration.update();
      await refreshPwaStatus();
      toast("Checked for refreshed PWA files.", "success");
    } catch {
      toast("Could not check PWA files.", "error");
    } finally {
      setPwaBusy(false);
    }
  };

  const handleReloadPwa = async () => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    }
    window.location.reload();
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
          Updates
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Check the Riverside version installed on this station and run the
          correct update path.
        </p>
      </header>

      <section className="ui-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              This station
            </h3>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-3">
                <dt className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  Station type
                </dt>
                <dd className="mt-1 font-mono text-app-text">{surfaceLabel}</dd>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-3">
                <dt className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  Riverside version
                </dt>
                <dd className="mt-1 font-mono text-app-text">
                  {releaseMismatch ? "Update incomplete" : CLIENT_SEMVER}
                </dd>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-3">
                <dt className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  Build
                </dt>
                <dd className="mt-1 font-mono text-app-text">{GIT_SHORT}</dd>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-3">
                <dt className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  Server address
                </dt>
                <dd className="mt-1 break-all font-mono text-xs text-app-text">
                  {baseUrl}
                </dd>
              </div>
            </dl>
            {releaseMismatch ? (
              <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-semibold leading-relaxed text-amber-900">
                This station did not finish updating. Close and reopen the
                Windows app.{" "}
                {serverLocalStatus?.is_local
                  ? "If the server is behind, use the \"Update local server\" button in the Server Update section below."
                  : "If the server is behind, go to the Backoffice / Server PC and use the Server Update section in Settings there."}
                {" "}Diagnostic detail: {releaseDiagnostic}.
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="ui-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Download className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Windows app
              </h3>
              <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                {serverLocalStatus?.is_local
                  ? "Updates this Windows station. (Note: Running the server update below automatically updates the app on this PC)."
                  : "Updates this Windows station to the current Riverside release."}
              </p>
            </div>
          </div>
          {serverNeedsUpdateFirst && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The Main Hub server must be updated to v{serverUpdateCheck?.latest_version} first.
                Go to the Backoffice / Server PC and run the server update there before updating this station.
              </span>
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={desktopBusy || serverNeedsUpdateFirst}
              onClick={() => void handleCheckForUpdates()}
              className="ui-btn-primary h-11 px-4 text-xs font-black disabled:opacity-50"
            >
              {desktopBusy ? "Checking..." : "Check for update"}
            </button>
            <button
              type="button"
              disabled={desktopBusy || serverNeedsUpdateFirst}
              onClick={() => void handleInstallUpdate()}
              className="ui-btn-secondary h-11 px-4 text-xs font-black disabled:opacity-50"
            >
              {desktopBusy ? "Installing..." : "Install update"}
            </button>
          </div>
          <p className="mt-4 text-xs font-medium leading-relaxed text-app-text-muted">
            {tauriShellVersion == null
              ? "This station is not running the Windows desktop app."
              : serverNeedsUpdateFirst
                ? "Waiting for Main Hub to update first."
                : updateCheck?.available
                  ? `Update ${updateCheck.version ?? ""} is ready to install.`
                  : updateCheck?.message ?? "No update check has run yet."}
          </p>
        </section>

        <section className="ui-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                iPad and browser app
              </h3>
              <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                Refreshes browser and iPad app files for the current Riverside
                release.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pwaBusy}
              onClick={() => void handleCheckPwaFiles()}
              className="ui-btn-primary h-11 px-4 text-xs font-black disabled:opacity-50"
            >
              {pwaBusy ? "Checking..." : "Check app files"}
            </button>
            <button
              type="button"
              onClick={() => void handleReloadPwa()}
              className="ui-btn-secondary h-11 px-4 text-xs font-black"
            >
              Reload app
            </button>
          </div>
          <p className="mt-4 text-xs font-medium leading-relaxed text-app-text-muted">
            {pwaStatus?.message ?? "Reading PWA update status..."}
          </p>
          {pwaStatus?.scope ? (
            <p className="mt-2 break-all text-[11px] font-mono text-app-text-muted">
              {pwaStatus.scope}
            </p>
          ) : null}
        </section>

        <section className="ui-card p-5 sm:p-6 xl:col-span-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Server className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
              <div>
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Server update
                </h3>
                <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                  {serverLocalStatus?.is_local
                    ? "This is the Main Hub. Updates run directly on this PC and atomically update both the server and desktop app."
                    : "Go to the Main Hub (server PC) to run server updates."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void fetchServerUpdateCheck()}
              disabled={serverUpdateCheckBusy}
              className="shrink-0 text-app-text-muted hover:text-app-text"
              title="Check for update"
            >
              <RefreshCw className={`h-4 w-4 ${serverUpdateCheckBusy ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* Version status */}
          {serverUpdateCheck && (
            <div className={`mt-4 rounded-xl border px-4 py-3 text-xs font-semibold leading-relaxed ${
              serverUpdateCheck.update_available
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-900"
            }`}>
              <div className="flex items-center gap-2">
                {serverUpdateCheck.update_available
                  ? <Sparkles className="h-4 w-4 shrink-0" />
                  : <CheckCircle2 className="h-4 w-4 shrink-0" />}
                {serverUpdateCheck.rebuild_available
                  ? `New build of v${serverUpdateCheck.latest_version} is available`
                  : serverUpdateCheck.update_available
                    ? `v${serverUpdateCheck.latest_version} is available (you are on v${serverUpdateCheck.current_version})`
                    : `You are on the latest version (v${serverUpdateCheck.current_version})`}
              </div>
              {serverUpdateCheck.update_available && serverUpdateCheck.rebuild_available && (
                <div className="mt-1 text-[10px] font-mono text-amber-700 opacity-80">
                  current build: {serverUpdateCheck.current_build_sha.slice(0, 8)}
                  {serverUpdateCheck.latest_build_sha && ` → latest: ${serverUpdateCheck.latest_build_sha.slice(0, 8)}`}
                </div>
              )}
              {serverUpdateCheck.update_available && (
                <div className={`mt-2 flex items-center gap-1.5 ${
                  serverUpdateCheck.safe_window ? "text-emerald-700" : "text-amber-700"
                }`}>
                  {serverUpdateCheck.safe_window
                    ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    : <Clock className="h-3.5 w-3.5 shrink-0" />}
                  {serverUpdateCheck.safe_window_hint}
                </div>
              )}
            </div>
          )}

          {serverLocalStatus?.is_local ? (
            <div className="mt-4 space-y-4">
              {/* Store hours warning */}
              {serverUpdateCheck && !serverUpdateCheck.safe_window && updateStep === "idle" && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Store may be open. Best to update before 10 AM or after 6 PM.</span>
                </div>
              )}

              {/* Step progress */}
              {updateStep !== "idle" && (
                <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-3 space-y-1.5">
                  {([
                    ["downloading", "Downloading deployment package"],
                    ["extracting", "Extracting package"],
                    ["running_installer", "Installing, restarting server & verifying"],
                    ["done", "Server ready — relaunch Riverside on all stations"],
                  ] as [UpdateStep, string][]).map(([s, label]) => {
                    const steps: UpdateStep[] = ["downloading", "extracting", "running_installer", "done"];
                    const idx = steps.indexOf(s);
                    const cur = steps.indexOf(updateStep);
                    const done = updateStep === "done" || cur > idx;
                    const active = updateStep === s;
                    const errored = updateStep === "error" && active;
                    return (
                      <div key={s} className="flex items-center gap-2 text-xs">
                        {done ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        ) : active && !errored ? (
                          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-app-accent" />
                        ) : errored ? (
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        ) : (
                          <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-app-border" />
                        )}
                        <span className={done ? "text-app-text" : "text-app-text-muted"}>{label}</span>
                      </div>
                    );
                  })}
                  {updateLog.length > 0 && (
                    <div className="mt-2 rounded border border-app-border bg-black/5 p-2 font-mono text-[10px] text-app-text-muted space-y-0.5 max-h-24 overflow-y-auto">
                      {updateLog.map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                disabled={serverUpdateBusy || !serverUpdateCheck?.update_available}
                onClick={() => void handleRunServerInstaller()}
                className="ui-btn-primary w-full h-11 text-xs font-black disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {serverUpdateBusy ? (
                  <><RefreshCw className="h-4 w-4 animate-spin" />Updating...</>
                ) : serverUpdateCheck?.update_available ? (
                  serverLocalStatus?.is_local
                    ? `Update Server & Client App to v${serverUpdateCheck.latest_version}`
                    : `Update server to v${serverUpdateCheck.latest_version}`
                ) : (
                  "Server is up to date"
                )}
              </button>

              {updateStep === "done" && (
                <p className="text-xs text-emerald-700 font-semibold">
                  Installer is running in the PowerShell window. Relaunch Riverside when it completes.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 px-4 py-3 text-xs font-semibold leading-relaxed text-app-text-muted">
                Go to the Main Hub (server PC) and open Settings → Updates to run the server update from there.
              </div>
              <ol className="space-y-2 text-xs font-medium leading-relaxed text-app-text-muted">
                {[
                  "On the Main Hub, open Settings → Updates.",
                  "Confirm the update window (before 10 AM or after 6 PM).",
                  "Click \"Update Server & Client App\" — it downloads, installs, and migrates automatically.",
                  "Relaunch Riverside on all stations when prompted.",
                ].map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-app-accent/10 text-[10px] font-black text-app-accent">{i + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-app-border bg-app-surface-2/40 p-4">
        <div className="flex items-start gap-3">
          <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
          <p className="text-sm font-medium leading-relaxed text-app-text-muted">
            Mac development still produces the source change. Windows desktop
            updates require a signed Windows release artifact. PWA updates come
            from the web files served by the store server.
          </p>
        </div>
      </section>
    </div>
  );
}
