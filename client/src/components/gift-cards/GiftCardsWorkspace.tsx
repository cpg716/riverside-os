import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, Gift, RefreshCw, X, TrendingUp, Wallet, BadgeDollarSign } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import { centsToFixed2, formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

const BASE = getBaseUrl();

interface GiftCardRow {
  id: string;
  code: string;
  card_kind: string;
  card_status: string;
  current_balance: string;
  original_value: string | null;
  is_liability: boolean;
  expires_at: string | null;
  customer_id: string | null;
  customer_name: string | null;
  notes: string | null;
  created_at: string;
}

interface GiftCardSummary {
  open_cards_count: number;
  active_liability_balance: string;
  loyalty_cards_count: number;
  donated_cards_count: number;
}

const KIND_LABELS: Record<string, string> = {
  purchased: "Purchased",
  loyalty_reward: "Loyalty reward",
  donated_giveaway: "Donated / giveaway",
};

function fmt(v: string | null | undefined): string {
  if (v == null) return "—";
  return formatUsdFromCents(parseMoneyToCents(v));
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

interface IssueFormProps {
  kind: "purchased" | "donated";
  onDone: () => void;
}

function IssueForm({ kind, onDone }: IssueFormProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerLabel, setCustomerLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

  const submit = async () => {
    setErr(null);
    if (!code.trim()) { setErr("Card code is required."); return; }
    const amtCents = parseMoneyToCents(amount);
    if (amtCents <= 0) { setErr("Enter a positive amount."); return; }
    setBusy(true);
    try {
      const endpoint = kind === "purchased" ? "issue-purchased" : "issue-donated";
      const res = await fetch(`${BASE}/api/gift-cards/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(backofficeHeaders() as Record<string, string>) },
        body: JSON.stringify({
          code: code.trim(),
          amount: centsToFixed2(amtCents),
          notes: notes.trim() || undefined,
          customer_id: customerId,
        }),
      });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        throw new Error(b.error ?? "Failed to issue card");
      }
      toast(`Gift card ${code} issued successfully.`, "success");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-card p-5 space-y-4 max-w-sm">
      <h3 className="text-sm font-black uppercase tracking-wide text-app-text">
        Issue {kind === "purchased" ? "Purchased" : "Donated / Giveaway"} Card
      </h3>
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Card code</span>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="Scan or type…" className="ui-input mt-1 w-full" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Amount ($)</span>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <div className="space-y-1">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Link Customer (optional)</span>
        <CustomerSearchInput 
          onSelect={(c) => {
            setCustomerId(c.id);
            setCustomerLabel(`${c.first_name} ${c.last_name}`.trim());
          }}
          placeholder="Search customer…"
          className="w-full"
        />
        {customerId && (
          <p className="text-[10px] text-emerald-600 font-bold">Linked: {customerLabel}</p>
        )}
      </div>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Notes (optional)</span>
        <input value={notes} onChange={e => setNotes(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      {kind === "purchased" && (
        <p className="text-xs text-app-text-muted">9-year expiry · Liability at issue.</p>
      )}
      {kind === "donated" && (
        <p className="text-xs text-app-text-muted">1-year expiry · No liability until redeemed.</p>
      )}
      <button onClick={submit} disabled={busy} className="ui-btn-primary w-full">
        {busy ? "Issuing…" : "Issue card"}
      </button>
    </div>
  );
}

export default function GiftCardsWorkspace({ activeSection }: { activeSection: string }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [cards, setCards] = useState<GiftCardRow[]>([]);
  const [summary, setSummary] = useState<GiftCardSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterKind, setFilterKind] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");
  /** Matches POS “open” list: positive balance, not expired. */
  const [openOnly, setOpenOnly] = useState(true);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [showVoidConfirm, setShowVoidConfirm] = useState<string | null>(null);
  const { toast } = useToast();

  const stats = useMemo(() => ({
    openCount: summary?.open_cards_count ?? 0,
    liabilityLabel: summary ? fmt(summary.active_liability_balance) : fmt("0"),
    loyaltyCount: summary?.loyalty_cards_count ?? 0,
    donatedCount: summary?.donated_cards_count ?? 0,
  }), [summary]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterKind) params.set("kind", filterKind);
      if (filterStatus) params.set("status", filterStatus);
      if (openOnly) {
        params.set("open_only", "true");
        params.set("sort", "recent_activity");
      }
      const res = await fetch(`${BASE}/api/gift-cards?${params}`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setCards((await res.json()) as GiftCardRow[]);
    } catch {
      // Keep workspace mounted during transient API outages.
      setCards([]);
    } finally {
      setLoading(false);
    }
  }, [filterKind, filterStatus, openOnly, backofficeHeaders]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/gift-cards/summary`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setSummary((await res.json()) as GiftCardSummary);
    } catch {
      // Preserve last known summary when API is unavailable.
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const initiateVoid = (id: string) => {
    setShowVoidConfirm(id);
  };

  const executeVoid = async () => {
    if (!showVoidConfirm) return;
    const id = showVoidConfirm;
    setShowVoidConfirm(null);
    setVoidingId(id);
    try {
      const res = await fetch(`${BASE}/api/gift-cards/${id}/void`, {
        method: "POST",
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Failed to void card");
      toast("Gift card voided.", "success");
      await load();
      await loadSummary();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Error voiding card", "error");
    } finally {
      setVoidingId(null);
    }
  };


  if (activeSection === "issue-purchased") {
    return (
      <div className="p-6">
        <IssueForm kind="purchased" onDone={() => void load()} />
      </div>
    );
  }

  if (activeSection === "issue-donated") {
    return (
      <div className="p-6">
        <IssueForm kind="donated" onDone={() => void load()} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-transparent">
      <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
        {[
          {
            label: "Open Cards",
            val: stats.openCount.toLocaleString(),
            icon: CreditCard,
            color: "text-sky-500",
            bg: "bg-sky-500/10",
            border: "border-sky-500/20",
            trend: openOnly ? "POS parity" : "all rows",
          },
          {
            label: "Liability",
            val: stats.liabilityLabel,
            icon: Wallet,
            color: "text-emerald-500",
            bg: "bg-emerald-500/10",
            border: "border-emerald-500/20",
            trend: "active balance",
          },
          {
            label: "Loyalty Cards",
            val: stats.loyaltyCount.toLocaleString(),
            icon: Gift,
            color: "text-amber-500",
            bg: "bg-amber-500/10",
            border: "border-amber-500/20",
            trend: "reward issued",
          },
          {
            label: "Donated Cards",
            val: stats.donatedCount.toLocaleString(),
            icon: TrendingUp,
            color: "text-purple-500",
            bg: "bg-purple-500/10",
            border: "border-purple-500/20",
            trend: "community",
          },
        ].map((s, idx) => (
          <div key={idx} className={`flex min-w-[240px] flex-1 items-center gap-5 rounded-[28px] border ${s.border} ${s.bg} p-5 shadow-sm backdrop-blur-3xl relative overflow-hidden group hover:scale-[1.02] transition-transform duration-500`}>
            <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity duration-700">
               <s.icon size={80} />
            </div>
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/40 shadow-xl dark:bg-black/20 border border-white/20">
              <s.icon size={26} className={s.color} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted opacity-80">{s.label}</p>
                <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-app-text-muted tabular-nums">{s.trend}</span>
              </div>
              <p className="text-3xl font-black tabular-nums text-app-text tracking-tight">{s.val}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-6 sm:pt-4 animate-workspace-snap">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-app-border bg-app-surface shadow-2xl">
          <div className="border-b border-app-border px-6 py-5 bg-app-surface-2/10 backdrop-blur-md">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20">
                  <BadgeDollarSign className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-base font-black tracking-tight text-app-text">Gift Cards</h1>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted mt-1">
                    {cards.length} cards shown
                    {openOnly && filterStatus === "active"
                      ? " · open only · newest activity first"
                      : ""}
                  </p>
                </div>
              </div>
              <button onClick={load} className="group flex items-center gap-2 rounded-xl border border-app-border/50 bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-app-surface-2 transition-all">
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-emerald-500" : "text-app-text-muted group-hover:text-emerald-500"}`} />
                Sync Ledger
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <select value={filterKind} onChange={e => setFilterKind(e.target.value)} className="ui-input text-xs px-2 py-1.5">
                <option value="">All kinds</option>
                <option value="purchased">Purchased</option>
                <option value="loyalty_reward">Loyalty reward</option>
                <option value="donated_giveaway">Donated / giveaway</option>
              </select>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="ui-input text-xs px-2 py-1.5">
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="depleted">Depleted</option>
                <option value="void">Void</option>
              </select>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-app-text touch-manipulation rounded-xl border border-app-border bg-app-surface px-3 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-app-border"
                  checked={openOnly}
                  onChange={(e) => setOpenOnly(e.target.checked)}
                />
                Open cards only
              </label>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <p className="py-12 text-center text-sm text-app-text-muted">Loading…</p>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-4">
            <CreditCard className="h-10 w-10 text-app-text-muted" />
            <p className="text-sm text-app-text-muted">No gift cards found.</p>
            <p className="text-xs text-app-text-muted">Use "Issue Purchased" or "Issue Donated" in the sidebar.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Code</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Kind</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Status</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Balance</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Original</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Expires</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Customer</th>
                <th className="pb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/30">
              {cards.map(c => (
                <tr key={c.id} className="group hover:bg-app-accent/5 transition-colors">
                  <td className="py-4 pr-4 font-mono text-xs font-black text-app-accent tracking-tighter">{c.code}</td>
                  <td className="py-4 pr-4">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-widest border ${
                      c.card_kind === "loyalty_reward"
                        ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
                        : c.card_kind === "donated_giveaway"
                          ? "border-purple-500/20 bg-purple-500/10 text-purple-600"
                          : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
                    }`}>
                      {KIND_LABELS[c.card_kind] ?? c.card_kind}
                    </span>
                  </td>
                  <td className="py-4 pr-4">
                    <span className={`ui-pill text-[9px] font-black uppercase tracking-widest ${
                      c.card_status === 'active' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 
                      c.card_status === 'void' ? 'bg-app-danger/10 text-app-danger border border-app-danger/20' :
                      'bg-app-surface-2 text-app-text-muted border border-app-border'
                    }`}>
                      {c.card_status}
                    </span>
                  </td>
                  <td className="py-4 pr-4 font-black tabular-nums text-app-text">{fmt(c.current_balance)}</td>
                  <td className="py-4 pr-4 font-bold tabular-nums text-app-text-muted opacity-60">{fmt(c.original_value)}</td>
                  <td className="py-4 pr-4 text-xs font-bold text-app-text-muted whitespace-nowrap">{fmtDate(c.expires_at)}</td>
                  <td className="py-4 pr-4 text-xs font-bold text-app-text truncate max-w-[120px]">{c.customer_name ?? "—"}</td>
                  <td className="py-4 text-right">
                    {c.card_status === "active" && (
                      <button
                        onClick={() => initiateVoid(c.id)}
                        disabled={voidingId === c.id}
                        className="rounded-lg p-2 text-app-text-muted hover:bg-app-danger/10 hover:text-app-danger transition-all opacity-0 group-hover:opacity-100"
                        title="Void card"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
        </div>
      </div>

      {showVoidConfirm && (
        <ConfirmationModal
          isOpen={true}
          title="Void Gift Card?"
          message="Are you sure you want to void this gift card? This action is permanent and cannot be undone."
          confirmLabel="Void Card"
          onConfirm={executeVoid}
          onClose={() => setShowVoidConfirm(null)}
          variant="danger"
        />
      )}
    </div>
  );
}
