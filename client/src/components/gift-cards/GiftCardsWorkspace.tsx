import { useEffect, useState } from "react";
import { CreditCard, Gift, RefreshCw, X } from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import ConfirmationModal from "../ui/ConfirmationModal";
import { centsToFixed2, formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
  const [loading, setLoading] = useState(false);
  const [filterKind, setFilterKind] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");
  /** Matches POS “open” list: positive balance, not expired. */
  const [openOnly, setOpenOnly] = useState(true);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [showVoidConfirm, setShowVoidConfirm] = useState<string | null>(null);
  const { toast } = useToast();

  const load = async () => {
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
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [filterKind, filterStatus, openOnly, backofficeHeaders]);

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
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100">
              <Gift className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-app-text">Gift Cards</h1>
              <p className="text-xs text-app-text-muted">
                {cards.length} cards shown
                {openOnly && filterStatus === "active"
                  ? " · open only (usable balance, not expired), newest activity first — uncheck to include depleted / expired rows"
                  : ""}
              </p>
            </div>
          </div>
          <button onClick={load} className="ui-btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
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
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-app-text touch-manipulation">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-app-border"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
            />
            Open cards only (POS parity)
          </label>
        </div>
      </div>

      {/* Table */}
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
                  <td className="py-4 pr-4 text-xs font-bold text-app-text-muted">
                    {KIND_LABELS[c.card_kind] ?? c.card_kind}
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
