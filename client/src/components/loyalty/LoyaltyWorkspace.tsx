import { getBaseUrl } from "../../lib/apiConfig";

import { useCallback, useEffect, useState } from "react";
import { 
  Printer, 
  RefreshCw, 
  Star, 
  Coins, 
  UserCheck, 
  Award, 
  TrendingUp, 
  LayoutDashboard, 
  FileText,
  Mail,
  ShoppingCart,
  Gift
} from "lucide-react";
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

interface LoyaltyPipelineStats {
  total_points_liability: number;
  eligible_customers_count: number;
  lifetime_rewards_issued: number;
  active_30d_adjustments: number;
}

const BASE = getBaseUrl();

interface RewardFulfillmentRow {
  reward_id: string;
  customer_id: string;
  customer_name: string;
  reward_amount: string;
  fulfillment_date: string;
  card_code?: string;
  first_name?: string;
  last_name?: string;
  customer_code?: string;
  address_line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  loyalty_points?: number;
  created_at?: string;
  points_deducted?: number;
  id?: string;
}

interface LoyaltyLedgerEntry {
  id: string;
  reason: string;
  delta_points: number;
  balance_after: number;
  created_at: string;
  transaction_display_id?: string | null;
  activity_label: string;
  activity_detail: string;
}

function printMailingLabels(customers: (LoyaltyEligibleCustomer | RewardFulfillmentRow)[]): void {
  const w = window.open("", "_blank", "width=600,height=800");
  if (!w) return;
  const labels = customers
    .map(c => {
      const name = c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : (('customer_code' in c ? c.customer_code : null) || "Customer");
      const addr = [
        'address_line1' in c ? c.address_line1 : null,
        'city' in c ? c.city : null,
        'state' in c ? c.state : null,
        'zip' in c ? c.zip : null
      ].filter(Boolean).join(", ");
      const pts = ('loyalty_points' in c && c.loyalty_points !== undefined) ? `${c.loyalty_points.toLocaleString()} pts` : "";
      return `
        <div class="label">
          <p class="name">${name}</p>
          ${addr ? `<p class="addr">${addr}</p>` : ""}
          <p class="pts">${pts}</p>
        </div>`;
    })
    .join("");
  w.document.write(`<!DOCTYPE html><html><head><title>Mailing Labels</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 12px; }
    .label { border: 1px solid #ccc; padding: 10px 14px; margin: 6px; inline-size: 240px; display: inline-block; font-size: 12px; vertical-align: top; border-radius: 8px; }
    .name { font-weight: bold; margin: 0 0 3px; color: #111; }
    .addr { color: #555; margin: 0 0 3px; font-size: 11px; }
    .pts { color: #d97706; font-size: 10px; font-weight: bold; margin: 0; border-top: 1px solid #eee; padding-top: 4px; margin-top: 4px; }
    @media print { body { padding: 0; } }
  </style></head><body>${labels}<script>window.onload=function(){window.print();}</script></body></html>`);
  w.document.close();
}

function printLoyaltyLetter(customer: LoyaltyEligibleCustomer | RewardFulfillmentRow, template: string, rewardAmount: string): void {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  
  const content = template
    .replace(/\{\{first_name\}\}/g, customer.first_name || "")
    .replace(/\{\{last_name\}\}/g, customer.last_name || "")
    .replace(/\{\{reward_amount\}\}/g, rewardAmount)
    .replace(/\{\{card_code\}\}/g, ('card_code' in customer ? customer.card_code : null) || "[GIFT CARD CODE]");

  w.document.write(`<!DOCTYPE html><html><head><title>Loyalty Reward Letter</title>
  <style>
    body { font-family: 'Times New Roman', serif; margin: 0; padding: 1in; line-height: 1.6; color: #333; }
    .letter-contents { max-width: 6.5in; margin: 0 auto; white-space: pre-wrap; font-size: 14pt; }
    .header { text-align: center; margin-bottom: 50pt; border-bottom: 2pt solid #eee; padding-bottom: 20pt; }
    .header h1 { font-size: 24pt; margin: 0; text-transform: uppercase; letter-spacing: 0.2em; color: #111; }
    .footer { margin-top: 50pt; text-align: center; font-size: 10pt; color: #999; border-top: 1pt solid #eee; padding-top: 10pt; }
    @media print { body { padding: 0.5in; } .header { border-bottom: 1pt solid #ddd; } }
  </style></head><body>
    <div class="header"><h1>Riverside</h1></div>
    <div class="letter-contents">${content}</div>
    <div class="footer">Riverside OS Loyalty Fulfillment System</div>
    <script>window.onload=function(){window.print();}</script></body></html>`);
  w.document.close();
}

