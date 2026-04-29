import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useRegisterGate } from "../../context/RegisterGateContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import RegisterRequiredModal from "../layout/RegisterRequiredModal";
import PosRefundModal from "../pos/PosRefundModal";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import {
  centsToFixed2,
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Search,
  RotateCcw,
  Wallet,
} from "lucide-react";
import AttachOrderToWeddingModal from "./AttachOrderToWeddingModal";
import TransactionDetailDrawer, {
  type TransactionDrawerAudit,
  type TransactionDrawerDetail,
} from "./TransactionDetailDrawer";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { getAppIcon } from "../../lib/icons";

const WEDDINGS_ICON = getAppIcon("weddings");
const ORDERS_ICON = getAppIcon("orders");

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
  transaction_line_id?: string;
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
  is_fulfilled: boolean;
}

type WorkspaceOrderDetail = Omit<TransactionDrawerDetail, "items"> & {
  items: OrderItem[];
};

interface TransactionPipelineStats {
  needs_action: number;
  ready_for_pickup: number;
  overdue: number;
  wedding_orders: number;
}

interface OrderIntegritySummary {
  visibleOrders: number;
  waitingOnDetails: number;
  balanceStillDue: number;
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

type Section = "open" | "all";
type OrderViewPreset = "open" | "all";
type FulfillmentKind =
  | "takeaway"
  | "shipment"
  | "wedding_order"
  | "special_order"
  | "custom"
  | "regular_order"
  | "layaway";

interface OrderRowActions {
  onOpenInRegister?: (orderId: string) => void;
  onAttachToWedding: () => void;
  onCancel: () => void;
  onReturnAll: () => void;
  deleteLine: (it: OrderItem) => void;
  addBySku: () => Promise<boolean>;
  updateLine: (
    item: Pick<
      OrderItem,
      "transaction_line_id" | "sku" | "product_name" | "quantity" | "unit_price" | "fulfillment"
    >,
    patch: {
      quantity?: number;
      unit_price?: string;
      fulfillment?: FulfillmentKind;
    },
  ) => Promise<void>;
  setSku: (s: string) => void;
  sku: string;
  canModify: boolean;
  canAttemptCancel: boolean;
}



function orderKindLabel(kind: string) {
  switch (kind) {
    case "wedding_order":
      return "Wedding";
    case "special_order":
      return "Special";
    case "custom":
      return "Custom";
    case "layaway":
      return "Layaway";
    default:
      return "Transaction";
  }
}

function formatOrderStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function OrderTableRow({ row, isSelected, onClick, actions }: {
  row: TransactionRow;
  isSelected: boolean; 
  onClick: () => void;
  actions: OrderRowActions;
}) {
  return (
    <tr 
      onClick={onClick}
      onDoubleClick={() => actions.onOpenInRegister?.(row.transaction_id)}
      className={cn(
        "group cursor-pointer transition-all duration-150 hover:bg-app-surface-2 focus-within:bg-app-surface-2",
        isSelected ? "border-l-4 border-app-success bg-app-success/8" : "border-l-4 border-transparent"
      )}
    >
        <td className="px-6 py-4">
           <p className="text-[11px] font-black tracking-tight text-app-text mb-1">{row.display_id}</p>
           <p className="text-[9px] font-bold uppercase tracking-widest italic text-app-text-muted">
             {new Date(row.booked_at).toLocaleDateString()}
           </p>
        </td>
        <td className="px-6 py-4">
           <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-success/10 text-[10px] font-black text-app-success">
                {row.customer_name?.[0] ?? row.counterpoint_customer_code?.[0] ?? "W"}
              </div>
              <div>
                <p className="text-[11px] font-bold text-app-text flex items-center gap-1.5">
                  {row.customer_name ?? `CP: ${row.counterpoint_customer_code ?? "Unknown"}`}
                  {row.party_name && <WEDDINGS_ICON size={10} className="text-app-danger" />}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <p className="text-[9px] font-bold uppercase tracking-widest italic text-app-text-muted">
                    {orderKindLabel(row.order_kind)}
                  </p>
                  {row.counterpoint_customer_code && (
                    <span className="rounded-md border border-app-success/20 bg-app-success/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-success">
                      CP Open Doc
                    </span>
                  )}
                  {row.party_name && <p className="text-[9px] font-bold uppercase tracking-tighter italic text-app-danger">{row.party_name}</p>}
                </div>
              </div>
           </div>
        </td>
        <td className="px-6 py-4 max-w-[300px]">
           <p className="truncate text-[10px] font-bold italic text-app-text-muted">
             {row.item_count} item{row.item_count === 1 ? "" : "s"}
             {row.primary_salesperson_name ? ` · ${row.primary_salesperson_name}` : ""}
           </p>
        </td>
        <td className="px-6 py-4">
           <span className={cn(
             "px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border",
             row.counterpoint_customer_code
               ? "border-app-info/20 bg-app-info/10 text-app-info"
               : "border-app-success/20 bg-app-success/10 text-app-success"
           )}>
             {formatOrderStatusLabel(row.status)}
           </span>
        </td>
        <td className="px-6 py-4">
          <p className="text-[11px] font-black text-app-text">{money(row.total_price)}</p>
          <p className="mt-1 text-[9px] font-bold text-app-text-muted">
            Paid {money(row.amount_paid)}
          </p>
        </td>
        <td className="px-6 py-4 text-right flex items-center justify-end gap-3">
          <p className={cn("text-[11px] font-black", parseMoneyToCents(row.balance_due) > 0 ? "text-app-warning" : "text-app-text-disabled")}>
            {money(row.balance_due)}
          </p>
           <button 
             onClick={(e) => { e.stopPropagation(); actions.onOpenInRegister?.(row.transaction_id); }}
             className="rounded-lg bg-app-success px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-white opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:brightness-110 active:scale-95 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-success/30"
           >
             Register
           </button>
        </td>
      </tr>
  );
}

function OrderMobileCard({
  row,
  isSelected,
  onClick,
  actions,
}: {
  row: TransactionRow;
  isSelected: boolean;
  onClick: () => void;
  actions: OrderRowActions;
}) {
  const balanceDue = parseMoneyToCents(row.balance_due);
  return (
    <article
      className={cn(
        "rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm",
        isSelected && "ring-2 ring-app-success",
      )}
    >
      <button type="button" onClick={onClick} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-black text-app-text">{row.display_id}</p>
            <p className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              {new Date(row.booked_at).toLocaleDateString()} · {orderKindLabel(row.order_kind)}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-lg border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest",
              row.counterpoint_customer_code
                ? "border-app-info/20 bg-app-info/10 text-app-info"
                : "border-app-success/20 bg-app-success/10 text-app-success",
            )}
          >
            {formatOrderStatusLabel(row.status)}
          </span>
        </div>

