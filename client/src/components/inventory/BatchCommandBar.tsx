import React from "react";
import { DollarSign, Globe, Package, X, Command, Zap } from "lucide-react";

export interface BatchCommandBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onBatchPrice: () => void;
  onBatchWeb: (status: boolean) => void;
  onBatchStock: () => void;
  onBatchTrackLow: (status: boolean) => void;
}

export const BatchCommandBar: React.FC<BatchCommandBarProps> = ({
  selectedCount,
  onClearSelection,
  onBatchPrice,
  onBatchWeb,
  onBatchStock,
  onBatchTrackLow,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-4 rounded-full border border-app-accent/30 bg-app-surface/80 p-2 shadow-[0_20px_50px_-12px_rgba(217,70,239,0.3)] backdrop-blur-xl ring-1 ring-white/20">
        {/* Selection Chip */}
        <div className="flex items-center gap-2 rounded-full bg-app-accent px-4 py-2 text-white shadow-lg">
          <Zap size={14} className="fill-white" />
          <span className="text-[11px] font-black uppercase tracking-widest">{selectedCount} Selected</span>
          <button
            onClick={onClearSelection}
            className="ml-2 rounded-full p-0.5 hover:bg-white/20 transition-colors"
          >
            <X size={12} strokeWidth={3} />
          </button>
        </div>

        {/* Actions Group */}
        <div className="flex items-center gap-1 p-1">
          <button
            onClick={onBatchPrice}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted hover:bg-app-accent/10 hover:text-app-accent transition-all duration-200"
            title="Update Retail Price"
          >
            <DollarSign size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Price</span>
          </button>

          <button
            onClick={() => onBatchWeb(true)}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted hover:bg-app-success/10 hover:text-app-success transition-all duration-200"
            title="Publish to Web"
          >
            <Globe size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Publish</span>
          </button>

          <button
            onClick={onBatchStock}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted hover:bg-app-accent-2/10 hover:text-app-accent-2 transition-all duration-200"
            title="Adjust Stock Qty"
          >
            <Package size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Stock</span>
          </button>

          <div className="mx-2 h-6 w-px bg-app-border" />

          <button
            onClick={() => onBatchTrackLow(true)}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted hover:bg-app-warning/10 hover:text-app-warning transition-all duration-200"
            title="Toggle Low Stock Alerts"
          >
            <Zap size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Tracking</span>
          </button>
        </div>

        {/* Shortcut Hint */}
        <div className="hidden items-center gap-1 px-4 md:flex">
          <Command size={12} className="text-app-text-muted" />
          <span className="text-[9px] font-bold text-app-text-muted/60 uppercase">Batch Commands</span>
        </div>
      </div>
    </div>
  );
};