function SettingsPanel({ 
  settings,
  onSettingsUpdated 
}: { 
  settings: LoyaltySettings | null,
  onSettingsUpdated: (s: LoyaltySettings) => void 
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [threshold, setThreshold] = useState("");
  const [reward, setReward] = useState("");
  const [template, setTemplate] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`${BASE}/api/loyalty/settings`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) {
        const s = (await res.json()) as LoyaltySettings;
        setThreshold(String(s.loyalty_point_threshold));
        setReward(String(s.loyalty_reward_amount));
        setTemplate(s.loyalty_letter_template || "");
      }
    })();
  }, [backofficeHeaders]);

  const save = async () => {
    setErr(null); setSaved(false); setSaving(true);
    const t = parseInt(threshold, 10);
    const rewardCents = parseMoneyToCents(reward);
    if (!Number.isFinite(t) || t <= 0) { setErr("Threshold must be a positive integer."); setSaving(false); return; }
    if (rewardCents <= 0) { setErr("Reward amount must be positive."); setSaving(false); return; }
    
    const res = await fetch(`${BASE}/api/loyalty/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...backofficeHeaders() },
      body: JSON.stringify({
        loyalty_point_threshold: t,
        loyalty_reward_amount: centsToFixed2(rewardCents),
        loyalty_letter_template: template.trim(),
      }),
    });
    if (res.ok) { 
      const updated = (await res.json()) as LoyaltySettings;
      onSettingsUpdated(updated);
      setTemplate(updated.loyalty_letter_template || "");
      setSaved(true); 
      setTimeout(() => setSaved(false), 3000);
    }
    else { const b = (await res.json()) as { error?: string }; setErr(b.error ?? "Save failed"); }
    setSaving(false);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-[600px] animate-in slide-in-from-bottom-4 duration-700">
      {/* Configuration Column */}
      <div className="w-full lg:w-[400px] space-y-6">
        <div className="ui-card relative overflow-hidden border-app-border p-6 group">
          <div className="absolute top-0 left-0 w-1 h-full bg-amber-500 rounded-full" />
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20">
              <Star className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Policy Engine</h3>
          </div>
          
          <div className="space-y-5">
            <div className="grid gap-4">
              <label className="block space-y-2">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted px-1">Unlock Points (Threshold)</span>
                <div className="relative group">
                   <input type="number" min="1" value={threshold} onChange={e => setThreshold(e.target.value)} className="ui-input w-full bg-app-surface border-app-border pl-10 transition-all font-black text-app-warning focus:border-app-warning/40" />
                   <Coins className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-app-text-muted opacity-40 group-focus-within:opacity-100 transition-opacity" />
                </div>
              </label>
              
              <label className="block space-y-2">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted px-1">Reward Value ($)</span>
                <div className="relative group">
                   <input type="number" min="0.01" step="0.01" value={reward} onChange={e => setReward(e.target.value)} className="ui-input w-full bg-app-surface border-app-border pl-10 transition-all font-black text-app-success focus:border-app-success/40" />
                   <div className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-app-text-muted opacity-40 group-focus-within:opacity-100 transition-opacity">$</div>
                </div>
              </label>
            </div>

            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 space-y-2">
               <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  <span>Point Multiplier</span>
                  <span>{settings?.points_per_dollar || 1}x</span>
               </div>
               <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  <span>Reward ROI</span>
                  <span className="text-app-success">{((parseFloat(reward) || 0) / (parseFloat(threshold) || 1) * 100).toFixed(1)}%</span>
               </div>
            </div>

            {err && <div className="rounded-xl border border-app-danger/20 bg-app-danger/10 p-3 text-[10px] font-black uppercase text-app-danger animate-shake">{err}</div>}
            {saved && <div className="rounded-xl border border-app-success/20 bg-app-success/10 p-3 text-[10px] font-black uppercase text-app-success">Program settings saved</div>}

            <button 
              onClick={save} 
              disabled={saving}
              className="ui-btn-primary w-full shadow-lg shadow-amber-500/20 hover:scale-[1.02] active:scale-95 transition-all py-3 rounded-2xl"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>

      {/* Designer Column */}
      <div className="flex flex-1 flex-col overflow-hidden ui-card p-0 group">
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 p-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600 ring-1 ring-purple-500/20">
              <Mail className="h-5 w-5" />
            </div>
            <div>
               <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Reward Letter Template</h3>
               <p className="text-[10px] font-bold text-app-text-muted tracking-tight opacity-60">Customer message for reward-card follow-up</p>
            </div>
          </div>
          
          <div className="flex items-center gap-1.5 rounded-xl bg-app-surface px-1 py-1">
            {["{{first_name}}", "{{reward_amount}}", "{{card_code}}"].map(tag => (
              <button 
                key={tag}
                onClick={() => setTemplate(prev => prev + tag)}
                className="px-2.5 py-1 rounded-lg bg-app-surface border border-app-border/50 text-[9px] font-black uppercase tracking-tighter text-app-text-muted hover:text-purple-600 hover:border-purple-300 transition-all hover:shadow-sm"
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 relative">
           <textarea
             value={template}
             onChange={e => setTemplate(e.target.value)}
             placeholder="Write the reward-card message here..."
             className="w-full h-full p-8 bg-transparent text-sm font-mono leading-relaxed text-app-text resize-none focus:outline-none placeholder:opacity-20 tabular-nums"
           />
           <div className="absolute bottom-6 right-6 flex items-center gap-2">
              <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-40">Markdown supported</span>
              <FileText size={12} className="text-app-text-muted opacity-20" />
           </div>
        </div>
      </div>
    </div>
  );
}

function AdjustPanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const [customerId, setCustomerId] = useState("");
  const [customerLabel, setCustomerLabel] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [badge, setBadge] = useState("");
  const [pin, setPin] = useState("");
  const [ledger, setLedger] = useState<LoyaltyLedgerEntry[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!customerId) { setLedger([]); return; }
    void (async () => {
      const res = await fetch(`${BASE}/api/loyalty/ledger?customer_id=${customerId}`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setLedger((await res.json()) as LoyaltyLedgerEntry[]);
    })();
  }, [customerId, backofficeHeaders]);

  const submit = async () => {
    setErr(null); setResult(null);
    if (!customerId.trim()) { setErr("Select a customer first."); return; }
    const d = parseInt(delta);
    if (!Number.isFinite(d) || d === 0) { setErr("Enter a points adjustment other than zero."); return; }
    if (!reason.trim()) { setErr("Enter a reason for the adjustment."); return; }
    if (!badge.trim()) { setErr("Enter the manager staff code."); return; }
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
        throw new Error(b.error ?? "We couldn't save this points adjustment.");
      }
      const data = (await res.json()) as { new_balance: number; effective_customer_id?: string };
      const sharedNotice =
        data.effective_customer_id && data.effective_customer_id !== customerId
          ? " Applied to the linked couple loyalty account."
          : "";
      setResult(`Points updated. New balance: ${data.new_balance.toLocaleString()} pts.${sharedNotice}`);
      setDelta(""); setReason("");
      // Refresh ledger
      const lres = await fetch(`${BASE}/api/loyalty/ledger?customer_id=${customerId}`, {
        headers: backofficeHeaders(),
      });
      if (lres.ok) setLedger((await lres.json()) as LoyaltyLedgerEntry[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 animate-in fade-in slide-in-from-right-4 duration-700">
      {/* Entry Column */}
      <div className="w-full lg:w-[450px] space-y-6">
        <div className="ui-card relative overflow-hidden border-app-border p-6">
          <div className="absolute top-0 right-0 p-4 opacity-[0.05] grayscale">
             <RefreshCw size={100} className={busy ? "animate-spin" : ""} />
          </div>
          <div className="flex items-center gap-3 mb-6">
            <div className="rounded-xl bg-app-info/10 p-2 text-app-info ring-1 ring-app-info/20">
              <RefreshCw className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Points Adjustment</h3>
          </div>

          <form 
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-5"
          >
            <div className="space-y-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Strategic Selection</span>
              <CustomerSearchInput
                onSelect={(c: Customer) => {
                  setCustomerId(c.id);
                  setCustomerLabel(`${c.first_name} ${c.last_name}`.trim());
                }}
                placeholder="Search Member Registry…"
                className="w-full rounded-2xl bg-app-surface"
              />
              {customerId && (
                <div className="mt-2 flex items-center justify-between rounded-2xl border border-app-success/16 bg-app-success/8 p-3 group">
                  <div className="flex items-center gap-3">
                     <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-success/10 text-app-success font-black text-[10px] ring-1 ring-app-success/20 uppercase">
                        {customerLabel?.[0] || 'C'}
                     </div>
                     <p className="text-[11px] text-app-success font-bold uppercase tracking-tight">{customerLabel}</p>
                  </div>
                  <button type="button" onClick={() => setCustomerId("")} className="px-2 text-[9px] font-black uppercase text-app-text-muted transition-colors hover:text-app-danger">Clear</button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Delta (±)</span>
                <input type="number" value={delta} onChange={e => setDelta(e.target.value)} className="ui-input w-full bg-app-surface font-black tabular-nums border-app-border" placeholder="0" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Auth Badge</span>
                <input value={badge} onChange={e => setBadge(e.target.value)} className="ui-input w-full bg-app-surface font-black border-app-border" placeholder="CASHIER CODE" />
              </label>
            </div>

            <label className="block space-y-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Internal Reason</span>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="CSR Goodwill / Manual Ingestion" className="ui-input w-full bg-app-surface border-app-border" />
            </label>

            <label className="block space-y-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Manager Security PIN</span>
              <input type="password" value={pin} onChange={e => setPin(e.target.value)} className="ui-input w-full bg-app-surface border-app-border" placeholder="••••" />
            </label>

            {err && <div className="rounded-xl border border-app-danger/20 bg-app-danger/10 p-3 text-[10px] font-black uppercase text-app-danger animate-shake">{err}</div>}
            {result && <div className="rounded-xl border border-app-success/20 bg-app-success/10 p-3 text-[10px] font-black uppercase text-app-success">{result}</div>}

            <button 
              type="submit" 
              disabled={busy} 
              className="ui-btn-primary w-full shadow-lg shadow-sky-500/20 hover:scale-[1.02] active:scale-95 transition-all py-3 rounded-2xl"
            >
              {busy ? "Authorizing..." : "Save Adjustment"}
            </button>
          </form>
        </div>
      </div>

      {/* Audit History Column (only shows if customer selected) */}
      <div className="flex min-h-[400px] flex-1 flex-col ui-card border-app-border p-6">
         <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-xl bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20">
               <LayoutDashboard size={18} />
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Loyalty Activity</h3>
         </div>

         {!customerId ? (
           <div className="flex-1 flex flex-col items-center justify-center grayscale opacity-20">
              <RefreshCw size={40} className="mb-4" />
              <p className="text-[10px] font-black uppercase tracking-widest">Select a customer to view loyalty activity</p>
           </div>
         ) : (
           <div className="space-y-3">
              {ledger.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface-2 p-3 transition-colors hover:bg-app-surface">
                   <div className="flex flex-col">
                      <span className="text-[11px] font-black uppercase tracking-tight text-app-text">{p.activity_label}</span>
                      <span className="text-[10px] text-app-text-muted">{p.activity_detail}</span>
                      <span className="text-[9px] font-bold text-app-text-muted opacity-60">
                         {new Date(p.created_at).toLocaleDateString()} at {new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                   </div>
                   <div className="flex flex-col items-end">
                      <span className={`text-xs font-black tabular-nums ${p.delta_points > 0 ? 'text-app-success' : 'text-app-danger'}`}>
                         {p.delta_points > 0 ? '+' : ''}{p.delta_points.toLocaleString()}
                      </span>
                      <span className="text-[9px] font-bold text-app-text-muted opacity-40">Balance: {p.balance_after.toLocaleString()}</span>
                   </div>
                </div>
              ))}
              {ledger.length === 0 && (
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 text-center py-10">No recent loyalty activity</p>
              )}
           </div>
         )}
      </div>
    </div>
  );
}

function EligibleList({ 
  settings, 
  onRedeemSuccess 
}: { 
  settings: LoyaltySettings | null, 
  onRedeemSuccess: () => void 
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [customers, setCustomers] = useState<LoyaltyEligibleCustomer[]>([]);
  const [loading, setLoading] = useState(false);
  const [redeemCustomer, setRedeemCustomer] = useState<LoyaltyEligibleCustomer | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/loyalty/monthly-eligible`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setCustomers((await res.json()) as LoyaltyEligibleCustomer[]);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-app-border px-6 py-5 bg-app-surface-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-black tracking-tight text-app-text">Customers Ready for Reward</h2>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted mt-1">
              {customers.length} members currently at or above threshold
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="ui-btn-secondary flex items-center gap-2 px-4 py-2 border-app-border/50 shadow-sm"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh Eligible Customers
            </button>
            {customers.length > 0 && (
              <button
                type="button"
                onClick={() => printMailingLabels(customers)}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 border-app-border/50 shadow-sm"
              >
                <Printer className="h-4 w-4" />
                Bulk Labels
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 sm:p-6 no-scrollbar">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-4">
             <div className="h-10 w-10 border-b-2 border-app-accent rounded-full animate-spin" />
             <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Loading eligible customers...</p>
          </div>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center gap-6 py-32 grayscale opacity-40">
            <Star className="h-16 w-16" />
            <p className="text-sm font-black uppercase tracking-widest text-app-text-muted max-w-xs text-center">No customers have reached the threshold yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* High-density Horizontal List for Elite Members */}
            <div className="hidden lg:grid grid-cols-[1fr_2fr_2fr_auto] gap-4 px-8 py-3 mb-2 opacity-40">
               <span className="text-[9px] font-black uppercase tracking-[0.2em]">Customer</span>
               <span className="text-[9px] font-black uppercase tracking-[0.2em] px-10">Points Status</span>
               <span className="text-[9px] font-black uppercase tracking-[0.2em]">Contact & Location</span>
               <span className="text-[9px] font-black uppercase tracking-[0.2em] w-[200px] text-right">Operations</span>
            </div>

            <div className="space-y-3">
              {customers.map(c => {
                const isMultiReward = c.loyalty_points >= (settings?.loyalty_point_threshold || 5000) * 2;
                const pointsValue = c.loyalty_points.toLocaleString();
                
                return (
                  <div key={c.id} className="group relative flex flex-col gap-4 rounded-[28px] border border-app-border bg-app-surface lg:flex-row lg:items-center lg:gap-0 p-4 lg:p-0 transition-all duration-500 hover:border-app-warning/20 hover:shadow-[0_18px_36px_rgba(15,23,42,0.08),0_4px_10px_rgba(15,23,42,0.05)]">
                    {/* ID & Basic Info */}
                    <div className="lg:w-[1fr] lg:flex-1 lg:pl-6 lg:py-4">
                      <div className="flex items-center gap-4">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-app-surface-2 ring-1 ring-app-border border-b-4 border-app-border/50 text-[13px] font-black text-app-text transition-all duration-500 group-hover:border-app-warning/30 group-hover:text-app-warning">
                           {c.first_name?.[0]}{c.last_name?.[0]}
                        </div>
                        <div className="min-w-0 flex flex-col">
                           <span className="text-[15px] font-black tracking-tight text-app-text leading-tight group-hover:translate-x-1 transition-transform">{loyaltyEligibleDisplayName(c)}</span>
                           <span className="text-[10px] font-black text-app-text-muted uppercase tracking-[0.1em] mt-1 tabular-nums opacity-60">#{c.customer_code || "NEW"}</span>
                        </div>
                      </div>
                    </div>

                    {/* Value KPIs */}
                    <div className="lg:w-[2fr] lg:flex-1 lg:px-10">
                      <div className="flex items-center gap-6">
                         <div className="flex flex-col">
                            <span className="text-2xl font-black text-app-warning tabular-nums tracking-tighter leading-none">{pointsValue}</span>
                            <span className="text-[9px] font-black uppercase tracking-[0.15em] text-app-text-muted mt-1 opacity-60">Current balance</span>
                         </div>
                         <div className="h-8 w-px bg-app-border/30 mx-2 hidden lg:block" />
                         <div className="flex flex-col">
                            <div className="flex items-center gap-1.5">
                               <span className={`text-[10px] font-black uppercase tracking-widest ${isMultiReward ? 'text-app-accent' : 'text-app-success'}`}>
                                  {isMultiReward ? "Two rewards ready" : "Reward ready"}
                               </span>
                               {isMultiReward && <Award size={14} className="text-purple-500 animate-pulse" />}
                            </div>
                            <span className="text-[9px] font-black uppercase tracking-[0.15em] text-app-text-muted mt-1 opacity-60">
                               Reward status
                            </span>
                         </div>
                      </div>
                    </div>

                    {/* Geo & Contact */}
                    <div className="lg:w-[2fr] lg:flex-1">
                       <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2 text-xs font-black text-app-text">
                             <Mail size={14} className="text-app-text-muted opacity-40" />
                             <span className="truncate max-w-[160px]">{c.email || "No email"}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] font-bold text-app-text-muted">
                             <TrendingUp size={14} className="text-app-success/50" />
                             <span>{[c.city, c.state].filter(Boolean).join(", ") || "Location not listed"}</span>
                          </div>
                       </div>
                    </div>

                    {/* Ops */}
                    <div className="lg:pr-6 py-2 lg:py-4">
                       <div className="flex items-center gap-2 justify-end">
                         <button
                           type="button"
                           onClick={() => setRedeemCustomer(c)}
                           disabled={!settings}
                           className="flex h-11 items-center gap-3 rounded-2xl bg-emerald-600 px-6 text-[10px] font-black uppercase tracking-[0.2em] text-white shadow-2xl shadow-emerald-500/20 hover:brightness-110 active:scale-95 transition-all border-b-4 border-emerald-800"
                         >
                           <Award size={18} />
                           Redeem
                         </button>
                         <button
                           type="button"
                           onClick={() => printMailingLabels([c])}
                           className="flex h-11 w-11 items-center justify-center rounded-2xl bg-app-surface border border-app-border text-app-text-muted hover:text-app-text hover:border-app-accent hover:shadow-lg transition-all active:scale-95"
                         >
                           <Printer size={18} />
                         </button>
                       </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
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
          onSuccess={() => {
            void load();
            void onRedeemSuccess();
          }}
        />
      )}
    </div>
  );
}

function IssuancesHistory({ settings }: { settings?: LoyaltySettings | null }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [issuances, setIssuances] = useState<RewardFulfillmentRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/loyalty/recent-issuances`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setIssuances((await res.json()) as RewardFulfillmentRow[]);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const template = settings?.loyalty_letter_template;

  return (
    <div className="flex flex-1 flex-col bg-app-surface scale-in-center overflow-hidden">
      <div className="border-b border-app-border px-6 py-5 bg-app-surface-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-black tracking-tight text-app-text">Reward Card History</h2>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted mt-1">
              Recent loyalty reward cards issued to customers
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="group flex items-center gap-2 rounded-xl border border-app-border/50 bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-app-surface-2 transition-all"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-purple-500" : "text-app-text-muted group-hover:text-purple-500"}`} />
            Refresh History
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6 no-scrollbar">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-4">
             <div className="h-12 w-12 border-b-2 border-purple-500 rounded-full animate-spin" />
             <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted italic">Loading reward history...</p>
          </div>
        ) : issuances.length === 0 ? (
          <div className="flex flex-col items-center gap-6 py-32 grayscale opacity-40">
            <LayoutDashboard size={48} className="text-app-text-muted" />
            <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">No reward cards have been issued yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {issuances.map(row => (
              <div key={row.reward_id} className="group flex flex-col gap-4 rounded-[24px] border border-app-border bg-app-surface p-5 transition-all duration-500 lg:flex-row lg:items-center lg:gap-0 hover:border-app-accent/20 hover:shadow-[0_16px_32px_rgba(15,23,42,0.08),0_4px_10px_rgba(15,23,42,0.05)]">
                  {/* ID & Basic Info */}
                  <div className="lg:w-[1fr] lg:flex-1">
                    <div className="flex items-center gap-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent font-black text-[12px] shadow-inner border border-app-accent/10">
                         {row.first_name?.[0] || '?'}{row.last_name?.[0] || '?'}
                      </div>
                      <div className="min-w-0 flex flex-col">
                         <span className="truncate text-[14px] font-black text-app-text transition-colors group-hover:text-app-accent">
                           {row.first_name} {row.last_name}
                         </span>
                         <span className="text-[9px] font-black tracking-widest text-app-text-muted uppercase mt-0.5 opacity-60">
                            {row.fulfillment_date ? new Date(row.fulfillment_date).toLocaleDateString() : 'N/A'} at {row.fulfillment_date ? new Date(row.fulfillment_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A'}
                         </span>
                      </div>
                    </div>
                  </div>

                {/* Value & Ledger Info */}
                <div className="lg:w-[1fr] lg:flex-1 lg:px-6">
                  <div className="flex flex-col">
                     <span className="text-lg font-black text-app-success tracking-tight leading-none">${centsToFixed2(parseMoneyToCents(row.reward_amount))}</span>
                     <span className="text-[9px] font-black uppercase tracking-[0.1em] text-app-text-muted mt-1 opacity-60">
                        {parseInt(String(row.points_deducted || '0')).toLocaleString()} pts deducted
                     </span>
                  </div>
                </div>

                {/* Status & Channel */}
                <div className="lg:w-[1fr] lg:flex-1 lg:px-6">
                  {row.card_code ? (
                    <div className="flex flex-col gap-1">
                       <div className="flex items-center gap-2">
                          <Gift size={14} className="text-purple-500 opacity-40" />
                          <code className="rounded-lg border border-app-accent/20 bg-app-accent/10 px-2 py-0.5 text-[10px] font-black text-app-accent tracking-widest">
                            {row.card_code}
                          </code>
                       </div>
                       <span className="text-[8px] font-black uppercase tracking-widest text-app-text-muted ml-6 opacity-40">Reward Card Issued</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                           <ShoppingCart size={14} className="text-app-success opacity-40" />
                           <span className="text-[10px] font-black uppercase tracking-tight text-app-success italic">Direct Redemption</span>
                        </div>
                        <span className="text-[8px] font-black uppercase tracking-widest text-app-text-muted ml-6 opacity-40">Applied to Sale</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="lg:pr-2">
                   <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 group-hover:translate-x-0 translate-x-2 transition-all duration-300">
                     {row.card_code && (
                       <button
                         type="button"
                         onClick={() => template && printLoyaltyLetter(row, template, centsToFixed2(parseMoneyToCents(row.reward_amount)))}
                         className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-surface-2 border border-app-border text-purple-600 hover:border-purple-300 hover:shadow-lg transition-all"
                         title="Print Award Letter"
                       >
                         <FileText size={18} />
                       </button>
                     )}
                     <button
                       type="button"
                       onClick={() => printMailingLabels([row])}
                       className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-surface-2 border border-app-border text-app-text-muted hover:text-app-text hover:border-app-accent hover:shadow-lg transition-all"
                       title="Print Label"
                     >
                       <Printer size={18} />
                     </button>
                   </div>
                </div>
              </div>
            ))}
          </div>
    )}
      </div>
    </div>
  );
}

