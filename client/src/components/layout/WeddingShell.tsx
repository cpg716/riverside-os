import { lazy, Suspense } from "react";
import { Gem, LayoutDashboard } from "lucide-react";

const WeddingManagerApp = lazy(() => import("../wedding-manager/WeddingManagerApp"));
import NotificationCenterBell from "../notifications/NotificationCenterBell";

type ThemeMode = "light" | "dark" | "system";

interface WeddingShellProps {
  actorLabel: string | null;
  /** When set, Wedding Manager opens this party’s detail (then call onInitialPartyConsumed). */
  initialPartyId: string | null;
  onInitialPartyConsumed: () => void;
  onExitWeddingMode: () => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

export default function WeddingShell({
  actorLabel,
  initialPartyId,
  onInitialPartyConsumed,
  onExitWeddingMode,
}: WeddingShellProps) {
  return (
    <div className="flex h-[100dvh] max-h-screen flex-col overflow-hidden bg-app-bg font-sans antialiased">
      {/* Thin bridge bar — standalone wedding app has no chrome; this only exits ROS shell */}
      <header className="relative z-50 flex h-12 shrink-0 items-center gap-3 border-b border-app-border bg-app-surface px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-surface-2 text-app-accent" aria-hidden>
            <Gem size={18} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[10px] font-black uppercase tracking-[0.14em] text-app-text-muted">
              Riverside OS
            </p>
            <p className="truncate text-sm font-black tracking-tight text-app-text">Wedding Manager</p>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-app-text-muted">
          <NotificationCenterBell />
          {actorLabel ? <span className="hidden max-w-[140px] truncate font-semibold text-app-text sm:inline">{actorLabel}</span> : null}
          <button
            type="button"
            onClick={onExitWeddingMode}
            className="inline-flex touch-manipulation items-center gap-1.5 rounded-lg border border-app-border bg-app-surface-2 px-3 py-1.5 text-[11px] font-semibold text-app-text shadow-sm transition-colors hover:bg-app-border/20"
          >
            <LayoutDashboard size={12} aria-hidden />
            Back to Back Office
          </button>
        </div>
      </header>

      {/* Scrollable region: standalone app relied on body scroll; here the shell must own vertical scroll */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain [-webkit-overflow-scrolling:touch]">
        <Suspense
          fallback={
            <div className="flex min-h-[40vh] items-center justify-center p-8 text-center text-sm font-semibold text-app-text-muted">
              Loading Wedding Manager…
            </div>
          }
        >
          <WeddingManagerApp
            rosActorName={actorLabel}
            initialPartyId={initialPartyId}
            onInitialPartyConsumed={onInitialPartyConsumed}
          />
        </Suspense>
      </div>
    </div>
  );
}
