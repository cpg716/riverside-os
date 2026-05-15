import { getBaseUrl } from "../../lib/apiConfig";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { 
  AlertTriangle,
  ArrowRight,
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
  Gift,
  X
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
import { useMediaQuery } from "../../hooks/useMediaQuery";

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
      const street = 'address_line1' in c ? c.address_line1 : null;
      const cityStateZip = [
        'city' in c ? c.city : null,
        'state' in c ? c.state : null,
        'zip' in c ? c.zip : null
      ].filter(Boolean).join(", ");
      const fallback = [
        'address_line1' in c ? c.address_line1 : null,
        'city' in c ? c.city : null,
        'state' in c ? c.state : null,
        'zip' in c ? c.zip : null
      ].filter(Boolean).join(", ");
      return `
        <div class="label">
          <p class="name">${name}</p>
          ${street ? `<p>${street}</p>` : ""}
          ${cityStateZip ? `<p>${cityStateZip}</p>` : fallback ? `<p>${fallback}</p>` : ""}
        </div>`;
    })
    .join("");
  w.document.write(`<!DOCTYPE html><html><head><title>Mailing Labels</title>
  <style>
    @page { size: letter; margin: 0.5in 0.1875in; }
    body { font-family: Arial, sans-serif; margin: 0; color: #111; }
    .sheet { display: grid; grid-template-columns: repeat(3, 2.625in); grid-auto-rows: 1in; column-gap: 0.125in; row-gap: 0; }
    .label { box-sizing: border-box; inline-size: 2.625in; block-size: 1in; padding: 0.12in 0.16in; overflow: hidden; font-size: 10pt; line-height: 1.15; }
    .name { font-weight: 700; margin: 0 0 0.04in; }
    p { margin: 0; }
    @media screen { body { padding: 12px; background: #f4f4f5; } .sheet { background: white; width: 8.125in; min-height: 10in; padding: 0.5in 0.1875in; box-shadow: 0 8px 30px rgba(15,23,42,.18); } .label { outline: 1px dashed #ddd; } }
  </style></head><body><div class="sheet">${labels}</div><script>window.onload=function(){window.print();}</script></body></html>`);
  w.document.close();
}

interface LoyaltyLetterCard {
  card_code: string;
  reward_amount: string;
  issue_date: string;
  expiration_date: string;
}

interface LoyaltyLetterContext {
  cards?: LoyaltyLetterCard[];
  issueDate?: string;
  expirationDate?: string;
  totalRewardAmount?: string;
}

function addOneYear(date: Date): Date {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + 1);
  return next;
}

function formatLetterDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function renderCardsTable(cards: LoyaltyLetterCard[]): string {
  if (cards.length === 0) return "";
  return cards
    .map(
      (card, index) =>
        `Card ${index + 1}: ${card.card_code} - $${card.reward_amount} - expires ${card.expiration_date}`,
    )
    .join("\n");
}