export default function LoyaltyWorkspace({ activeSection }: { activeSection: string }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [stats, setStats] = useState<LoyaltyPipelineStats | null>(null);
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const loadData = useCallback(async () => {
    try {
      const h = backofficeHeaders();
      const [statsRes, setRes] = await Promise.all([
        fetch(`${BASE}/api/loyalty/pipeline-stats`, { headers: h }),
        fetch(`${BASE}/api/loyalty/settings`, { headers: h }),
      ]);
      if (statsRes.ok) setStats((await statsRes.json()) as LoyaltyPipelineStats);
      if (setRes.ok) setSettings((await setRes.json()) as LoyaltySettings);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Unused helper removed

  if (loading) {
     return (
       <div className="flex flex-1 items-center justify-center bg-app-bg text-app-text-muted">
          <div className="flex flex-col items-center gap-3">
             <RefreshCw className="animate-spin text-app-accent" size={24} />
             <span className="text-[10px] font-black uppercase tracking-widest opacity-40">Loading loyalty workspace...</span>
          </div>
       </div>
     );
  }

  return (
    <div className="flex flex-1 flex-col bg-transparent">
      {/* Executive Summary Strip */}
      <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
        {[
          { label: "Points On Accounts", val: stats?.total_points_liability.toLocaleString() ?? "—", icon: Coins, color: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/20", trend: "Current total" },
          { label: "Ready For Reward", val: stats?.eligible_customers_count.toLocaleString() ?? "—", icon: UserCheck, color: "text-sky-500", bg: "bg-sky-500/10", border: "border-sky-500/20", trend: "At threshold" },
          { label: "Reward Cards Issued", val: stats?.lifetime_rewards_issued.toLocaleString() ?? "—", icon: Award, color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20", trend: "All time" },
          { label: "Recent Adjustments", val: stats?.active_30d_adjustments.toLocaleString() ?? "—", icon: TrendingUp, color: "text-purple-500", bg: "bg-purple-500/10", border: "border-purple-500/20", trend: "Last 30 days" },
        ].map((s, idx) => (
          <div key={idx} className={`relative flex min-w-[240px] flex-1 items-center gap-5 overflow-hidden rounded-[28px] border ${s.border} bg-app-surface p-5 shadow-[0_12px_28px_rgba(15,23,42,0.06),0_2px_6px_rgba(15,23,42,0.04)] group transition-transform duration-500 hover:scale-[1.02]`}>
            <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity duration-700">
               <s.icon size={80} />
            </div>
            <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-app-surface-2 shadow-sm border border-app-border`}>
              <s.icon size={26} className={s.color} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted opacity-80">{s.label}</p>
                <span className="rounded-full bg-app-surface-2 px-1.5 py-0.5 text-[8px] font-black text-app-text-muted tabular-nums">{s.trend}</span>
              </div>
              <p className="text-3xl font-black tabular-nums text-app-text tracking-tight">{s.val}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-6 sm:pt-4 animate-workspace-snap">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-app-border bg-app-surface shadow-2xl">
          {activeSection === "adjust" ? (
            <div className="flex-1 overflow-auto p-6"><AdjustPanel /></div>
          ) : activeSection === "settings" ? (
            <div className="flex-1 overflow-auto">
              <SettingsPanel 
                settings={settings}
                onSettingsUpdated={(s) => {
                  setSettings(s);
                  void loadData();
                }} 
              />
            </div>
          ) : activeSection === "history" ? (
            <IssuancesHistory settings={settings} />
          ) : (
            <EligibleList 
              settings={settings} 
              onRedeemSuccess={() => void loadData()} 
            />
          )}
        </div>
      </div>
    </div>
  );
}
