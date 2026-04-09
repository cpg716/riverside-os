import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/apiUrl";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { CheckCircle2, Gem, Ruler, Search, User, UserPlus, X, UserX } from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import type { WeddingMembership } from "./customerProfileTypes";

export interface Customer {
  id: string;
  /** Present for all server-backed customers; may be missing on older persisted cart state. */
  customer_code?: string;
  first_name: string;
  last_name: string;
  company_name?: string | null;
  email: string | null;
  phone: string | null;
  wedding_active?: boolean;
  wedding_party_name?: string | null;
  wedding_party_id?: string | null;
}

interface CustomerSelectorProps {
  selectedCustomer: Customer | null;
  weddingMemberships: WeddingMembership[];
  onOpenWeddingParty?: (partyId: string) => void;
  onSelect: (customer: Customer | null) => void;
  /** Open customer detail drawer without selecting (POS quick-peek). */
  onViewCustomer?: (customer: Customer) => void;
  /** Register: dense single-row customer chip + optional measurements control. */
  variant?: "default" | "posStrip";
  /** When `variant="posStrip"` and a customer is selected, show vault/measurements control. */
  onOpenMeasurements?: () => void;
  /** Show a prominent "Walk-in" option in the search dropdown (payment rail variant). */
  showWalkInOption?: boolean;
}

interface ApiErrorBody {
  error?: string;
}

const CUSTOMER_SELECTOR_PAGE = 50;

