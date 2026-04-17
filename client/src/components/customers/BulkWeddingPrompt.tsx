import { Users } from "lucide-react";

interface BulkWeddingPromptProps {
  onClose: () => void;
  onConfirm: () => void;
  count: number;
  weddingPartyQuery: string;
}

export default function BulkWeddingPrompt({
  onClose,
  onConfirm,
  count,
  weddingPartyQuery,
}: BulkWeddingPromptProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-md">
      <div className="ui-modal max-w-md shadow-2xl">
        <div className="ui-modal-header">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-500 text-white shadow-lg shadow-indigo-500/20">
              <Users size={20} />
            </div>
            <div>
              <h3 className="text-xl font-black italic tracking-tighter text-app-text uppercase">
                Bulk Registry Add
              </h3>
              <p className="text-xs font-bold text-app-text-muted">
                Assign {count} customers to party.
              </p>
            </div>
          </div>
        </div>
        <div className="ui-modal-body">
          <p className="text-sm font-semibold text-app-text">
            Are you sure you want to add these {count} selected customers to the
            wedding registry for{" "}
            <span className="font-black italic text-indigo-600">
              {weddingPartyQuery}
            </span>
            ?
          </p>
          <p className="mt-3 text-xs text-app-text-muted">
            They will be added as unassigned members. You can set their roles
            later in the Wedding Registry dashboard.
          </p>
        </div>
        <div className="ui-modal-footer">
          <button
            type="button"
            className="ui-btn-secondary flex-1 py-3"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-8 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-indigo-600/20 transition-all hover:brightness-110 active:scale-95"
            onClick={onConfirm}
          >
            Confirm Add
          </button>
        </div>
      </div>
    </div>
  );
}
