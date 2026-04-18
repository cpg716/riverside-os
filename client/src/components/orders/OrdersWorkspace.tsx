import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useRegisterGate } from "../../context/RegisterGateContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import RegisterRequiredModal from "../layout/RegisterRequiredModal";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import {
  centsToFixed2,
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import {
  Activity,
  ArrowLeftRight,
  Clock,
  Heart,
  Package,
  Search,
  Wrench,
  ShoppingBag,
  Trash2,
  RotateCcw,
} from "lucide-react";
import AttachOrderToWeddingModal from "./AttachOrderToWeddingModal";
import DashboardGridCard from "../ui/DashboardGridCard";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: (string | undefined | null | boolean)[]) {
  return twMerge(clsx(inputs));
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
  customer_name: string | null;
  wedding_member_id: string | null;
  wedding_party_id: string | null;
  party_name: string | null;
  primary_salesperson_name?: string | null;
  item_count: number;
  order_kind: string;
  counterpoint_customer_code?: string | null;
}

interface OrderItem {
  order_item_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned: number;
  unit_price: string;
  unit_cost?: string;
  state_tax: string;
  local_tax: string;
  fulfillment: FulfillmentKind;
  /** Takeaway lines can be fulfilled at checkout; orders at pickup. */
  is_fulfilled?: boolean;
}

interface OrderDetail {
  transaction_id: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  exchange_group_id: string | null;
  items: OrderItem[];
  booked_at: string;
  wedding_member_id: string | null;
  is_forfeited: boolean;
  forfeited_at: string | null;
  forfeiture_reason: string | null;
}

interface OrderAuditEvent {
  id: string;
  event_kind: string;
  summary: string;
  created_at: string;
}




interface ScanItem {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  standard_retail_price: string | number;
  unit_cost: string | number;
  state_tax: string | number;
  local_tax: string | number;
}

function money(v: string | number) {
  return formatUsdFromCents(parseMoneyToCents(v));
}

const OrderKindIcon = ({ kind, className }: { kind: string; className?: string }) => {
  switch (kind) {
    case "wedding_order": return <Heart size={18} className={className} />;
    case "special_order": return <ShoppingBag size={18} className={className} />;
    case "regular_order": return <Package size={18} className={className} />;
    case "custom": return <Wrench size={18} className={className} />;
    case "layaway": return <Clock size={18} className={className} />;
    default: return <Search size={18} className={className} />;
  }
};

type Section = "open" | "all";
type FulfillmentKind = "takeaway" | "shipment" | "wedding_order" | "special_order" | "regular_order" | "layaway";

interface OrderRowActions {
  onOpenInRegister?: (orderId: string) => void;
  onAttachToWedding: () => void;
  onCancel: () => void;
  onReturnAll: () => void;
  onProcessRefund: () => void;
  deleteLine: (it: OrderItem) => void;
  addBySku: () => void;
  setSku: (s: string) => void;
  sku: string;
  canModify: boolean;
  canRefund: boolean;
  canAttemptCancel: boolean;
  _canSuitSwap: boolean;
  _orderAllowsLineSwap: boolean;
  setSuitSwapTarget: (it: OrderItem | null) => void;
}



function orderKindLabel(kind: string) {
  switch (kind) {
    case "wedding_order":
      return "Wedding";
    case "special_order":
      return "Order";
    case "custom":
      return "Custom";
    case "layaway":
      return "Layaway";
    default:
      return "Order";
  }
}

