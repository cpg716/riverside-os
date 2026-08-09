import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, Gift, RefreshCw, X, TrendingUp, Wallet, BadgeDollarSign, Megaphone, ScanLine } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import { centsToFixed2, formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

const BASE = getBaseUrl();
const GIFT_CARD_PAGE_SIZE = 100;

function summaryValueSize(value: string): string {
  if (value.length >= 10) return "text-[1.2rem] sm:text-[1.4rem] xl:text-[1.6rem]";
  if (value.length >= 7) return "text-[1.5rem] sm:text-[1.7rem] xl:text-[1.9rem]";
  return "text-[2rem]";
}

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
  promo_event_name: string | null;
  notes: string | null;
  created_at: string;
}

interface GiftCardSummary {
  open_cards_count: number;
  active_liability_balance: string;
  loyalty_cards_count: number;
  donated_cards_count: number;
  promo_cards_count: number;
}

interface GiftCardListPage {
  items: GiftCardRow[];
  total: number;
  limit: number;
  offset: number;
}

interface GiftCardEventRow {
  id: string;
  event_kind: string;
  amount: string;
  balance_after: string;
  transaction_id: string | null;
  staff_id: string | null;
  staff_name: string | null;
  notes: string | null;
  created_at: string;
}

const KIND_LABELS: Record<string, string> = {
  purchased: "Sold / Purchased",
  loyalty_reward: "Loyalty",
  donated_giveaway: "Donated",
  promo_gift_card: "Promo",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  depleted: "Depleted",
  expired: "Expired",
  void: "Void",
};

const EVENT_LABELS: Record<string, string> = {
  issued: "Issued",
  loaded: "Loaded",
  redeemed: "Used at checkout",
  refunded: "Refunded to card",
  voided: "Voided",
};

