import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MailPlus, UserX } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { getBaseUrl } from "../../lib/apiConfig";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import type { Customer } from "./CustomerSelector";

interface CustomerEmailCollectionStatus {
  email: string | null;
  customer_declined: boolean;
}

interface CustomerEmailCollectionModalProps {
  customer: Customer | null;
  open: boolean;
  onSkip: () => void;
  onSaved: (email: string) => void;
  onDeclined: () => void;
}

const baseUrl = getBaseUrl();

export default function CustomerEmailCollectionModal({
  customer,
  open,
  onSkip,
  onSaved,
  onDeclined,
}: CustomerEmailCollectionModalProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  useShellBackdropLayer(open);
  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onSkip,
    closeOnEscape: !busy,
  });

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setBusy(false);
  }, [customer?.id, open]);

  if (!open || !customer) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const submit = async (decision: "save" | "customer_declined") => {
    const normalizedEmail = email.trim();
    if (decision === "save" && !normalizedEmail) {
      toast("Enter the customer's email address, or choose Skip.", "warning");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `${baseUrl}/api/customers/${encodeURIComponent(customer.id)}/email-collection`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify({
            decision,
            email: decision === "save" ? normalizedEmail : null,
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | (CustomerEmailCollectionStatus & { error?: string })
        | null;
      if (!response.ok) {
        toast(body?.error || `Email collection failed (${response.status})`, "error");
        return;
      }
      if (decision === "save") {
        if (!body?.email) {
          toast("The customer email was not returned after saving.", "error");
          return;
        }
        onSaved(body.email);
        toast("Customer email saved and counted for today's report.", "success");
      } else {
        onDeclined();
        toast("Customer declined email collection. This prompt will not appear again.", "info");
      }
    } catch {
      toast("Network error while updating the customer email.", "error");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-md outline-none"
      >
        <div className="ui-modal-header">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-app-accent/10 p-2 text-app-accent">
              <MailPlus className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 id={titleId} className="text-lg font-black text-app-text">
                Please add customer email
              </h2>
              <p className="mt-1 text-sm text-app-text-muted">
                {customer.first_name} {customer.last_name} does not have an email address on file.
              </p>
            </div>
          </div>
        </div>

        <div className="ui-modal-body space-y-4">
          <label className="block text-xs font-black uppercase tracking-widest text-app-text-muted">
            Customer email
            <input
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) void submit("save");
              }}
              placeholder="customer@example.com"
              className="ui-input mt-2 w-full text-base normal-case tracking-normal"
              disabled={busy}
            />
          </label>
          <p className="rounded-xl border border-app-border bg-app-surface p-3 text-xs text-app-text-muted">
            Saving an address updates the customer account and records the signed-in staff member for the Email Collection report. It does not enroll the customer in marketing.
          </p>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-app-border px-5 py-4 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={() => void submit("customer_declined")}
            disabled={busy}
            className="ui-btn-secondary inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold disabled:opacity-50"
          >
            <UserX className="h-4 w-4" aria-hidden />
            Customer declined
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSkip}
              disabled={busy}
              className="ui-btn-secondary flex-1 px-4 py-2 text-xs font-bold disabled:opacity-50 sm:flex-none"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => void submit("save")}
              disabled={busy}
              className="ui-btn-primary flex-1 px-5 py-2 text-xs font-bold disabled:opacity-50 sm:flex-none"
            >
              {busy ? "Saving…" : "Save email"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    root,
  );
}
