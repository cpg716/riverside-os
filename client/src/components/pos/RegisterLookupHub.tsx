import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import {
  Search,
  CreditCard,
  User,
  Loader2,
  AlertCircle,
  History,
  RefreshCw,
  TrendingUp,
  Star,
} from "lucide-react";
import { LoyaltyRedeemDialog } from "../loyalty/LoyaltyRedeemDialog";
import {
  loyaltyEligibleDisplayName,
  type LoyaltyEligibleCustomer,
} from "../loyalty/LoyaltyLogic";

interface CustomerRecord {
  selected_customer_id: string;
  selected_customer_name: string;
  effective_customer_id: string;
  effective_customer_name: string;
  loyalty_points: number;
  shared_with_linked_customer: boolean;
}

interface CustomerSearchHit {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
}

interface OpenGiftCardRow {
  id: string;
  code: string;
  card_kind: string;
  card_status: string;
  current_balance: string;
  expires_at: string | null;
  customer_name: string | null;
}

interface GiftCardLookupDetail extends OpenGiftCardRow {
  original_value: string | null;
  is_liability: boolean;
  notes: string | null;
  created_at: string;
}

interface GiftCardEventRow {
  id: string;
  event_kind: string;
  amount: string;
  balance_after: string;
  order_id: string | null;
  notes: string | null;
  created_at: string;
}

interface LoyaltySummary {
  loyalty_point_threshold: number;
  loyalty_reward_amount: string | number;
  points_per_dollar: number;
}

interface LoyaltyLedgerEntry {
  id: string;
  delta_points: number;
  balance_after: number;
  reason: string;
  transaction_id: string | null;
  transaction_display_id?: string | null;
  created_at: string;
  activity_label: string;
  activity_detail: string;
}

const LOYALTY_SEARCH_LIMIT = 50;

const KIND_LABELS: Record<string, string> = {
  purchased: "Purchased",
  loyalty_reward: "Loyalty",
  donated_giveaway: "Donated",
};

const EVENT_LABELS: Record<string, string> = {
  issued: "Issued",
  loaded: "Loaded",
  redeemed: "Used at checkout",
  refunded: "Refunded to card",
  voided: "Voided",
};

function giftCardEventLabel(eventKind: string): string {
  return EVENT_LABELS[eventKind] ?? eventKind.replaceAll("_", " ");
}

function loyaltyInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

async function fetchCustomerForLoyaltyLookup(
  baseUrl: string,
  id: string,
  headers: Record<string, string>,
): Promise<CustomerRecord> {
  const res = await fetch(`${baseUrl}/api/loyalty/customer-summary?customer_id=${id}`, {
    headers,
  });
  if (!res.ok) throw new Error("Could not load loyalty customer summary");
  const p = (await res.json()) as {
    selected_customer_id: string;
    selected_customer_name: string;
    effective_customer_id: string;
    effective_customer_name: string;
    loyalty_points: number;
    shared_with_linked_customer: boolean;
  };
  return {
    selected_customer_id: p.selected_customer_id,
    selected_customer_name: p.selected_customer_name,
    effective_customer_id: p.effective_customer_id,
    effective_customer_name: p.effective_customer_name,
    loyalty_points: p.loyalty_points,
    shared_with_linked_customer: p.shared_with_linked_customer,
  };
}

async function fetchLoyaltyLedgerForLookup(
  baseUrl: string,
  customerId: string,
  headers: Record<string, string>,
): Promise<LoyaltyLedgerEntry[]> {
  const res = await fetch(`${baseUrl}/api/loyalty/ledger?customer_id=${customerId}`, { headers });
  if (!res.ok) throw new Error("Could not load loyalty activity");
  return (await res.json()) as LoyaltyLedgerEntry[];
}

export interface RegisterLookupHubProps {
  initialTab?: "giftcard" | "loyalty";
  registerSessionId?: string | null;
}

