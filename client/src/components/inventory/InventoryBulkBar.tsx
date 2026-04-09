import { useCallback, useRef, useState } from "react";
import { Archive, Globe, Printer, ScanBarcode, Tags, X } from "lucide-react";
import { useToast } from "../ui/ToastProvider";

export type BulkCategoryOption = { id: string; name: string };

interface InventoryBulkBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  /** Opens combined print job; parent marks shelf-labeled for selected variants. */
  onBulkPrintLabels: () => void;
  onBulkArchive: () => void;
  categories: BulkCategoryOption[];
  onMassAssign: (payload: {
    brand: string | null;
    categoryId: string | null;
  }) => Promise<void>;
  /** Scan-to-receive: bump stock +1 for resolved SKU (barcode = SKU in this stack). */
  onScanReceive: (sku: string) => Promise<void>;
  /** Publish all variants under selected templates to the online storefront. */
  onBulkPublishWeb?: () => void | Promise<void>;
  /** Remove selected variants from the online storefront. */
  onBulkUnpublishWeb?: () => void | Promise<void>;
}

/**
 * Nexo-shell V2 command dock: always-on scan lane + bulk actions when rows are selected.
 */
export default function InventoryBulkBar({
  selectedCount,
  onClearSelection,
  onBulkPrintLabels,
  onBulkArchive,
  categories,
  onMassAssign,
  onScanReceive,
  onBulkPublishWeb,
  onBulkUnpublishWeb,
}: InventoryBulkBarProps) {
  const { toast } = useToast();
  const [massOpen, setMassOpen] = useState(false);
  const [massBrand, setMassBrand] = useState("");
  const [massCategoryId, setMassCategoryId] = useState("");
  const [massBusy, setMassBusy] = useState(false);
  const [scan, setScan] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const submitMass = useCallback(async () => {
    const brand = massBrand.trim() || null;
    const categoryId = massCategoryId.trim() || null;
    if (!brand && !categoryId) {
      toast("Enter a brand and/or pick a category.", "info");
      return;
    }
    setMassBusy(true);
    try {
      await onMassAssign({ brand, categoryId });
      setMassOpen(false);
      setMassBrand("");
      setMassCategoryId("");
    } finally {
      setMassBusy(false);
    }
  }, [massBrand, massCategoryId, onMassAssign, toast]);

  const onScanKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = scan.trim();
    if (!raw) return;
    setScanBusy(true);
    try {
      await onScanReceive(raw);
      setScan("");
      scanRef.current?.focus();
    } finally {
      setScanBusy(false);
    }
  };

  return (
    <>
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-6 pt-2"
        role="region"
        aria-label="Inventory command dock"
      >
        <div         className="pointer-events-auto w-full max-w-5xl rounded-2xl border border-white/30 bg-app-surface/85 shadow-[0_-12px_48px_-8px_color-mix(in_srgb,var(--app-accent)_28%,transparent),0_8px_32px_-12px_rgba(15,23,42,0.25)] backdrop-blur-xl supports-[backdrop-filter]:bg-app-surface/75">
          <div className="px-4 py-3">
            <label className="mb-1 block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Scan to receive (+1)
            </label>
            <div className="flex items-center gap-2 rounded-xl border border-app-border/90 bg-app-surface/90 px-3 py-2 shadow-inner shadow-app-border/40">
              <ScanBarcode
                size={16}
                className="shrink-0 text-app-accent"
                aria-hidden
              />
              <input
                ref={scanRef}
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => void onScanKeyDown(e)}
                disabled={scanBusy}
                placeholder="Scan barcode (SKU)…"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm font-mono font-semibold text-app-text outline-none placeholder:text-app-text-muted"
                autoComplete="off"
              />
            </div>
            <p className="mt-1 text-[9px] font-medium text-app-text-muted">
              Enter posts +1 on-hand without opening the Product Hub.
            </p>
          </div>

          {selectedCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-app-border/80 px-4 py-3">
              <div className="flex items-center gap-2 border-r border-app-border/80 pr-3">
                <span className="rounded-full bg-app-accent px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest text-white">
                  {selectedCount}
                </span>
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Selected
                </span>
              </div>

              <button
                type="button"
                onClick={() => onBulkPrintLabels()}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-app-accent to-app-accent px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/25 transition-transform hover:brightness-105 active:scale-[0.98]"
              >
                <Printer size={15} aria-hidden />
                Bulk print labels
              </button>

              <button
                type="button"
                onClick={() => setMassOpen(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text shadow-sm transition-colors hover:border-app-accent/35 hover:bg-app-accent/10"
              >
                <Tags size={15} aria-hidden />
                Mass assign
              </button>

              <button
                type="button"
                onClick={() => void onBulkArchive()}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-200/90 bg-amber-50/90 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-amber-950 transition-colors hover:bg-amber-100"
              >
                <Archive size={15} aria-hidden />
                Archive
              </button>

              {onBulkPublishWeb ? (
                <button
                  type="button"
                  onClick={() => void onBulkPublishWeb()}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-200/90 bg-emerald-50/90 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-emerald-950 transition-colors hover:bg-emerald-100"
                >
                  <Globe size={15} aria-hidden />
                  Publish web
                </button>
              ) : null}
              {onBulkUnpublishWeb ? (
                <button
                  type="button"
                  onClick={() => void onBulkUnpublishWeb()}
                  className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface-2"
                >
                  <Globe size={15} aria-hidden />
                  Unpublish web
                </button>
              ) : null}

              <button
                type="button"
                onClick={onClearSelection}
                className="ml-auto inline-flex items-center gap-1 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:border-app-input-border"
              >
                <X size={14} aria-hidden />
                Clear
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {massOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Close"
            onClick={() => setMassOpen(false)}
          />
          <div
            className="relative w-full max-w-md rounded-2xl border border-white/40 bg-app-surface/95 p-6 shadow-2xl shadow-app-accent/15 backdrop-blur-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mass-assign-title"
          >
            <h2
              id="mass-assign-title"
              className="text-lg font-black uppercase italic tracking-tight text-app-text"
            >
              Mass assign
            </h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Update every selected template. At least one field is required.
            </p>

            <label className="mt-4 block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Brand
            </label>
            <input
              value={massBrand}
              onChange={(e) => setMassBrand(e.target.value)}
              placeholder="e.g. Eton"
              className="ui-input mt-1 w-full"
            />

            <label className="mt-3 block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Category
            </label>
            <select
              value={massCategoryId}
              onChange={(e) => setMassCategoryId(e.target.value)}
              className="ui-input mt-1 w-full"
            >
              <option value="">— Pick a category (optional if brand set) —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={massBusy}
                onClick={() => void submitMass()}
                className="ui-btn-primary px-5 py-2.5 disabled:opacity-50"
              >
                {massBusy ? "Applying…" : "Apply to selection"}
              </button>
              <button
                type="button"
                onClick={() => setMassOpen(false)}
                className="ui-btn-secondary px-5 py-2.5"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
