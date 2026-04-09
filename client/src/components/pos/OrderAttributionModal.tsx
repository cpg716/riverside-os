import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContext";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProvider";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type StaffRole = "admin" | "salesperson" | "sales_support";

interface StaffRow {
  id: string;
  full_name: string;
  role?: StaffRole;
}

interface OrderDetailLine {
  order_item_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  salesperson_id: string | null;
  salesperson_name: string | null;
}

interface OrderDetail {
  order_id: string;
  primary_salesperson_id: string | null;
  primary_salesperson_name: string | null;
  operator_name: string | null;
  items: OrderDetailLine[];
}

interface Props {
  orderId: string;
  onClose: () => void;
  onSaved?: () => void;
}

export default function OrderAttributionModal({
  orderId,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  // Register: POS session token + staff code (no PIN persisted offline). Matches orders read + staff list gates.
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  useShellBackdropLayer(true);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [lineMap, setLineMap] = useState<Record<string, string>>({});
  const [managerCode, setManagerCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: onClose,
    closeOnEscape: !saving,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [rs, rd] = await Promise.all([
        fetch(`${baseUrl}/api/staff/list-for-pos`, { headers: apiAuth() }),
        fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderId)}`, {
          headers: apiAuth(),
        }),
      ]);
      if (!rs.ok) throw new Error("Could not load staff");
      if (!rd.ok) throw new Error("Order not found");
      const sl = (await rs.json()) as StaffRow[];
      const d = (await rd.json()) as OrderDetail;
      setStaff(sl);
      setDetail(d);
      setPrimaryId(d.primary_salesperson_id ?? "");
      const m: Record<string, string> = {};
      for (const it of d.items) {
        m[it.order_item_id] = it.salesperson_id ?? "";
      }
      setLineMap(m);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [orderId, apiAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  const commissionStaff = useMemo(
    () =>
      staff.filter(
        (s) =>
          !s.role ||
          s.role === "salesperson" ||
          s.role === "admin",
      ),
    [staff],
  );

  const save = async () => {
    if (!detail) return;
    const code = managerCode.trim();
    if (!code) {
      toast("Manager cashier code is required.", "error");
      return;
    }
    const line_attribution = detail.items.map((it) => ({
      order_item_id: it.order_item_id,
      salesperson_id: lineMap[it.order_item_id]?.trim()
        ? lineMap[it.order_item_id]
        : null,
    }));
    const primary_salesperson_id = primaryId.trim() ? primaryId : null;
    setSaving(true);
    setErr(null);
    try {
      const h = new Headers(apiAuth());
      h.set("Content-Type", "application/json");
      const res = await fetch(
        `${baseUrl}/api/orders/${encodeURIComponent(orderId)}/attribution`,
        {
          method: "PATCH",
          headers: h,
          body: JSON.stringify({
            manager_cashier_code: code,
            manager_pin: managerPin.trim() || null,
            reason: reason.trim() || null,
            primary_salesperson_id,
            line_attribution,
          }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Update failed");
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
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
        className="ui-modal flex max-h-[90vh] max-w-lg flex-col outline-none"
      >
        <div className="ui-modal-header flex items-center justify-between">
          <div>
            <h2 id={titleId} className="text-lg font-black text-app-text">
              Correct attribution
            </h2>
            <p className="text-[10px] font-bold uppercase text-app-text-muted">
              Order {orderId.slice(0, 8)}… · audit logged
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-lg text-app-text-muted hover:bg-app-surface"
            aria-label="Close"
          >
            <X size={22} aria-hidden />
          </button>
        </div>

        <div className="ui-modal-body flex-1 overflow-y-auto text-sm">
          {loading ? (
            <p className="text-app-text-muted">Loading…</p>
          ) : err && !detail ? (
            <p className="text-red-600">{err}</p>
          ) : detail ? (
            <div className="space-y-4">
              {detail.operator_name ? (
                <p className="text-xs text-app-text-muted">
                  Cashier on ticket:{" "}
                  <strong>{detail.operator_name}</strong> (unchanged here)
                </p>
              ) : null}

              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Order primary salesperson
                <select
                  value={primaryId}
                  onChange={(e) => setPrimaryId(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                >
                  <option value="">Unassigned</option>
                  {commissionStaff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
              </label>

              <div>
                <p className="mb-2 text-[10px] font-black uppercase text-app-text-muted">
                  Line commission targets
                </p>
                <ul className="space-y-2">
                  {detail.items.map((it) => (
                    <li
                      key={it.order_item_id}
                      className="rounded-xl border border-app-border bg-app-surface px-3 py-2"
                    >
                      <p className="text-xs font-semibold text-app-text">
                        {it.quantity}× {it.product_name}
                        {it.variation_label ? ` · ${it.variation_label}` : ""}
                      </p>
                      <p className="font-mono text-[10px] text-app-text-muted">
                        {it.sku}
                      </p>
                      <select
                        value={lineMap[it.order_item_id] ?? ""}
                        onChange={(e) =>
                          setLineMap((m) => ({
                            ...m,
                            [it.order_item_id]: e.target.value,
                          }))
                        }
                        className="ui-input mt-2 w-full text-xs"
                      >
                        <option value="">Unassigned</option>
                        {commissionStaff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.full_name}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </div>

              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Manager cashier code
                <input
                  type="password"
                  value={managerCode}
                  onChange={(e) => setManagerCode(e.target.value)}
                  className="ui-input mt-1 w-full font-mono text-sm tracking-widest"
                  autoComplete="one-time-code"
                />
              </label>

              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Manager PIN (if profile uses hashed PIN)
                <input
                  type="password"
                  value={managerPin}
                  onChange={(e) => setManagerPin(e.target.value)}
                  className="ui-input mt-1 w-full font-mono text-sm tracking-widest"
                  autoComplete="current-password"
                />
              </label>

              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Reason (optional)
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="Wrong name selected at POS…"
                />
              </label>

              {err ? <p className="text-xs text-red-600">{err}</p> : null}
            </div>
          ) : null}
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
            disabled={saving || !detail}
            onClick={() => void save()}
            className="ui-btn-primary flex-1 py-3 text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Apply correction"}
          </button>
        </div>
      </div>
    </div>
  );
}
