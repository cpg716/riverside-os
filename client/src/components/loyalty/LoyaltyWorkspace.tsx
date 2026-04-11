
import { useCallback, useEffect, useState } from "react";
import { Printer, RefreshCw, Star } from "lucide-react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { LoyaltyRedeemDialog } from "./LoyaltyRedeemDialog";
import {
  type LoyaltyEligibleCustomer,
  loyaltyEligibleDisplayName,
  type LoyaltySettings,
} from "./LoyaltyLogic";
import type { Customer } from "../pos/CustomerSelector";
import CustomerSearchInput from "../ui/CustomerSearchInput";

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";



function printMailingLabels(customers: LoyaltyEligibleCustomer[]): void {
  const w = window.open("", "_blank", "width=600,height=800");
  if (!w) return;
  const labels = customers
    .map(c => {
      const addr = [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(", ");
      return `
        <div class="label">
          <p class="name">${loyaltyEligibleDisplayName(c)}</p>
          ${addr ? `<p class="addr">${addr}</p>` : ""}
          <p class="pts">${c.loyalty_points.toLocaleString()} pts</p>
        </div>`;
    })
    .join("");
  w.document.write(`<!DOCTYPE html><html><head><title>Mailing Labels</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 12px; }
    .label { border: 1px solid #ccc; padding: 10px 14px; margin: 6px; inline-size: 240px; display: inline-block; font-size: 12px; vertical-align: top; }
    .name { font-weight: bold; margin: 0 0 3px; }
    .addr { color: #555; margin: 0 0 3px; font-size: 11px; }
    .pts { color: #7c3aed; font-size: 10px; font-weight: bold; margin: 0; }
    @media print { body { padding: 0; } }
  </style></head><body>${labels}<script>window.onload=function(){window.print();}</script></body></html>`);
  w.document.close();
}

function SettingsPanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [threshold, setThreshold] = useState("");
  const [reward, setReward] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`${BASE}/api/loyalty/settings`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) {
        const s = (await res.json()) as LoyaltySettings;
        setSettings(s);
        setThreshold(String(s.loyalty_point_threshold));
        setReward(String(s.loyalty_reward_amount));
      }
    })();
  }, [backofficeHeaders]);

  const save = async () => {
    setErr(null); setSaved(false);
    const t = parseInt(threshold, 10);
    const rewardCents = parseMoneyToCents(reward);
    if (!Number.isFinite(t) || t <= 0) { setErr("Threshold must be a positive integer."); return; }
    if (rewardCents <= 0) { setErr("Reward amount must be positive."); return; }
    const res = await fetch(`${BASE}/api/loyalty/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...backofficeHeaders() },
      body: JSON.stringify({
        loyalty_point_threshold: t,
        loyalty_reward_amount: centsToFixed2(rewardCents),
      }),
    });
    if (res.ok) { setSettings((await res.json()) as LoyaltySettings); setSaved(true); }
    else { const b = (await res.json()) as { error?: string }; setErr(b.error ?? "Save failed"); }
  };

  return (
    <div className="ui-card flex flex-col overflow-hidden bg-app-surface/50 backdrop-blur-xl border-app-border/30 shadow-2xl animate-workspace-snap">
      <div className="bg-gradient-to-br from-amber-500/10 to-transparent p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600">
            <Star className="h-5 w-5" />
          </div>
          <h3 className="text-base font-black uppercase tracking-widest text-app-text">Program Settings</h3>
        </div>
        
        {settings && (
          <div className="p-3 rounded-xl bg-app-surface border border-app-border/50 shadow-sm">
            <p className="text-xs font-medium text-app-text-muted">
              Current: <span className="text-amber-600 font-bold">{settings.loyalty_point_threshold.toLocaleString()} pts</span> = <span className="text-emerald-600 font-bold">${settings.loyalty_reward_amount}</span> reward
              <br/>
              <span className="opacity-70">Rate: {settings.points_per_dollar} pts / $1</span>
            </p>
          </div>
        )}
        
        {err && <p className="rounded-xl bg-red-500/10 px-4 py-3 text-xs font-bold text-red-600 border border-red-500/20">{err}</p>}
        {saved && <p className="rounded-xl bg-emerald-500/10 px-4 py-3 text-xs font-bold text-emerald-600 border border-emerald-500/20">Changes applied successfully.</p>}

        <div className="grid gap-4">
          <label className="block space-y-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Points threshold</span>
            <input type="number" min="1" value={threshold} onChange={e => setThreshold(e.target.value)} className="ui-input w-full bg-app-surface/80" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Reward amount ($)</span>
            <input type="number" min="0.01" step="0.01" value={reward} onChange={e => setReward(e.target.value)} className="ui-input w-full bg-app-surface/80" />
          </label>
        </div>
        
        <button 
          onClick={save} 
          className="ui-btn-primary w-full shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40 transition-all duration-300 transform active:scale-[0.98]"
        >
          Update Program
        </button>
      </div>
    </div>
  );
}

function AdjustPanel() {
  const [customerId, setCustomerId] = useState("");
  const [customerLabel, setCustomerLabel] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [badge, setBadge] = useState("");
  const [pin, setPin] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null); setResult(null);
    if (!customerId.trim()) { setErr("Customer ID required."); return; }
    const d = parseInt(delta);
    if (!Number.isFinite(d) || d === 0) { setErr("Enter a non-zero delta."); return; }
    if (!reason.trim()) { setErr("Reason required."); return; }
    if (!badge.trim()) { setErr("Manager badge required."); return; }
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/loyalty/adjust-points`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customerId.trim(),
          delta_points: d,
          reason: reason.trim(),
          manager_cashier_code: badge.trim(),
          manager_pin: pin.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        throw new Error(b.error ?? "Failed");
      }
      const data = (await res.json()) as { new_balance: number };
      setResult(`Adjusted ${d > 0 ? "+" : ""}${d} pts. New balance: ${data.new_balance.toLocaleString()}`);
      setDelta(""); setReason("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-card flex flex-col overflow-hidden bg-app-surface/50 backdrop-blur-xl border-app-border/30 shadow-2xl animate-workspace-snap">
      <div className="bg-gradient-to-br from-sky-500/10 to-transparent p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-sky-500/10 text-sky-600">
            <RefreshCw className="h-5 w-5" />
          </div>
          <h3 className="text-base font-black uppercase tracking-widest text-app-text">Adjust Balance</h3>
        </div>
        <p className="text-xs font-medium text-app-text-muted px-1 leading-relaxed">Modify customer points manually. Positive builds balance; negative deducts.</p>
        
        {err && <p className="rounded-xl bg-red-500/10 px-4 py-3 text-xs font-bold text-red-600 border border-red-500/20">{err}</p>}
        {result && <p className="rounded-xl bg-emerald-500/10 px-4 py-3 text-xs font-bold text-emerald-600 border border-emerald-500/20">{result}</p>}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Customer Search</span>
            <CustomerSearchInput
              onSelect={(c: Customer) => {
                setCustomerId(c.id);
                setCustomerLabel(`${c.first_name} ${c.last_name}`.trim());
              }}
              placeholder="Name, code, or phone…"
              className="w-full bg-app-surface/80 shadow-inner"
            />
            {customerId && (
              <div className="mt-2 p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10 flex items-center justify-between">
                <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-tight">Focusing: {customerLabel}</p>
                <button onClick={() => setCustomerId("")} className="text-[10px] text-app-text-muted hover:text-red-500 transition-colors">Clear</button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Delta (±)</span>
              <input type="number" value={delta} onChange={e => setDelta(e.target.value)} className="ui-input w-full bg-app-surface/80" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Auth Badge</span>
              <input value={badge} onChange={e => setBadge(e.target.value)} className="ui-input w-full bg-app-surface/80" />
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Reason for change</span>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. CSR goodwill" className="ui-input w-full bg-app-surface/80" />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Manager PIN</span>
            <input type="password" value={pin} onChange={e => setPin(e.target.value)} className="ui-input w-full bg-app-surface/80" />
          </label>
        </div>

        <button 
          onClick={submit} 
          disabled={busy} 
          className="ui-btn-primary w-full shadow-lg shadow-sky-500/20 hover:shadow-sky-500/40 transition-all duration-300 transform active:scale-[0.98] disabled:scale-100"
        >
          {busy ? "Applying Changes…" : "Commit Adjustment"}
        </button>
      </div>
    </div>
  );
}

function EligibleList() {
  const { backofficeHeaders } = useBackofficeAuth();
  const [customers, setCustomers] = useState<LoyaltyEligibleCustomer[]>([]);
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [redeemCustomer, setRedeemCustomer] = useState<LoyaltyEligibleCustomer | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const h = backofficeHeaders();
      const [elRes, stRes, sumRes] = await Promise.all([
        fetch(`${BASE}/api/loyalty/monthly-eligible`, { headers: h }),
        fetch(`${BASE}/api/loyalty/settings`, { headers: h }),
        fetch(`${BASE}/api/loyalty/program-summary`, { headers: h }),
      ]);
      if (elRes.ok)
        setCustomers((await elRes.json()) as LoyaltyEligibleCustomer[]);
      if (stRes.ok) setSettings((await stRes.json()) as LoyaltySettings);
      else if (sumRes.ok) setSettings((await sumRes.json()) as LoyaltySettings);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-black tracking-tight text-app-text">Monthly Eligible Customers</h2>
            <p className="text-xs text-app-text-muted">{customers.length} customers at or above threshold</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="ui-btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            {customers.length > 0 && (
              <button
                type="button"
                onClick={() => printMailingLabels(customers)}
                className="ui-btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
              >
                <Printer className="h-3.5 w-3.5" />
                Print labels
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <p className="py-12 text-center text-sm text-app-text-muted">Loading…</p>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-16">
            <Star className="h-10 w-10 text-app-text-muted" />
            <p className="text-sm text-app-text-muted">No customers have reached the threshold yet.</p>
          </div>
        ) : (
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="text-left">
                <th className="pb-4 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border px-4 py-3 bg-app-surface-2/50">Customer</th>
                <th className="pb-4 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border px-4 py-3 bg-app-surface-2/50">Loyalty Level</th>
                <th className="pb-4 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border px-4 py-3 bg-app-surface-2/50">Contact Info</th>
                <th className="pb-4 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border px-4 py-3 bg-app-surface-2/50">Location</th>
                <th className="pb-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border px-4 py-3 bg-app-surface-2/50 text-right">Operations</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/30">
              {customers.map(c => (
                <tr key={c.id} className="group hover:bg-amber-500/5 transition-colors duration-200">
                  <td className="py-4 px-4 font-bold text-app-text">
                    <div className="flex flex-col">
                      <span>{loyaltyEligibleDisplayName(c)}</span>
                      <span className="text-[10px] text-app-text-muted font-black tracking-widest uppercase mt-0.5 opacity-60">#{c.customer_code}</span>
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex items-center gap-2">
                      <div className="px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-700 text-xs font-black tracking-wide shadow-sm">
                        {c.loyalty_points.toLocaleString()} PTS
                      </div>
                      {c.loyalty_points >= (settings?.loyalty_point_threshold || 1000) * 2 && (
                        <div className="p-1 rounded bg-amber-500 text-white shadow-sm">
                          <Star className="h-3 w-3 fill-current" />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-app-text font-medium">{c.email ?? "—"}</span>
                      <span className="text-[11px] text-app-text-muted">{c.phone ?? "—"}</span>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-xs text-app-text-muted font-medium italic">
                    {[c.city, c.state].filter(Boolean).join(", ") || "No address on file"}
                  </td>
                  <td className="py-4 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => setRedeemCustomer(c)}
                      disabled={!settings}
                      className="inline-flex items-center gap-2 bg-app-surface border border-amber-500/30 px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-amber-700 hover:bg-amber-500 hover:text-white hover:border-amber-600 transition-all duration-300 shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Redeem Reward
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {settings && (
        <LoyaltyRedeemDialog
          isOpen={redeemCustomer !== null}
          customer={redeemCustomer}
          rewardAmountRaw={settings.loyalty_reward_amount}
          pointThreshold={settings.loyalty_point_threshold}
          getAuthHeaders={backofficeHeaders}
          onClose={() => setRedeemCustomer(null)}
          onSuccess={() => void load()}
        />
      )}
    </div>
  );
}

export default function LoyaltyWorkspace({ activeSection }: { activeSection: string }) {
  if (activeSection === "adjust") return <div className="p-6"><AdjustPanel /></div>;
  if (activeSection === "settings") return <div className="p-6"><SettingsPanel /></div>;
  return <EligibleList />;
}
