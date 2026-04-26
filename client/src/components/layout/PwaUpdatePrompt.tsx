import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRegisterSW } from "virtual:pwa-register/react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const PWA_INSTALL_DISMISSED_KEY = "ros:pwa-install-dismissed";

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

function isLikelyIosFamily(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isLikelySafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/CriOS|Chrome|FxiOS|Firefox|EdgiOS|Edg|OPR/i.test(ua);
}

function readInstallDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PWA_INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstallDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, "1");
  } catch {
    /* ignore */
  }
}

function PwaUpdatePromptInner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(readInstallDismissed);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };

    const handleInstalled = () => {
      setInstallPromptEvent(null);
      setInstallDismissed(false);
      try {
        window.localStorage.removeItem(PWA_INSTALL_DISMISSED_KEY);
      } catch {
        /* ignore */
      }
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const showInstallPrompt = useMemo(() => {
    if (needRefresh || installDismissed || isStandaloneDisplay()) return false;
    if (installPromptEvent) return true;
    return isLikelyIosFamily() && isLikelySafari();
  }, [needRefresh, installDismissed, installPromptEvent]);

  const installDescription = useMemo(() => {
    if (installPromptEvent) {
      return "Install Riverside on this device for a full-screen station and a more reliable update path.";
    }
    return "On iPad or iPhone, use Share > Add to Home Screen, then launch Riverside from the icon for the most reliable station experience.";
  }, [installPromptEvent]);

  const dismissInstallPrompt = () => {
    writeInstallDismissed();
    setInstallDismissed(true);
  };

  const handleInstall = async () => {
    if (!installPromptEvent) return;
    await installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice;
    if (choice.outcome === "accepted") {
      setInstallPromptEvent(null);
      setInstallDismissed(false);
      try {
        window.localStorage.removeItem(PWA_INSTALL_DISMISSED_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    dismissInstallPrompt();
  };

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  if (needRefresh) {
    return createPortal(
      <div
        className="fixed bottom-4 left-1/2 z-[300] flex w-[min(92vw,44rem)] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-app-border bg-app-surface px-4 py-3 shadow-xl"
        style={{
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
          paddingLeft: "max(1rem, env(safe-area-inset-left))",
          paddingRight: "max(1rem, env(safe-area-inset-right))",
        }}
        role="status"
      >
        <div className="space-y-1">
          <p className="text-sm font-semibold text-app-text">
            A new version of Riverside is ready.
          </p>
          <p className="text-xs font-medium text-app-text-muted">
            Reload when staff can afford a quick refresh. If the shell still looks stale after reloading, close and reopen the installed app icon or clear site data when practical.
          </p>
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:self-end">
          <button
            type="button"
            className="ui-btn-secondary h-10 w-full px-4 text-xs font-bold uppercase tracking-wide sm:h-9 sm:w-auto"
            onClick={() => setNeedRefresh(false)}
          >
            Later
          </button>
          <button
            type="button"
            className="h-10 w-full rounded-xl border-b-4 border-emerald-800 bg-emerald-600 px-4 text-xs font-bold uppercase tracking-wide text-white shadow hover:bg-emerald-500 sm:h-9 sm:w-auto"
            onClick={() => void updateServiceWorker(true)}
          >
            Reload now
          </button>
        </div>
      </div>,
      root
    );
  }

  if (showInstallPrompt) {
    return createPortal(
      <div
        className="fixed bottom-4 left-1/2 z-[300] flex w-[min(92vw,44rem)] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-app-border bg-app-surface px-4 py-3 shadow-xl"
        style={{
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
          paddingLeft: "max(1rem, env(safe-area-inset-left))",
          paddingRight: "max(1rem, env(safe-area-inset-right))",
        }}
        role="status"
      >
        <div className="space-y-1">
          <p className="text-sm font-semibold text-app-text">
            Install Riverside on this device
          </p>
          <p className="text-xs font-medium text-app-text-muted">
            {installDescription}
          </p>
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:self-end">
          <button
            type="button"
            className="ui-btn-secondary h-10 w-full px-4 text-xs font-bold uppercase tracking-wide sm:h-9 sm:w-auto"
            onClick={dismissInstallPrompt}
          >
            Later
          </button>
          {installPromptEvent ? (
            <button
              type="button"
              className="h-10 w-full rounded-xl border-b-4 border-emerald-800 bg-emerald-600 px-4 text-xs font-bold uppercase tracking-wide text-white shadow hover:bg-emerald-500 sm:h-9 sm:w-auto"
              onClick={() => void handleInstall()}
            >
              Install app
            </button>
          ) : null}
        </div>
      </div>,
      root
    );
  }

  return null;
}

export default function PwaUpdatePrompt() {
  if (!import.meta.env.PROD) return null;
  return <PwaUpdatePromptInner />;
}
