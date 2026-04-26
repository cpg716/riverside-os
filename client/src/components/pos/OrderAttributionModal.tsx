import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { X, ShieldCheck } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";

const baseUrl = getBaseUrl();

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
  const { backofficeHeaders, staffRole, staffPin } = useBackofficeAuth();
  
  const hasAccess = staffRole === "admin";
  
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  
  useShellBackdropLayer(true);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [lineMap, setLineMap] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [managerPin, setManagerPin] = useState("");
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
        fetch(`${baseUrl}/api/transactions/${encodeURIComponent(orderId)}`, {
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

  const managers = useMemo(
    () => staff.filter((s) => s.role === "admin"),
    [staff],
  );

  const save = async () => {
    if (!detail) return;
    
    // If user has global access, use their session PIN. Otherwise require manual manager approval.
    const pin = (hasAccess ? staffPin : managerPin).trim();
    if (pin.length !== 4) {
      setErr(hasAccess ? "Auth session expired. Please re-sign in." : "4-digit Manager PIN is required for approval.");
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
        `${baseUrl}/api/transactions/${encodeURIComponent(orderId)}/attribution`,
        {
          method: "PATCH",
          headers: h,
          body: JSON.stringify({
            manager_cashier_code: pin,
            manager_pin: pin,
            reason: reason.trim() || null,
            primary_salesperson_id,
            line_attribution,
          }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Authorization failed");
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
    <div className="fixed inset-0 z-[130] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl outline-none bg-app-bg-alt/95 backdrop-blur-2xl sm:max-h-[95vh] sm:max-w-4xl sm:rounded-3xl"
      >
        <div className="ui-modal-header flex items-center justify-between border-b-4 border-app-border bg-app-surface px-4 py-4 sm:px-8 sm:py-6">
          <div className="flex items-center gap-4">
             <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500 shadow-inner sm:h-12 sm:w-12">
                <ShieldCheck className="h-5 w-5 sm:h-7 sm:w-7" />
             </div>
             <div>
                <h2 id={titleId} className="text-lg font-black tracking-tight text-app-text sm:text-xl">
                  Correct attribution
                </h2>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted italic">
                  Order {orderId.slice(0, 8)}… · Authorization Required
                </p>
             </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-app-border bg-app-surface-2 text-app-text-muted shadow-lg transition-all hover:border-amber-500 hover:text-app-text active:scale-90 sm:h-12 sm:w-12"
            aria-label="Close"
          >
            <X size={24} />
          </button>
        </div>

        <div className="ui-modal-body flex-1 overflow-y-auto p-0 flex flex-col lg:flex-row">
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center p-20 gap-4">
               <div className="h-10 w-10 animate-spin rounded-full border-4 border-app-accent border-t-transparent" />
               <p className="text-xs font-black uppercase tracking-widest text-app-text-muted animate-pulse">Synchronizing Order State…</p>
            </div>
          ) : err && !detail ? (
            <div className="flex-1 p-20 text-center">
               <p className="text-red-500 font-black italic uppercase tracking-widest">{err}</p>
            </div>
          ) : detail ? (
            <>
              {/* Left Column: Data Entry */}
              <div className="flex-1 space-y-8 border-b-4 border-app-border/40 p-4 sm:p-8 lg:border-b-0 lg:border-r-4">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-text italic">1. Line Attribution</h3>
                    {detail.operator_name && <span className="text-[9px] font-bold text-app-text-muted uppercase tracking-widest opacity-50">Origin: {detail.operator_name}</span>}
                  </div>
                  
                  <div className="custom-scrollbar max-h-[40vh] space-y-3 overflow-y-auto pr-2 sm:max-h-[400px]">
                    {detail.items.map((it) => (
                      <div key={it.order_item_id} className="group relative rounded-2xl border-4 border-app-border bg-app-surface p-4 transition-all hover:border-app-accent/40 shadow-sm">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <p className="font-black text-app-text text-sm italic group-hover:text-app-accent transition-colors">
                              {it.quantity}× {it.product_name}
                            </p>
                            <p className="font-mono text-[10px] text-app-text-muted uppercase tracking-widest opacity-60">
                              {it.sku} {it.variation_label ? ` · ${it.variation_label}` : ""}
                            </p>
                          </div>
                        </div>
                        <select
                          value={lineMap[it.order_item_id] ?? ""}
                          onChange={(e) => setLineMap(prev => ({ ...prev, [it.order_item_id]: e.target.value }))}
                          className="ui-input w-full p-2.5 text-xs font-bold bg-app-bg/50 border-app-border/40 hover:border-app-accent transition-all cursor-pointer"
                        >
                          <option value="">Unassigned</option>
                          {commissionStaff.map((s) => (
                            <option key={s.id} value={s.id}>{s.full_name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-6">
                  <label className="block space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-app-text italic">2. Primary Salesperson</span>
                    <select
                      value={primaryId}
                      onChange={(e) => setPrimaryId(e.target.value)}
                      className="ui-input w-full p-4 font-black bg-app-surface border-4 border-app-border hover:border-app-accent transition-all cursor-pointer"
                    >
                      <option value="">Unassigned</option>
                      {commissionStaff.map((s) => (
                        <option key={s.id} value={s.id}>{s.full_name}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-app-text italic">3. Reason (Optional)</span>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="ui-input w-full p-4 bg-app-surface border-4 border-app-border hover:border-app-accent transition-all"
                      placeholder="e.g. Sales accidentally attributed to support staff..."
                    />
                  </label>
                </div>
              </div>

              {/* Right Column: Authorization Gate or Final Actions */}
              <div className={`flex flex-col justify-center gap-8 border-t-4 border-app-border p-4 sm:p-8 lg:border-t-0 ${hasAccess ? 'w-full lg:w-[300px] bg-app-surface/40' : 'w-full lg:w-[400px] bg-app-surface-2/40'}`}>
                {!hasAccess ? (
                  <>
                    <div className="text-center space-y-2">
                      <h3 className="text-sm font-black uppercase tracking-[0.3em] text-app-text italic">Manager Approval</h3>
                      <p className="text-[11px] font-medium text-app-text-muted leading-relaxed">
                        Changes to commission attribution require a manager PIN for audit compliance.
                      </p>
                    </div>

                    <div className="space-y-6">
                      <div className="space-y-2 text-center">
                        <label className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted block">Current Manager</label>
                        <select
                          className="ui-input w-full p-3 text-center font-black bg-white/5 border-app-border/40"
                          value={localStorage.getItem("ros_last_staff_id") || ""}
                          onChange={(e) => localStorage.setItem("ros_last_staff_id", e.target.value)}
                        >
                          <option value="">-- Choose Manager --</option>
                          {managers.map(m => (
                            <option key={m.id} value={m.id}>{m.full_name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-4">
                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted text-center italic">Authorization PIN</p>
                        <PinDots length={managerPin.length} className="py-2" />
                        <NumericPinKeypad
                          value={managerPin}
                          onChange={(v) => { setErr(null); setManagerPin(v); }}
                          onEnter={() => void save()}
                          disabled={saving}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-center space-y-4">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-500/10 text-emerald-500 shadow-glow-emerald-sm">
                      <ShieldCheck size={32} />
                    </div>
                    <h3 className="text-sm font-black uppercase tracking-[0.3em] text-app-text italic">Admin Override</h3>
                    <p className="text-[10px] font-bold text-app-text-muted leading-relaxed uppercase tracking-widest px-4">
                      Your identity is authorized to correct attribution directly.
                    </p>
                  </div>
                )}

                {err ? (
                  <div className="rounded-2xl border-4 border-red-500/20 bg-red-500/5 p-4 text-center text-[11px] font-black uppercase tracking-widest text-red-500 italic animate-in fade-in zoom-in-95">
                    {err}
                  </div>
                ) : null}

                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    disabled={saving || !detail || (!hasAccess && managerPin.length !== 4)}
                    onClick={() => void save()}
                    className="ui-btn-primary h-16 w-full text-xs font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-app-accent/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50"
                  >
                    {saving ? "Signing…" : hasAccess ? "Commit Changes" : "Approve & Save"}
                  </button>
                   <button
                    type="button"
                    onClick={onClose}
                    className="ui-btn-secondary h-12 w-full text-[10px] font-black uppercase tracking-widest rounded-2xl border-4 border-app-border hover:bg-app-bg transition-all active:scale-95"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
