import { useCallback, useEffect, useState } from "react";
import { Ruler, X } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import CustomerMeasurementVaultForm from "../customers/CustomerMeasurementVaultForm";
import {
  measurementDraftFromLatest,
  serializeMeasurementPatch,
} from "../customers/CustomerMeasurementLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface VaultResp {
  latest: Record<string, string | number | null> | null;
}

export default function PosCustomerMeasurementsDrawer({
  open,
  customerId,
  customerLabel,
  getAuthHeaders,
  onClose,
}: {
  open: boolean;
  customerId: string;
  customerLabel: string;
  getAuthHeaders: () => Record<string, string>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  useShellBackdropLayer(open);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: !saving,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/${customerId}/measurements`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        toast("Could not load measurements (check staff session).", "error");
        return;
      }
      const data = (await res.json()) as VaultResp;
      setDraft(measurementDraftFromLatest(data.latest ?? null));
    } finally {
      setLoading(false);
    }
  }, [customerId, getAuthHeaders, toast]);

  useEffect(() => {
    if (!open || !customerId) return;
    void load();
  }, [open, customerId, load]);

  const save = async () => {
    const body = serializeMeasurementPatch(draft);
    if (Object.keys(body).length === 0) {
      toast("Enter at least one value to save.", "info");
      return;
    }
    setSaving(true);
    try {
      const h = new Headers({ "Content-Type": "application/json", ...getAuthHeaders() });
      const res = await fetch(`${baseUrl}/api/customers/${customerId}/measurements`, {
        method: "PATCH",
        headers: h,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Save failed", "error");
        return;
      }
      toast("Measurements saved (wedding members mirror retail sizes).", "success");
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="ui-overlay-backdrop">
      <div
        ref={dialogRef}
        className="ui-modal flex max-h-[min(92vh,720px)] w-full max-w-lg flex-col overflow-hidden outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-app-accent" aria-hidden />
            <div>
              <h2 id={titleId} className="text-sm font-black uppercase tracking-tight text-app-text">
                Measurements
              </h2>
              <p className="text-[11px] text-app-text-muted">{customerLabel}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-lg text-app-text-muted hover:bg-app-surface"
            aria-label="Close"
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="text-xs text-app-text-muted">Loading vault…</p>
          ) : (
            <>
              <p className="mb-3 text-[11px] text-app-text-muted">
                Same fields as Back Office CRM. Saving updates the vault and mirrors retail sizes to
                linked wedding members.
              </p>
              <CustomerMeasurementVaultForm
                draft={draft}
                onDraftChange={(key, value) => setDraft((d) => ({ ...d, [key]: value }))}
              />
            </>
          )}
        </div>
        <div className="flex gap-2 border-t border-app-border p-4">
          <button
            type="button"
            disabled={saving || loading}
            onClick={() => void save()}
            className="ui-btn-primary flex-1 py-2 text-xs font-black uppercase"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onClose} className="ui-btn-secondary px-4 py-2 text-xs">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