function fmt(v: string | null | undefined): string {
  if (v == null) return "—";
  return formatUsdFromCents(parseMoneyToCents(v));
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function fmtDateTime(s: string): string {
  return new Date(s).toLocaleString();
}

function giftCardEventLabel(eventKind: string): string {
  return EVENT_LABELS[eventKind] ?? eventKind.replaceAll("_", " ");
}

function giftCardDisplayStatus(card: GiftCardRow): string {
  const expiresAt = card.expires_at ? Date.parse(card.expires_at) : Number.NaN;
  if (card.card_status === "active" && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    return "expired";
  }
  return card.card_status;
}

interface SelectedCardPanelProps {
  selectedCard: GiftCardRow | null;
  selectedEvents: GiftCardEventRow[];
  eventsLoading: boolean;
  isSmallScreen: boolean;
}

function SelectedCardPanel({
  selectedCard,
  selectedEvents,
  eventsLoading,
  isSmallScreen,
}: SelectedCardPanelProps) {
  if (!selectedCard) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-app-border bg-app-surface px-4 py-12 text-center text-sm text-app-text-muted">
        Select a gift card to view balance details and recent activity.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Selected card
        </p>
        <p className="mt-1 font-mono text-lg font-black tracking-tight text-app-accent">
          {selectedCard.code}
        </p>
        <p className="mt-1 text-xs font-semibold text-app-text-muted">
          {KIND_LABELS[selectedCard.card_kind] ?? selectedCard.card_kind}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-2xl border border-app-border bg-app-surface px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Balance</p>
          <p className="mt-1 text-lg font-black tabular-nums text-app-text">{fmt(selectedCard.current_balance)}</p>
        </div>
        <div className="rounded-2xl border border-app-border bg-app-surface px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Original</p>
          <p className="mt-1 text-lg font-black tabular-nums text-app-text">{fmt(selectedCard.original_value)}</p>
        </div>
      </div>

      <div className="grid gap-2 text-xs text-app-text">
        <div className="flex items-start justify-between gap-3 rounded-2xl border border-app-border bg-app-surface px-3 py-2">
          <span className="font-black uppercase tracking-widest text-[10px] text-app-text-muted">Status</span>
          <span className="font-bold">
            {STATUS_LABELS[giftCardDisplayStatus(selectedCard)] ?? giftCardDisplayStatus(selectedCard)}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-2xl border border-app-border bg-app-surface px-3 py-2">
          <span className="font-black uppercase tracking-widest text-[10px] text-app-text-muted">Expires</span>
          <span className="font-bold">{fmtDate(selectedCard.expires_at)}</span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-2xl border border-app-border bg-app-surface px-3 py-2">
          <span className="font-black uppercase tracking-widest text-[10px] text-app-text-muted">Tracked to</span>
          <span className="font-bold text-right">{selectedCard.customer_name ?? "—"}</span>
        </div>
        {selectedCard.promo_event_name ? (
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-app-border bg-app-surface px-3 py-2">
            <span className="font-black uppercase tracking-widest text-[10px] text-app-text-muted">Event</span>
            <span className="font-bold text-right">{selectedCard.promo_event_name}</span>
          </div>
        ) : null}
      </div>

      {selectedCard.notes ? (
        <div className="rounded-2xl border border-app-border bg-app-surface px-3 py-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Notes</p>
          <p className="mt-1 text-xs font-semibold text-app-text">{selectedCard.notes}</p>
        </div>
      ) : null}

      <div className="rounded-2xl border border-app-border bg-app-surface px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Recent activity
          </p>
          {eventsLoading ? (
            <span className="text-[10px] font-semibold text-app-text-muted">Loading…</span>
          ) : null}
        </div>
        {selectedEvents.length === 0 ? (
          <p className="text-xs text-app-text-muted">
            No activity has been recorded for this card yet.
          </p>
        ) : (
          <ul className={isSmallScreen ? "space-y-2" : "max-h-[24rem] space-y-2 overflow-y-auto pr-1"}>
            {selectedEvents.map((event) => (
              <li
                key={event.id}
                className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-black text-app-text">
                      {giftCardEventLabel(event.event_kind)}
                    </p>
                    <p className="mt-1 text-[10px] text-app-text-muted">
                      {fmtDateTime(event.created_at)}
                      {event.transaction_id ? ` · sale ${event.transaction_id.slice(0, 8)}…` : ""}
                      {event.staff_name ? ` · ${event.staff_name}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-black tabular-nums text-app-text">
                      {parseMoneyToCents(event.amount) < 0 ? "-" : "+"}
                      {fmt(event.amount)}
                    </p>
                    <p className="text-[10px] font-semibold text-app-text-muted">
                      Balance {fmt(event.balance_after)}
                    </p>
                  </div>
                </div>
                {event.notes ? (
                  <p className="mt-2 text-[10px] text-app-text-muted">{event.notes}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface IssueFormProps {
  mode: "donated" | "promo";
  onDone: () => void;
}

function IssueForm({ mode, onDone }: IssueFormProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [eventName, setEventName] = useState("");
  const [notes, setNotes] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerLabel, setCustomerLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();
  const isPromo = mode === "promo";

  const submit = async () => {
    setErr(null);
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) { setErr("Card code is required."); return; }
    if (isPromo && !eventName.trim()) { setErr("Event name is required."); return; }
    const amtCents = parseMoneyToCents(amount);
    if (amtCents <= 0) { setErr("Enter a positive amount."); return; }
    if (!isPromo && notes.trim().length < 12) {
      setErr("Enter the approval or donation reason (at least 12 characters).");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/gift-cards/${isPromo ? "issue-promo" : "issue-donated"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(backofficeHeaders() as Record<string, string>) },
        body: JSON.stringify({
          code: normalizedCode,
          amount: centsToFixed2(amtCents),
          ...(isPromo ? { event_name: eventName.trim() } : {}),
          notes: notes.trim() || undefined,
          customer_id: customerId,
        }),
      });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        throw new Error(b.error ?? "Failed to issue card");
      }
      const issuedCard = (await res.json()) as GiftCardRow;
      const expectedKind = isPromo ? "promo_gift_card" : "donated_giveaway";
      if (issuedCard.card_kind !== expectedKind || issuedCard.is_liability) {
        throw new Error("The issued card did not retain its required financial classification.");
      }
      const expiresAt = issuedCard.expires_at ? new Date(issuedCard.expires_at) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        throw new Error("The server did not return the saved gift-card expiration.");
      }
      const expiresOn = expiresAt.toLocaleDateString();
      toast(
        `${isPromo ? "Promo" : "Donated"} gift card ${normalizedCode} issued · expires ${expiresOn}.`,
        "success",
      );
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
        {isPromo ? "Issue Promo Gift Card" : "Issue Donated / Giveaway Card"}
      </h3>
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Card code</span>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Scan or type…" className="ui-input mt-1 w-full" />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Amount ($)</span>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      {isPromo ? (
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">Event name</span>
          <input value={eventName} onChange={e => setEventName(e.target.value)} placeholder="Event or giveaway name" className="ui-input mt-1 w-full" />
        </label>
      ) : null}
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
        <span className="text-xs font-bold uppercase tracking-wide text-app-text-muted">
          {isPromo ? "Notes (optional)" : "Approval / donation reason"}
        </span>
        <input value={notes} onChange={e => setNotes(e.target.value)} className="ui-input mt-1 w-full" />
      </label>
      <p className="text-xs text-app-text-muted">
        1-year expiry · Store-funded, never purchased-card liability · Expense recognized when redeemed.
      </p>
      <button onClick={submit} disabled={busy} className="ui-btn-primary w-full">
        {busy ? "Issuing…" : "Issue card"}
      </button>
    </div>
  );
}

export default function GiftCardsWorkspace({
  activeSection,
  surface = "backoffice",
}: {
  activeSection: string;
  surface?: "backoffice" | "pos";
}) {
  const posSurface = surface === "pos";
  const { backofficeHeaders } = useBackofficeAuth();
  const [cards, setCards] = useState<GiftCardRow[]>([]);
  const [summary, setSummary] = useState<GiftCardSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [filterKind, setFilterKind] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");
  /** Matches POS “open” list: positive balance, not expired. */
  const [openOnly, setOpenOnly] = useState(true);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [showVoidConfirm, setShowVoidConfirm] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [scannedCard, setScannedCard] = useState<GiftCardRow | null>(null);
  const [scanCode, setScanCode] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<GiftCardEventRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const { toast } = useToast();
  const isSmallScreen = useMediaQuery("(max-width: 1023px)");

  const stats = useMemo(() => ({
    openCount: summary?.open_cards_count ?? 0,
    liabilityLabel: summary ? fmt(summary.active_liability_balance) : fmt("0"),
    loyaltyCount: summary?.loyalty_cards_count ?? 0,
    donatedCount: summary?.donated_cards_count ?? 0,
    promoCount: summary?.promo_cards_count ?? 0,
  }), [summary]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(GIFT_CARD_PAGE_SIZE));
      params.set("offset", String(page * GIFT_CARD_PAGE_SIZE));
      if (filterKind) params.set("kind", filterKind);
      if (filterStatus) params.set("status", filterStatus);
      if (openOnly) {
        params.set("open_only", "true");
        params.set("sort", "recent_activity");
      }
      const res = await fetch(`${BASE}/api/gift-cards/page?${params}`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Gift cards could not be loaded.");
      const data = (await res.json()) as GiftCardListPage;
      setCards(data.items);
      setTotalCount(data.total);
      if (data.total > 0 && data.items.length === 0 && page > 0) {
        setPage(Math.max(0, Math.ceil(data.total / GIFT_CARD_PAGE_SIZE) - 1));
      }
    } catch {
      // Keep workspace mounted during transient API outages.
      setCards([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [filterKind, filterStatus, openOnly, page, backofficeHeaders]);

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

  useEffect(() => {
    if (!selectedCardId) return;
    if (scannedCard?.id === selectedCardId) return;
    if (!cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(null);
    }
  }, [cards, scannedCard, selectedCardId]);

  useEffect(() => {
    if (!selectedCardId) {
      setSelectedEvents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setEventsLoading(true);
      try {
        const res = await fetch(`${BASE}/api/gift-cards/${selectedCardId}/events`, {
          headers: backofficeHeaders(),
        });
        if (!res.ok) throw new Error("Could not load card activity");
        const rows = (await res.json()) as GiftCardEventRow[];
        if (!cancelled) setSelectedEvents(rows);
      } catch {
        if (!cancelled) setSelectedEvents([]);
      } finally {
        if (!cancelled) setEventsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCardId, backofficeHeaders]);

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

  const lookupScannedCard = async () => {
    const code = scanCode.trim().toUpperCase();
    if (!code) {
      toast("Scan or enter a gift card code.", "error");
      return;
    }
    setScanBusy(true);
    try {
      const res = await fetch(`${BASE}/api/gift-cards/code/${encodeURIComponent(code)}`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Gift card not found.");
      const card = (await res.json()) as GiftCardRow;
      setScannedCard(card);
      setSelectedCardId(card.id);
      setScanCode("");
      toast(`Opened gift card ${card.code}.`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gift card lookup failed.", "error");
    } finally {
      setScanBusy(false);
    }
  };

  const selectedCard =
    scannedCard?.id === selectedCardId
      ? scannedCard
      : cards.find((card) => card.id === selectedCardId) ?? null;
  const totalPages = Math.max(1, Math.ceil(totalCount / GIFT_CARD_PAGE_SIZE));
  const firstShown = totalCount === 0 ? 0 : page * GIFT_CARD_PAGE_SIZE + 1;
  const lastShown = Math.min(totalCount, page * GIFT_CARD_PAGE_SIZE + cards.length);

  if (activeSection === "issue-donated" || activeSection === "issue-promo") {
    return (
      <div className="p-6">
        <IssueForm mode={activeSection === "issue-promo" ? "promo" : "donated"} onDone={() => void load()} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-transparent">
      {!posSurface ? <div className="no-scrollbar flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2">
        {[
          {
            label: "Open Cards",
            val: stats.openCount.toLocaleString(),
            icon: CreditCard,
            color: "text-sky-500",
            bg: "bg-sky-500/10",
            border: "border-sky-500/20",
            trend: openOnly ? "Open cards only" : "All visible cards",
          },
          {
            label: "Liability",
            val: stats.liabilityLabel,
            icon: Wallet,
            color: "text-emerald-500",
            bg: "bg-emerald-500/10",
            border: "border-emerald-500/20",
            trend: "Total active balance",
          },
          {
            label: "Loyalty Cards",
            val: stats.loyaltyCount.toLocaleString(),
            icon: Gift,
            color: "text-amber-500",
            bg: "bg-amber-500/10",
            border: "border-amber-500/20",
            trend: "Issued as rewards",
          },
          {
            label: "Donated Cards",
            val: stats.donatedCount.toLocaleString(),
            icon: TrendingUp,
            color: "text-purple-500",
            bg: "bg-purple-500/10",
            border: "border-purple-500/20",
            trend: "Community cards",
          },
          {
            label: "Promo Cards",
            val: stats.promoCount.toLocaleString(),
            icon: Megaphone,
            color: "text-fuchsia-500",
            bg: "bg-fuchsia-500/10",
            border: "border-fuchsia-500/20",
            trend: "Promotional cards",
          },
        ].map((s, idx) => (
          <div key={idx} className={`group relative flex min-w-[210px] flex-1 items-center gap-4 overflow-hidden rounded-[28px] border ${s.border} ${s.bg} p-5 shadow-sm backdrop-blur-3xl transition-transform duration-500 hover:scale-[1.02] sm:min-w-[240px]`}>
            <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity duration-700">
               <s.icon size={80} />
            </div>
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-app-surface/40 shadow-xl dark:bg-black/20 border border-white/20">
              <s.icon size={26} className={s.color} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black uppercase leading-tight tracking-[0.1em] text-app-text-muted">{s.label}</p>
              <p className={`max-w-full whitespace-nowrap font-black leading-none tabular-nums tracking-tight text-app-text ${summaryValueSize(s.val)}`}>{s.val}</p>
              <p className="mt-1 text-[10px] font-bold leading-tight text-app-text-muted">
                {s.trend}
              </p>
            </div>
          </div>
        ))}
      </div> : null}

      <div className="flex flex-1 flex-col p-4 sm:p-6 sm:pt-4 animate-workspace-snap">
        <div className="flex flex-1 flex-col rounded-[24px] border border-app-border bg-app-surface shadow-2xl">
          <div className="border-b border-app-border px-6 py-5 bg-app-surface-2/10 backdrop-blur-md">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20">
                  <BadgeDollarSign className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-base font-black tracking-tight text-app-text">Gift Cards</h1>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted mt-1">
                    Showing {firstShown}–{lastShown} of {totalCount} matching cards
                    {openOnly && filterStatus === "active"
                      ? " · open only · newest activity first"
                      : ""}
                  </p>
                </div>
              </div>
              <button onClick={load} className="group flex w-full items-center justify-center gap-2 rounded-xl border border-app-border/50 bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest shadow-sm transition-all hover:bg-app-surface-2 sm:w-auto">
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-emerald-500" : "text-app-text-muted group-hover:text-emerald-500"}`} />
                Refresh Cards
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <select
                value={filterKind}
                onChange={(event) => {
                  setPage(0);
                  setFilterKind(event.target.value);
                }}
                className="ui-input text-xs px-2 py-1.5"
              >
                <option value="">All kinds</option>
                <option value="purchased">Sold / Purchased</option>
                <option value="loyalty_reward">Loyalty</option>
                <option value="donated_giveaway">Donated</option>
                <option value="promo_gift_card">Promo</option>
              </select>
              <select
                value={filterStatus}
                onChange={(event) => {
                  const status = event.target.value;
                  setPage(0);
                  setFilterStatus(status);
                  if (status !== "active") setOpenOnly(false);
                }}
                className="ui-input text-xs px-2 py-1.5"
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="depleted">Depleted</option>
                <option value="expired">Expired</option>
                <option value="void">Void</option>
              </select>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-app-text touch-manipulation rounded-xl border border-app-border bg-app-surface px-3 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-app-border"
                  checked={openOnly}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setPage(0);
                    setOpenOnly(checked);
                    if (checked) setFilterStatus("active");
                  }}
                />
                Open cards only
              </label>
            </div>
            <div className="mt-4 rounded-2xl border border-app-border bg-app-surface px-3 py-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20">
                    <ScanLine className="h-4 w-4" aria-hidden />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Scan gift card
                    </p>
                    <p className="text-xs font-semibold text-app-text-muted">
                      Scan or type a card code to open its balance and activity.
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-1 gap-2 lg:max-w-xl">
                  <input
                    value={scanCode}
                    onChange={(event) => setScanCode(event.target.value.toUpperCase())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void lookupScannedCard();
                    }}
                    className="ui-input min-w-0 flex-1 font-mono text-sm font-black uppercase tracking-[0.12em]"
                    placeholder="Scan or type card code..."
                  />
                  <button
                    type="button"
                    onClick={() => void lookupScannedCard()}
                    disabled={scanBusy}
                    className="ui-btn-secondary shrink-0 px-4 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    {scanBusy ? "Opening..." : "Open"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-5">
        {loading ? (
          <p className="py-12 text-center text-sm text-app-text-muted">Loading…</p>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-4">
            <CreditCard className="h-10 w-10 text-app-text-muted" />
            <p className="text-sm text-app-text-muted">No gift cards found.</p>
            <p className="text-xs text-app-text-muted">Sold / Purchased gift cards are loaded in Register. Use Issue Donated or Issue Promo for approved giveaway cards.</p>
          </div>
        ) : (
          <div className={isSmallScreen ? "space-y-3" : "overflow-x-auto"}>
          {isSmallScreen ? (
            <div data-testid="gift-cards-card-list" className="space-y-3">
              {cards.map((c) => {
                const displayStatus = giftCardDisplayStatus(c);
                return (
                  <article
                    key={c.id}
                    className="rounded-[20px] border border-app-border bg-app-surface-2/50 p-4 transition-colors hover:border-app-accent/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => setSelectedCardId(c.id)}
                      >
                        <p className="font-mono text-sm font-black tracking-tight text-app-accent">{c.code}</p>
                        <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
                          {KIND_LABELS[c.card_kind] ?? c.card_kind}
                        </p>
                      </button>
                      {c.card_status === "active" ? (
                        <button
                          type="button"
                          onClick={() => initiateVoid(c.id)}
                          disabled={voidingId === c.id}
                          className="rounded-lg p-2 text-app-text-muted hover:bg-app-danger/10 hover:text-app-danger transition-all"
                          title="Void card"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl border border-app-border bg-app-surface px-2.5 py-2">
                        <p className="text-[10px] font-black uppercase tracking-wide text-app-text-muted">Balance</p>
                        <p className="mt-1 font-black tabular-nums text-app-text">{fmt(c.current_balance)}</p>
                      </div>
                      <div className="rounded-xl border border-app-border bg-app-surface px-2.5 py-2">
                        <p className="text-[10px] font-black uppercase tracking-wide text-app-text-muted">Original</p>
                        <p className="mt-1 font-black tabular-nums text-app-text">{fmt(c.original_value)}</p>
                      </div>
                    </div>

                    <div className="mt-2 grid gap-1.5 text-[11px] text-app-text">
                      <p className="flex justify-between gap-2">
                        <span className="font-semibold text-app-text-muted">Status</span>
                        <span className="font-black">
                          {STATUS_LABELS[displayStatus] ?? displayStatus}
                        </span>
                      </p>
                      <p className="flex justify-between gap-2">
                        <span className="font-semibold text-app-text-muted">Expires</span>
                        <span className="font-black">{fmtDate(c.expires_at)}</span>
                      </p>
	                      <p className="flex justify-between gap-2">
	                        <span className="font-semibold text-app-text-muted">Customer</span>
	                        <span className="truncate font-black">{c.customer_name ?? "—"}</span>
	                      </p>
	                      {c.promo_event_name ? (
	                        <p className="flex justify-between gap-2">
	                          <span className="font-semibold text-app-text-muted">Event</span>
	                          <span className="truncate font-black">{c.promo_event_name}</span>
	                        </p>
	                      ) : null}
                    </div>

                  </article>
                );
              })}
            </div>
          ) : (
          <table data-testid="gift-cards-table" className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Code</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Kind</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Status</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Balance</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Original</th>
                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Expires</th>
	                <th className="pb-3 pr-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Customer / event</th>
                <th className="pb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/30">
              {cards.map(c => {
                const displayStatus = giftCardDisplayStatus(c);
                return (
                <tr
                  key={c.id}
                  tabIndex={0}
                  aria-label={`View gift card ${c.code}`}
                  className="group cursor-pointer transition-colors hover:bg-app-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-accent/30"
                  onClick={() => setSelectedCardId(c.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelectedCardId(c.id);
                  }}
                >
                  <td className="py-4 pr-4 font-mono text-xs font-black text-app-accent tracking-tighter">{c.code}</td>
                  <td className="py-4 pr-4">
	                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-widest border ${
	                      c.card_kind === "loyalty_reward"
	                        ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
	                        : c.card_kind === "donated_giveaway"
	                          ? "border-purple-500/20 bg-purple-500/10 text-purple-600"
	                          : c.card_kind === "promo_gift_card"
	                            ? "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-600"
	                            : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
	                    }`}>
                      {KIND_LABELS[c.card_kind] ?? c.card_kind}
                    </span>
                  </td>
                  <td className="py-4 pr-4">
                    <span className={`ui-pill text-[9px] font-black uppercase tracking-widest ${
                      displayStatus === 'active' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' :
                      displayStatus === 'expired' || displayStatus === 'void' ? 'bg-app-danger/10 text-app-danger border border-app-danger/20' :
                      'bg-app-surface-2 text-app-text-muted border border-app-border'
                    }`}>
                      {STATUS_LABELS[displayStatus] ?? displayStatus}
                    </span>
                  </td>
                  <td className="py-4 pr-4 font-black tabular-nums text-app-text">{fmt(c.current_balance)}</td>
                  <td className="py-4 pr-4 font-bold tabular-nums text-app-text-muted opacity-60">{fmt(c.original_value)}</td>
                  <td className="py-4 pr-4 text-xs font-bold text-app-text-muted whitespace-nowrap">{fmtDate(c.expires_at)}</td>
	                  <td className="py-4 pr-4 text-xs font-bold text-app-text truncate max-w-[150px]">{c.promo_event_name ?? c.customer_name ?? "—"}</td>
                  <td className="py-4 text-right">
                    {c.card_status === "active" && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          initiateVoid(c.id);
                        }}
                        disabled={voidingId === c.id}
                        className="rounded-lg p-2 text-app-text-muted hover:bg-app-danger/10 hover:text-app-danger transition-all opacity-0 group-hover:opacity-100"
                        title="Void card"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          )}
          </div>
        )}
        {totalCount > 0 ? (
          <div
            data-testid="gift-cards-pagination"
            className="mt-4 flex flex-col gap-3 border-t border-app-border pt-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-xs font-bold text-app-text-muted">
              Showing {firstShown}–{lastShown} of {totalCount} matching cards
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="ui-btn-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                disabled={page === 0 || loading}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Previous
              </button>
              <span className="text-xs font-black text-app-text-muted">
                Page {page + 1} of {totalPages}
              </span>
              <button
                type="button"
                className="ui-btn-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                disabled={page + 1 >= totalPages || loading}
                onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
        </div>
      </div>

      {selectedCard ? (
        <div className="ui-overlay-backdrop !z-[200]">
          <div
            className="ui-modal max-h-[92dvh] w-full max-w-2xl overflow-y-auto p-5"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Gift Card Details
                </p>
                <h2 className="mt-1 font-mono text-xl font-black text-app-accent">
                  {selectedCard.code}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCardId(null)}
                className="rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                aria-label="Close gift card details"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SelectedCardPanel
              selectedCard={selectedCard}
              selectedEvents={selectedEvents}
              eventsLoading={eventsLoading}
              isSmallScreen={isSmallScreen}
            />
          </div>
        </div>
      ) : null}

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