        <div className="mt-4 min-w-0">
          <p className="truncate text-base font-black text-app-text">
            {row.customer_name ?? `CP: ${row.counterpoint_customer_code ?? "Unknown"}`}
          </p>
          <p className="mt-1 truncate text-xs font-semibold text-app-text-muted">
            {row.item_count} item{row.item_count === 1 ? "" : "s"}
            {row.primary_salesperson_name ? ` · ${row.primary_salesperson_name}` : ""}
          </p>
          {row.party_name ? (
            <p className="mt-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-app-danger">
              <WEDDINGS_ICON size={12} />
              {row.party_name}
            </p>
          ) : null}
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-xl border border-app-border/50 bg-app-surface-2/70 p-3">
            <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Total
            </dt>
            <dd className="mt-1 font-mono font-black text-app-text">
              {money(row.total_price)}
            </dd>
          </div>
          <div className="rounded-xl border border-app-border/50 bg-app-surface-2/70 p-3">
            <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Paid
            </dt>
            <dd className="mt-1 font-mono font-black text-app-text">
              {money(row.amount_paid)}
            </dd>
          </div>
          <div className="rounded-xl border border-app-border/50 bg-app-surface-2/70 p-3">
            <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Due
            </dt>
            <dd className={cn("mt-1 font-mono font-black", balanceDue > 0 ? "text-app-warning" : "text-app-text-muted")}>
              {money(row.balance_due)}
            </dd>
          </div>
        </dl>
      </button>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => actions.onOpenInRegister?.(row.transaction_id)}
          className="min-h-11 rounded-xl bg-app-success px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white"
        >
          Register
        </button>
        <button
          type="button"
          onClick={onClick}
          className="min-h-11 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
        >
          {isSelected ? "Hide Detail" : "View Detail"}
        </button>
      </div>
    </article>
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
  refreshSignal = 0,
}: {
  activeSection?: string;
  onOpenInRegister?: (orderId: string) => void;
  /** When set, selects this order in the list and opens detail (e.g. from CRM hub). */
  deepLinkTxnId?: string | null;
  onDeepLinkTxnConsumed?: () => void;
  refreshSignal?: number;
}) {
  const defaultViewPreset: OrderViewPreset =
    activeSection === "all" ? "all" : "open";
  const baseUrl = getBaseUrl();
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { goToOpenRegister } = useRegisterGate();

  const canModify = hasPermission("orders.modify");
  const canCancel = hasPermission("orders.cancel");
  const canVoidUnpaid = hasPermission("orders.void_sale");
  const canRefund = hasPermission("orders.refund_process");

  const [transactionRows, setTransactionRows] = useState<TransactionRow[]>([]);
  const [pipelineStats, setPipelineStats] =
    useState<TransactionPipelineStats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sku, setSku] = useState("");
  const [audit, setAudit] = useState<TransactionDrawerAudit[]>([]);
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
  // exchangeOtherId removed
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [attachWeddingModalOpen, setAttachWeddingModalOpen] = useState(false);
  const detailRequestSeqRef = useRef(0);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [salespersonFilter, setSalespersonFilter] = useState("all");
  const [datePreset, setDatePreset] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [viewPreset, setViewPreset] = useState<OrderViewPreset>(
    defaultViewPreset,
  );

  const section: Section = viewPreset === "all" ? "all" : "open";

  useEffect(() => {
    setViewPreset(defaultViewPreset);
  }, [defaultViewPreset]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, kindFilter, paymentFilter, salespersonFilter, datePreset, dateFrom, dateTo, section]);

  const loadPipelineStats = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/transactions/pipeline-stats`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as TransactionPipelineStats;
      setPipelineStats(data);
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
    const requestSeq = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestSeq;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [detailRes, auditRes] = await Promise.all([
        fetch(`${baseUrl}/api/transactions/${id}`, {
          headers: backofficeHeaders(),
        }),
        fetch(`${baseUrl}/api/transactions/${id}/audit`, {
          headers: backofficeHeaders(),
        }),
      ]);

      if (!detailRes.ok) {
        if (detailRequestSeqRef.current !== requestSeq) return;
        setDetail(null);
        setAudit([]);
        setDetailError("We couldn't load this transaction record right now.");
        return;
      }

      const rawDetail = (await detailRes.json()) as TransactionDrawerDetail;
      if (detailRequestSeqRef.current !== requestSeq) return;
      setDetail({
        ...rawDetail,
        items: (rawDetail.items ?? []).map((item) => ({
          order_item_id:
            (item as { order_item_id?: string; transaction_line_id?: string }).order_item_id ??
            item.transaction_line_id ??
            `${item.sku}-${item.product_name}`,
          transaction_line_id: item.transaction_line_id,
          product_id: (item as { product_id?: string }).product_id ?? "",
          variant_id: (item as { variant_id?: string }).variant_id ?? "",
          sku: item.sku,
          product_name: item.product_name,
          variation_label: item.variation_label,
          quantity: item.quantity,
          quantity_returned: item.quantity_returned ?? 0,
          unit_price: item.unit_price,
          unit_cost: item.unit_cost,
          state_tax: String(item.state_tax ?? "0"),
          local_tax: String(item.local_tax ?? "0"),
          fulfillment: item.fulfillment as FulfillmentKind,
          is_fulfilled: Boolean(item.is_fulfilled),
        })),
      });
      if (auditRes.ok) {
        const nextAudit = (await auditRes.json()) as TransactionDrawerAudit[];
        if (detailRequestSeqRef.current !== requestSeq) return;
        setAudit(nextAudit);
      } else {
        if (detailRequestSeqRef.current !== requestSeq) return;
        setAudit([]);
      }
    } catch {
      if (detailRequestSeqRef.current !== requestSeq) return;
      setDetail(null);
      setAudit([]);
      setDetailError("We couldn't load this transaction record right now.");
    } finally {
      if (detailRequestSeqRef.current === requestSeq) {
        setDetailLoading(false);
      }
    }
    setReturnQtyDraft({});
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
      detailRequestSeqRef.current += 1;
      setDetail(null);
      setAudit([]);
      setDetailError(null);
      setRefundTargetOrderId(null);
      return;
    }
    void loadDetail(selectedId);
    setRefundTargetOrderId(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    void loadPipelineStats();
    void loadTransactions();
    if (selectedId) {
      void loadDetail(selectedId);
    }
  }, [loadDetail, loadPipelineStats, loadTransactions, refreshSignal, selectedId]);

  const addBySku = async (): Promise<boolean> => {
    if (!detail || !sku.trim() || !canModify) return false;
    const enteredSku = sku.trim();
    let item: ScanItem;
    try {
      const scanRes = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(enteredSku)}`,
        {
          headers: backofficeHeaders(),
        },
      );
      if (!scanRes.ok) {
        const body = (await scanRes.json().catch(() => ({}))) as { error?: string };
        if (scanRes.status === 404) {
          toast(`SKU "${enteredSku}" was not found. Check it and try again.`, "error");
          return false;
        }
        if (scanRes.status === 401 || scanRes.status === 403) {
          toast(body.error ?? "Your session or access has expired. Sign in again and retry.", "error");
          return false;
        }
        if (scanRes.status >= 500) {
          toast("SKU lookup is temporarily unavailable. Please try again.", "error");
          return false;
        }
        toast(body.error ?? "SKU lookup failed. Please try again.", "error");
        return false;
      }
      item = (await scanRes.json()) as ScanItem;
    } catch {
      toast("SKU lookup failed. Please try again.", "error");
      return false;
    }
    if (!item.product_id || !item.variant_id) {
      toast(`SKU "${enteredSku}" was not found. Check it and try again.`, "error");
      return false;
    }
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
      toast(b.error ?? "We couldn't add this item. Please try again.", "error");
      return false;
    }
    setSku("");
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    return true;
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
      toast(b.error ?? "We couldn't cancel this transaction. Please try again.", "error");
      return;
    }
    setCancelConfirmOpen(false);
    toast("Transaction cancelled", "info");
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    void loadRefundsDue();
  };

  const deleteLine = async (item: Pick<OrderItem, "order_item_id">) => {
    if (!detail || !canModify) return;
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/items/${item.order_item_id}`, {
      method: "DELETE",
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "We couldn't remove this item. Please try again.", "error");
      return;
    }
    await loadDetail(detail.transaction_id);
    await loadTransactions();
  };

  const updateLine = useCallback(
    async (
      item: Pick<
        OrderItem,
        "transaction_line_id" | "sku" | "product_name" | "quantity" | "unit_price" | "fulfillment"
      >,
      patch: {
        quantity?: number;
        unit_price?: string;
        fulfillment?: FulfillmentKind;
      },
    ) => {
      if (!detail || !canModify || !item.transaction_line_id) return;
      const body: {
        quantity?: number;
        unit_price?: string;
        fulfillment?: FulfillmentKind;
      } = {};
      if (patch.quantity !== undefined) {
        body.quantity = patch.quantity;
      }
      if (patch.unit_price !== undefined) {
        body.unit_price = centsToFixed2(parseMoneyToCents(patch.unit_price));
      }
      if (patch.fulfillment !== undefined) {
        body.fulfillment = patch.fulfillment;
      }
      if (
        body.quantity === undefined &&
        body.unit_price === undefined &&
        body.fulfillment === undefined
      ) {
        return;
      }
      const res = await fetch(
        `${baseUrl}/api/transactions/${detail.transaction_id}/items/${item.transaction_line_id}`,
        {
          method: "PATCH",
          headers: jsonHeaders(backofficeHeaders),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "We couldn't save that line. Please try again.");
      }
      toast(`${item.product_name} updated.`, "success");
      await loadDetail(detail.transaction_id);
      await loadTransactions();
    },
    [backofficeHeaders, baseUrl, canModify, detail, loadDetail, loadTransactions, toast],
  );

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
    toast("Return saved.", "success");
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
      toast("Refund completed.", "success");
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

  const orderIntegritySummary = useMemo<OrderIntegritySummary>(() => {
    return transactionRows.reduce(
      (summary, row) => ({
        visibleOrders: summary.visibleOrders + 1,
        waitingOnDetails:
          summary.waitingOnDetails + (row.status === "pending_measurement" ? 1 : 0),
        balanceStillDue:
          summary.balanceStillDue +
          (parseMoneyToCents(row.balance_due) > 0 ? 1 : 0),
      }),
      {
        visibleOrders: 0,
        waitingOnDetails: 0,
        balanceStillDue: 0,
      },
    );
  }, [transactionRows]);

  const orderStatCards = [
    {
      label: "Visible Records",
      value: orderIntegritySummary.visibleOrders,
      icon: ORDERS_ICON,
      tint: "ui-tint-info",
      color: "text-app-info",
      bg: "bg-app-info/8",
      border: "border-app-info/16",
    },
    {
      label: "Waiting Details",
      value: orderIntegritySummary.waitingOnDetails,
      icon: Clock,
      tint: "ui-tint-warning",
      color: "text-app-warning",
      bg: "bg-app-warning/8",
      border: "border-app-warning/16",
    },
    {
      label: "Balance Due",
      value: orderIntegritySummary.balanceStillDue,
      icon: Wallet,
      tint: "ui-tint-danger",
      color: "text-app-danger",
      bg: "bg-app-danger/8",
      border: "border-app-danger/16",
    },
    {
      label: "Wedding Orders",
      value: pipelineStats?.wedding_orders ?? 0,
      icon: WEDDINGS_ICON,
      tint: "ui-tint-accent",
      color: "text-app-accent",
      bg: "bg-app-accent/8",
      border: "border-app-accent/16",
    },
  ];

  const orderFollowUpMetrics = [
    { label: "Needs action", value: pipelineStats?.needs_action ?? 0, icon: Activity },
    { label: "Ready pickup", value: pipelineStats?.ready_for_pickup ?? 0, icon: CheckCircle2 },
    { label: "Overdue follow-up", value: pipelineStats?.overdue ?? 0, icon: AlertTriangle },
  ];

  return (
    <div className="ui-page flex flex-1 flex-col bg-transparent p-0">
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
          {orderStatCards.map((stat) => (
            <div
              key={stat.label}
              className={`ui-card flex min-w-[200px] flex-1 items-center gap-4 p-4 ${stat.tint}`}
            >
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${stat.border} ${stat.bg} shadow-sm`}
              >
                <stat.icon size={24} className={stat.color} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
                  {stat.label}
                </p>
                <p className="text-2xl font-black tabular-nums text-app-text">
                  {stat.value}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 sm:px-6">
          <div className="ui-card ui-tint-warning px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                  Fulfillment Follow-Up
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  Special, Custom, and Wedding order work with transaction payment context. Layaways stay separate.
                </p>
              </div>
              <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {totalCount} records found
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {orderFollowUpMetrics.map((metric) => {
                const Icon = metric.icon;
                return (
                <div key={metric.label} className="ui-metric-cell px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {metric.label}
                      </p>
                      <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                        {metric.value}
                      </p>
                    </div>
                    <Icon size={18} className="text-app-text-muted opacity-50" />
                  </div>
                </div>
              );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col p-3 sm:p-6 lg:p-8 animate-workspace-snap">
          <div className="ui-card flex flex-col overflow-hidden">
            <div className="flex shrink-0 flex-col gap-3 border-b border-app-border bg-app-surface-2 px-4 py-4 lg:flex-row lg:flex-wrap lg:items-center lg:gap-4 lg:px-5">
              <div className="relative group min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors" size={16} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by customer, phone, transaction number, or fulfillment order number..."
                  className="ui-input w-full pl-10 text-sm font-bold shadow-sm focus:border-app-accent"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { id: "open", label: "Open Fulfillment" },
                    { id: "all", label: "Transaction History" },
                  ] satisfies Array<{ id: OrderViewPreset; label: string }>
                ).map((preset) => {
                  const active = viewPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setViewPreset(preset.id)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all",
                        active
                          ? "border-app-accent/20 bg-app-accent/10 text-app-accent"
                          : "border-app-border bg-app-surface-3 text-app-text-muted hover:bg-app-surface hover:text-app-text",
                      )}
                      aria-pressed={active}
                    >
                      {preset.label}
                    </button>
                  );
                })}

                <button
                  onClick={() => {
                    setSearch("");
                    setViewPreset(defaultViewPreset);
                    setKindFilter("all");
                    setPaymentFilter("all");
                    setSalespersonFilter("all");
                    setDatePreset("all");
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="flex items-center justify-center rounded-xl bg-app-surface-2 p-2.5 text-app-text-muted border border-app-border hover:bg-app-surface transition-colors"
                  title="Reset filters"
                >
                  <RotateCcw size={18} />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-app-surface-3 px-4 py-4 lg:px-5">
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Type: All</option>
                  <option value="special_order">Special</option>
                  <option value="wedding_order">Wedding</option>
                  <option value="custom">Custom</option>
                </select>
                <select
                  value={paymentFilter}
                  onChange={(e) => setPaymentFilter(e.target.value)}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Payment: All</option>
                  <option value="paid">Paid</option>
                  <option value="partial">Partial</option>
                  <option value="unpaid">Unpaid</option>
                </select>
                <select
                  value={salespersonFilter}
                  onChange={(e) => setSalespersonFilter(e.target.value)}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
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
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Date: Always</option>
                  <option value="today">Today</option>
                  <option value="30d">30 Days</option>
                  <option value="custom">Custom</option>
                </select>
            </div>

            <div className="grid gap-3 p-3 lg:hidden">
              {transactionRows.map((r) => (
                <OrderMobileCard
                  key={r.transaction_id}
                  row={r}
                  isSelected={selectedId === r.transaction_id}
                  onClick={() => setSelectedId(selectedId === r.transaction_id ? null : r.transaction_id)}
                  actions={{
                    onOpenInRegister,
                    onAttachToWedding: () => setAttachWeddingModalOpen(true),
                    onCancel: () => setCancelConfirmOpen(true),
                    onReturnAll: () => setReturnConfirmOpen(true),
                    deleteLine: (it: OrderItem) => void deleteLine(it),
                    addBySku,
                    updateLine,
                    setSku,
                    sku,
                    canModify,
                    canAttemptCancel,
                  }}
                />
              ))}
              {transactionRows.length === 0 && (
                <div className="rounded-2xl border border-dashed border-app-border bg-app-surface-2 p-8 text-center text-app-text-muted">
                  <Search size={40} className="mx-auto mb-3 opacity-50" />
                  <p className="text-sm font-black uppercase tracking-widest italic">No matching records found</p>
                  <p className="mt-2 text-sm font-medium normal-case tracking-normal">
                    Try a broader search or clear one of the active filters.
                  </p>
                </div>
              )}
            </div>

            <div className="hidden flex-1 custom-scrollbar overflow-x-auto lg:block">
              <table className="w-full text-left border-collapse min-w-[1000px]">
              <thead className="sticky top-0 z-20 border-b border-app-border bg-app-surface-3">
                <tr>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">ID / Date</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Customer</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Fulfillment Summary</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Status</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Transaction Amounts</th>
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
                    actions={{
                      onOpenInRegister,
                      onAttachToWedding: () => setAttachWeddingModalOpen(true),
                      onCancel: () => setCancelConfirmOpen(true),
                      onReturnAll: () => setReturnConfirmOpen(true),
                      deleteLine: (it: OrderItem) => void deleteLine(it),
                      addBySku,
                      updateLine,
                      setSku,
                      sku,
                      canModify,
                      canAttemptCancel,
                    }}
                  />
                ))}
              </tbody>
            </table>

              {transactionRows.length === 0 && (
                <div className="flex flex-col items-center justify-center p-16 text-center text-app-text-muted">
                  <Search size={48} className="mb-4 opacity-70" />
                  <p className="text-sm font-black uppercase tracking-widest italic">No matching records found</p>
                  <p className="mt-2 max-w-sm text-sm font-medium normal-case tracking-normal text-app-text-muted">
                    Try a broader search or clear one of the active filters to bring records back into view.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmationModal
        isOpen={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={() => void runCancelOrder()}
        title={orderUnpaid && !canCancel ? "Void this transaction?" : "Cancel this transaction?"}
        message={
          orderUnpaid
            ? "No payments are allocated to this transaction. Loyalty accrual will be reversed when applicable."
            : "This will queue any refundable payments. Loyalty accrual will be reversed when applicable."
        }
        confirmLabel={orderUnpaid && !canCancel ? "Void transaction" : "Cancel transaction"}
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

      <PosRefundModal
        isOpen={refundModalOpen}
        onClose={() => setRefundModalOpen(false)}
        onSubmit={() => void submitProcessRefund()}
        busy={refundBusy}
        amount={refundAmountStr}
        setAmount={setRefundAmountStr}
        method={refundMethod}
        setMethod={setRefundMethod}
        giftCode={refundGiftCode}
        setGiftCode={setRefundGiftCode}
      />

      <TransactionDetailDrawer
        orderId={selectedId}
        isOpen={selectedId !== null}
        onClose={() => setSelectedId(null)}
        detail={detail}
        audit={audit}
        loading={detailLoading}
        errorMessage={detailError}
        orderActions={{
          onOpenInRegister,
          onAttachToWedding: () => setAttachWeddingModalOpen(true),
          onCancel: () => setCancelConfirmOpen(true),
          onReturnAll: () => setReturnConfirmOpen(true),
          onProcessRefund: () => setRefundModalOpen(true),
          deleteLine: (it) => void deleteLine(it),
          addBySku,
          updateLine,
          setSku,
          sku,
          canModify,
          canAttemptCancel,
          canRefund,
        }}
      />

      <RegisterRequiredModal
        open={registerRequiredOpen}
        onClose={() => setRegisterRequiredOpen(false)}
        onGoToRegister={goToOpenRegister}
      />
    </div>
  );
}
