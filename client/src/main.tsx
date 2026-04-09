import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PublicStorefront from "./components/storefront/PublicStorefront";
import PodiumOAuthCallback from "./components/settings/PodiumOAuthCallback";
import StorefrontEmbedHost from "./components/layout/StorefrontEmbedHost";
import PwaUpdatePrompt from "./components/layout/PwaUpdatePrompt";
import { ToastProvider } from "./components/ui/ToastProvider";
import { CLIENT_SEMVER, GIT_SHORT } from "./clientBuildMeta";
import {
  installDocumentThemeListeners,
  syncDocumentThemeFromStorage,
} from "./lib/rosDocumentTheme";
import { installClientDiagnostics } from "./lib/clientDiagnostics";
import "./index.css";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      {isPublicShop ? (
        <PublicStorefront />
      ) : isPodiumOAuthCallback ? (
        <PodiumOAuthCallback />
      ) : (
        <App />
      )}
      {isPodiumOAuthCallback ? null : <StorefrontEmbedHost />}
      <PwaUpdatePrompt />
    </ToastProvider>
  </StrictMode>,
);
