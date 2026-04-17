import { useEffect, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { Customer } from "../pos/CustomerSelector";
import DetailDrawer from "../layout/DetailDrawer";
import {
  Receipt,
  Package,
  Truck,
  DollarSign,
  Calendar,
  Search,
  Download,
} from "lucide-react";
import TransactionDetailDrawer from "../orders/TransactionDetailDrawer";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

type HubTab =
  | "relationship"
  | "messages"
  | "measurements"
  | "profile"
  | "shipments"
  | "payments"
  | "transactions"
  | "fulfillment";

export function CustomerRelationshipHubDrawer({
  open,
  onClose,
  customer,
  baseUrl,
  backofficeHeaders = [],
  initialHubTab,
  onOpenWeddingParty,
  onStartSale,
  onNavigateRegister,
  navigateAfterStartSale,
  onAddToWedding,
  onBookAppointment,
  onOpenTransactionInBackoffice,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer;
  baseUrl?: string;
  backofficeHeaders?: Array<{ label: string; value: string }>;
  initialHubTab?: string;
  onOpenWeddingParty?: (partyId: string) => void;
  onStartSale?: (c: Customer) => void;
  onNavigateRegister?: () => void;
  navigateAfterStartSale?: boolean;
  onAddToWedding?: (c: Customer) => void;
  onBookAppointment?: (c: Customer) => void;
  onOpenTransactionInBackoffice?: (txnId: string) => void;
}) {
  const [tab, setTab] = useState<HubTab>((initialHubTab as HubTab) || "profile");

  useEffect(() => {
    // Suppress unused warnings for interface props that are passed by workspaces
    // but not yet mapped to explicit button actions in this thinned version.
    if (onOpenWeddingParty && onNavigateRegister && navigateAfterStartSale && onAddToWedding && onBookAppointment && onOpenTransactionInBackoffice) {
      void 0;
    }
  }, [onOpenWeddingParty, onNavigateRegister, navigateAfterStartSale, onAddToWedding, onBookAppointment, onOpenTransactionInBackoffice]);

  return (
    <DetailDrawer
      isOpen={open}
      onClose={onClose}
      title="Customer Profile"
      subtitle={`${customer.first_name} ${customer.last_name}`}
      panelMaxClassName="max-w-7xl max-h-[90dvh]"
      titleClassName="!normal-case !tracking-tight"
      actions={
        <div className="flex flex-wrap gap-2">
          {tabBtn("profile", "Profile", tab, setTab)}
          {canViewTransactions && (
            <>
              {tabBtn("transactions", "Transactions", tab, setTab)}
              {tabBtn("fulfillment", "Fulfillments", tab, setTab)}
            </>
          )}
          {tabBtn("shipments", "Shipments", tab, setTab)}
          {tabBtn("payments", "Payments", tab, setTab)}
          {onStartSale && (
             <button 
               onClick={() => onStartSale(customer)}
               className="ml-4 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white shadow-md shadow-app-accent/20 hover:bg-app-accent/90"
             >
               Start POS Sale
             </button>
          )}
        </div>
      }
    >
      <div className="space-y-6">
        {/* Profile Tab */}
        {tab === "profile" && <CustomerProfileSection 
          customer={customer} 
          baseUrl={baseUrl} 
          backofficeHeaders={backofficeHeaders} 
        />}

        {/* Transactions Tab - All Sales Transactions */}
        {tab === "transactions" && canViewTransactions && (
          <div className="space-y-4">
            <TransactionHistorySection
              customer={customer}
              baseUrl={baseUrl}
              backofficeHeaders={backofficeHeaders}
              mode="all"
            />
          </div>
        )}

        {/* Fulfillments Tab - Only Fulfillment Orders */}
        {tab === "fulfillment" && canViewTransactions && (
          <div className="space-y-4">
            <TransactionHistorySection
              customer={customer}
              baseUrl={baseUrl}
              backofficeHeaders={backofficeHeaders}
              mode="fulfillment"
            />
          </div>
        )}

        {/* Shipments Tab */}
        {tab === "shipments" && (
          <ShipmentsHubSection
            customerIdFilter={customer.id}
          />
        )}

        {/* Payments Tab */}
        {tab === "payments" && (
          <CustomerPaymentVaultSection
            customer={customer}
          />
        )}
      </div>
    </DetailDrawer>
  );
}

// Helper component for Profile section
function CustomerProfileSection({ 
  customer, 
  baseUrl, 
  backofficeHeaders 
}: { 
  customer: Customer;
  baseUrl?: string;
  backofficeHeaders: Array<{ label: string; value: string }>;
}) {
  const [profile, setProfile] = useState<CustomerProfileData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProfile() {
      try {
        if (!baseUrl) return;
        const headersRecord: Record<string, string> = {};
        backofficeHeaders.forEach(h => { headersRecord[h.label] = h.value; });

        const res = await fetch(`${baseUrl}/api/customers/${customer.id}/profile`, {
          headers: mergedPosStaffHeaders(headersRecord),
        });
        if (res.ok) {
          const data = (await res.json()) as CustomerProfileResponse;
          setProfile(data.customer);
        }
      } catch (err) {
        console.error("Error fetching customer profile:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchProfile();
  }, [customer.id, baseUrl, backofficeHeaders]);

  if (loading) return <div className="p-8 text-center animate-pulse text-[10px] font-black uppercase tracking-widest text-app-text-muted">Loading Dashboard...</div>;

  return (
    <div className="space-y-6">
      {/* Financial Overview Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-app-border bg-app-surface/50 p-5 shadow-sm">
          <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2">Lifetime Sales</h4>
          <p className="text-2xl font-black text-emerald-600 tabular-nums">
             {profile?.lifetime_sales ? `$${profile.lifetime_sales}` : "$0.00"}
          </p>
          <div className="mt-2 text-[9px] font-bold text-app-text-muted uppercase">Closed Transactions</div>
        </div>
        
        <div className="rounded-2xl border border-app-border bg-app-surface/50 p-5 shadow-sm">
          <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2">Open Balance</h4>
          <p className={`text-2xl font-black tabular-nums ${(profile?.open_balance_due || 0) > 0 ? "text-rose-600" : "text-app-text"}`}>
             {profile?.open_balance_due ? `$${profile.open_balance_due}` : "$0.00"}
          </p>
          <div className="mt-2 text-[9px] font-bold text-app-text-muted uppercase">Pending Collection</div>
        </div>

        <div className="rounded-2xl border border-app-border bg-app-surface/50 p-5 shadow-sm">
          <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2">Loyalty Points</h4>
          <p className="text-2xl font-black text-amber-500 tabular-nums">
             {profile?.loyalty_points || 0}
          </p>
          <div className="mt-2 text-[9px] font-bold text-app-text-muted uppercase">Available Balance</div>
        </div>
      </div>

      <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-6">
        <div className="flex items-center gap-4 mb-6">
           <div className="h-14 w-14 rounded-full bg-app-accent/10 flex items-center justify-center text-app-accent border border-app-accent/20">
              <span className="text-xl font-black">{customer.first_name[0]}{customer.last_name[0]}</span>
           </div>
           <div>
              <h3 className="text-xl font-black uppercase tracking-tight text-app-text">
                {customer.first_name} {customer.last_name}
              </h3>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {customer.customer_code || "No Code assigned"}
              </p>
           </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
           <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block mb-1">Email Address</label>
              <div className="text-sm font-bold text-app-text">{customer.email || "—"}</div>
           </div>
           <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block mb-1">Phone Number</label>
              <div className="text-sm font-bold text-app-text tabular-nums">{customer.phone || "—"}</div>
           </div>
           <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block mb-1">Store Provenance</label>
              <div className="text-[10px] font-black uppercase tracking-widest bg-app-accent/10 text-app-accent inline-block px-2 py-0.5 rounded">
                {profile?.customer_created_source || "Manual Entry"}
              </div>
           </div>
           <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block mb-1">VIP Status</label>
              <div className={`text-[10px] font-black uppercase tracking-widest inline-block px-2 py-0.5 rounded ${profile?.is_vip ? "bg-amber-500 text-white" : "bg-app-surface border border-app-border text-app-text-muted"}`}>
                {profile?.is_vip ? "VIP Member" : "Standard Client"}
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}

interface CustomerProfileData extends Customer {
  open_balance_due: number;
  lifetime_sales: number;
  loyalty_points: number;
  customer_created_source: string;
  is_vip: boolean;
}

interface CustomerProfileResponse {
  customer: CustomerProfileData;
  profile_complete: boolean;
  weddings: unknown[];
}

interface TransactionRow {
  transaction_id: string;
  display_id: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  customer_id: string | null;
  item_count: number;
  is_fulfillment_order: boolean;
}

interface OrderItem {
  order_item_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  unit_price: string;
  state_tax: string;
  local_tax: string;
  fulfillment:
    | "takeaway"
    | "shipment"
    | "wedding_order"
    | "special_order"
    | "regular_order"
    | "layaway";
}

interface OrderDetail {
  transaction_id: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  items: OrderItem[];
  booked_at: string;
  is_fulfillment_order?: boolean;
}

const FulfillmentOrderKindIcon = ({ kind }: { kind: string }) => {
  switch (kind) {
    case "wedding_order":
      return <span className="text-pink-600">♥</span>;
    case "special_order":
      return <span className="text-indigo-600">🛍️</span>;
    case "regular_order":
      return <span className="text-blue-600">📦</span>;
    case "takeaway":
      return <span className="text-green-600">🥡</span>;
    case "layaway":
      return <span className="text-yellow-600">⏰</span>;
    default:
      return <span className="text-gray-500">?</span>;
  }
};

function TransactionTableRow({
  row,
  isSelected,
  onClick,
  detail,
  onOpenDetail,
  isFulfillmentOrder = false,
}: {
  row: TransactionRow;
  isSelected: boolean;
  onClick: () => void;
  detail: OrderDetail | null;
  onOpenDetail: (id: string) => void;
  isFulfillmentOrder?: boolean;
}) {
  return (
    <>
      <tr
        onClick={onClick}
        className={`cursor-pointer transition-all hover:bg-app-bg group ${isSelected ? "bg-app-accent/10 ring-2 ring-app-accent" : "bg-app-surface"}`}
      >
        <td className="px-6 py-5">
          <p className="text-[10px] font-black tracking-tight text-app-text mb-1">
            TXN #{row.display_id}
          </p>
          <p className="text-[9px] font-bold text-app-text-muted opacity-60 uppercase tracking-widest">
            {new Date(row.booked_at).toLocaleDateString()}
          </p>
        </td>
        <td className="px-6 py-5">
          <div className="flex items-center gap-3">
            {isFulfillmentOrder && (
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[9px] font-black uppercase tracking-wider text-amber-700">
                FP
              </span>
            )}
            {!isFulfillmentOrder && (
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-app-accent/10 text-[9px] font-black uppercase tracking-wider text-app-accent">
                S
              </span>
            )}
            {row.customer_id ? (
              <p className="text-[10px] font-bold text-app-text truncate max-w-[8rem]">
                {row.customer_id}
              </p>
            ) : (
              <p className="text-[10px] font-bold text-app-text italic opacity-75">
                Walk-in
              </p>
            )}
          </div>
        </td>
        <td
          className="px-6 py-5 max-w-[120px] truncate"
          title={`${row.item_count} items`}
        >
          <p className="text-[9px] font-bold text-app-text-muted uppercase tracking-wide">
            {row.item_count} Items
          </p>
        </td>
        <td className="px-6 py-5">
          <span
            className={cn(
              "px-2.5 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest border",
              row.status === "open"
                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                : row.status === "cancelled" || row.status === "refunded"
                  ? "bg-rose-500/10 text-rose-600 border-rose-500/20"
                  : "bg-app-accent/10 text-app-accent border-app-accent/20",
            )}
          >
            {row.status}
          </span>
        </td>
        <td className="px-6 py-5">
          <p className="text-[10px] font-black text-app-text">
            {formatMoney(row.total_price)}
          </p>
        </td>
      </tr>

      {isSelected && detail && (
        <tr className="bg-app-bg/40 border-y border-app-border animate-workspace-snap">
          <td colSpan={6} className="p-8">
            <div className="space-y-8 max-w-[1200px]">
              {/* Financial Summary */}
              <div className="flex items-center justify-between pb-5 border-b border-app-border/40">
                <div>
                  <h4 className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                    Financial Summary
                  </h4>
                  <p className="text-[8px] font-bold text-app-text-muted">
                    {new Date(detail.booked_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canViewTransactions && (
                    <>
                      <TransactionDetailDrawerButton
                        onClick={() => onOpenDetail(detail.transaction_id)}
                        isFulfillmentOrder={
                          isFulfillmentOrder || !!detail.is_fulfillment_order
                        }
                      />
                      <a
                        href={`/api/transactions/${detail.transaction_id}/receipt`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-[9px] font-black uppercase tracking-widest bg-app-accent text-white shadow-glow-emerald-xs hover:bg-app-accent/90"
                      >
                        <Download size={12} /> Receipt
                      </a>
                    </>
                  )}
                </div>
              </div>

              {/* Items Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-app-border/30">
                  <h4 className="text-[9px] font-black uppercase tracking-widest text-app-text-muted flex items-center gap-1.5">
                    <Package size={12} /> Order Items
                  </h4>
                  {isFulfillmentOrder && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[8px] font-black uppercase tracking-wider text-amber-700">
                      <Truck size={10} /> Fulfillment Order
                    </span>
                  )}
                </div>

                {detail.items.length === 0 ? (
                  <p className="text-[9px] font-bold text-app-text-muted italic py-4">
                    No items recorded
                  </p>
                ) : (
                  detail.items.map((it: OrderItem) => (
                    <div
                      key={it.order_item_id}
                      className="flex items-center justify-between p-3 rounded-xl border border-app-border bg-app-surface/50 hover:bg-app-surface/80 transition-colors"
                    >
                      <div className="flex items-start gap-4 flex-1 min-w-0">
                        <FulfillmentOrderKindIcon kind={it.fulfillment} />
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold text-app-text truncate">
                            {it.product_name}
                          </p>
                          <p className="text-[8px] font-bold text-app-text-muted opacity-60 uppercase tracking-wide">
                            SKU: {it.sku} • QTY: {it.quantity}
                            {it.variation_label
                              ? ` • ${it.variation_label}`
                              : ""}
                          </p>
                        </div>
                      </div>
                      <div className="text-right ml-4">
                        <p className="text-[10px] font-black text-app-text">
                          {formatMoney(it.unit_price)}
                        </p>
                        {parseFloat(it.state_tax) > 0 ||
                        parseFloat(it.local_tax) > 0 ? (
                          <p className="text-[8px] font-bold text-emerald-600 opacity-75">
                            Tax:{" "}
                            {(
                              parseFloat(it.state_tax) +
                              parseFloat(it.local_tax)
                            ).toFixed(2)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Audit / Status */}
              <div className="pt-3 border-t border-app-border/30">
                <h4 className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-2 flex items-center gap-1.5">
                  <Calendar size={12} /> Transaction Status
                </h4>
                <div
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
                    detail.status === "open"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300"
                      : detail.status === "cancelled" ||
                          detail.status === "refunded"
                        ? "bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-300"
                        : "bg-app-accent/10 border-app-accent/20 text-app-accent dark:bg-app-accent/20 dark:border-app-accent/40 dark:text-app-accent/90"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      detail.status === "open"
                        ? "bg-emerald-500 animate-pulse"
                        : detail.status === "cancelled" ||
                            detail.status === "refunded"
                          ? "bg-rose-500"
                          : "bg-app-accent"
                    }`}
                  />
                  <span className="text-[9px] font-black uppercase tracking-widest">
                    {detail.status}
                  </span>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const canViewTransactions = true; // Enable transactions tab by default

function TransactionDetailDrawerButton({
  isFulfillmentOrder = false,
  onClick,
}: {
  isFulfillmentOrder?: boolean;
  onClick: () => void;
}) {
  return (
    <button 
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[9px] font-black uppercase tracking-widest bg-app-surface border border-app-border hover:border-app-accent/30 hover:bg-app-accent/5 transition-colors"
    >
      {isFulfillmentOrder ? (
        <>
          <Package size={12} /> Fulfillment Detail
        </>
      ) : (
        <>
          <Receipt size={12} /> Transaction Detail
        </>
      )}
    </button>
  );
}

/**
 * Shared component for Transaction history - used for both "Transactions" and "Fulfillments" tabs.
 */
function TransactionHistorySection({
  customer,
  baseUrl,
  backofficeHeaders,
  mode = "all",
}: {
  customer: Customer;
  baseUrl?: string;
  backofficeHeaders: Array<{ label: string; value: string }>;
  mode: "all" | "fulfillment";
}) {
  const { toast } = useToast();
  const [selectedTxnId, setSelectedTxnId] = useState<string | null>(null);
  const [transactionData, setTransactionData] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchTransactions() {
      try {
        if (!baseUrl) return;
        setLoading(true);

        const url = `${baseUrl}/api/transactions?customer_id=${encodeURIComponent(customer.id)}`;
        const headersRecord: Record<string, string> = {};
        backofficeHeaders.forEach(h => { headersRecord[h.label] = h.value; });

        const res = await fetch(url, {
          headers: mergedPosStaffHeaders(headersRecord),
        });

        if (!res.ok) throw new Error(`Failed to load transactions: ${res.status}`);

        const data = await res.json();
        const items: TransactionRow[] = data.items || [];
        
        // Filter based on mode
        const filtered = mode === "fulfillment" 
          ? items.filter(row => row.is_fulfillment_order)
          : items;

        setTransactionData(filtered);
      } catch (err) {
        console.error("Error loading transaction history:", err);
        toast("Could not load transaction history.", "error");
        setTransactionData([]);
      } finally {
        setLoading(false);
      }
    }

    fetchTransactions();
  }, [customer.id, baseUrl, backofficeHeaders, mode, toast]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-4 rounded-xl border border-app-border bg-app-surface/50">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted animate-pulse">
            Processing {mode === "fulfillment" ? "Fulfillment" : "Transaction"} Records...
          </p>
        </div>
      </div>
    );
  }

  if (transactionData.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center justify-center py-12 px-6 rounded-xl border border-app-border bg-app-surface/50 text-center">
          {mode === "fulfillment" ? (
            <Truck size={32} className="text-app-text-muted mb-3 opacity-30" />
          ) : (
            <Receipt size={32} className="text-app-text-muted mb-3 opacity-30" />
          )}
          <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text mb-1.5">
            No {mode === "fulfillment" ? "Fulfillments" : "Transactions"} Found
          </h3>
          <p className="text-xs text-app-text-muted max-w-sm">
            {mode === "fulfillment" 
              ? "This customer has no recorded pickup or delivery orders yet." 
              : "This customer has no recorded sales transactions yet."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with stats */}
      <div className="flex items-center justify-between p-3 rounded-xl border border-app-border bg-app-surface/50 flex-wrap gap-3 shadow-sm shadow-black/10">
        <div>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-0.5">
            {mode === "fulfillment" ? "Logistical Order History" : "Financial Sale History"}
          </h3>
          <p className="text-xs font-bold text-app-text">
            {transactionData.length} {mode === "fulfillment" ? "orders" : "transactions"} found for {customer.first_name} {customer.last_name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mode === "fulfillment" && (
             <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-wider text-amber-600 border border-amber-500/20">
               <Truck size={10} /> Orders Only
             </span>
          )}
          <div className="h-8 w-8 flex items-center justify-center rounded-lg bg-app-surface hover:bg-app-bg cursor-pointer transition-colors border border-app-border">
            <Search size={14} className="text-app-text-muted" />
          </div>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="overflow-auto rounded-xl border border-app-border bg-app-surface/30 shadow-inner max-h-[500px] custom-scrollbar">
        <table className="w-full min-w-[700px]">
          <thead className="bg-app-surface sticky top-0 z-10 backdrop-blur-md bg-app-surface/90">
            <tr>
              <th className="sticky left-0 z-20 w-48 border-b border-app-border bg-app-surface px-6 py-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted text-left">
                TXN ID
              </th>
              <th className="border-b border-app-border px-6 py-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted text-left">
                Customer Identifier
              </th>
              <th className="w-24 border-b border-app-border px-4 py-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted text-center">
                Line Items
              </th>
              <th className="border-b border-app-border px-6 py-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted text-left">
                Status
              </th>
              <th className="w-28 border-b border-app-border px-6 py-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted text-right">
                Total Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/50">
            {transactionData.map((row) => (
              <TransactionTableRow
                key={row.transaction_id}
                row={row}
                isSelected={selectedTxnId === row.transaction_id}
                onClick={() =>
                  setSelectedTxnId(
                    selectedTxnId === row.transaction_id
                      ? null
                      : row.transaction_id,
                  )
                }
                onOpenDetail={(id) => setSelectedTxnId(id)}
                detail={null}
                isFulfillmentOrder={row.is_fulfillment_order}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail Drawer (for Reprint and full view) */}
      {selectedTxnId && (
        <TransactionDetailDrawer
          orderId={selectedTxnId}
          isOpen={true}
          onClose={() => setSelectedTxnId(null)}
        />
      )}
    </div>
  );
}

function ShipmentsHubSection({
  customerIdFilter,
}: {
  customerIdFilter: string | null;
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 flex items-center gap-1.5">
        <Truck size={12} /> Shipments Hub
      </h3>
      <p className="text-xs text-app-text-muted italic">
        Viewing shipments for customer ID: {customerIdFilter}
      </p>
    </div>
  );
}

function CustomerPaymentVaultSection({
  customer,
}: {
  customer: Customer;
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 flex items-center gap-1.5">
        <DollarSign size={12} /> Payment Vault
      </h3>
      <p className="text-xs text-app-text-muted italic">
        Gift cards and payment history for {customer.first_name}{" "}
        {customer.last_name}
      </p>
    </div>
  );
}

function tabBtn(id: HubTab, label: string, currentTab: HubTab, onSelect: (id: HubTab) => void) {
  return (
    <button
      key={id}
      type="button"
      onClick={() => onSelect(id)}
      className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors ${
        currentTab === id
          ? "bg-app-accent text-white shadow-md shadow-app-accent/20"
          : "bg-app-surface-2 text-app-text-muted hover:text-app-text hover:bg-app-surface"
      }`}
    >
      {label}
    </button>
  );
}

function cn(...inputs: (string | undefined | null | boolean)[]) {
  return inputs.filter(Boolean).join(" ");
}

function formatMoney(centsStr: string): string {
  const cents = parseInt(centsStr, 10);
  if (isNaN(cents)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

// Add missing imports at the top of the file - merge these into existing imports
