import { useEffect, useState } from "react";
import { BarChart3, LayoutDashboard } from "lucide-react";
import NotificationCenterBell from "../notifications/NotificationCenterBell";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

/** Same-origin `/api` when VITE_API_BASE is unset or empty (Vite proxy → Axum). */
function rosApiOrigin(): string {
  const raw = import.meta.env.VITE_API_BASE;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim().replace(/\/$/, "");
  }
  return "";
}

/** Path prefix for proxied Metabase (must match JWT `return_to` after SSO). */
function metabasePublicPath(): string {
  const fromEnv = import.meta.env.VITE_METABASE_PUBLIC_PATH;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const t = fromEnv.trim();
    return t.endsWith("/") ? t : `${t}/`;
  }
  const base = import.meta.env.BASE_URL || "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}metabase/`;
}

function metabaseIframeSrc(): string {
  return metabasePublicPath();
}

interface InsightsShellProps {
  actorLabel: string | null;
  onExitInsightsMode: () => void;
}

export default function InsightsShell({
  actorLabel,
  onExitInsightsMode,
}: InsightsShellProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [iframeSrc, setIframeSrc] = useState(() => metabaseIframeSrc());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const origin = rosApiOrigin();
        const launchPath = `/api/insights/metabase-launch?return_to=${encodeURIComponent(metabasePublicPath())}`;
        const launchUrl = origin ? `${origin}${launchPath}` : launchPath;
        const res = await fetch(launchUrl, {
          method: "GET",
          cache: "no-store",
          headers: backofficeHeaders() as Record<string, string>,
        });
        if (!res.ok) {
          if (!cancelled) setIframeSrc(metabaseIframeSrc());
          return;
        }
        const data = (await res.json()) as { iframe_src?: string };
        if (
          !cancelled &&
          typeof data.iframe_src === "string" &&
          data.iframe_src.length > 0
        ) {
          setIframeSrc(data.iframe_src);
        }
      } catch {
        if (!cancelled) setIframeSrc(metabaseIframeSrc());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backofficeHeaders]);

  useEffect(() => {
    setLoaded(false);
  }, [iframeSrc]);

  return (
    <div className="flex h-[100dvh] max-h-screen flex-col overflow-hidden bg-app-bg font-sans antialiased">
      <header className="relative z-50 flex h-12 shrink-0 items-center gap-3 border-b border-app-border bg-app-surface px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-surface-2 text-app-accent"
            aria-hidden
          >
            <BarChart3 size={18} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[10px] font-black uppercase tracking-[0.14em] text-app-text-muted">
              Riverside OS
            </p>
            <p className="truncate text-sm font-black tracking-tight text-app-text">
              Insights
            </p>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-app-text-muted">
          <NotificationCenterBell />
          {actorLabel ? (
            <span className="hidden max-w-[140px] truncate font-semibold text-app-text sm:inline">
              {actorLabel}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onExitInsightsMode}
            className="inline-flex touch-manipulation items-center gap-1.5 rounded-lg border border-app-border bg-app-surface-2 px-3 py-1.5 text-[11px] font-semibold text-app-text shadow-sm transition-colors hover:bg-app-border/20"
          >
            <LayoutDashboard size={12} aria-hidden />
            Back to Back Office
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-app-surface-2">
        {!loaded ? (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-app-bg text-sm font-semibold text-app-text-muted"
            aria-hidden
          >
            Loading analytics…
          </div>
        ) : null}
        <iframe
          title="Insights (Metabase)"
          src={iframeSrc}
          className="h-full w-full min-h-0 border-0 bg-app-bg"
          onLoad={() => setLoaded(true)}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </div>
  );
}
