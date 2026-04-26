import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { CheckCircle2, Gem, Ruler, Search, User, UserPlus, X, UserX, Clock } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { AddCustomerDrawer } from "../customers/CustomersWorkspace";
import type { WeddingMembership } from "./customerProfileTypes";

export interface Customer {
  id: string;
  customer_code?: string;
  first_name: string;
  last_name: string;
  company_name?: string | null;
  email: string | null;
  phone: string | null;
  wedding_active?: boolean;
  wedding_party_name?: string | null;
  wedding_party_id?: string | null;
  couple_id?: string | null;
  wedding_member_id?: string | null;
}

interface CustomerSelectorProps {
  selectedCustomer: Customer | null;
  weddingMemberships: WeddingMembership[];
  onOpenWeddingParty?: (partyId: string) => void;
  onSelect: (customer: Customer | null) => void;
  onViewCustomer?: (customer: Customer) => void;
  /** Register: dense single-row customer chip + optional measurements control. */
  variant?: "default" | "posStrip";
  onOpenMeasurements?: () => void;
  showWalkInOption?: boolean;
  hasParkedSales?: boolean;
  onOpenParkedSales?: () => void;
}

const CUSTOMER_SELECTOR_PAGE = 50;

type PosCustomerDraft = Parameters<typeof AddCustomerDrawer>[0]["initialDraft"];

function formatPhoneDraft(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function customerDraftFromQuery(value: string): PosCustomerDraft {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { email: trimmed };
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7 && digits.length >= trimmed.replace(/\s/g, "").length - 2) {
    return { phone: formatPhoneDraft(digits) };
  }
  const [first = "", ...rest] = trimmed.split(/\s+/);
  return { first_name: first, last_name: rest.join(" ") };
}