function OrderTableRow({ row, isSelected, onClick, detail, audit, actions }: {
  row: TransactionRow;
  isSelected: boolean; 
  onClick: () => void;
  detail: OrderDetail | null;
  audit: OrderAuditEvent[];
  actions: OrderRowActions;
}) {
  return (
    <>
      <tr 
        onClick={onClick}
        onDoubleClick={() => actions.onOpenInRegister?.(row.transaction_id)}
        className={cn(
          "cursor-pointer transition-all hover:bg-app-bg group",
          isSelected ? "bg-app-bg/80 border-l-4 border-emerald-500" : "bg-app-surface border-l-4 border-transparent"
        )}
      >
        <td className="px-6 py-5">
           <p className="text-[11px] font-black tracking-tight text-app-text mb-1">{row.display_id}</p>
           <p className="text-[9px] font-bold text-app-text-muted opacity-60 uppercase tracking-widest italic">
             {new Date(row.booked_at).toLocaleDateString()}
           </p>
        </td>
        <td className="px-6 py-5">
           <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-600 text-[10px] font-black">
                {row.customer_name?.[0] ?? row.counterpoint_customer_code?.[0] ?? "W"}
              </div>
              <div>
                <p className="text-[11px] font-bold text-app-text flex items-center gap-1.5">
                  {row.customer_name ?? `CP: ${row.counterpoint_customer_code ?? "Unknown"}`}
                  {row.party_name && <Heart size={10} className="text-rose-500" />}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <p className="text-[9px] font-bold text-app-text-muted opacity-60 uppercase tracking-widest italic">
                    {orderKindLabel(row.order_kind)}
                  </p>
                  {row.counterpoint_customer_code && (
                    <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-emerald-600">
                      CP Open Doc
                    </span>
                  )}
                  {row.party_name && <p className="text-[9px] font-bold text-rose-500/60 uppercase tracking-tighter italic">{row.party_name}</p>}
                </div>
              </div>
           </div>
        </td>
        <td className="px-6 py-5 max-w-[300px]">
           <p className="text-[10px] font-bold text-app-text-muted italic opacity-80 truncate">
             {row.item_count} item{row.item_count === 1 ? "" : "s"}
             {row.primary_salesperson_name ? ` · ${row.primary_salesperson_name}` : ""}
           </p>
        </td>
        <td className="px-6 py-5">
           <span className={cn(
             "px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border",
             row.counterpoint_customer_code
               ? "border-sky-500/20 bg-sky-500/10 text-sky-600"
               : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
           )}>
             {row.status}
           </span>
        </td>
        <td className="px-6 py-5">
           {detail ? (
             <>
               <p className="text-[11px] font-black text-app-text">{money(detail.total_price)}</p>
               <p className="text-[9px] font-bold text-app-text-muted opacity-80 mt-1">
                 Paid {money(detail.amount_paid)}
               </p>
             </>
           ) : (
             <p className="text-[9px] font-bold text-app-text-muted opacity-40 italic tracking-widest">Select record...</p>
           )}
        </td>
        <td className="px-6 py-5 text-right flex items-center justify-end gap-3">
           {detail && (
             <p className={cn("text-[11px] font-black", parseMoneyToCents(detail.balance_due) > 0 ? "text-amber-500" : "text-app-text-muted opacity-40")}>
               {money(detail.balance_due)}
             </p>
           )}
           <button 
             onClick={(e) => { e.stopPropagation(); actions.onOpenInRegister?.(row.transaction_id); }}
             className="opacity-0 group-hover:opacity-100 transition-all px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-[9px] font-black uppercase tracking-widest"
           >
             Open
           </button>
        </td>
      </tr>
      {isSelected && (
        <tr className="bg-app-bg/40 border-y border-emerald-500/10 animate-workspace-snap">
          <td colSpan={6} className="p-8">
            {detail ? (
              <div className="space-y-8 max-w-[1200px]">
                {/* Action Board Row */}
                <div className="flex items-center justify-between pb-6 border-b border-app-border/40">
                  <div className="flex items-center gap-2">
                    {actions.onOpenInRegister && (
                      <button onClick={() => actions.onOpenInRegister!(detail.transaction_id)} className="px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-white bg-emerald-600 shadow-glow-emerald-xs">Open in POS</button>
                    )}
                    {actions.canModify && !detail.wedding_member_id && detail.status !== "cancelled" && (
                      <button onClick={actions.onAttachToWedding} className="px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text bg-app-surface border border-app-border">Attach Wedding</button>
                    )}
                    {actions.canAttemptCancel && detail.status !== "cancelled" && (
                      <button onClick={actions.onCancel} className="px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-rose-500 bg-app-surface border border-app-border">Cancel Order</button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {actions.canModify && detail.status !== "cancelled" && (
                      <button onClick={actions.onReturnAll} className="px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text bg-app-surface border border-app-border">Return All</button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-12">
                   {/* Items Sub-Table */}
                     <div>
                     <div className="flex items-center justify-between mb-4 px-2">
                        <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted italic">Order Lines</h4>
                        {actions.canModify && detail.status !== "cancelled" && (
                          <div className="flex gap-2">
                            <input 
                              value={actions.sku} 
                              onChange={(e) => actions.setSku(e.target.value)}
                              placeholder="Add SKU..."
                              className="h-8 w-32 rounded-lg border border-app-border bg-app-bg px-3 text-[10px] font-bold outline-none"
                            />
                            <button onClick={actions.addBySku} className="text-[10px] font-black uppercase tracking-widest text-app-accent mt-0.5">Add</button>
                          </div>
                        )}
                     </div>
                     <div className="space-y-3">
                        {detail.items.map((it: OrderItem) => (
                          <div key={it.order_item_id} className="p-4 rounded-xl border border-app-border bg-app-surface/60 flex items-center justify-between group">
                             <div className="flex items-center gap-4">
                                <OrderKindIcon kind={it.fulfillment} className="text-app-text-muted" />
                                <div>
                                   <p className="text-[11px] font-black text-app-text">{it.product_name}</p>
                                   <p className="text-[9px] font-bold text-app-text-muted opacity-60 mt-0.5">{it.sku} · QTY {it.quantity}</p>
                                </div>
                             </div>
                             <div className="flex items-center gap-2">
                                <div className="text-right mr-4">
                                   <p className="text-[11px] font-black text-app-text">{money(it.unit_price)}</p>
                                </div>
                                {it.fulfillment === "takeaway" && actions._canSuitSwap && actions._orderAllowsLineSwap && (
                                  <button onClick={() => actions.setSuitSwapTarget(it)} className="text-app-text-muted hover:text-purple-500 p-2"><ArrowLeftRight size={14}/></button>
                                )}
                                {actions.canModify && detail.status !== "cancelled" && (
                                  <button onClick={() => actions.deleteLine(it)} className="text-app-text-muted hover:text-rose-500 p-2 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={14}/></button>
                                )}
                             </div>
                          </div>
                        ))}
                     </div>
                   </div>

                   {/* Audit / Logistics */}
                   <div>
                     <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted italic mb-4 px-2">Order Activity</h4>
                     <div className="p-6 rounded-2xl border border-app-border bg-app-surface/40 space-y-4">
                        {audit.slice(0, 4).map((e: OrderAuditEvent) => (
                           <div key={e.id} className="flex gap-4">
                              <div className="shrink-0 h-1.5 w-1.5 rounded-full bg-emerald-500 mt-1.5" />
                              <div className="min-w-0">
                                 <p className="text-[11px] font-bold text-app-text leading-tight">{e.summary}</p>
                                 <p className="text-[9px] font-bold text-app-text-muted opacity-60 mt-1 uppercase tracking-widest italic">{new Date(e.created_at).toLocaleDateString()}</p>
                              </div>
                           </div>
                        ))}
                     </div>
                   </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center p-20 gap-4 opacity-50">
                 <div className="h-6 w-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                 <p className="text-[11px] font-black uppercase tracking-widest italic">Loading order record...</p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

export default function OrdersWorkspace({
  activeSection = "open",
  onOpenInRegister,
  deepLinkTxnId = null,
  onDeepLinkTxnConsumed,
}: {
  activeSection?: string;
  onOpenInRegister?: (orderId: string) => void;
  /** When set, selects this order in the list and opens detail (e.g. from CRM hub). */
  deepLinkTxnId?: string | null;
  onDeepLinkTxnConsumed?: () => void;
}) {
  const section: Section = activeSection === "all" ? "all" : "open";
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { goToOpenRegister } = useRegisterGate();

  const canModify = hasPermission("orders.modify");
  const canCancel = hasPermission("orders.cancel");
  const canVoidUnpaid = hasPermission("orders.void_sale");
  const canRefund = hasPermission("orders.refund_process");
  const _canSuitSwap = hasPermission("orders.suit_component_swap") && canModify;

  const [transactionRows, setTransactionRows] = useState<TransactionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [sku, setSku] = useState("");
  const [audit, setAudit] = useState<OrderAuditEvent[]>([]);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 5000; // High-volume non-paginated limit for operational focus

  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundTargetOrderId, setRefundTargetOrderId] = useState<string | null>(null);
  const [refundAmountStr, setRefundAmountStr] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [refundGiftCode, setRefundGiftCode] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);
  const [registerRequiredOpen, setRegisterRequiredOpen] = useState(false);
  useShellBackdropLayer(refundModalOpen || registerRequiredOpen);
  const { dialogRef: refundDialogRef, titleId: refundTitleId } = useDialogAccessibility(
    refundModalOpen && !registerRequiredOpen,
    {
      onEscape: () => setRefundModalOpen(false),
      closeOnEscape: !refundBusy,
    },
  );
  // exchangeOtherId removed
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [suitSwapTarget, setSuitSwapTarget] = useState<OrderItem | null>(null);
  const [suitSwapSku, setSuitSwapSku] = useState("");
  const [suitSwapNote, setSuitSwapNote] = useState("");
  const [suitSwapBusy, setSuitSwapBusy] = useState(false);
  const [attachWeddingModalOpen, setAttachWeddingModalOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [salespersonFilter, setSalespersonFilter] = useState("all");
  const [datePreset, setDatePreset] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, kindFilter, paymentFilter, salespersonFilter, datePreset, dateFrom, dateTo, section]);

  const loadPipelineStats = useCallback(async () => {
    try {
      await fetch(`${baseUrl}/api/transactions/pipeline-stats`, {
        headers: backofficeHeaders(),
      });
    } catch {
      // ignore
    }
  }, [baseUrl, backofficeHeaders]);

  const loadRefundsDue = useCallback(async () => {
    // Logic removed to stabilize build
  }, []);

  const loadTransactions = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));
    params.set("status_scope", section === "open" ? "open" : "closed");
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (kindFilter !== "all") params.set("kind_filter", kindFilter);
    if (paymentFilter !== "all") params.set("payment_filter", paymentFilter);
    if (salespersonFilter !== "all") params.set("salesperson_filter", salespersonFilter);
    if (dateFrom) params.set("date_from", new Date(dateFrom).toISOString());
    if (dateTo) params.set("date_to", new Date(dateTo).toISOString());

    const res = await fetch(`${baseUrl}/api/transactions?${params.toString()}`, {
      headers: backofficeHeaders(),
    });
    if (res.ok) {
       const data = await res.json();
       setTransactionRows(data.items);
       setTotalCount(data.total_count);
    }
  }, [baseUrl, backofficeHeaders, page, debouncedSearch, kindFilter, paymentFilter, salespersonFilter, dateFrom, dateTo, section]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`${baseUrl}/api/transactions/${id}`, {
      headers: backofficeHeaders(),
    });
    if (!res.ok) return;
    setDetail((await res.json()) as OrderDetail);
    const a = await fetch(`${baseUrl}/api/transactions/${id}/audit`, {
      headers: backofficeHeaders(),
    });
    if (a.ok) setAudit((await a.json()) as OrderAuditEvent[]);
    setReturnQtyDraft({});
    setSuitSwapTarget(null);
    setSuitSwapSku("");
    setSuitSwapNote("");
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void loadPipelineStats();
  }, [loadPipelineStats]);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  useEffect(() => {
    if (!deepLinkTxnId) return;
    setSelectedId(deepLinkTxnId);
    onDeepLinkTxnConsumed?.();
  }, [deepLinkTxnId, onDeepLinkTxnConsumed]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setRefundTargetOrderId(null);
      return;
    }
    void loadDetail(selectedId);
    setRefundTargetOrderId(selectedId);
  }, [selectedId, loadDetail]);

