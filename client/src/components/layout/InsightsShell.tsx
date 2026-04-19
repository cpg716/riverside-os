import { useEffect, useState } from "react";
import { LayoutDashboard } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useTopBar } from "../../context/TopBarContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";

function rosApiOrigin(): string {
  return getBaseUrl();
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
  onExitInsightsMode: () => void;
}

export default function InsightsShell({
  onExitInsightsMode,
}: InsightsShellProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [iframeSrc, setIframeSrc] = useState(() => metabaseIframeSrc());
  const [loaded, setLoaded] = useState(false);
  const { setSlotContent } = useTopBar();

  useEffect(() => {
    setSlotContent(
      <button
        type="button"
        onClick={onExitInsightsMode}
        className="inline-flex touch-manipulation items-center gap-1.5 rounded-lg border border-app-border bg-app-surface-2 px-3 py-1.5 text-[11px] font-semibold text-app-text shadow-sm transition-colors hover:bg-app-border/20"
      >
        <LayoutDashboard size={12} aria-hidden />
        Back to Back Office
      </button>
    );
    return () => setSlotContent(null);
  }, [onExitInsightsMode, setSlotContent]);

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
    <div className="flex flex-1 flex-col bg-app-bg font-sans antialiased">

      <div className="relative flex-1 bg-app-surface-2 min-h-[85vh]">
        {!loaded ? (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-app-bg text-sm font-semibold text-app-text-muted"
            aria-hidden
          >
            Loading Data Insights...
          </div>
        ) : null}
        <iframe
          title="Data Insights"
          src={iframeSrc}
          className="h-full w-full min-h-0 border-0 bg-app-bg"
          onLoad={() => setLoaded(true)}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </div>
  );
}
