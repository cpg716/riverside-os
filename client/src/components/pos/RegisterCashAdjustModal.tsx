import { getBaseUrl } from "../../lib/apiConfig";
import { useState } from "react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { X } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";

const baseUrl = getBaseUrl();

interface Props {
  sessionId: string;
  /** Staff + optional POS session headers (BO needs `register.open_drawer`). */
  getAuthHeaders?: () => Record<string, string>;
  onClose: () => void;
  onRecorded: () => void;
}

export default function RegisterCashAdjustModal({
  sessionId,
  getAuthHeaders,
  onClose,
  onRecorded,
}: Props) {
  const { toast } = useToast();
  useShellBackdropLayer(true);
  const [direction, setDirection] = useState<"paid_in" | "paid_out">(
    "paid_out",
  );
  const [amount, setAmount] = useState("20.00");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  const submit = async () => {
    const amtCents = parseMoneyToCents(amount);
    if (amtCents <= 0) {
      toast("Enter a positive amount.", "error");
      return;
    }
    if (!reason.trim()) {
      toast("Reason is required for audit trail.", "error");
      return;
    }
    setBusy(true);
    try {
      const baseHeaders = getAuthHeaders?.() ?? {};
      const res = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/adjustments`,
        {
          method: "POST",
          headers: {
            ...baseHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            direction,
            amount: centsToFixed2(amtCents),
            reason: reason.trim(),
            category: category.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Could not record adjustment");
      }
      onRecorded();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to record adjustment", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-overlay-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal outline-none"
      >
        <div className="ui-modal-header mb-0 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-black uppercase tracking-tight text-app-text">
            Drawer cash adjustment
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-lg text-app-text-muted hover:bg-app-surface"
            aria-label="Close"
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className="ui-modal-body">
        <p className="mb-4 text-xs text-app-text-muted">
          Non-sale cash: <strong>Paid-in</strong> adds float (e.g. quarters
          roll). <strong>Paid-out</strong> removes cash (supplies, postage).
          Expected drawer updates immediately for Z-report.
        </p>

        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={() => setDirection("paid_in")}
            className={`flex-1 rounded-xl py-2 text-[10px] font-black uppercase tracking-widest ${
              direction === "paid_in"
                ? "bg-app-success text-white"
                : "border border-app-border bg-app-surface text-app-text-muted"
            }`}
          >
            Paid-in
          </button>
          <button
            type="button"
            onClick={() => setDirection("paid_out")}
            className={`flex-1 rounded-xl py-2 text-[10px] font-black uppercase tracking-widest ${
              direction === "paid_out"
                ? "bg-app-warning text-white"
                : "border border-app-border bg-app-surface text-app-text-muted"
            }`}
          >
            Paid-out
          </button>
        </div>

        {direction === "paid_out" ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {["Shop supplies", "Postage", "Petty / misc"].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCategory(c);
                  if (!reason) setReason(c);
                }}
                className="rounded-full border border-app-border bg-app-surface px-3 py-1 text-[10px] font-bold uppercase text-app-text"
              >
                {c}
              </button>
            ))}
          </div>
        ) : (
          <div className="mb-3 flex flex-wrap gap-2">
            {["Roll of quarters", "Change fund", "Bank break"].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCategory(c);
                  if (!reason) setReason(c);
                }}
                className="rounded-full border border-app-border bg-[color-mix(in_srgb,var(--app-success)_14%,var(--app-surface-2))] px-3 py-1 text-[10px] font-bold uppercase text-app-text"
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <label className="mb-2 block text-[10px] font-black uppercase text-app-text-muted">
          Amount ($)
        </label>
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="ui-input mb-3 w-full font-mono"
        />

        <label className="mb-2 block text-[10px] font-black uppercase text-app-text-muted">
          Category (optional)
        </label>
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="ui-input mb-3 w-full text-sm"
        />

        <label className="mb-2 block text-[10px] font-black uppercase text-app-text-muted">
          Reason (required)
        </label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="ui-input mb-4 w-full text-sm"
          placeholder="Manager-approved postage…"
        />
        </div>
        <div className="ui-modal-footer">
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-secondary flex-1 py-3 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="ui-btn-primary flex-1 py-3 text-sm disabled:opacity-50"
          >
            {busy ? "Saving…" : "Record"}
          </button>
        </div>
      </div>
    </div>
  );
}
