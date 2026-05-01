import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  Monitor,
  RefreshCw,
  Server,
  Smartphone,
} from "lucide-react";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { getBaseUrl } from "../../lib/apiConfig";
import {
  checkForAppUpdate,
  installAppUpdate,
  type UpdateCheckResult,
} from "../../lib/appUpdater";
import { useToast } from "../ui/ToastProviderLogic";

type PwaUpdateStatus = {
  supported: boolean;
  controlled: boolean;
  waiting: boolean;
  scope: string | null;
  message: string;
};

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
  }, []);

  const surfaceLabel = useMemo(
    () =>
      tauriShellVersion != null
        ? `Desktop app (Tauri ${tauriShellVersion})`
        : isStandaloneDisplay()
          ? "Installed PWA"
          : "Web browser",
    [tauriShellVersion],
  );

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
          Check the installed version, update Windows app stations, and refresh
          browser or iPad app installs from one place.
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
                  Surface
                </dt>
                <dd className="mt-1 font-mono text-app-text">{surfaceLabel}</dd>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-3">
                <dt className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  Client version
                </dt>
                <dd className="mt-1 font-mono text-app-text">{CLIENT_SEMVER}</dd>
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
                Use this for Register #1 and other Windows desktop app stations.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={desktopBusy}
              onClick={() => void handleCheckForUpdates()}
              className="ui-btn-primary h-11 px-4 text-xs font-black disabled:opacity-50"
            >
              {desktopBusy ? "Checking..." : "Check for update"}
            </button>
            <button
              type="button"
              disabled={desktopBusy}
              onClick={() => void handleInstallUpdate()}
              className="ui-btn-secondary h-11 px-4 text-xs font-black disabled:opacity-50"
            >
              {desktopBusy ? "Installing..." : "Install update"}
            </button>
          </div>
          <p className="mt-4 text-xs font-medium leading-relaxed text-app-text-muted">
            {tauriShellVersion == null
              ? "This station is not running the Windows desktop app."
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
                Use this for Register #2, iPad, and browser-installed stations.
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

        <section className="ui-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Server className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Server update
              </h3>
              <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
                The store server update still needs a backup, migrations, and a
                restart window.
              </p>
            </div>
          </div>
          <ol className="mt-5 space-y-3 text-xs font-medium leading-relaxed text-app-text-muted">
            {[
              "Back up the database.",
              "Replace the server and web bundle.",
              "Apply migrations.",
              "Restart the store server.",
              "Smoke test Backoffice, Register #1, and Register #2.",
            ].map((step) => (
              <li key={step} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                <span>{step}</span>
              </li>
            ))}
          </ol>
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
