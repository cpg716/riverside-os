import { useEffect, useState } from "react";
import { Printer, RefreshCw, Star } from "lucide-react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { LoyaltyRedeemDialog } from "./LoyaltyRedeemDialog";
import {
  type LoyaltyEligibleCustomer,
  loyaltyEligibleDisplayName,
  type LoyaltySettings,
} from "./LoyaltyLogic";

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
    <div className="ui-card p-6 max-w-sm space-y-4">
      <h3 className="text-sm font-black uppercase tracking-wide text-app-text">Program Settings</h3>
      {settings && (
        <p className="text-xs text-app-text-muted">
          Current: {settings.loyalty_point_threshold.toLocaleString()} pts = ${settings.loyalty_reward_amount} reward
          · {settings.points_per_dollar} pts / $1
        </p>
      )}
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {saved && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">Saved.</p>}
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Points threshold</span>
        <input type="number" min="1" value={threshold} onChange={e => setThreshold(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Reward amount ($)</span>
        <input type="number" min="0.01" step="0.01" value={reward} onChange={e => setReward(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <button onClick={save} className="ui-btn-primary w-full">Save</button>
    </div>
  );
}

function AdjustPanel() {
  const [customerId, setCustomerId] = useState("");
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
    <div className="ui-card p-6 max-w-sm space-y-4">
      <h3 className="text-sm font-black uppercase tracking-wide text-app-text">Adjust Points</h3>
      <p className="text-xs text-app-text-muted">Requires admin badge. Positive delta = add points; negative = deduct.</p>
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {result && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{result}</p>}
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Customer ID (UUID)</span>
        <input value={customerId} onChange={e => setCustomerId(e.target.value)} className="ui-input mt-1 w-full font-mono text-xs" placeholder="Paste customer ID…" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Delta points (± integer)</span>
        <input type="number" value={delta} onChange={e => setDelta(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Reason</span>
        <input value={reason} onChange={e => setReason(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Manager badge</span>
        <input value={badge} onChange={e => setBadge(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">PIN (if required)</span>
        <input type="password" value={pin} onChange={e => setPin(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <button onClick={submit} disabled={busy} className="ui-btn-primary w-full">
        {busy ? "Processing…" : "Apply adjustment"}
      </button>
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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="pb-2 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Name</th>
                <th className="pb-2 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Points</th>
                <th className="pb-2 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Email</th>
                <th className="pb-2 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Phone</th>
                <th className="pb-2 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Address</th>
                <th className="pb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.map(c => (
                <tr key={c.id} className="border-b border-app-border/50 hover:bg-app-surface-2/50">
                  <td className="py-2 pr-4 font-semibold text-app-text">{loyaltyEligibleDisplayName(c)}</td>
                  <td className="py-2 pr-4">
                    <span className="font-mono font-black text-amber-700">{c.loyalty_points.toLocaleString()}</span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-app-text-muted">{c.email ?? "—"}</td>
                  <td className="py-2 pr-4 text-xs text-app-text-muted">{c.phone ?? "—"}</td>
                  <td className="py-2 pr-4 text-xs text-app-text-muted">
                    {[c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => setRedeemCustomer(c)}
                      disabled={!settings}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Redeem
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