export default function CustomerSelector({
  selectedCustomer,
  weddingMemberships,
  onOpenWeddingParty,
  onSelect,
  onViewCustomer,
  variant = "default",
  onOpenMeasurements,
  showWalkInOption = false,
  hasParkedSales = false,
  onOpenParkedSales,
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
  const [searchBusy, setSearchBusy] = useState(false);
  const [partyFilterMode, setPartyFilterMode] = useState(false);
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<PosCustomerDraft>({});

  const baseUrl = getBaseUrl();
  const trimmedQuery = query.trim();
  const queryPhoneDigits = trimmedQuery.replace(/\D/g, "");
  const queryHasExactCustomerMatch =
    trimmedQuery.length >= 2 &&
    results.some((customer) => {
      const fullName = `${customer.first_name} ${customer.last_name}`
        .trim()
        .toLowerCase();
      const email = (customer.email ?? "").trim().toLowerCase();
      const phoneDigits = (customer.phone ?? "").replace(/\D/g, "");
      const normalizedQuery = trimmedQuery.toLowerCase();
      return (
        fullName === normalizedQuery ||
        email === normalizedQuery ||
        (queryPhoneDigits.length >= 7 && phoneDigits === queryPhoneDigits)
      );
    });
  const showAddFromSearch =
    trimmedQuery.length >= 2 && !searchBusy && !queryHasExactCustomerMatch;

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
        toast("We couldn't load more customers. Please try again.", "error");
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
      toast("We couldn't load more customers. Please try again.", "error");
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
              <span className="tabular-nums">{selectedCustomer.customer_code || "\u2014"}</span>
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
                    <span className="shrink-0 text-app-text-muted">\u00b7 {w.event_date}</span>
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
                {selectedCustomer.customer_code || "\u2014"}
              </div>
              <div className="flex items-center gap-3 mt-1.5 opacity-80">
                <span className="text-[10px] font-bold uppercase tracking-widest bg-white/20 px-1.5 py-0.5 rounded-md">
                   Active
                </span>
                {selectedCustomer.phone && (
                  <span className="text-[10px] font-bold tabular-nums tracking-widest">{selectedCustomer.phone}</span>
                )}
                {selectedCustomer.email && (
                  <span className="max-w-[120px] truncate text-[10px] font-bold italic sm:max-w-[180px]">{selectedCustomer.email}</span>
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
                  <span className="max-w-[120px] truncate sm:max-w-[180px]">{w.party_name}</span>
                  <span className="text-app-text-muted">\u00b7 {w.event_date}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 1. Search Bar (Top) */}
      <div className="group relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted transition-colors group-focus-within:text-app-accent"
            size={16}
          />
          <input
            data-testid="pos-customer-search"
            placeholder="Search by name, phone, or email..."
            className="ui-input w-full py-2.5 pl-9 pr-4 transition-all border-2 border-app-border focus:border-app-accent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {query.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full z-100 mt-2 max-h-[min(78vh,28rem)] isolate overflow-hidden rounded-xl border border-app-border bg-[#fffdfa] text-app-text shadow-2xl shadow-black/30 ring-1 ring-black/10 backdrop-blur-none dark:bg-[#202a38]">
               <div className="max-h-[min(72vh,26rem)] overflow-y-auto no-scrollbar">
               {showWalkInOption && (
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
                       No account \u00b7 no loyalty \u00b7 no orders
                     </div>
                   </div>
                 </button>
               )}
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
                     ? `Party filter on`
                     : `Search by wedding party`}
                 </button>
               </div>
               {showAddFromSearch && (
                 <button
                   type="button"
                   onClick={() => {
                     setAddDraft(customerDraftFromQuery(query));
                     setAddDrawerOpen(true);
                     setResults([]);
                   }}
                   className="flex w-full items-center gap-3 border-b border-app-border bg-app-accent/10 px-4 py-3 text-left transition-colors hover:bg-app-accent/15"
                 >
                   <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app-accent text-white shadow-sm">
                     <UserPlus size={16} />
                   </div>
                   <div className="min-w-0">
                     <div className="text-sm font-black uppercase italic tracking-tight text-app-text">
                       Add customer
                     </div>
                     <div className="truncate text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                       Start profile from "{trimmedQuery}"
                     </div>
                   </div>
                 </button>
               )}
               {searchBusy && (
                 <div className="p-3 text-sm text-app-text-muted">Searching\u2026</div>
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
                         {customer.customer_code || "\u2014"}
                         {customer.company_name ? ` \u00b7 ${customer.company_name}` : ""}
                       </div>
                       <div className="text-xs text-app-text-muted">
                         {customer.phone ?? customer.email ?? "No contact info"}
                       </div>
                     </button>
                      <div className="flex shrink-0 items-center pr-3">
                         <CheckCircle2 size={18} className="text-app-border group-hover:text-app-accent transition-colors" />
                      </div>
                   </div>
                 ))}
               {hasMore && (
                 <div className="border-t border-app-border p-2">
                   <button
                     type="button"
                     disabled={loadingMore || searchBusy}
                     onClick={() => void loadMoreResults()}
                     className="w-full rounded-lg border border-app-border bg-app-surface-2 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2 disabled:opacity-50"
                   >
                     {loadingMore ? "Loading\u2026" : "Load more"}
                   </button>
                 </div>
               )}
               </div>
            </div>
          )}
      </div>

      {/* 2. Walk-in / Parked / Options Row */}
      {!query.trim() && (
        <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
           <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">Quick Actions</span>
             <button
                type="button"
                onClick={() => {
                  setAddDraft({});
                  setAddDrawerOpen(true);
                }}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-blue-600 hover:text-blue-800 transition-colors"
              >
                <UserPlus size={14} />
                Add Customer
              </button>
          </div>

          <div className="grid grid-cols-1 gap-2">
               {showWalkInOption && (
                <button
                  type="button"
                  onClick={() => { onSelect(null); setQuery(""); }}
                  className="group flex w-full items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-50/50 p-2.5 text-left transition-all hover:bg-amber-50 active:scale-[0.98] dark:bg-amber-500/5 dark:hover:bg-amber-500/10"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20 group-hover:bg-amber-500 group-hover:text-white transition-colors">
                    <UserX size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-black uppercase tracking-tight text-amber-900 dark:text-amber-200">
                      Walk-in Sale
                    </div>
                    <div className="truncate text-[9px] font-bold uppercase tracking-widest text-amber-700/60 dark:text-amber-400/60">
                      Standard checkout without account
                    </div>
                  </div>
                </button>
              )}

              {hasParkedSales && (
                <button
                  type="button"
                  onClick={() => onOpenParkedSales?.()}
                  className="group flex w-full items-center gap-3 rounded-xl border border-app-accent/30 bg-app-accent/5 p-2.5 text-left transition-all hover:bg-app-accent/10 active:scale-[0.98]"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20 group-hover:bg-app-accent group-hover:text-white transition-colors">
                    <Clock size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-black uppercase tracking-tight text-app-text">
                      Parked Sales ({hasParkedSales ? "Active" : "None"})
                    </div>
                    <div className="truncate text-[9px] font-bold uppercase tracking-widest text-app-accent">
                      Recall or manage snapshots
                    </div>
                  </div>
                </button>
              )}
          </div>
        </div>
      )}
      <AddCustomerDrawer
        isOpen={addDrawerOpen}
        initialDraft={addDraft}
        onClose={() => setAddDrawerOpen(false)}
        onSaved={() => {
          setAddDrawerOpen(false);
          setQuery("");
          setResults([]);
        }}
        onCreatedCustomer={(customer) => onSelect(customer)}
      />
    </div>
  );
}
