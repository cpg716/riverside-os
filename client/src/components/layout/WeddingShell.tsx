import { lazy, Suspense, useEffect } from "react";
import { LayoutDashboard } from "lucide-react";
import { useTopBar } from "../../context/TopBarContextLogic";

const WeddingManagerApp = lazy(() => import("../wedding-manager/WeddingManagerApp"));

interface WeddingShellProps {
  actorLabel: string | null;
  /** When set, Wedding Manager opens this party’s detail (then call onInitialPartyConsumed). */
  initialPartyId: string | null;
  onInitialPartyConsumed: () => void;
  onExitWeddingMode: () => void;
}

export default function WeddingShell({
  actorLabel,
  initialPartyId,
  onInitialPartyConsumed,
  onExitWeddingMode,
}: WeddingShellProps) {
  const { setSlotContent } = useTopBar();

  useEffect(() => {
    setSlotContent(
      <button
        type="button"
        onClick={onExitWeddingMode}
        className="inline-flex touch-manipulation items-center gap-1.5 rounded-lg border border-app-border bg-app-surface-2 px-3 py-1.5 text-[11px] font-semibold text-app-text shadow-sm transition-colors hover:bg-app-border/20"
      >
        <LayoutDashboard size={12} aria-hidden />
        Back to Back Office
      </button>
    );
    return () => setSlotContent(null);
  }, [onExitWeddingMode, setSlotContent]);

  return (
    <div className="flex flex-1 flex-col bg-app-bg font-sans antialiased">

      {/* Scrollable region: standalone app relied on body scroll; here the shell must own vertical scroll */}
      <div className="flex-1">
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