export default function CustomerSelector({
  selectedCustomer,
  weddingMemberships,
  onOpenWeddingParty,
  onSelect,
  onViewCustomer,
  variant = "default",
  onOpenMeasurements,
  showWalkInOption = false,
}: CustomerSelectorProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [partyFilterMode, setPartyFilterMode] = useState(false);

  const [newCustomer, setNewCustomer] = useState({
    first_name: "",
    last_name: "",
    phone: "",
    email: "",
    address_line1: "",
    city: "",
    state: "",
    postal_code: "",
    marketing_email_opt_in: false,
    marketing_sms_opt_in: false,
  });

  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setHasMore(false);
      setPartyFilterMode(false);
      return;
    }

    const delayDebounce = setTimeout(async () => {
      setSearchBusy(true);
      try {
        const trimmed = query.trim();
        const res = await fetch(
          partyFilterMode
            ? `${baseUrl}/api/customers/browse?${new URLSearchParams({
                wedding_party_q: trimmed,
                limit: String(CUSTOMER_SELECTOR_PAGE),
                offset: "0",
              }).toString()}`
            : `${baseUrl}/api/customers/search?${new URLSearchParams({ q: trimmed, limit: String(CUSTOMER_SELECTOR_PAGE), offset: "0" }).toString()}`,
          { headers: { ...apiAuth() } },
        );
        if (res.ok) {
          const data = (await res.json()) as Customer[] | Array<Customer & { wedding_party_name?: string | null; wedding_party_id?: string | null }>;
          const mapped = partyFilterMode
            ? (data as Array<Customer & { wedding_party_name?: string | null; wedding_party_id?: string | null }>).map((r) => ({
                id: r.id,
                customer_code: r.customer_code,
                first_name: r.first_name,
                last_name: r.last_name,
                company_name: r.company_name ?? null,
                email: r.email,
                phone: r.phone,
                wedding_active: true,
                wedding_party_name: r.wedding_party_name ?? null,
                wedding_party_id: r.wedding_party_id ?? null,
              }))
            : (data as Customer[]);
          setResults(mapped);
          setHasMore(mapped.length === CUSTOMER_SELECTOR_PAGE);
        } else {
          setResults([]);
          setHasMore(false);
        }
      } catch {
        setResults([]);
        setHasMore(false);
      } finally {
        setSearchBusy(false);
      }
    }, 300);

    return () => clearTimeout(delayDebounce);
  }, [query, baseUrl, partyFilterMode, apiAuth]);

  const loadMoreResults = useCallback(async () => {
    if (!hasMore || loadingMore || searchBusy) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        partyFilterMode
          ? `${baseUrl}/api/customers/browse?${new URLSearchParams({
              wedding_party_q: trimmed,
              limit: String(CUSTOMER_SELECTOR_PAGE),
              offset: String(results.length),
            }).toString()}`
          : `${baseUrl}/api/customers/search?${new URLSearchParams({
              q: trimmed,
              limit: String(CUSTOMER_SELECTOR_PAGE),
              offset: String(results.length),
            }).toString()}`,
        { headers: { ...apiAuth() } },
      );
      if (!res.ok) {
        toast("Could not load more results.", "error");
        return;
      }
      const data = (await res.json()) as Customer[] | Array<Customer & { wedding_party_name?: string | null; wedding_party_id?: string | null }>;
      const mapped = partyFilterMode
        ? (data as Array<Customer & { wedding_party_name?: string | null; wedding_party_id?: string | null }>).map((r) => ({
            id: r.id,
            customer_code: r.customer_code,
            first_name: r.first_name,
            last_name: r.last_name,
            company_name: r.company_name ?? null,
            email: r.email,
            phone: r.phone,
            wedding_active: true,
            wedding_party_name: r.wedding_party_name ?? null,
            wedding_party_id: r.wedding_party_id ?? null,
          }))
        : (data as Customer[]);
      setResults((prev) => [...prev, ...mapped]);
      setHasMore(mapped.length === CUSTOMER_SELECTOR_PAGE);
    } catch {
      toast("Could not load more results.", "error");
    } finally {
      setLoadingMore(false);
    }
  }, [
    hasMore,
    loadingMore,
    searchBusy,
    query,
    partyFilterMode,
    baseUrl,
    results.length,
    toast,
    apiAuth,
  ]);

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/customers"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          first_name: newCustomer.first_name.trim(),
          last_name: newCustomer.last_name.trim(),
          phone: newCustomer.phone.trim() || null,
          email: newCustomer.email.trim() || null,
          address_line1: newCustomer.address_line1.trim() || null,
          city: newCustomer.city.trim() || null,
          state: newCustomer.state.trim() || null,
          postal_code: newCustomer.postal_code.trim() || null,
          marketing_email_opt_in: newCustomer.marketing_email_opt_in,
          marketing_sms_opt_in: newCustomer.marketing_sms_opt_in,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        throw new Error(body.error ?? "Failed to add customer");
      }
      const data = (await res.json()) as Customer;
      onSelect(data);
      if (data.customer_code) {
        toast(`Customer added — code ${data.customer_code}`, "success");
      } else {
        toast("Customer added", "success");
      }
      setIsAdding(false);
      setQuery("");
      setResults([]);
      setNewCustomer({
        first_name: "",
        last_name: "",
        phone: "",
        email: "",
        address_line1: "",
        city: "",
        state: "",
        postal_code: "",
        marketing_email_opt_in: false,
        marketing_sms_opt_in: false,
      });
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to add customer", "error");
    } finally {
      setLoading(false);
    }
  };

  if (selectedCustomer) {
    if (variant === "posStrip") {
      const stripIdentityInner = (
        <>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20">
            <User size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-black italic uppercase leading-tight tracking-tight">
              {selectedCustomer.first_name} {selectedCustomer.last_name}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-bold uppercase tracking-widest text-blue-100/95">
              <span className="rounded bg-white/20 px-1 py-0.5">Active</span>
              <span className="tabular-nums">{selectedCustomer.customer_code || "—"}</span>
              {selectedCustomer.phone ? (
                <span className="tabular-nums opacity-90">{selectedCustomer.phone}</span>
              ) : null}
            </div>
          </div>
        </>
      );
      return (
        <div className="rounded-xl bg-blue-600 px-2.5 py-2 text-white shadow-md">
          <div className="flex min-w-0 items-center gap-2">
            {onViewCustomer ? (
              <button
                type="button"
                onClick={() => onViewCustomer(selectedCustomer)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg -mx-1 px-1 py-0.5 text-left outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40"
                aria-label="Open customer profile"
              >
                {stripIdentityInner}
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">{stripIdentityInner}</div>
            )}
            {onOpenMeasurements ? (
              <button
                type="button"
                onClick={() => onOpenMeasurements()}
                className="shrink-0 rounded-xl border border-white/25 bg-white/10 p-1.5 transition-colors hover:bg-white/20"
                title="Edit measurements (vault)"
                aria-label="Edit measurements vault"
              >
                <Ruler size={16} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="shrink-0 rounded-full p-1.5 transition-colors hover:bg-white/10"
              aria-label="Remove customer from sale"
            >
              <X size={16} />
            </button>
          </div>
          {weddingMemberships.length > 0 ? (
            <div className="mt-1.5 border-t border-white/15 pt-1.5">
              <div className="flex max-h-14 flex-wrap gap-1 overflow-y-auto no-scrollbar">
                {weddingMemberships.map((w) => (
                  <button
                    key={`${w.wedding_member_id}-${w.wedding_party_id}`}
                    type="button"
                    onClick={() => onOpenWeddingParty?.(w.wedding_party_id)}
                    className="inline-flex max-w-full items-center gap-1 rounded-lg bg-app-surface/95 px-2 py-1 text-left text-[10px] font-bold text-blue-900 shadow-sm hover:bg-app-surface dark:text-sky-100"
                  >
                    <Gem size={11} className="shrink-0 text-app-accent" />
                    <span className="truncate">{w.party_name}</span>
                    <span className="shrink-0 text-app-text-muted">· {w.event_date}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="space-y-3 rounded-xl bg-blue-600 p-4 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/20">
              <User size={20} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-black leading-none italic uppercase tracking-tight">
                {selectedCustomer.first_name} {selectedCustomer.last_name}
              </div>
              <div className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-widest text-blue-100/90">
                {selectedCustomer.customer_code || "—"}
              </div>
              <div className="flex items-center gap-3 mt-1.5 opacity-80">
                <span className="text-[10px] font-bold uppercase tracking-widest bg-white/20 px-1.5 py-0.5 rounded-md">
                   Active
                </span>
                {selectedCustomer.phone && (
                  <span className="text-[10px] font-bold tabular-nums tracking-widest">{selectedCustomer.phone}</span>
                )}
                {selectedCustomer.email && (
                  <span className="text-[10px] font-bold truncate max-w-[140px] italic">{selectedCustomer.email}</span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="shrink-0 rounded-full p-2 transition-colors hover:bg-white/10"
          >
            <X size={18} />
          </button>
        </div>
        {weddingMemberships.length > 0 && (
          <div className="rounded-lg bg-white/10 p-3">
            <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-blue-100">
              Weddings ({weddingMemberships.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {weddingMemberships.map((w) => (
                <button
                  key={`${w.wedding_member_id}-${w.wedding_party_id}`}
                  type="button"
                  onClick={() => onOpenWeddingParty?.(w.wedding_party_id)}
                  className="inline-flex items-center gap-1 rounded-lg bg-app-surface/95 px-2 py-1.5 text-left text-[11px] font-bold text-blue-900 shadow-sm hover:bg-app-surface dark:text-sky-100"
                >
                  <Gem size={12} className="shrink-0 text-app-accent" />
                  <span className="max-w-[140px] truncate">{w.party_name}</span>
                  <span className="text-app-text-muted">· {w.event_date}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          {showWalkInOption ? "Customer" : "Client Search"}
        </span>
        <div className="flex items-center gap-2">
          {showWalkInOption ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-700 ring-1 ring-amber-500/25">
              Walk-in
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setIsAdding((v) => !v)}
            className="flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-800"
          >
            {isAdding ? <X size={14} /> : <UserPlus size={14} />}
            {isAdding ? "Cancel" : "Quick Add"}
          </button>
        </div>
      </div>

      {isAdding ? (
        <form
          onSubmit={handleQuickAdd}
          className="space-y-3 rounded-xl border border-app-border bg-app-surface p-4 shadow-sm"
        >
          <div className="grid grid-cols-2 gap-2">
            <input
              required
              placeholder="First Name"
              className="ui-input w-full rounded-lg p-2 text-sm"
              value={newCustomer.first_name}
              onChange={(e) =>
                setNewCustomer((prev) => ({
                  ...prev,
                  first_name: e.target.value,
                }))
              }
            />
            <input
              required
              placeholder="Last Name"
              className="ui-input w-full rounded-lg p-2 text-sm"
              value={newCustomer.last_name}
              onChange={(e) =>
                setNewCustomer((prev) => ({
                  ...prev,
                  last_name: e.target.value,
                }))
              }
            />
          </div>
          <input
            placeholder="Phone Number"
            className="ui-input w-full rounded-lg p-2 text-sm"
            value={newCustomer.phone}
            onChange={(e) =>
              setNewCustomer((prev) => ({
                ...prev,
                phone: e.target.value,
              }))
            }
          />
          <input
            placeholder="Email (optional)"
            className="ui-input w-full rounded-lg p-2 text-sm"
            value={newCustomer.email}
            onChange={(e) =>
              setNewCustomer((prev) => ({
                ...prev,
                email: e.target.value,
              }))
            }
          />
          <input
            placeholder="Street address"
            className="ui-input w-full rounded-lg p-2 text-sm"
            value={newCustomer.address_line1}
            onChange={(e) =>
              setNewCustomer((prev) => ({
                ...prev,
                address_line1: e.target.value,
              }))
            }
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              placeholder="City"
              className="ui-input w-full rounded-lg p-2 text-sm"
              value={newCustomer.city}
              onChange={(e) =>
                setNewCustomer((prev) => ({ ...prev, city: e.target.value }))
              }
            />
            <input
              placeholder="ST"
              className="ui-input w-full rounded-lg p-2 text-sm"
              value={newCustomer.state}
              onChange={(e) =>
                setNewCustomer((prev) => ({ ...prev, state: e.target.value }))
              }
            />
            <input
              placeholder="ZIP"
              className="ui-input w-full rounded-lg p-2 text-sm"
              value={newCustomer.postal_code}
              onChange={(e) =>
                setNewCustomer((prev) => ({
                  ...prev,
                  postal_code: e.target.value,
                }))
              }
            />
          </div>
          <div className="rounded-lg border border-app-border bg-app-surface-2 p-3 text-xs">
            <p className="mb-2 font-bold text-app-text">Marketing only</p>
            <label className="mb-1 flex items-center justify-between gap-2">
              Promo email
              <select
                value={newCustomer.marketing_email_opt_in ? "yes" : "no"}
                onChange={(e) =>
                  setNewCustomer((prev) => ({
                    ...prev,
                    marketing_email_opt_in: e.target.value === "yes",
                  }))
                }
                className="ui-input rounded px-1 py-0.5 text-xs"
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Promo text
              <select
                value={newCustomer.marketing_sms_opt_in ? "yes" : "no"}
                onChange={(e) =>
                  setNewCustomer((prev) => ({
                    ...prev,
                    marketing_sms_opt_in: e.target.value === "yes",
                  }))
                }
                className="ui-input rounded px-1 py-0.5 text-xs"
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-app-accent py-2 text-sm font-bold text-white transition-colors hover:bg-black disabled:opacity-50"
          >
            {loading ? "Adding..." : "Add & Select Client"}
          </button>
        </form>
      ) : (
        <div className="space-y-1.5">
        {showWalkInOption && !query.trim() ? (
          <button
            type="button"
            onClick={() => { onSelect(null); setQuery(""); }}
            className="flex w-full items-center gap-2.5 rounded-xl border-2 border-amber-400/40 bg-amber-50/70 px-3 py-2 text-left transition-all hover:bg-amber-100 active:scale-[0.98] dark:border-amber-500/25 dark:bg-amber-500/10 dark:hover:bg-amber-500/20"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-400">
              <UserX size={14} />
            </div>
            <div>
              <div className="text-[11px] font-black uppercase italic tracking-tight text-amber-900 dark:text-amber-200">
                Walk-in Sale
              </div>
              <div className="text-[9px] font-bold uppercase tracking-widest text-amber-700/70 dark:text-amber-400/70">
                No account · no loyalty · no orders
              </div>
            </div>
          </button>
        ) : null}
        <div className="group relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted transition-colors group-focus-within:text-app-accent"
            size={16}
          />
          <input
            placeholder="Search by name, phone, or email..."
            className="ui-input w-full py-2.5 pl-9 pr-4 transition-all"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {query.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[min(70vh,28rem)] overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-xl">
              <div className="max-h-[min(65vh,26rem)] overflow-y-auto">
              {/* Walk-in option — shown only in payment-rail mode */}
              {showWalkInOption ? (
                <button
                  type="button"
                  onClick={() => { onSelect(null); setQuery(""); setResults([]); }}
                  className="flex w-full items-center gap-3 border-b border-amber-200/60 bg-amber-50/80 px-4 py-3 text-left transition-colors hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:hover:bg-amber-500/20"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-400">
                    <UserX size={16} />
                  </div>
                  <div>
                    <div className="text-sm font-black uppercase italic tracking-tight text-amber-900 dark:text-amber-200">
                      Walk-in Sale
                    </div>
                    <div className="text-[9px] font-bold uppercase tracking-widest text-amber-700/80 dark:text-amber-400/80">
                      No account · no loyalty · no orders
                    </div>
                  </div>
                </button>
              ) : null}
              <div className="border-b border-app-border p-2">
                <button
                  type="button"
                  onClick={() => setPartyFilterMode((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${
                    partyFilterMode
                      ? "border-app-accent/40 bg-app-accent/15 text-app-text"
                      : "border-app-border bg-app-surface-2 text-app-text"
                  }`}
                >
                  <Gem size={11} aria-hidden />
                  {partyFilterMode
                    ? `Party filter on: "${query.trim()}"`
                    : `Search by wedding party: "${query.trim()}"`}
                </button>
              </div>
              {searchBusy && (
                <div className="p-3 text-sm text-app-text-muted">Searching…</div>
              )}
              {!searchBusy && results.length === 0 && (
                <div className="p-3 text-sm text-app-text-muted">
                  No customers found
                </div>
              )}
              {!searchBusy &&
                results.map((customer) => (
                  <div
                    key={customer.id}
                    className="group relative flex items-stretch justify-between gap-2 border-b border-app-border/50 last:border-0"
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(customer)}
                      className="min-w-0 flex-1 p-4 text-left transition-colors hover:bg-app-surface-2"
                    >
                      <div className="font-bold text-app-text">
                        {customer.first_name} {customer.last_name}
                      </div>
                      <div className="text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
                        {customer.customer_code || "—"}
                        {customer.company_name ? ` · ${customer.company_name}` : ""}
                      </div>
                      <div className="text-xs text-app-text-muted">
                        {customer.phone ?? customer.email ?? "No contact info"}
                      </div>
                      {customer.wedding_active ? (
                        <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-app-accent/35 bg-app-accent/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-app-accent">
                          <Gem size={11} aria-hidden />
                          {customer.wedding_party_name ?? "Wedding active"}
                        </div>
                      ) : null}
                    </button>
                    <div className="pointer-events-none flex shrink-0 items-center pr-2 opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100">
                      <div className="flex flex-col gap-1 rounded-l-xl border border-app-border/90 bg-app-surface/95 px-2 py-2 shadow-md backdrop-blur-md">
                        <button
                          type="button"
                          onClick={() => onSelect(customer)}
                          className="whitespace-nowrap rounded-lg px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-app-text transition-colors hover:bg-app-surface-2"
                        >
                          Select
                        </button>
                        {onViewCustomer ? (
                          <button
                            type="button"
                            onClick={() => onViewCustomer(customer)}
                            className="whitespace-nowrap rounded-lg px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-app-text transition-colors hover:bg-app-surface-2"
                          >
                            View
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="pointer-events-none flex items-center pr-3 text-app-border group-hover:hidden">
                      <CheckCircle2 size={18} aria-hidden />
                    </div>
                  </div>
                ))}
              {hasMore ? (
                <div className="border-t border-app-border p-2">
                  <button
                    type="button"
                    disabled={loadingMore || searchBusy}
                    onClick={() => void loadMoreResults()}
                    className="w-full rounded-lg border border-app-border bg-app-surface-2 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
              </div>
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  );
}
