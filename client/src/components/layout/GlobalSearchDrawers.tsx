import { useCallback, useEffect, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { ExternalLink, Package, Shirt, Wallet } from "lucide-react";
import type { Customer, ResolvedSkuItem } from "../pos/types";
import DetailDrawer from "./DetailDrawer";
import SmartButton from "../ui/SmartButton";
import { CustomerRelationshipHubDrawer } from "../customers/CustomerRelationshipHubDrawer";
import ShipmentsHubSection from "../customers/ShipmentsHubSection";

import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

export type GlobalSearchDrawerState =
  | { kind: "customer"; customer: Customer }
  | { kind: "product"; sku: string; hintName?: string }
  | { kind: "wedding-party-customers"; partyQuery: string }
  | { kind: "shipment"; shipmentId: string };

function fmtUsd(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return formatUsdFromCents(parseMoneyToCents(v));
}

interface GlobalSearchDrawerHostProps {
  state: GlobalSearchDrawerState | null;
  onClose: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onUseCustomerInRegister: (c: Customer) => void;
  onNavigateRegister: () => void;
  onAddCustomerToWedding?: () => void;
  onBookCustomerAppointment?: () => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}

export default function GlobalSearchDrawerHost({
  state,
  onClose,
  onOpenWeddingParty,
  onUseCustomerInRegister,
  onNavigateRegister,
  onAddCustomerToWedding,
  onBookCustomerAppointment,
  onOpenTransactionInBackoffice,
}: GlobalSearchDrawerHostProps) {
  if (!state) return null;

  if (state.kind === "customer") {
    return (
      <CustomerSearchDrawer
        customer={state.customer}
        onClose={onClose}
        onOpenWeddingParty={onOpenWeddingParty}
        onUseCustomerInRegister={onUseCustomerInRegister}
        onNavigateRegister={onNavigateRegister}
        onAddToWedding={onAddCustomerToWedding}
        onBookAppointment={onBookCustomerAppointment}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      />
    );
  }

  if (state.kind === "wedding-party-customers") {
    return (
      <WeddingPartyCustomersDrawer
        partyQuery={state.partyQuery}
        onClose={onClose}
        onOpenWeddingParty={onOpenWeddingParty}
        onUseCustomerInRegister={onUseCustomerInRegister}
        onNavigateRegister={onNavigateRegister}
        onAddToWedding={onAddCustomerToWedding}
        onBookAppointment={onBookCustomerAppointment}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      />
    );
  }

  if (state.kind === "shipment") {
    return (
      <DetailDrawer
        isOpen
        onClose={onClose}
        title="Shipment"
        subtitle="Shared shipping hub"
      >
        <ShipmentsHubSection
          embedded
          openShipmentId={state.shipmentId}
          onOpenShipmentIdConsumed={() => {}}
          onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
        />
      </DetailDrawer>
    );
  }

  return (
    <ProductSearchDrawer
      sku={state.sku}
      hintName={state.hintName}
      onClose={onClose}
      onNavigateRegister={onNavigateRegister}
    />
  );
}

interface BrowseCustomerRow extends Customer {
  wedding_party_name: string | null;
  wedding_party_id: string | null;
  wedding_active: boolean;
}

const WEDDING_PARTY_CUSTOMER_PAGE = 200;

function WeddingPartyCustomersDrawer({
  partyQuery,
  onClose,
  onOpenWeddingParty,
  onUseCustomerInRegister,
  onNavigateRegister,
  onAddToWedding,
  onBookAppointment,
  onOpenTransactionInBackoffice,
}: {
  partyQuery: string;
  onClose: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onUseCustomerInRegister: (c: Customer) => void;
  onNavigateRegister: () => void;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<BrowseCustomerRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Customer | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        wedding_party_q: partyQuery,
        limit: String(WEDDING_PARTY_CUSTOMER_PAGE),
        offset: "0",
      }).toString();
      const res = await fetch(`${baseUrl}/api/customers/browse?${qs}`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as BrowseCustomerRow[];
      setRows(data);
      setHasMore(data.length === WEDDING_PARTY_CUSTOMER_PAGE);
    } catch {
      setRows([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [partyQuery, apiAuth]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({
        wedding_party_q: partyQuery,
        limit: String(WEDDING_PARTY_CUSTOMER_PAGE),
        offset: String(rows.length),
      }).toString();
      const res = await fetch(`${baseUrl}/api/customers/browse?${qs}`, {
        headers: apiAuth(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as BrowseCustomerRow[];
      setRows((prev) => [...prev, ...data]);
      setHasMore(data.length === WEDDING_PARTY_CUSTOMER_PAGE);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, loading, partyQuery, rows.length, apiAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  if (picked) {
    return (
      <CustomerRelationshipHubDrawer
        customer={picked}
        open
        onClose={() => setPicked(null)}
        onOpenWeddingParty={onOpenWeddingParty}
        onStartSale={onUseCustomerInRegister}
        onNavigateRegister={onNavigateRegister}
        onAddToWedding={onAddToWedding}
        onBookAppointment={onBookAppointment}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
        baseUrl={baseUrl}
      />
    );
  }

  return (
    <DetailDrawer
      isOpen
      onClose={onClose}
      title="Wedding Party Customers"
      subtitle={`Filtered by: ${partyQuery}`}
    >
      <div className="space-y-3">
        {loading ? <p className="text-sm text-app-text-muted">Loading...</p> : null}
        {!loading && rows.length === 0 ? (
          <p className="text-sm text-app-text-muted">No customer matches for this wedding party query.</p>
        ) : null}
        {!loading ? (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => setPicked(r)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate font-semibold text-app-text">
                    {r.first_name} {r.last_name}
                  </p>
                  <p className="truncate text-xs text-app-text-muted">
                    {r.phone ?? r.email ?? "No contact"} {r.wedding_party_name ? `· ${r.wedding_party_name}` : ""}
                  </p>
                </button>
                {r.wedding_party_id ? (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenWeddingParty(r.wedding_party_id!);
                      onClose();
                    }}
                    className="rounded-lg border border-app-accent/35 bg-app-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent"
                  >
                    Open Party
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {hasMore && !loading ? (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="w-full rounded-xl border border-app-border py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </DetailDrawer>
  );
}

function CustomerSearchDrawer({
  customer,
  onClose,
  onOpenWeddingParty,
  onUseCustomerInRegister,
  onNavigateRegister,
  navigateAfterAttach = true,
  onAddToWedding,
  onBookAppointment,
  onOpenTransactionInBackoffice,
}: {
  customer: Customer;
  onClose: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onUseCustomerInRegister: (c: Customer) => void;
  onNavigateRegister: () => void;
  navigateAfterAttach?: boolean;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}) {
  return (
    <CustomerRelationshipHubDrawer
      customer={customer}
      open
      onClose={onClose}
      onOpenWeddingParty={onOpenWeddingParty}
      onStartSale={onUseCustomerInRegister}
      onNavigateRegister={onNavigateRegister}
      navigateAfterStartSale={navigateAfterAttach}
      onAddToWedding={onAddToWedding}
      onBookAppointment={onBookAppointment}
      onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      baseUrl={baseUrl}
    />
  );
}

/** Customer profile drawer for POS / embedded contexts (no forced navigation after attach). */
export function PosCustomerDetailDrawer({
  customer,
  open,
  onClose,
  onOpenWeddingParty,
  onAttachToSale,
}: {
  customer: Customer | null;
  open: boolean;
  onClose: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onAttachToSale: (c: Customer) => void;
}) {
  if (!open || !customer) return null;
  return (
    <CustomerRelationshipHubDrawer
      customer={customer}
      open={open}
      onClose={onClose}
      onOpenWeddingParty={onOpenWeddingParty}
      onStartSale={onAttachToSale}
      onNavigateRegister={() => {}}
      navigateAfterStartSale={false}
      baseUrl={baseUrl}
    />
  );
}

function ProductSearchDrawer({
  sku,
  hintName,
  onClose,
  onNavigateRegister,
}: {
  sku: string;
  hintName?: string;
  onClose: () => void;
  onNavigateRegister: () => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [item, setItem] = useState<ResolvedSkuItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (s: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(s)}`,
        { headers: apiAuth() },
      );
      if (!res.ok) {
        let message = "SKU not found";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      setItem((await res.json()) as ResolvedSkuItem);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Load failed");
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [apiAuth]);

  useEffect(() => {
    void load(sku);
  }, [sku, load]);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const title = item?.name ?? hintName ?? sku;
  const subtitle = item ? item.sku : "Product / variant";

  const actions =
    item && !loading && !err ? (
      <>
        <SmartButton
          icon={<Package size={18} aria-hidden />}
          label="Stock"
          value={item.stock_on_hand ?? 0}
          color="blue"
          onClick={() => scrollTo("gs-sku-details")}
        />
        <SmartButton
          icon={<Shirt size={18} aria-hidden />}
          label="Retail"
          value={fmtUsd(item.standard_retail_price)}
          color="emerald"
          onClick={() => scrollTo("gs-sku-details")}
        />
        <SmartButton
          icon={<Wallet size={18} aria-hidden />}
          label="Employee"
          value={fmtUsd(item.employee_price ?? 0)}
          color="accent"
          onClick={() => scrollTo("gs-sku-details")}
        />
      </>
    ) : null;

  return (
    <DetailDrawer
      isOpen
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      actions={actions}
    >
      {loading ? (
        <p className="text-sm text-app-text-muted">Loading SKU…</p>
      ) : err ? (
        <p className="text-sm text-red-600">{err}</p>
      ) : item ? (
        <div className="space-y-8">
          <section id="gs-sku-details">
            <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Variant
            </h3>
            <dl className="grid gap-2 rounded-2xl border border-app-border bg-app-surface-2/80 p-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">SKU</dt>
                <dd className="font-mono font-bold text-app-text">{item.sku}</dd>
              </div>
              {item.variation_label ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-app-text-muted">Variation</dt>
                  <dd className="font-semibold text-app-text">{item.variation_label}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">On hand</dt>
                <dd className="font-black text-app-text">{item.stock_on_hand ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">Standard retail</dt>
                <dd className="font-bold text-emerald-700">
                  {fmtUsd(item.standard_retail_price)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">Employee price</dt>
                <dd className="font-semibold text-app-text">
                  {fmtUsd(item.employee_price ?? 0)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">Unit cost</dt>
                <dd className="font-mono text-app-text">{fmtUsd(item.unit_cost)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">Spiff</dt>
                <dd>{fmtUsd(item.spiff_amount)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-app-text-muted">Tax / unit (state + local)</dt>
                <dd className="font-mono text-xs text-app-text-muted">
                  {fmtUsd(item.state_tax)} + {fmtUsd(item.local_tax)}
                </dd>
              </div>
            </dl>
          </section>

          <div className="border-t border-app-border pt-6">
            <button
              type="button"
              onClick={() => {
                onNavigateRegister();
                onClose();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-nexoNavy py-4 text-sm font-black uppercase tracking-tight text-white transition-colors hover:bg-black/80"
            >
              <ExternalLink size={18} aria-hidden />
              Open Register
            </button>
            <p className="mt-3 text-center text-[10px] text-app-text-muted">
              Add this SKU from the register with the barcode field or scanner.
            </p>
          </div>
        </div>
      ) : null}
    </DetailDrawer>
  );
}
