import type { ReactNode } from "react";
import { X } from "lucide-react";

interface FloatingBulkBarProps {
  count: number;
  onClearSelection: () => void;
  children: ReactNode;
  /** Screen-reader label for the bar. */
  label?: string;
}

/**
 * Glass dock that appears when list rows are multi-selected (Nexo-style).
 */
export default function FloatingBulkBar({
  count,
  onClearSelection,
  children,
  label = "Bulk actions",
}: FloatingBulkBarProps) {
  if (count <= 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-6 pt-2"
      role="region"
      aria-label={label}
    >
      <div
        className="pointer-events-auto flex max-w-5xl flex-wrap items-center gap-2 rounded-2xl border border-white/30 bg-app-surface/85 px-4 py-3 shadow-[0_-12px_48px_-8px_color-mix(in_srgb,var(--app-accent)_28%,transparent),0_8px_32px_-12px_rgba(15,23,42,0.25)] backdrop-blur-xl supports-[backdrop-filter]:bg-app-surface/75"
      >
        <div className="flex items-center gap-2 border-r border-app-border/80 pr-3">
          <span className="rounded-full bg-app-accent px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest text-white">
            {count}
          </span>
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Selected
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        <button
          type="button"
          onClick={onClearSelection}
          className="ml-auto inline-flex items-center gap-1 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:border-app-input-border"
        >
          <X size={14} aria-hidden />
          Clear
        </button>
      </div>
    </div>
  );
}
