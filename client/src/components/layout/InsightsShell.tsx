import { useEffect } from "react";
import { LayoutDashboard } from "lucide-react";
import { useTopBar } from "../../context/TopBarContextLogic";
import NativeInsightsWorkspace from "../insights/NativeInsightsWorkspace";

interface InsightsShellProps {
  onExitInsightsMode: () => void;
}

export default function InsightsShell({
  onExitInsightsMode,
}: InsightsShellProps) {
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
      </button>,
    );
    return () => setSlotContent(null);
  }, [onExitInsightsMode, setSlotContent]);

  return (
    <div className="flex flex-1 flex-col bg-app-bg font-sans antialiased">
      <NativeInsightsWorkspace />
    </div>
  );
}
