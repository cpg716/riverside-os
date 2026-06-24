import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PublicStorefront from "./components/storefront/PublicStorefront";
import PodiumOAuthCallback from "./components/settings/PodiumOAuthCallback";
import StorefrontEmbedHost from "./components/layout/StorefrontEmbedHost";
import PwaUpdatePrompt from "./components/layout/PwaUpdatePrompt";
import ServerConnectionMonitor from "./components/layout/ServerConnectionMonitor";
import { ToastProvider } from "./components/ui/ToastProvider";
import { CLIENT_SEMVER, GIT_SHORT } from "./clientBuildMeta";
import {
  installDocumentThemeListeners,
  syncDocumentThemeFromStorage,
} from "./lib/rosDocumentTheme";
import { installClientDiagnostics } from "./lib/clientDiagnostics";
import "./index.css";
import { applyInstallerStationConfig } from "./lib/stationConfigBootstrap";

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("APP_RENDER_ERROR", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-app-bg px-6 py-10 text-app-text">
        <section className="ui-card max-w-xl p-6 text-center">
          <h1 className="text-2xl font-black tracking-tight">
            Riverside needs a refresh
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-app-text-muted">
            This screen stopped before it could finish loading. Reload ROS, then
            use Report a bug if it happens again.
          </p>
          <button
            type="button"
            className="ui-btn-primary mt-5 px-4 py-2"
            onClick={() => window.location.reload()}
          >
            Reload ROS
          </button>
        </section>
      </main>
    );
  }
}

syncDocumentThemeFromStorage();
installDocumentThemeListeners();

const isPublicShop =
  typeof window !== "undefined" &&
  (window.location.pathname === "/shop" ||
    window.location.pathname.startsWith("/shop/"));

const isPodiumOAuthCallback =
  typeof window !== "undefined" && window.location.pathname === "/callback";

if (!isPublicShop && !isPodiumOAuthCallback) {
  installClientDiagnostics();
}

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
if (sentryDsn && !isPublicShop && !isPodiumOAuthCallback) {
  void import("@sentry/react").then((Sentry) => {
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      release: `riverside-pos@${CLIENT_SEMVER}`,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.06,
    });
  });
}

if (import.meta.env.DEV) {
  const t = new Date().toISOString();
  console.info(
    `%c[ROS dev]%c v${CLIENT_SEMVER} %c(${GIT_SHORT})%c @ ${t}`,
    "color:#059669;font-weight:bold",
    "color:inherit;font-weight:bold",
    "color:#6b7280",
    "color:#9ca3af",
  );
  console.info(
    "[ROS dev] Missing after refresh? Wrong tab/port, or clear site data / disable cache in DevTools.",
  );
}

async function init() {
  try {
    await applyInstallerStationConfig();
  } catch (err) {
    console.error("[ROS Startup] Config bootstrap failed:", err);
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ToastProvider>
        {isPublicShop ? (
          <PublicStorefront />
        ) : isPodiumOAuthCallback ? (
          <PodiumOAuthCallback />
        ) : (
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        )}
        {isPodiumOAuthCallback ? null : <StorefrontEmbedHost />}
        {!isPublicShop && !isPodiumOAuthCallback ? <ServerConnectionMonitor /> : null}
        <PwaUpdatePrompt />
      </ToastProvider>
    </StrictMode>,
  );
}

void init();
