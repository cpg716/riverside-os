import React from "react";
import {
  AlertTriangle,
  Command,
  DollarSign,
  Globe,
  Package,
  Tags,
  X,
  Zap,
} from "lucide-react";

export interface BatchCommandBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onBatchPrice: () => void;
  onBatchWeb: (status: boolean) => void;
  onBatchStock: () => void;
  onBatchTrackLow: (status: boolean) => void;
  onBatchTags: () => void;
  onBatchMaintenance: (type: "damaged" | "return_to_vendor") => void;
}

export const BatchCommandBar: React.FC<BatchCommandBarProps> = ({
  selectedCount,
  onClearSelection,
  onBatchPrice,
  onBatchWeb,
  onBatchStock,
  onBatchTrackLow,
  onBatchTags,
  onBatchMaintenance,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-8 left-1/2 z-[120] -translate-x-1/2 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-4 rounded-full border border-app-accent/30 bg-app-surface/80 p-2 shadow-[0_20px_50px_-12px_rgba(217,70,239,0.3)] backdrop-blur-xl ring-1 ring-white/20">
        {/* Selection Chip */}
        <div className="flex items-center gap-2 rounded-full bg-app-accent px-4 py-2 text-white shadow-lg">
          <Zap size={14} className="fill-white" />
          <span className="text-[11px] font-black uppercase tracking-widest">{selectedCount} Selected</span>
          <button
            onClick={onClearSelection}
            className="ml-2 rounded-full p-0.5 hover:bg-app-surface/20 transition-colors"
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
            title="Apply count correction to selected SKUs"
          >
            <Package size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Count Fix</span>
          </button>

          <button
            onClick={onBatchTags}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted transition-all duration-200 hover:bg-app-accent/10 hover:text-app-accent"
            title="Print selected tags"
          >
            <Tags size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Tag</span>
          </button>

          <div className="mx-2 h-6 w-px bg-app-border" />

          <button
            onClick={() => onBatchTrackLow(true)}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted hover:bg-app-warning/10 hover:text-app-warning transition-all duration-200"
            title="Turn on low-stock alerts for selected SKUs"
          >
            <Zap size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Low Stock</span>
          </button>

          <button
            onClick={() => onBatchMaintenance("return_to_vendor")}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted transition-all duration-200 hover:bg-app-accent/10 hover:text-app-accent"
            title="Return selected variants to vendor"
          >
            <Package size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">RTV</span>
          </button>

          <button
            onClick={() => onBatchMaintenance("damaged")}
            className="flex h-10 items-center justify-center gap-2 rounded-full px-4 text-app-text-muted transition-all duration-200 hover:bg-app-danger/10 hover:text-app-danger"
            title="Mark selected variants as damaged"
          >
            <AlertTriangle size={16} />
            <span className="text-[10px] font-black uppercase tracking-widest">Damage</span>
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