// updateItem removed

  const _orderAllowsLineSwap =
    !!detail &&
    (detail.status === "open" || detail.status === "pending_measurement");

  const submitSuitSwap = async () => {
    if (!detail || !suitSwapTarget || !suitSwapSku.trim()) return;
    setSuitSwapBusy(true);
    try {
      const scanRes = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(suitSwapSku.trim())}`,
        { headers: backofficeHeaders() },
      );
      if (!scanRes.ok) {
        toast("Could not resolve replacement SKU (check catalog / staff headers).", "error");
        return;
      }
      const scanned = (await scanRes.json()) as ScanItem;
      const res = await fetch(
        `${baseUrl}/api/transactions/${detail.transaction_id}/items/${suitSwapTarget.order_item_id}/suit-swap`,
        {
          method: "POST",
          headers: jsonHeaders(backofficeHeaders),
          body: JSON.stringify({
            in_variant_id: scanned.variant_id,
            note: suitSwapNote.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Swap failed", "error");
        return;
      }
      toast("Line updated and inventory recorded where applicable.", "success");
      setSuitSwapTarget(null);
      setSuitSwapSku("");
      setSuitSwapNote("");
      await loadDetail(detail.transaction_id);
      await loadTransactions();
    } finally {
      setSuitSwapBusy(false);
    }
  };

  const addBySku = async () => {
    if (!detail || !sku.trim() || !canModify) return;
    const scanRes = await fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(sku.trim())}`, {
      headers: backofficeHeaders(),
    });
    if (!scanRes.ok) return;
    const item = (await scanRes.json()) as ScanItem;
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/items`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({
        product_id: item.product_id,
        variant_id: item.variant_id,
        fulfillment: detail.wedding_member_id ? "wedding_order" : "special_order",
        quantity: 1,
        unit_price: centsToFixed2(parseMoneyToCents(item.standard_retail_price)),
        unit_cost: centsToFixed2(parseMoneyToCents(item.unit_cost)),
        state_tax: centsToFixed2(parseMoneyToCents(item.state_tax)),
        local_tax: centsToFixed2(parseMoneyToCents(item.local_tax)),
      }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Add item failed", "error");
      return;
    }
    setSku("");
    await loadDetail(detail.transaction_id);
    await loadTransactions();
  };

  const orderUnpaid = detail
    ? parseMoneyToCents(detail.amount_paid) === 0
    : false;
  const canAttemptCancel =
    !!detail &&
    (canCancel || (canVoidUnpaid && orderUnpaid));

  const runCancelOrder = async () => {
    if (!detail || !canAttemptCancel) return;
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ status: "cancelled" }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Cancel failed", "error");
      return;
    }
    setCancelConfirmOpen(false);
    toast("Order cancelled", "info");
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    void loadRefundsDue();
  };

  const deleteLine = async (item: OrderItem) => {
    if (!detail || !canModify) return;
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/items/${item.order_item_id}`, {
      method: "DELETE",
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Delete failed", "error");
      return;
    }
    await loadDetail(detail.transaction_id);
    await loadTransactions();
  };

  /** applyReturns is used in ConfirmationModal or similar, if unused prefix with _ */
  const _applyReturns = async () => {
    if (!detail || !canModify || detail.status === "cancelled") return;
    const lines: { order_item_id: string; quantity: number; reason?: string }[] = [];
    for (const it of detail.items) {
      const raw = (returnQtyDraft[it.order_item_id] ?? "").trim();
      if (!raw) continue;
      const q = Number(raw);
      if (!Number.isFinite(q) || q <= 0) continue;
      const max = it.quantity - (it.quantity_returned ?? 0);
      if (q > max) {
        toast(`Return qty too high for line ${it.sku} (max ${max})`, "error");
        return;
      }
      lines.push({ order_item_id: it.order_item_id, quantity: q, reason: "return" });
    }
    if (lines.length === 0) {
      toast("Enter return quantities first", "info");
      return;
    }
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/returns`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ lines }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Return failed", "error");
      return;
    }
    toast("Return recorded", "success");
    setReturnQtyDraft({});
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    void loadRefundsDue();
  };

// linkExchange logic removed for build stabilization

  const submitProcessRefund = async () => {
    if (!refundTargetOrderId || !canRefund) return;
    setRefundBusy(true);
    try {
      const cur = await fetch(`${baseUrl}/api/sessions/current`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (cur.status === 409) {
        toast(
          "More than one register is open. Choose which register to use when prompted, then try again.",
          "error",
        );
        return;
      }
      if (!cur.ok) {
        setRegisterRequiredOpen(true);
        return;
      }
      const sess = (await cur.json()) as { session_id: string };
      const amtCents = parseMoneyToCents(refundAmountStr.trim());
      if (amtCents <= 0) {
        toast("Enter a valid refund amount", "error");
        return;
      }
      const body: Record<string, unknown> = {
        session_id: sess.session_id,
        payment_method: refundMethod.trim(),
        amount: centsToFixed2(amtCents),
      };
      if (refundMethod.toLowerCase().includes("gift")) {
        body.gift_card_code = refundGiftCode.trim();
      }
      const res = await fetch(`${baseUrl}/api/transactions/${refundTargetOrderId}/refunds/process`, {
        method: "POST",
        headers: jsonHeaders(backofficeHeaders),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Refund failed", "error");
        return;
      }
      toast("Refund processed", "success");
      setRefundModalOpen(false);
      await loadRefundsDue();
      if (detail?.transaction_id === refundTargetOrderId) await loadDetail(refundTargetOrderId);
      await loadTransactions();
    } finally {
      setRefundBusy(false);
    }
  };

  const salespersonOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of transactionRows) {
      const n = (r.primary_salesperson_name ?? "").trim();
      if (n) set.add(n);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [transactionRows]);

  return (
    <div className="flex flex-1 flex-col bg-transparent">


      <div className="flex shrink-0 items-center justify-between p-6 sm:p-10 pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-black uppercase tracking-widest text-app-text">Order Management Hub</h1>
          <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-[0.2em] italic opacity-60">
            {section === "open" ? "Current Open Orders & Counterpoint Open Docs" : "Closed Order History"}
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setSearch("");
              setKindFilter("all");
              setPaymentFilter("all");
              setSalespersonFilter("all");
              setDatePreset("all");
              setDateFrom("");
              setDateTo("");
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-rose-500 hover:bg-rose-500/5 transition-all"
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 text-emerald-600 shadow-soft-xs">
            <Activity size={14} className={section === "open" ? "animate-pulse" : ""} />
            <p className="text-[10px] font-black uppercase tracking-widest italic">
              {section === "open" ? "Open Order View" : "Closed Order View"}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-1 p-6 sm:p-10 sm:pt-4">
        {/* Unified Order Dashboard */}
        <DashboardGridCard 
          title={section === "open" ? "Open Orders" : "Closed Orders"}
          subtitle={`${totalCount} records detected`}
          icon={Package}
          className="flex-1"
          contentClassName="p-0 flex flex-col"
        >
          {/* Header Filters Area */}
          <div className="px-8 py-6 border-b border-app-border bg-app-bg/20 flex flex-wrap items-center gap-4">
            <div className="relative group flex-1 min-w-[300px]">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted opacity-40 group-focus-within:text-app-accent group-focus-within:opacity-100 transition-all" size={18} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SEARCH ORDERS (By name, phone number, Order #, etc)"
                
                className="w-full h-11 rounded-xl border border-app-border bg-app-surface px-11 text-[11px] font-black uppercase tracking-wider transition-all focus:border-app-accent/40 focus:ring-4 focus:ring-app-accent/5 outline-none shadow-soft-sm"
              />
            </div>
            
            <div className="flex items-center gap-2">
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                className="h-11 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest transition-all focus:border-app-accent/40 outline-none shadow-soft-sm hover:bg-app-bg"
              >
                <option value="all">Kind: All</option>
                <option value="special_order">Order</option>
                <option value="wedding_order">Wedding</option>
                <option value="custom">Custom</option>
              </select>
              <select
                value={paymentFilter}
                onChange={(e) => setPaymentFilter(e.target.value)}
                className="h-11 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest transition-all focus:border-app-accent/40 outline-none shadow-soft-sm hover:bg-app-bg"
              >
                <option value="all">Payment: All</option>
                <option value="paid">Paid</option>
                <option value="partial">Partial</option>
                <option value="unpaid">Unpaid</option>
              </select>
              <select
                value={salespersonFilter}
                onChange={(e) => setSalespersonFilter(e.target.value)}
                className="h-11 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest transition-all focus:border-app-accent/40 outline-none shadow-soft-sm hover:bg-app-bg"
              >
                <option value="all">Staff: All</option>
                {salespersonOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              <select
                value={datePreset}
                onChange={(e) => {
                  const val = e.target.value;
                  setDatePreset(val);
                  if (val === "today") {
                    const d = new Date().toISOString().split("T")[0];
                    setDateFrom(d);
                    setDateTo(d);
                  } else if (val === "30d") {
                    const d = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
                    setDateFrom(d);
                    setDateTo(new Date().toISOString().split("T")[0]);
                  } else if (val === "all") {
                    setDateFrom("");
                    setDateTo("");
                  }
                }}
                className="h-11 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest transition-all focus:border-app-accent/40 outline-none shadow-soft-sm hover:bg-app-bg"
              >
                <option value="all">Date: Always</option>
                <option value="today">Today</option>
                <option value="30d">30 Days</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>

          {/* Wide Table Implementation */}
          <div className="flex-1 custom-scrollbar">
            <table className="w-full text-left border-collapse min-w-[1000px]">
              <thead className="sticky top-0 z-20 bg-app-surface/80 backdrop-blur-md border-b border-app-border">
                <tr>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">ID / Date</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Customer</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Order Summary</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Status</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Financials</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border/40">
                {transactionRows.map((r) => (
                  <OrderTableRow 
                    key={r.transaction_id} 
                    row={r} 
                    isSelected={selectedId === r.transaction_id}
                    onClick={() => setSelectedId(selectedId === r.transaction_id ? null : r.transaction_id)}
                    detail={selectedId === r.transaction_id ? detail : null}
                    audit={selectedId === r.transaction_id ? audit : []}
                    actions={{
                      onOpenInRegister,
                      onAttachToWedding: () => setAttachWeddingModalOpen(true),
                      onCancel: () => setCancelConfirmOpen(true),
                      onReturnAll: () => setReturnConfirmOpen(true),
                      onProcessRefund: () => setRefundModalOpen(true),
                      deleteLine: (it: OrderItem) => void deleteLine(it),
                      addBySku: () => void addBySku(),
                      setSku,
                      sku,
                      canModify,
                      canRefund,
                      canAttemptCancel,
                      _canSuitSwap,
                      _orderAllowsLineSwap,
                      setSuitSwapTarget
                    }}
                  />
                ))}
              </tbody>
            </table>

            {transactionRows.length === 0 && (
              <div className="flex flex-col items-center justify-center p-20 opacity-30 italic">
                <Search size={48} className="mb-4" />
                <p className="text-sm font-black uppercase tracking-widest italic">No matching records found</p>
              </div>
            )}
          </div>


        </DashboardGridCard>
      </div>


      <ConfirmationModal
        isOpen={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={() => void runCancelOrder()}
        title={orderUnpaid && !canCancel ? "Void this order?" : "Cancel this order?"}
        message={
          orderUnpaid
            ? "No payments are allocated to this order. Loyalty accrual will be reversed when applicable."
            : "This will queue any refundable payments. Loyalty accrual will be reversed when applicable."
        }
        confirmLabel={orderUnpaid && !canCancel ? "Void order" : "Cancel order"}
        variant="danger"
      />

      <ConfirmationModal
        isOpen={returnConfirmOpen}
        onClose={() => setReturnConfirmOpen(false)}
        onConfirm={() => void _applyReturns()}
        title="Return all items?"
        message="This will mark all eligible items as returned and calculate the refund due. This action cannot be undone."
        confirmLabel="Process returns"
        variant="danger"
      />

      {detail && (
        <AttachOrderToWeddingModal
          isOpen={attachWeddingModalOpen}
          onClose={() => setAttachWeddingModalOpen(false)}
          onSuccess={async () => {
            if (selectedId) await loadDetail(selectedId);
            await loadTransactions();
            await loadPipelineStats();
          }}
          orderId={detail.transaction_id}
          customerName={transactionRows.find(r => r.transaction_id === selectedId)?.customer_name ?? "Customer"}
        />
      )}

      {refundModalOpen && (
        <div className="ui-overlay-backdrop flex items-center justify-center p-4">
          <div
            ref={refundDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={refundTitleId}
            tabIndex={-1}
            className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300 outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-app-border p-4">
              <h3 id={refundTitleId} className="text-lg font-bold text-app-text">
                Process refund
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                A register session must be open. Card methods trigger Stripe when a payment intent exists on the
                order. Gift card refunds require the card code.
              </p>
            </div>
            <div className="space-y-3 p-4">
              <label className="block text-xs font-bold text-app-text-muted">
                Amount (USD)
                <input
                  type="text"
                  value={refundAmountStr}
                  onChange={(e) => setRefundAmountStr(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
              <label className="block text-xs font-bold text-app-text-muted">
                Payment method
                <input
                  type="text"
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="cash, card_present, gift_card, …"
                />
              </label>
              {refundMethod.toLowerCase().includes("gift") && (
                <label className="block text-xs font-bold text-app-text-muted">
                  Gift card code
                  <input
                    type="text"
                    value={refundGiftCode}
                    onChange={(e) => setRefundGiftCode(e.target.value)}
                    className="ui-input mt-1 w-full text-sm font-mono"
                  />
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-app-border p-4">
              <button
                type="button"
                className="ui-btn-secondary px-4 py-2 text-sm"
                disabled={refundBusy}
                onClick={() => setRefundModalOpen(false)}
              >
                Close
              </button>
              <button
                type="button"
                className="ui-btn-primary px-4 py-2 text-sm"
                disabled={refundBusy}
                onClick={() => void submitProcessRefund()}
              >
                {refundBusy ? "Processing…" : "Submit refund"}
              </button>
            </div>
          </div>
        </div>
      )}

      {suitSwapTarget && (
        <div className="ui-overlay-backdrop flex items-center justify-center p-4">
          <div className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300">
            <div className="border-b border-app-border p-4">
              <h3 className="text-lg font-bold text-app-text">Suit Swap</h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Replace <strong>{suitSwapTarget.product_name}</strong> ({suitSwapTarget.sku}) with a different variant.
              </p>
            </div>
            <div className="space-y-4 p-4">
              <label className="block text-xs font-bold text-app-text-muted uppercase tracking-widest">
                New SKU / Variant
                <input
                  type="text"
                  value={suitSwapSku}
                  onChange={(e) => setSuitSwapSku(e.target.value)}
                  className="ui-input mt-1.5 w-full text-sm font-mono"
                  placeholder="Enter replacement SKU…"
                  autoFocus
                />
              </label>
              <label className="block text-xs font-bold text-app-text-muted uppercase tracking-widest">
                Internal note
                <textarea
                  value={suitSwapNote}
                  onChange={(e) => setSuitSwapNote(e.target.value)}
                  className="ui-input mt-1.5 w-full text-sm"
                  rows={2}
                  placeholder="Reason for swap…"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-app-border p-4">
              <button
                type="button"
                className="ui-btn-secondary px-4 py-2 text-sm"
                disabled={suitSwapBusy}
                onClick={() => setSuitSwapTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ui-btn-primary px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 font-bold"
                disabled={suitSwapBusy || !suitSwapSku.trim()}
                onClick={() => void submitSuitSwap()}
              >
                {suitSwapBusy ? "Swapping…" : "Confirm swap"}
              </button>
            </div>
          </div>
        </div>
      )}

      <RegisterRequiredModal
        open={registerRequiredOpen}
        onClose={() => setRegisterRequiredOpen(false)}
        onGoToRegister={goToOpenRegister}
      />
    </div>
  );
}
