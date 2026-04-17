import { AlertTriangle, GitMerge } from "lucide-react";
import { CustomerBrowseRow } from "./CustomerWorkspaceTypes";

interface MergeCustomersModalProps {
  onClose: () => void;
  onConfirm: () => void;
  primary: CustomerBrowseRow | null;
  secondary: CustomerBrowseRow | null;
  busy: boolean;
}

export default function MergeCustomersModal({
  onClose,
  onConfirm,
  primary,
  secondary,
  busy,
}: MergeCustomersModalProps) {
  if (!primary || !secondary) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-md">
      <div className="ui-modal max-w-2xl shadow-2xl">
        <div className="ui-modal-header bg-amber-500/5 dark:bg-amber-500/10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg shadow-amber-500/20">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h3 className="text-xl font-black italic tracking-tighter text-app-text uppercase">
                Confirm Customer Merge
              </h3>
              <p className="text-xs font-black uppercase tracking-widest text-amber-600">
                This action is destructive and cannot be undone.
              </p>
            </div>
          </div>
        </div>
        <div className="ui-modal-body space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl border-2 border-app-accent bg-app-accent/5 p-4 relative">
              <div className="absolute -top-3 left-4 bg-app-accent text-white px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest">
                Survivor (Primary)
              </div>
              <p className="text-lg font-black italic text-app-text">
                {primary.first_name} {primary.last_name}
              </p>
              <p className="text-xs font-bold text-app-text-muted">
                {primary.customer_code}
              </p>
              <div className="mt-2 text-[10px] text-app-text-muted opacity-60">
                All records from the duplicate will be re-assigned to this
                profile.
              </div>
            </div>
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 relative opacity-60">
              <div className="absolute -top-3 left-4 bg-app-text-muted text-white px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest">
                Duplicate (will be deleted)
              </div>
              <p className="text-lg font-black italic text-app-text">
                {secondary.first_name} {secondary.last_name}
              </p>
              <p className="text-xs font-bold text-app-text-muted">
                {secondary.customer_code}
              </p>
              <div className="mt-2 text-[10px] text-app-text-muted">
                This profile will be permanently removed.
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold text-amber-900 leading-relaxed dark:border-amber-900/30 dark:bg-amber-900/10 dark:text-amber-200">
            Merging will move:
            <ul className="mt-2 list-inside list-disc opacity-80">
              <li>All historical transactions and sales records</li>
              <li>Fulfillment orders and shipment history</li>
              <li>Wedding party memberships and registry roles</li>
              <li>Timeline notes and communication logs</li>
            </ul>
          </div>
        </div>
        <div className="ui-modal-footer">
          <button
            type="button"
            className="ui-btn-secondary flex-1 py-3"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-2 rounded-2xl bg-app-accent px-8 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
            onClick={onConfirm}
            disabled={busy}
          >
            <GitMerge size={16} />
            {busy ? "Merging..." : "Execute Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
