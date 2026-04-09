import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContext";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProvider";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { CustomerProfile } from "./customerProfileTypes";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface Props {
  customerId: string;
  initial: CustomerProfile;
  open: boolean;
  onClose: () => void;
  onSaved: (p: CustomerProfile) => void;
}

export default function CustomerProfileCompletionModal({
  customerId,
  initial,
  open,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  useShellBackdropLayer(open);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address_line1, setAddressLine1] = useState("");
  const [address_line2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postal_code, setPostalCode] = useState("");
  const [marketing_email_opt_in, setMarketingEmail] = useState(false);
  const [marketing_sms_opt_in, setMarketingSms] = useState(false);
  const [transactional_sms_opt_in, setTransactionalSms] = useState(false);
  const [busy, setBusy] = useState(false);
  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  useEffect(() => {
    if (!open) return;
    setPhone(initial.phone ?? "");
    setEmail(initial.email ?? "");
    setAddressLine1(initial.address_line1 ?? "");
    setAddressLine2(initial.address_line2 ?? "");
    setCity(initial.city ?? "");
    setState(initial.state ?? "");
    setPostalCode(initial.postal_code ?? "");
    setMarketingEmail(initial.marketing_email_opt_in);
    setMarketingSms(initial.marketing_sms_opt_in);
    setTransactionalSms(
      initial.transactional_sms_opt_in ?? initial.marketing_sms_opt_in,
    );
  }, [open, initial]);

  if (!open) return null;

  const save = async () => {
    const p = phone.trim();
    const em = email.trim();
    if (!p || !em) {
      toast("Phone and email are required to continue.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/${customerId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...mergedPosStaffHeaders(backofficeHeaders),
        },
        body: JSON.stringify({
          phone: p || null,
          email: em || null,
          address_line1: address_line1.trim() || null,
          address_line2: address_line2.trim() || null,
          city: city.trim() || null,
          state: state.trim() || null,
          postal_code: postal_code.trim() || null,
          marketing_email_opt_in,
          marketing_sms_opt_in,
          transactional_sms_opt_in,
        }),
      });
      if (!res.ok) {
        let msg = `Save failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore */
        }
        toast(msg, "error");
        return;
      }
      const profRes = await fetch(`${baseUrl}/api/customers/${customerId}/profile`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (!profRes.ok) {
        toast(`Profile reload failed (${profRes.status})`, "error");
        return;
      }
      const full = (await profRes.json()) as CustomerProfile;
      onSaved(full);
      onClose();
    } catch {
      toast("Network error while saving profile.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-overlay-backdrop z-[60]">
      <div
        ref={dialogRef}
        className="ui-modal max-h-[90vh] max-w-lg overflow-y-auto outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="ui-modal-header flex items-start justify-between">
          <div>
            <h2 id={titleId} className="text-lg font-black uppercase tracking-tight text-app-text">
              Complete customer profile
            </h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Phone and email are required before checkout. Mailing address is
              optional. Marketing choices below apply only to{" "}
              <span className="font-semibold text-app-text">promotions</span> —
              transactional messages (appointments, pickup notices) are
              unaffected.
            </p>
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

        <div className="ui-modal-body space-y-3">
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Phone *
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
            />
          </label>
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Email *
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
            />
          </label>
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Street address
            <input
              value={address_line1}
              onChange={(e) => setAddressLine1(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
            />
          </label>
          <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Address line 2
            <input
              value={address_line2}
              onChange={(e) => setAddressLine2(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="col-span-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              City
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="ui-input mt-1 w-full px-2 py-2 text-sm"
              />
            </label>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              State
              <input
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="ui-input mt-1 w-full px-2 py-2 text-sm"
              />
            </label>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              ZIP
              <input
                value={postal_code}
                onChange={(e) => setPostalCode(e.target.value)}
                className="ui-input mt-1 w-full px-2 py-2 text-sm"
              />
            </label>
          </div>

          <div className="rounded-xl border border-amber-100 bg-amber-50/80 p-4">
            <p className="mb-3 text-[10px] font-black uppercase tracking-widest text-amber-900">
              Marketing (optional promotions only)
            </p>
            <label className="mb-2 flex cursor-pointer items-center justify-between gap-2 text-sm font-semibold text-app-text">
              Email marketing
              <select
                value={marketing_email_opt_in ? "yes" : "no"}
                onChange={(e) => setMarketingEmail(e.target.value === "yes")}
                className="ui-input rounded-lg px-2 py-1 text-sm"
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label className="mb-2 flex cursor-pointer items-center justify-between gap-2 text-sm font-semibold text-app-text">
              Text marketing
              <select
                value={marketing_sms_opt_in ? "yes" : "no"}
                onChange={(e) => setMarketingSms(e.target.value === "yes")}
                className="ui-input rounded-lg px-2 py-1 text-sm"
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-2 text-sm font-semibold text-app-text">
              Operational texts (pickup / alterations)
              <select
                value={transactional_sms_opt_in ? "yes" : "no"}
                onChange={(e) => setTransactionalSms(e.target.value === "yes")}
                className="ui-input rounded-lg px-2 py-1 text-sm"
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-app-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-secondary px-4 py-2 text-xs font-bold uppercase"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="ui-btn-primary px-5 py-2 text-xs normal-case tracking-normal disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