export default function RegisterLookupHub({
  initialTab = "giftcard",
  registerSessionId = null,
}: RegisterLookupHubProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders) as Record<string, string>,
    [backofficeHeaders],
  );
  const [tab, setTab] = useState<"giftcard" | "loyalty">(initialTab);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [customerPickList, setCustomerPickList] = useState<CustomerSearchHit[] | null>(null);
  const [pickListLoadingMore, setPickListLoadingMore] = useState(false);
  const [giftDetail, setGiftDetail] = useState<GiftCardLookupDetail | null>(null);
  const [giftEvents, setGiftEvents] = useState<GiftCardEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCards, setOpenCards] = useState<OpenGiftCardRow[]>([]);
  const [openLoading, setOpenLoading] = useState(false);
  const [eligible, setEligible] = useState<LoyaltyEligibleCustomer[]>([]);
  const [loyaltySummary, setLoyaltySummary] = useState<LoyaltySummary | null>(null);
  const [loyaltyLedger, setLoyaltyLedger] = useState<LoyaltyLedgerEntry[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [redeemCustomer, setRedeemCustomer] = useState<LoyaltyEligibleCustomer | null>(null);

  const baseUrl = getBaseUrl();

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const loadOpenGiftCards = useCallback(async () => {
    setOpenLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/gift-cards/open`, {
        headers: apiAuth(),
      });
      if (res.ok) setOpenCards((await res.json()) as OpenGiftCardRow[]);
    } finally {
      setOpenLoading(false);
    }
  }, [apiAuth, baseUrl]);

  const loadEligible = useCallback(async () => {
    setEligibleLoading(true);
    try {
      const h = apiAuth();
      const [elRes, sumRes] = await Promise.all([
        fetch(`${baseUrl}/api/loyalty/monthly-eligible`, { headers: h }),
        fetch(`${baseUrl}/api/loyalty/program-summary`, { headers: h }),
      ]);
      if (elRes.ok) setEligible((await elRes.json()) as LoyaltyEligibleCustomer[]);
      if (sumRes.ok) setLoyaltySummary((await sumRes.json()) as LoyaltySummary);
    } finally {
      setEligibleLoading(false);
    }
  }, [apiAuth, baseUrl]);

  useEffect(() => {
    if (tab === "giftcard") void loadOpenGiftCards();
  }, [tab, loadOpenGiftCards]);

  useEffect(() => {
    if (tab === "loyalty") void loadEligible();
  }, [tab, loadEligible]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setCustomer(null);
    setCustomerPickList(null);
    setGiftDetail(null);
    setGiftEvents(null);
    setLoyaltyLedger([]);
 try {
      if (tab === "giftcard") {
        const code = query.trim();
        const res = await fetch(
          `${baseUrl}/api/gift-cards/code/${encodeURIComponent(code)}`,
          { headers: apiAuth() },
        );
        if (!res.ok) throw new Error("Gift card not found");
        const data = (await res.json()) as GiftCardLookupDetail;
        setGiftDetail(data);
        const evRes = await fetch(
          `${baseUrl}/api/gift-cards/code/${encodeURIComponent(code)}/events`,
          { headers: apiAuth() },
        );
        if (evRes.ok) setGiftEvents((await evRes.json()) as GiftCardEventRow[]);
        else setGiftEvents([]);
      } else {
        const res = await fetch(
          `${baseUrl}/api/customers/search?q=${encodeURIComponent(query.trim())}&limit=${LOYALTY_SEARCH_LIMIT}&offset=0`,
          { headers: apiAuth() },
        );
        if (!res.ok) throw new Error("Lookup failed");
        const list = (await res.json()) as CustomerSearchHit[];
        if (!Array.isArray(list) || list.length === 0) {
          throw new Error("No customer matches that query");
        }
        if (list.length === 1) {
          const selectedCustomer = await fetchCustomerForLoyaltyLookup(baseUrl, list[0]!.id, apiAuth());
          setCustomer(selectedCustomer);
          setLoyaltyLedger(
            await fetchLoyaltyLedgerForLookup(
              baseUrl,
              selectedCustomer.selected_customer_id,
              apiAuth(),
            ),
          );
        } else {
          setCustomerPickList(list);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  };

  const giftOpen =
    giftDetail != null &&
    giftDetail.card_status === "active" &&
    parseMoneyToCents(giftDetail.current_balance) > 0 &&
    (!giftDetail.expires_at || new Date(giftDetail.expires_at) > new Date());

  return (
    <div className="flex flex-1 flex-col bg-app-surface">
      <div className="shrink-0 border-b border-app-border px-4 py-4 sm:px-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black tracking-tight text-app-text sm:text-xl">
              {tab === "giftcard" ? "Gift cards" : "Loyalty"}
            </h2>
            <p className="text-[11px] text-app-text-muted sm:text-xs">
              {tab === "giftcard"
                ? "Open cards (usable balance) and quick scan for balance plus full activity history."
                : "Customers at reward threshold — redeem issues a loyalty reward card, and the activity list shows recent earns, reward issues, and clawbacks. Adjust points and donated cards are Back Office only."}
            </p>
          </div>
          <div className="flex gap-1 rounded-xl bg-app-surface-2 p-1">
            <button
              type="button"
              onClick={() => {
                setTab("giftcard");
                setCustomerPickList(null);
                setError(null);
              }}
              className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wide transition-all touch-manipulation sm:flex-none sm:px-4 sm:text-xs ${
                tab === "giftcard"
                  ? "bg-app-surface text-app-accent shadow-sm"
                  : "text-app-text-muted hover:text-app-text"
              }`}
            >
              <CreditCard className="h-4 w-4 shrink-0" />
              Gift cards
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("loyalty");
                setCustomerPickList(null);
                setError(null);
              }}
              className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wide transition-all touch-manipulation sm:flex-none sm:px-4 sm:text-xs ${
                tab === "loyalty"
                  ? "bg-app-surface text-app-accent shadow-sm"
                  : "text-app-text-muted hover:text-app-text"
              }`}
            >
              <Star className="h-4 w-4 shrink-0" />
              Loyalty
            </button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="relative mx-auto w-full max-w-2xl">
          <div className="group relative">
            <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === "giftcard"
                  ? "Quick scan: gift card code for balance & history…"
                  : "Search customer name, phone, or email…"
              }
              className="ui-input h-12 w-full rounded-2xl bg-app-surface-2 pl-12 pr-24 text-base font-bold shadow-inner focus:bg-app-surface sm:h-14 sm:text-lg"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="absolute right-2 top-1/2 min-h-10 -translate-y-1/2 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-wide text-white shadow-lg active:scale-95 disabled:bg-app-surface-2 disabled:text-app-text-muted disabled:shadow-none touch-manipulation"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Find"}
            </button>
          </div>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        {tab === "giftcard" && (
          <div className="mb-8">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Open gift cards (newest activity first)
              </h3>
              <button
                type="button"
                onClick={() => void loadOpenGiftCards()}
                className="ui-btn-secondary flex items-center gap-1.5 px-2 py-1.5 text-[10px]"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${openLoading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            {openLoading ? (
              <p className="py-8 text-center text-sm text-app-text-muted">Loading…</p>
            ) : openCards.length === 0 ? (
              <p className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-6 text-center text-sm text-app-text-muted">
                No open gift cards (zero balance, void, or expired cards are hidden — scan a code
                to view history).
              </p>
            ) : (
              <div>
                <div className="space-y-2.5 sm:hidden">
                  {openCards.map((r) => (
                    <article
                      key={r.id}
                      className="rounded-xl border border-app-border bg-app-surface p-3 shadow-sm"
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <p className="font-mono text-xs font-black text-app-accent">{r.code}</p>
                        <p className="text-lg font-black tabular-nums text-app-text">
                          ${centsToFixed2(parseMoneyToCents(r.current_balance))}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px] text-app-text-muted">
                        <p>
                          <span className="font-black uppercase tracking-wide text-app-text">Kind:</span>{" "}
                          {KIND_LABELS[r.card_kind] ?? r.card_kind}
                        </p>
                        <p className="text-right">
                          <span className="font-black uppercase tracking-wide text-app-text">Expires:</span>{" "}
                          {r.expires_at ? new Date(r.expires_at).toLocaleDateString() : "—"}
                        </p>
                        <p className="col-span-2 truncate">
                          <span className="font-black uppercase tracking-wide text-app-text">
                            Tracked:
                          </span>{" "}
                          {r.card_kind === "purchased" ? "—" : (r.customer_name ?? "—")}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-xl border border-app-border sm:block">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-app-border bg-app-surface-2">
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Code
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Kind
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Balance
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Expires
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Tracked to
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border/40">
                      {openCards.map((r) => (
                        <tr key={r.id} className="hover:bg-app-accent/5">
                          <td className="px-3 py-2 font-mono text-xs font-black text-app-accent">
                            {r.code}
                          </td>
                          <td className="px-3 py-2 text-xs font-semibold text-app-text-muted">
                            {KIND_LABELS[r.card_kind] ?? r.card_kind}
                          </td>
                          <td className="px-3 py-2 font-black tabular-nums text-app-text">
                            ${centsToFixed2(parseMoneyToCents(r.current_balance))}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-xs text-app-text-muted">
                            {r.expires_at ? new Date(r.expires_at).toLocaleDateString() : "—"}
                          </td>
                          <td className="max-w-[140px] truncate px-3 py-2 text-xs text-app-text-muted">
                            {r.card_kind === "purchased" ? "—" : (r.customer_name ?? "—")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <p className="mt-2 text-[10px] leading-snug text-app-text-muted">
              Purchased cards are not tied to a customer. Loyalty and donated cards show the CRM
              contact they are tracked to. Scan any code above for balance and full historical
              events (loads, checkouts, refills).
            </p>
          </div>
        )}

        {tab === "loyalty" && (
          <div className="mb-8">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                At or above threshold (reward due)
              </h3>
              <button
                type="button"
                onClick={() => void loadEligible()}
                className="ui-btn-secondary flex items-center gap-1.5 px-2 py-1.5 text-[10px]"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${eligibleLoading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            {loyaltySummary && (
              <p className="mb-3 rounded-xl border border-amber-200/50 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-app-text">
                Program: {loyaltySummary.loyalty_point_threshold.toLocaleString()} pts → $
                {loyaltySummary.loyalty_reward_amount} reward
                <span className="font-normal text-app-text-muted">
                  {" "}
                  · scan card at redeem to mark loyalty gift with 1yr expiry · points deducted on
                  redeem
                </span>
              </p>
            )}
            {eligibleLoading ? (
              <p className="py-8 text-center text-sm text-app-text-muted">Loading…</p>
            ) : eligible.length === 0 ? (
              <p className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-6 text-center text-sm text-app-text-muted">
                No customers are at the threshold yet.
              </p>
            ) : (
              <div>
                <div className="space-y-2.5 sm:hidden">
                  {eligible.map((c) => (
                    <article
                      key={c.id}
                      className="rounded-xl border border-app-border bg-app-surface p-3 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold text-app-text">{loyaltyEligibleDisplayName(c)}</p>
                          <p className="text-xs text-app-text-muted">{c.phone ?? "No phone on file"}</p>
                        </div>
                        <p className="text-right text-lg font-black tabular-nums text-app-accent">
                          {c.loyalty_points.toLocaleString()}
                          <span className="ml-1 text-[10px] font-bold uppercase text-app-text-muted">
                            pts
                          </span>
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!loyaltySummary}
                        onClick={() => setRedeemCustomer(c)}
                        className="mt-3 w-full rounded-lg border border-emerald-600/30 bg-emerald-600/15 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-emerald-800 dark:text-emerald-200 disabled:opacity-50 touch-manipulation"
                      >
                        Redeem
                      </button>
                    </article>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-xl border border-app-border sm:block">
                  <table className="w-full min-w-[480px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-app-border bg-app-surface-2">
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Name
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Points
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          Phone
                        </th>
                        <th className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border/40">
                      {eligible.map((c) => (
                        <tr key={c.id} className="hover:bg-app-accent/5">
                          <td className="px-3 py-2 font-bold text-app-text">{loyaltyEligibleDisplayName(c)}</td>
                          <td className="px-3 py-2 font-black tabular-nums text-app-accent">
                            {c.loyalty_points.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-xs text-app-text-muted">{c.phone ?? "—"}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              disabled={!loyaltySummary}
                              onClick={() => setRedeemCustomer(c)}
                              className="rounded-lg border border-emerald-600/30 bg-emerald-600/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-emerald-800 dark:text-emerald-200 disabled:opacity-50 touch-manipulation"
                            >
                              Redeem
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <p className="mt-2 text-[10px] text-app-text-muted">
              Point adjustments and issuing donated cards stay in Back Office. POS lookup is for balance and recent loyalty activity only.
            </p>
          </div>
        )}

        {error ? (
          <div className="flex animate-in fade-in flex-col items-center justify-center p-8 text-center">
            <div className="mb-4 rounded-full bg-red-100 p-4 text-red-600 dark:bg-red-950/40 dark:text-red-300">
              <AlertCircle className="h-8 w-8" />
            </div>
            <p className="text-lg font-black text-app-text">{error}</p>
            <p className="mt-2 text-sm text-app-text-muted">Check the entry and try again.</p>
          </div>
        ) : !loading && customerPickList && customerPickList.length > 0 ? (
          <div className="mx-auto w-full max-w-2xl animate-in fade-in space-y-3">
            <p className="text-center text-sm font-bold text-app-text">
              Multiple customers match — pick one
            </p>
            <ul className="space-y-2 rounded-2xl border border-app-border bg-app-surface p-3 sm:max-h-[min(60vh,24rem)] sm:overflow-y-auto">
              {customerPickList.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        setLoading(true);
                        setError(null);
                        try {
                          const c = await fetchCustomerForLoyaltyLookup(baseUrl, h.id, apiAuth());
                          setCustomer(c);
                          setLoyaltyLedger(
                            await fetchLoyaltyLedgerForLookup(
                              baseUrl,
                              c.selected_customer_id,
                              apiAuth(),
                            ),
                          );
                          setCustomerPickList(null);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Lookup failed");
                        } finally {
                          setLoading(false);
                        }
                      })();
                    }}
                    className="flex w-full flex-col items-start rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-left transition-colors hover:border-app-accent hover:bg-app-surface touch-manipulation"
                  >
                    <span className="font-black text-app-text">
                      {h.first_name} {h.last_name}
                    </span>
                    <span className="text-xs text-app-text-muted">
                      {h.phone ?? "No phone"} · {h.id.slice(0, 8)}…
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {customerPickList.length >= LOYALTY_SEARCH_LIMIT ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  disabled={pickListLoadingMore}
                  onClick={() => {
                    void (async () => {
                      setPickListLoadingMore(true);
                      setError(null);
                      try {
                        const res = await fetch(
                          `${baseUrl}/api/customers/search?q=${encodeURIComponent(query.trim())}&limit=${LOYALTY_SEARCH_LIMIT}&offset=${customerPickList.length}`,
                          { headers: apiAuth() },
                        );
                        if (!res.ok) return;
                        const next = (await res.json()) as CustomerSearchHit[];
                        const seen = new Set(customerPickList.map((x) => x.id));
                        const merged = [
                          ...customerPickList,
                          ...next.filter((x) => !seen.has(x.id)),
                        ];
                        setCustomerPickList(merged);
                      } finally {
                        setPickListLoadingMore(false);
                      }
                    })();
                  }}
                  className="rounded-xl border border-app-border px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 disabled:opacity-50"
                >
                  {pickListLoadingMore ? "Loading…" : "Load more matches"}
                </button>
              </div>
            ) : null}
          </div>
        ) : !loading && !customer && !giftDetail && !error ? (
          <div className="flex animate-in fade-in flex-col items-center justify-center p-12 text-center text-app-text-muted opacity-50">
            {tab === "giftcard" ? (
              <CreditCard className="h-20 w-20 sm:h-24 sm:w-24" />
            ) : (
              <User className="h-20 w-20 sm:h-24 sm:w-24" />
            )}
            <p className="mt-4 text-base font-bold">Scan or search</p>
          </div>
        ) : null}

        {giftDetail && (
          <div className="animate-in fade-in mx-auto max-w-3xl space-y-4 pb-8">
            <div className="ui-card overflow-hidden rounded-3xl border-2 border-app-accent/10 bg-gradient-to-br from-app-surface to-app-surface-2 p-6 shadow-xl sm:p-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Gift card
                  </p>
                  <p className="font-mono text-2xl font-black tracking-tighter text-app-text sm:text-3xl">
                    {giftDetail.code}
                  </p>
                  <p className="mt-1 text-xs font-bold text-app-text-muted">
                    {KIND_LABELS[giftDetail.card_kind] ?? giftDetail.card_kind}
                    {giftDetail.customer_name && giftDetail.card_kind !== "purchased"
                      ? ` · tracked: ${giftDetail.customer_name}`
                      : null}
                  </p>
                  <p
                    className={`mt-2 inline-flex rounded-full px-3 py-1 text-[10px] font-black uppercase ${
                      giftOpen ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-app-surface-2 text-app-text-muted"
                    }`}
                  >
                    {giftOpen ? "Open / usable" : "Not in open list (depleted, void, or expired)"}
                  </p>
                </div>
                <div className="text-left sm:text-right">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Balance
                  </p>
                  <p className="text-4xl font-black tabular-nums text-app-accent sm:text-5xl">
                    ${centsToFixed2(parseMoneyToCents(giftDetail.current_balance))}
                  </p>
                  {giftDetail.expires_at && (
                    <p className="mt-1 text-xs text-app-text-muted">
                      Expires {new Date(giftDetail.expires_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {giftEvents && giftEvents.length > 0 && (
              <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                <h3 className="mb-3 flex items-center gap-2 px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  <History className="h-4 w-4" />
                  Historical activity
                </h3>
                <ul className="space-y-2 sm:max-h-[min(50vh,22rem)] sm:overflow-y-auto">
                  {giftEvents.map((h) => (
                    <li
                      key={h.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-app-surface px-4 py-3 shadow-sm"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-app-text">
                          {giftCardEventLabel(h.event_kind)}
                        </p>
                        <p className="text-[10px] text-app-text-muted">
                          {new Date(h.created_at).toLocaleString()}
                          {h.order_id ? ` · order ${h.order_id.slice(0, 8)}…` : ""}
                        </p>
                      </div>
                      <div className="shrink-0 text-sm font-black tabular-nums text-app-text">
                        {parseMoneyToCents(h.amount) < 0 ? "" : "+"}$
                        {centsToFixed2(Math.abs(parseMoneyToCents(h.amount)))}{" "}
                        <span className="text-[10px] font-semibold text-app-text-muted">
                          → ${centsToFixed2(parseMoneyToCents(h.balance_after))}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {customer && tab === "loyalty" && (
          <div className="animate-in fade-in mx-auto max-w-3xl space-y-6 pb-8">
            <div className="ui-card overflow-hidden rounded-3xl border-2 border-app-accent/25 bg-app-surface p-6 shadow-xl sm:p-8">
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-app-accent text-2xl font-black text-white shadow-lg sm:h-20 sm:w-20 sm:text-3xl">
                    {loyaltyInitials(customer.selected_customer_name)}
                  </div>
                  <div>
                    <h3 className="text-2xl font-black tracking-tight text-app-text sm:text-3xl">
                      {customer.selected_customer_name}
                    </h3>
                    <p className="font-semibold text-app-text-muted">
                      {customer.shared_with_linked_customer
                        ? `Shared loyalty with ${customer.effective_customer_name}`
                        : "Loyalty balance"}
                    </p>
                  </div>
                </div>
                <div className="text-left sm:text-right">
                  <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Loyalty balance
                  </p>
                  <div className="inline-flex items-center gap-2 rounded-2xl border border-app-accent/25 bg-app-accent/10 px-5 py-3">
                    <TrendingUp className="h-6 w-6 text-app-accent" />
                    <span className="text-3xl font-black tabular-nums text-app-accent sm:text-4xl">
                      {(customer.loyalty_points ?? 0).toLocaleString()}
                    </span>
                    <span className="text-[10px] font-black text-app-accent/80">pts</span>
                  </div>
                </div>
              </div>
            </div>

            {customer.shared_with_linked_customer ? (
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[11px] font-semibold text-app-text">
                This customer is linked in a couple. Loyalty points, reward cards, and clawbacks
                follow the primary loyalty account for {customer.effective_customer_name}.
              </div>
            ) : null}

            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
              <h3 className="mb-3 flex items-center gap-2 px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <History className="h-4 w-4" />
                Recent loyalty activity
              </h3>
              {loyaltyLedger.length === 0 ? (
                <p className="rounded-xl bg-app-surface px-4 py-5 text-sm text-app-text-muted">
                  No loyalty activity found for this customer yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {loyaltyLedger.slice(0, 6).map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-app-surface px-4 py-3 shadow-sm"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-app-text">{entry.activity_label}</p>
                        <p className="text-[10px] text-app-text-muted">{entry.activity_detail}</p>
                        <p className="text-[10px] text-app-text-muted">
                          {new Date(entry.created_at).toLocaleString()}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={`text-sm font-black tabular-nums ${
                            entry.delta_points > 0 ? "text-emerald-600" : "text-red-500"
                          }`}
                        >
                          {entry.delta_points > 0 ? "+" : ""}
                          {entry.delta_points.toLocaleString()} pts
                        </p>
                        <p className="text-[10px] font-semibold text-app-text-muted">
                          Balance {entry.balance_after.toLocaleString()}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {loyaltySummary && (
        <LoyaltyRedeemDialog
          isOpen={redeemCustomer !== null}
          customer={redeemCustomer}
          rewardAmountRaw={loyaltySummary.loyalty_reward_amount}
          pointThreshold={loyaltySummary.loyalty_point_threshold}
          getAuthHeaders={() => mergedPosStaffHeaders(backofficeHeaders)}
          registerSessionId={registerSessionId}
          onClose={() => setRedeemCustomer(null)}
          onSuccess={() => {
            void loadEligible();
            setRedeemCustomer(null);
          }}
        />
      )}
    </div>
  );
}