function printLoyaltyLetter(
  customer: LoyaltyEligibleCustomer | RewardFulfillmentRow,
  template: string,
  rewardAmount: string,
  context: LoyaltyLetterContext = {},
): void {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  const fallbackIssueDate =
    "fulfillment_date" in customer && customer.fulfillment_date
      ? formatLetterDate(new Date(customer.fulfillment_date))
      : "created_at" in customer && customer.created_at
        ? formatLetterDate(new Date(customer.created_at))
        : formatLetterDate(new Date());
  const fallbackExpirationDate =
    "fulfillment_date" in customer && customer.fulfillment_date
      ? formatLetterDate(addOneYear(new Date(customer.fulfillment_date)))
      : "created_at" in customer && customer.created_at
        ? formatLetterDate(addOneYear(new Date(customer.created_at)))
        : formatLetterDate(addOneYear(new Date()));
  const cards =
    context.cards && context.cards.length > 0
      ? context.cards
      : [
          {
            card_code:
              ("card_code" in customer ? customer.card_code : null) ||
              "[GIFT CARD CODE]",
            reward_amount: rewardAmount,
            issue_date: context.issueDate ?? fallbackIssueDate,
            expiration_date: context.expirationDate ?? fallbackExpirationDate,
          },
        ];
  const totalRewardAmount =
    context.totalRewardAmount ??
    centsToFixed2(cards.reduce((sum, card) => sum + parseMoneyToCents(card.reward_amount), 0));

  const content = template
    .replace(/\{\{first_name\}\}/g, customer.first_name || "")
    .replace(/\{\{last_name\}\}/g, customer.last_name || "")
    .replace(/\{\{reward_amount\}\}/g, rewardAmount)
    .replace(/\{\{total_reward_amount\}\}/g, totalRewardAmount)
    .replace(/\{\{card_code\}\}/g, cards[0]?.card_code || "[GIFT CARD CODE]")
    .replace(/\{\{card_codes\}\}/g, cards.map((card) => card.card_code).join(", "))
    .replace(/\{\{card_count\}\}/g, String(cards.length))
    .replace(/\{\{issue_date\}\}/g, context.issueDate ?? cards[0]?.issue_date ?? fallbackIssueDate)
    .replace(
      /\{\{expiration_date\}\}/g,
      context.expirationDate ?? cards[0]?.expiration_date ?? fallbackExpirationDate,
    )
    .replace(/\{\{cards_table\}\}/g, renderCardsTable(cards));

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
  const [templateSaved, setTemplateSaved] = useState(false);
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

  const saveTemplateOnly = async () => {
    setErr(null);
    setTemplateSaved(false);
    setSaving(true);
    const res = await fetch(`${BASE}/api/loyalty/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...backofficeHeaders() },
      body: JSON.stringify({
        loyalty_letter_template: template.trim(),
      }),
    });
    if (res.ok) {
      const updated = (await res.json()) as LoyaltySettings;
      onSettingsUpdated(updated);
      setTemplate(updated.loyalty_letter_template || "");
      setTemplateSaved(true);
      setTimeout(() => setTemplateSaved(false), 3000);
    } else {
      const b = (await res.json()) as { error?: string };
      setErr(b.error ?? "Template save failed");
    }
    setSaving(false);
  };

  return (
    <div className="animate-in slide-in-from-bottom-4 flex min-h-0 flex-col gap-6 duration-700 lg:min-h-[600px] lg:flex-row">
      {/* Configuration Column */}
      <div className="w-full space-y-6 lg:max-w-[400px]">
        <div className="ui-card relative overflow-hidden border-app-border p-6 group">
          <div className="absolute top-0 left-0 w-1 h-full bg-amber-500 rounded-full" />
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20">
              <Star className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-black text-app-text">Reward Settings</h3>
          </div>
          
          <div className="space-y-5">
            <div className="grid gap-4">
              <label className="block space-y-2">
                <span className="px-1 text-xs font-bold text-app-text-muted">Points needed</span>
                <div className="relative group">
                   <input type="number" min="1" value={threshold} onChange={e => setThreshold(e.target.value)} className="ui-input w-full bg-app-surface border-app-border pl-10 transition-all font-black text-app-warning focus:border-app-warning/40" />
                   <Coins className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-app-text-muted opacity-40 group-focus-within:opacity-100 transition-opacity" />
                </div>
              </label>
              
              <label className="block space-y-2">
                <span className="px-1 text-xs font-bold text-app-text-muted">Reward amount</span>
                <div className="relative group">
                   <input type="number" min="0.01" step="0.01" value={reward} onChange={e => setReward(e.target.value)} className="ui-input w-full bg-app-surface border-app-border pl-10 transition-all font-black text-app-success focus:border-app-success/40" />
                   <div className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-app-text-muted opacity-40 group-focus-within:opacity-100 transition-opacity">$</div>
                </div>
              </label>
            </div>

            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 space-y-2">
               <div className="flex justify-between text-xs font-bold text-app-text-muted">
                  <span>Point Multiplier</span>
                  <span>{settings?.points_per_dollar || 1}x</span>
               </div>
               <div className="flex justify-between text-xs font-bold text-app-text-muted">
                  <span>Reward ROI</span>
                  <span className="text-app-success">{((parseFloat(reward) || 0) / (parseFloat(threshold) || 1) * 100).toFixed(1)}%</span>
               </div>
            </div>

            {err && <div className="animate-shake rounded-xl border border-app-danger/20 bg-app-danger/10 p-3 text-sm font-semibold text-app-danger">{err}</div>}
            {saved && <div className="rounded-xl border border-app-success/20 bg-app-success/10 p-3 text-sm font-semibold text-app-success">Program settings saved</div>}
            {templateSaved && <div className="rounded-xl border border-app-success/20 bg-app-success/10 p-3 text-sm font-semibold text-app-success">Reward letter template saved</div>}

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
      <div className="flex flex-1 flex-col overflow-visible ui-card p-0 group lg:overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-app-border bg-app-surface-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600 ring-1 ring-purple-500/20">
              <Mail className="h-5 w-5" />
            </div>
            <div>
               <h3 className="text-sm font-black text-app-text">Reward Letter Template</h3>
               <p className="text-xs font-semibold text-app-text-muted">Customer message for reward-card follow-up</p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-app-surface px-1 py-1">
            {[
              "{{first_name}}",
              "{{total_reward_amount}}",
              "{{card_count}}",
              "{{card_codes}}",
              "{{cards_table}}",
              "{{issue_date}}",
              "{{expiration_date}}",
              "{{reward_amount}}",
              "{{card_code}}",
            ].map(tag => (
              <button 
                key={tag}
                onClick={() => setTemplate(prev => prev + tag)}
                className="min-h-9 rounded-lg border border-app-border/50 bg-app-surface px-2.5 py-1 text-xs font-bold text-app-text-muted transition-all hover:border-purple-300 hover:text-purple-600 hover:shadow-sm"
              >
                {tag}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void saveTemplateOnly()}
              disabled={saving}
              className="min-h-9 rounded-lg bg-app-accent px-3 py-1 text-xs font-black uppercase tracking-widest text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Template"}
            </button>
          </div>
        </div>

        <div className="relative min-h-[320px] flex-1 lg:min-h-0">
           <textarea
             value={template}
             onChange={e => setTemplate(e.target.value)}
             placeholder="Write the reward-card message here..."
             className="h-full w-full resize-none bg-transparent p-4 text-sm font-mono leading-relaxed text-app-text placeholder:opacity-20 tabular-nums focus:outline-none sm:p-6 lg:p-8"
           />
           <div className="absolute bottom-6 right-6 flex items-center gap-2">
              <span className="text-xs font-semibold text-app-text-muted opacity-70">Markdown supported</span>
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
    <div className="animate-in fade-in slide-in-from-right-4 flex flex-col gap-6 duration-700 lg:flex-row">
      {/* Entry Column */}
      <div className="w-full space-y-6 lg:max-w-[450px]">
        <div className="ui-card relative overflow-hidden border-app-border p-6">
          <div className="absolute top-0 right-0 p-4 opacity-[0.05] grayscale">
             <RefreshCw size={100} className={busy ? "animate-spin" : ""} />
          </div>
          <div className="flex items-center gap-3 mb-6">
            <div className="rounded-xl bg-app-info/10 p-2 text-app-info ring-1 ring-app-info/20">
              <RefreshCw className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-black text-app-text">Points Adjustment</h3>
          </div>

          <form 
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-5"
          >
            <div className="space-y-2">
              <span className="px-1 text-xs font-bold text-app-text-muted">Customer</span>
              <CustomerSearchInput
                onSelect={(c: Customer) => {
                  setCustomerId(c.id);
                  setCustomerLabel(`${c.first_name} ${c.last_name}`.trim());
                }}
                placeholder="Search customers..."
                className="w-full rounded-2xl bg-app-surface"
              />
              {customerId && (
                <div className="mt-2 flex items-center justify-between rounded-2xl border border-app-success/16 bg-app-success/8 p-3 group">
                  <div className="flex items-center gap-3">
                     <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-success/10 text-app-success font-black text-[10px] ring-1 ring-app-success/20 uppercase">
                        {customerLabel?.[0] || 'C'}
                     </div>
                     <p className="text-sm font-bold text-app-success">{customerLabel}</p>
                  </div>
                  <button type="button" onClick={() => setCustomerId("")} className="min-h-9 rounded-lg px-3 text-xs font-bold text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-danger">Clear</button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-2">
                <span className="px-1 text-xs font-bold text-app-text-muted">Point change</span>
                <input type="number" value={delta} onChange={e => setDelta(e.target.value)} className="ui-input w-full bg-app-surface font-black tabular-nums border-app-border" placeholder="0" />
              </label>
              <label className="block space-y-2">
                <span className="px-1 text-xs font-bold text-app-text-muted">Manager code</span>
                <input value={badge} onChange={e => setBadge(e.target.value)} className="ui-input w-full border-app-border bg-app-surface font-black" placeholder="Staff code" />
              </label>
            </div>

            <label className="block space-y-2">
              <span className="px-1 text-xs font-bold text-app-text-muted">Reason</span>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Goodwill adjustment or correction" className="ui-input w-full border-app-border bg-app-surface" />
            </label>

            <label className="block space-y-2">
              <span className="px-1 text-xs font-bold text-app-text-muted">Manager Access PIN</span>
              <input type="password" value={pin} onChange={e => setPin(e.target.value)} className="ui-input w-full bg-app-surface border-app-border" placeholder="••••" />
            </label>

            {err && <div className="animate-shake rounded-xl border border-app-danger/20 bg-app-danger/10 p-3 text-sm font-semibold text-app-danger">{err}</div>}
            {result && <div className="rounded-xl border border-app-success/20 bg-app-success/10 p-3 text-sm font-semibold text-app-success">{result}</div>}

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
            <h3 className="text-sm font-black text-app-text">Loyalty Activity</h3>
         </div>

         {!customerId ? (
           <div className="flex-1 flex flex-col items-center justify-center grayscale opacity-20">
              <RefreshCw size={40} className="mb-4" />
              <p className="text-sm font-semibold">Select a customer to view loyalty activity</p>
           </div>
         ) : (
           <div className="space-y-3">
              {ledger.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface-2 p-3 transition-colors hover:bg-app-surface">
                   <div className="flex flex-col">
                      <span className="text-sm font-black text-app-text">{p.activity_label}</span>
                      <span className="text-[10px] text-app-text-muted">{p.activity_detail}</span>
                      <span className="text-xs font-semibold text-app-text-muted opacity-70">
                         {new Date(p.created_at).toLocaleDateString()} at {new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                   </div>
                   <div className="flex flex-col items-end">
                      <span className={`text-xs font-black tabular-nums ${p.delta_points > 0 ? 'text-app-success' : 'text-app-danger'}`}>
                         {p.delta_points > 0 ? '+' : ''}{p.delta_points.toLocaleString()}
                      </span>
                      <span className="text-xs font-semibold text-app-text-muted opacity-60">Balance: {p.balance_after.toLocaleString()}</span>
                   </div>
                </div>
              ))}
              {ledger.length === 0 && (
                <p className="py-10 text-center text-sm font-semibold text-app-text-muted opacity-70">No recent loyalty activity</p>
              )}
           </div>
         )}
      </div>
    </div>
  );
}

interface BatchIssuedReward {
  customer: LoyaltyEligibleCustomer;
  card_code: string;
  points_deducted: number;
  reward_amount: string;
  issue_date: string;
  expiration_date: string;
}

function LoyaltyBatchRedeemDialog({
  isOpen,
  customers,
  settings,
  getAuthHeaders,
  onClose,
  onFinished,
}: {
  isOpen: boolean;
  customers: LoyaltyEligibleCustomer[];
  settings: LoyaltySettings;
  getAuthHeaders: () => HeadersInit;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [customerIndex, setCustomerIndex] = useState(0);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [cardCode, setCardCode] = useState("");
  const [issued, setIssued] = useState<BatchIssuedReward[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);

  const threshold = settings.loyalty_point_threshold || 5000;
  const rewardCents = parseMoneyToCents(settings.loyalty_reward_amount);
  const current = customers[customerIndex] ?? null;
  const currentBalance = current ? (balances[current.id] ?? current.loyalty_points) : 0;
  const maxUnits = Math.floor(currentBalance / threshold);
  const singleRewardAmount = centsToFixed2(rewardCents);
  const completed = current == null || customerIndex >= customers.length;

  useEffect(() => {
    if (!isOpen) return;
    setCustomerIndex(0);
    setBalances(Object.fromEntries(customers.map((customer) => [customer.id, customer.loyalty_points])));
    setCardCode("");
    setIssued([]);
    setBusy(false);
    setError(null);
  }, [customers, isOpen, settings.loyalty_point_threshold]);

  useEffect(() => {
    if (!isOpen || !current) return;
    setCardCode("");
    setError(null);
    window.setTimeout(() => cardInputRef.current?.focus(), 50);
  }, [current, isOpen, maxUnits, threshold]);

  if (!isOpen) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const uniqueIssuedCustomers = Array.from(
    new Map(issued.map((row) => [row.customer.id, row.customer])).values(),
  );

  const issuedForCustomer = (customer: LoyaltyEligibleCustomer) =>
    issued.filter((row) => row.customer.id === customer.id);

  const printBatchLetterForCustomer = (
    customer: LoyaltyEligibleCustomer,
    cards: BatchIssuedReward[],
  ) => {
    if (cards.length === 0) return;
    const letterCards = cards.map((card) => ({
      card_code: card.card_code,
      reward_amount: card.reward_amount,
      issue_date: card.issue_date,
      expiration_date: card.expiration_date,
    }));
    const totalRewardAmount = centsToFixed2(
      letterCards.reduce(
        (sum, card) => sum + parseMoneyToCents(card.reward_amount),
        0,
      ),
    );
    printLoyaltyLetter(customer, settings.loyalty_letter_template || "", totalRewardAmount, {
      cards: letterCards,
      issueDate: letterCards[0]?.issue_date,
      expirationDate: letterCards[0]?.expiration_date,
      totalRewardAmount,
    });
  };

  const moveNext = () => {
    const nextIndex = customerIndex + 1;
    setCustomerIndex(nextIndex);
    setCardCode("");
    setError(null);
  };

  const issueCurrentCard = async () => {
    if (!current || busy) return;
    setError(null);
    if (currentBalance < threshold) {
      setError("This customer does not have enough points for another reward card.");
      return;
    }
    if (!cardCode.trim()) {
      setError("Scan or enter the gift card code before issuing.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/loyalty/redeem-reward`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          customer_id: current.id,
          points_to_redeem: threshold,
          apply_to_sale: centsToFixed2(0),
          remainder_card_code: cardCode.trim(),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        new_balance?: number;
        points_deducted?: number;
        remainder_loaded?: string | number;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Reward card could not be issued.");
      }
      const rewardAmount = centsToFixed2(parseMoneyToCents(data.remainder_loaded ?? singleRewardAmount));
      const issuedOn = new Date();
      const issueDate = formatLetterDate(issuedOn);
      const expirationDate = formatLetterDate(addOneYear(issuedOn));
      const issuedRow: BatchIssuedReward = {
        customer: current,
        card_code: cardCode.trim(),
        points_deducted: data.points_deducted ?? threshold,
        reward_amount: rewardAmount,
        issue_date: issueDate,
        expiration_date: expirationDate,
      };
      setIssued((rows) => [...rows, issuedRow]);
      setBalances((currentBalances) => ({
        ...currentBalances,
        [current.id]: data.new_balance ?? Math.max(0, currentBalance - threshold),
      }));
      const cardsForLetter = [...issuedForCustomer(current), issuedRow];
      setCardCode("");
      const nextBalance = data.new_balance ?? Math.max(0, currentBalance - threshold);
      if (nextBalance < threshold) {
        printBatchLetterForCustomer(current, cardsForLetter);
        moveNext();
      } else {
        window.setTimeout(() => cardInputRef.current?.focus(), 50);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reward card could not be issued.");
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    onFinished();
    onClose();
  };

  return createPortal(
    <div className="ui-overlay-backdrop animate-in fade-in duration-300">
      <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[32px] border border-app-border bg-app-surface shadow-[0_32px_128px_rgba(0,0,0,0.55)]">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border bg-app-surface-2 px-6 py-5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted">
              Loyalty reward batch
            </p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-app-text">
              Issue cards, print customer letters, then print labels
            </h2>
            <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-app-text-muted">
              Each scanned card issues one configured reward. ROS prints one customer letter after all reward cards for that customer are issued.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-app-border bg-app-surface text-app-text-muted hover:text-app-text disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-b border-app-border bg-app-surface-2/60 p-4 lg:border-b-0 lg:border-r">
            <p className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Selected customers
            </p>
            <div className="space-y-2">
              {customers.map((customer, index) => {
                const balance = balances[customer.id] ?? customer.loyalty_points;
                const done = balance < threshold;
                return (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => setCustomerIndex(index)}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                      index === customerIndex
                        ? "border-app-accent bg-app-accent/10"
                        : "border-app-border bg-app-surface"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-black text-app-text">
                        {loyaltyEligibleDisplayName(customer)}
                      </span>
                      <span className={done ? "text-app-success" : "text-app-warning"}>
                        {done ? "Done" : `${Math.floor(balance / threshold)}x`}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] font-bold text-app-text-muted">
                      {balance.toLocaleString()} pts remaining
                    </p>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-h-0 overflow-auto p-5 sm:p-6">
            {completed ? (
              <div className="flex min-h-[30rem] flex-col items-center justify-center text-center">
                <Award className="mb-4 h-14 w-14 text-app-success" aria-hidden />
                <h3 className="text-2xl font-black text-app-text">Batch complete</h3>
                <p className="mt-2 max-w-md text-sm font-semibold leading-6 text-app-text-muted">
                  {issued.length} reward card{issued.length === 1 ? "" : "s"} issued. Print the mailing labels for the customers completed in this batch.
                </p>
                <button
                  type="button"
                  onClick={() => printMailingLabels(uniqueIssuedCustomers)}
                  disabled={uniqueIssuedCustomers.length === 0}
                  className="ui-btn-primary mt-6 inline-flex items-center gap-2 px-6 py-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  <Printer className="h-4 w-4" aria-hidden />
                  Print mailing labels
                </button>
                <button
                  type="button"
                  onClick={finish}
                  className="ui-btn-secondary mt-3 px-5 py-2 text-[10px] font-black uppercase tracking-widest"
                >
                  Close batch
                </button>
              </div>
            ) : current ? (
              <div className="space-y-5">
                <div className="rounded-[28px] border border-app-border bg-app-surface-2 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Customer {customerIndex + 1} of {customers.length}
                      </p>
                      <h3 className="mt-1 text-2xl font-black text-app-text">
                        {loyaltyEligibleDisplayName(current)}
                      </h3>
                      <p className="mt-1 text-xs font-bold text-app-text-muted">
                        {current.customer_code || "No customer code"} · {current.email || "No email"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Available
                      </p>
                      <p className="text-3xl font-black text-app-warning">
                        {currentBalance.toLocaleString()} pts
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
                  <label className="block">
                    <span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Gift card code
                    </span>
                    <input
                      ref={cardInputRef}
                      value={cardCode}
                      onChange={(event) => setCardCode(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void issueCurrentCard();
                      }}
                      className="ui-input h-14 w-full px-4 font-mono text-lg font-black uppercase tracking-[0.18em]"
                      placeholder="Scan card..."
                    />
                  </label>
                  <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      This card
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {threshold.toLocaleString()} pts · ${singleRewardAmount}
                    </p>
                    <p className="mt-1 text-[10px] font-bold text-app-text-muted">
                      {maxUnits.toLocaleString()} card{maxUnits === 1 ? "" : "s"} available for this customer
                    </p>
                  </div>
                </div>

                {error ? (
                  <div className="flex items-center gap-3 rounded-2xl border border-app-danger/25 bg-app-danger/10 px-4 py-3 text-sm font-bold text-app-danger">
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    {error}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-[28px] border border-app-border bg-app-surface-2 p-4">
                  <div>
                    <p className="text-sm font-black text-app-text">
                      This card will load ${singleRewardAmount}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">
                      The customer letter prints after the last available reward card for this customer is issued.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={moveNext}
                      disabled={busy}
                      className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                    >
                      Skip customer
                      <ArrowRight className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void issueCurrentCard()}
                      disabled={busy || !cardCode.trim() || maxUnits <= 0}
                      className="ui-btn-primary inline-flex items-center gap-2 px-5 py-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                    >
                      <Award className="h-4 w-4" aria-hidden />
                      {busy ? "Issuing..." : `Issue $${singleRewardAmount} card`}
                    </button>
                  </div>
                </div>

                {issued.length > 0 ? (
                  <section className="rounded-[28px] border border-app-border bg-app-surface p-4">
                    <p className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Issued in this batch
                    </p>
                    <div className="max-h-44 space-y-2 overflow-auto">
                      {issued.map((row, index) => (
                        <div key={`${row.customer.id}-${row.card_code}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-app-surface-2 px-3 py-2">
                          <span className="text-sm font-bold text-app-text">
                            {loyaltyEligibleDisplayName(row.customer)}
                          </span>
                          <span className="font-mono text-[10px] font-black text-app-text-muted">
                            {row.card_code} · {row.points_deducted.toLocaleString()} pts · ${row.reward_amount}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}
          </main>
        </div>
      </div>
    </div>,
    root,
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/loyalty/monthly-eligible`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) {
        const rows = (await res.json()) as LoyaltyEligibleCustomer[];
        setCustomers(rows);
        setSelectedIds((current) => {
          const valid = new Set(rows.map((customer) => customer.id));
          return new Set(Array.from(current).filter((id) => valid.has(id)));
        });
      }
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedCustomers = useMemo(
    () => customers.filter((customer) => selectedIds.has(customer.id)),
    [customers, selectedIds],
  );

  const toggleSelected = (customerId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };

  const allSelected = customers.length > 0 && selectedIds.size === customers.length;
  const toggleAll = () => {
    setSelectedIds(
      allSelected
        ? new Set()
        : new Set(customers.map((customer) => customer.id)),
    );
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-app-border px-6 py-5 bg-app-surface-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-black tracking-tight text-app-text">Customers Ready for Reward</h2>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted mt-1">
              {customers.length} members currently at or above threshold
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
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
                onClick={toggleAll}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 border-app-border/50 shadow-sm"
              >
                {allSelected ? "Clear Selection" : "Select All"}
              </button>
            )}
            {selectedCustomers.length > 0 && settings && (
              <button
                type="button"
                onClick={() => setBatchOpen(true)}
                className="ui-btn-primary flex items-center gap-2 px-4 py-2 shadow-sm"
              >
                <Award className="h-4 w-4" />
                Start Batch ({selectedCustomers.length})
              </button>
            )}
            {customers.length > 0 && (
              <button
                type="button"
                onClick={() => printMailingLabels(selectedCustomers.length > 0 ? selectedCustomers : customers)}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 border-app-border/50 shadow-sm"
              >
                <Printer className="h-4 w-4" />
                Print Labels
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="p-4 sm:p-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-4">
             <div className="h-10 w-10 border-b-2 border-app-accent rounded-full animate-spin" />
	             <p className="text-sm font-semibold text-app-text-muted">Loading eligible customers...</p>
          </div>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center gap-6 py-32 grayscale opacity-40">
            <Star className="h-16 w-16" />
	            <p className="max-w-xs text-center text-sm font-semibold text-app-text-muted">No customers have reached the reward level yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* High-density Horizontal List for Elite Members */}
            <div className="hidden lg:grid grid-cols-[1fr_2fr_2fr_auto] gap-4 px-8 py-3 mb-2 opacity-40">
	               <span className="text-xs font-bold">Customer</span>
	               <span className="px-10 text-xs font-bold">Points Status</span>
	               <span className="text-xs font-bold">Contact & Location</span>
	               <span className="text-right text-xs font-bold">Actions</span>
            </div>

            <div className="space-y-3">
              {customers.map(c => {
                const isMultiReward = c.loyalty_points >= (settings?.loyalty_point_threshold || 5000) * 2;
                const pointsValue = c.loyalty_points.toLocaleString();
                const selected = selectedIds.has(c.id);
                
                return (
                  <div
                    key={c.id}
                    data-testid="loyalty-eligible-row"
                    className="group relative flex flex-col gap-4 rounded-[28px] border border-app-border bg-app-surface p-4 transition-all duration-500 hover:border-app-warning/20 hover:shadow-[0_18px_36px_rgba(15,23,42,0.08),0_4px_10px_rgba(15,23,42,0.05)] lg:flex-row lg:items-center lg:gap-0 lg:p-0"
                  >
                    {/* ID & Basic Info */}
                    <div className="lg:w-[1fr] lg:flex-1 lg:pl-6 lg:py-4">
                      <div className="flex items-center gap-4">
                        <label className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-text-muted">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelected(c.id)}
                            className="h-4 w-4 accent-app-accent"
                            aria-label={`Select ${loyaltyEligibleDisplayName(c)} for loyalty batch`}
                          />
                        </label>
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-app-surface-2 ring-1 ring-app-border border-b-4 border-app-border/50 text-[13px] font-black text-app-text transition-all duration-500 group-hover:border-app-warning/30 group-hover:text-app-warning">
                           {c.first_name?.[0]}{c.last_name?.[0]}
                        </div>
                        <div className="min-w-0 flex flex-col">
                           <span className="text-[15px] font-black tracking-tight text-app-text leading-tight group-hover:translate-x-1 transition-transform">{loyaltyEligibleDisplayName(c)}</span>
	                           <span className="mt-1 text-xs font-bold tabular-nums text-app-text-muted opacity-70">#{c.customer_code || "New"}</span>
                        </div>
                      </div>
                    </div>

                    {/* Value KPIs */}
                    <div className="lg:w-[2fr] lg:flex-1 lg:px-10">
                      <div className="flex items-center gap-6">
                         <div className="flex flex-col">
                            <span className="text-2xl font-black text-app-warning tabular-nums tracking-tighter leading-none">{pointsValue}</span>
	                            <span className="mt-1 text-xs font-bold text-app-text-muted opacity-70">Current balance</span>
                         </div>
                         <div className="h-8 w-px bg-app-border/30 mx-2 hidden lg:block" />
                         <div className="flex flex-col">
                            <div className="flex items-center gap-1.5">
	                               <span className={`text-xs font-black ${isMultiReward ? 'text-app-accent' : 'text-app-success'}`}>
                                  {isMultiReward ? "Two rewards ready" : "Reward ready"}
                               </span>
                               {isMultiReward && <Award size={14} className="text-purple-500 animate-pulse" />}
                            </div>
	                            <span className="mt-1 text-xs font-bold text-app-text-muted opacity-70">
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
                             <span className="max-w-[220px] truncate lg:max-w-[160px]">{c.email || "No email"}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] font-bold text-app-text-muted">
                             <TrendingUp size={14} className="text-app-success/50" />
                             <span>{[c.city, c.state].filter(Boolean).join(", ") || "Location not listed"}</span>
                          </div>
                       </div>
                    </div>

                    {/* Ops */}
                    <div className="lg:pr-6 py-2 lg:py-4">
                       <div data-testid="loyalty-eligible-actions" className="flex items-center gap-2 justify-end">
                         <button
                           type="button"
                           onClick={() => setRedeemCustomer(c)}
                           disabled={!settings}
	                           className="flex min-h-11 items-center gap-3 rounded-2xl border-b-4 border-emerald-800 bg-emerald-600 px-6 text-sm font-black text-white shadow-2xl shadow-emerald-500/20 transition-all hover:brightness-110 active:scale-95"
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
        <>
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
          <LoyaltyBatchRedeemDialog
            isOpen={batchOpen}
            customers={selectedCustomers}
            settings={settings}
            getAuthHeaders={backofficeHeaders}
            onClose={() => setBatchOpen(false)}
            onFinished={() => {
              setSelectedIds(new Set());
              void load();
              void onRedeemSuccess();
            }}
          />
        </>
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
    <div className="flex flex-1 flex-col bg-app-surface scale-in-center">
      <div className="border-b border-app-border px-6 py-5 bg-app-surface-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-black tracking-tight text-app-text">Reward Card History</h2>
	            <p className="mt-1 text-sm font-semibold text-app-text-muted">
              Recent loyalty reward cards issued to customers
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
	            className="group flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-app-border/50 bg-app-surface px-4 py-2 text-sm font-bold shadow-sm transition-all hover:bg-app-surface-2 sm:w-auto"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-purple-500" : "text-app-text-muted group-hover:text-purple-500"}`} />
            Refresh History
          </button>
        </div>
      </div>
      <div className="p-4 sm:p-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-4">
             <div className="h-12 w-12 border-b-2 border-purple-500 rounded-full animate-spin" />
	             <p className="text-sm font-semibold text-app-text-muted">Loading reward history...</p>
          </div>
        ) : issuances.length === 0 ? (
          <div className="flex flex-col items-center gap-6 py-32 grayscale opacity-40">
            <LayoutDashboard size={48} className="text-app-text-muted" />
	            <p className="text-sm font-semibold text-app-text-muted">No reward cards have been issued yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {issuances.map(row => (
              <div
                key={row.reward_id}
                data-testid="loyalty-history-row"
                className="group flex flex-col gap-4 rounded-[24px] border border-app-border bg-app-surface p-5 transition-all duration-500 hover:border-app-accent/20 hover:shadow-[0_16px_32px_rgba(15,23,42,0.08),0_4px_10px_rgba(15,23,42,0.05)] lg:flex-row lg:items-center lg:gap-0"
              >
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
	                         <span className="mt-0.5 text-xs font-semibold text-app-text-muted opacity-70">
                            {row.fulfillment_date ? new Date(row.fulfillment_date).toLocaleDateString() : 'N/A'} at {row.fulfillment_date ? new Date(row.fulfillment_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A'}
                         </span>
                      </div>
                    </div>
                  </div>

                {/* Value & Ledger Info */}
                <div className="lg:w-[1fr] lg:flex-1 lg:px-6">
                  <div className="flex flex-col">
                     <span className="text-lg font-black text-app-success tracking-tight leading-none">${centsToFixed2(parseMoneyToCents(row.reward_amount))}</span>
	                     <span className="mt-1 text-xs font-semibold text-app-text-muted opacity-70">
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
	                       <span className="ml-6 text-xs font-semibold text-app-text-muted opacity-70">Reward card issued</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                           <ShoppingCart size={14} className="text-app-success opacity-40" />
	                           <span className="text-xs font-black text-app-success">Direct redemption</span>
                        </div>
	                        <span className="ml-6 text-xs font-semibold text-app-text-muted opacity-70">Applied to sale</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="lg:pr-2">
                   <div
                     data-testid="loyalty-history-actions"
                     className="flex translate-x-0 items-center justify-end gap-2 opacity-100 transition-all duration-300 lg:translate-x-2 lg:opacity-0 lg:group-hover:translate-x-0 lg:group-hover:opacity-100"
                   >
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
  const isCompactLayout = useMediaQuery("(max-width: 1023px)");
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
      <div className="no-scrollbar flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2">
        {[
          { label: "Points On Accounts", val: stats?.total_points_liability.toLocaleString() ?? "—", icon: Coins, color: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/20", trend: "Current total" },
          { label: "Ready For Reward", val: stats?.eligible_customers_count.toLocaleString() ?? "—", icon: UserCheck, color: "text-sky-500", bg: "bg-sky-500/10", border: "border-sky-500/20", trend: "At threshold" },
          { label: "Reward Cards Issued", val: stats?.lifetime_rewards_issued.toLocaleString() ?? "—", icon: Award, color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20", trend: "All time" },
          { label: "Recent Adjustments", val: stats?.active_30d_adjustments.toLocaleString() ?? "—", icon: TrendingUp, color: "text-purple-500", bg: "bg-purple-500/10", border: "border-purple-500/20", trend: "Last 30 days" },
        ].map((s, idx) => (
          <div
            key={idx}
            className={`group relative flex ${isCompactLayout ? "min-w-[210px]" : "min-w-[240px]"} flex-1 items-center gap-5 overflow-hidden rounded-[28px] border ${s.border} bg-app-surface p-5 shadow-[0_12px_28px_rgba(15,23,42,0.06),0_2px_6px_rgba(15,23,42,0.04)] transition-transform duration-500 hover:scale-[1.02]`}
          >
            <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity duration-700">
               <s.icon size={80} />
            </div>
            <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-app-surface-2 shadow-sm border border-app-border`}>
              <s.icon size={26} className={s.color} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-xs font-bold text-app-text-muted opacity-80">{s.label}</p>
                <span className="rounded-full bg-app-surface-2 px-1.5 py-0.5 text-xs font-bold tabular-nums text-app-text-muted">{s.trend}</span>
              </div>
              <p className="text-3xl font-black tabular-nums text-app-text tracking-tight">{s.val}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-1 flex-col p-4 sm:p-6 sm:pt-4 animate-workspace-snap">
        <div className="flex flex-1 flex-col rounded-[24px] border border-app-border bg-app-surface shadow-2xl">
          {activeSection === "adjust" ? (
            <div className="p-4 sm:p-6"><AdjustPanel /></div>
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
