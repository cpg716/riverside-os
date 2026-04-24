import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Search,
  RotateCcw,
} from "lucide-react";
import AttachOrderToWeddingModal from "./AttachOrderToWeddingModal";
import TransactionDetailDrawer, {
  type TransactionDrawerAudit,
  type TransactionDrawerDetail,
} from "./TransactionDetailDrawer";
import DashboardGridCard from "../ui/DashboardGridCard";
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
  addBySku: () => void;
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
      return "Order";
    case "custom":
      return "Custom";
    case "layaway":
      return "Layaway";
    default:
      return "Order";
  }
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
        "cursor-pointer transition-all hover:bg-app-bg group",
        isSelected ? "bg-app-bg/80 border-l-4 border-emerald-500" : "bg-app-surface border-l-4 border-transparent"
      )}
    >
        <td className="px-6 py-4">
           <p className="text-[11px] font-black tracking-tight text-app-text mb-1">{row.display_id}</p>
           <p className="text-[9px] font-bold text-app-text-muted opacity-60 uppercase tracking-widest italic">
             {new Date(row.booked_at).toLocaleDateString()}
           </p>
        </td>
        <td className="px-6 py-4">
           <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-600 text-[10px] font-black">
                {row.customer_name?.[0] ?? row.counterpoint_customer_code?.[0] ?? "W"}
              </div>
              <div>
                <p className="text-[11px] font-bold text-app-text flex items-center gap-1.5">
                  {row.customer_name ?? `CP: ${row.counterpoint_customer_code ?? "Unknown"}`}
                  {row.party_name && <WEDDINGS_ICON size={10} className="text-rose-500" />}
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
        <td className="px-6 py-4 max-w-[300px]">
           <p className="text-[10px] font-bold text-app-text-muted italic opacity-80 truncate">
             {row.item_count} item{row.item_count === 1 ? "" : "s"}
             {row.primary_salesperson_name ? ` · ${row.primary_salesperson_name}` : ""}
           </p>
        </td>
        <td className="px-6 py-4">
           <span className={cn(
             "px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border",
             row.counterpoint_customer_code
               ? "border-sky-500/20 bg-sky-500/10 text-sky-600"
               : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
           )}>
             {row.status}
           </span>
        </td>
        <td className="px-6 py-4">
          <p className="text-[11px] font-black text-app-text">{money(row.total_price)}</p>
          <p className="text-[9px] font-bold text-app-text-muted opacity-80 mt-1">
            Paid {money(row.amount_paid)}
          </p>
        </td>
        <td className="px-6 py-4 text-right flex items-center justify-end gap-3">
          <p className={cn("text-[11px] font-black", parseMoneyToCents(row.balance_due) > 0 ? "text-amber-500" : "text-app-text-muted opacity-40")}>
            {money(row.balance_due)}
          </p>
           <button 
             onClick={(e) => { e.stopPropagation(); actions.onOpenInRegister?.(row.transaction_id); }}
             className="opacity-0 group-hover:opacity-100 transition-all px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-[9px] font-black uppercase tracking-widest"
           >
             Open
           </button>
        </td>
      </tr>
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
  const { dialogRef: refundDialogRef, titleId: refundTitleId } = useDialogAccessibility(
    refundModalOpen && !registerRequiredOpen,
    {
      onEscape: () => setRefundModalOpen(false),
      closeOnEscape: !refundBusy,
    },
  );
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
        setDetailError("We couldn't load this order right now.");
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
      setDetailError("We couldn't load this order right now.");
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
      toast(b.error ?? "We couldn't add this item. Please try again.", "error");
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
      toast(b.error ?? "We couldn't cancel this order. Please try again.", "error");
      return;
    }
    setCancelConfirmOpen(false);
    toast("Order cancelled", "info");
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

  return (
    <div className="flex flex-1 flex-col bg-transparent">


      <div className="flex shrink-0 items-center justify-between p-6 sm:p-10 pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-black uppercase tracking-widest text-app-text">Orders</h1>
          <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-[0.2em] italic opacity-60">
            {section === "open" ? "Current Open Orders & Counterpoint Open Docs" : "Closed Order History"}
          </p>
        </div>
        
        <div className="flex items-center gap-3">
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
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-rose-500 hover:bg-rose-500/5 transition-all"
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 text-emerald-600 shadow-soft-xs">
            <Activity size={14} className={section === "open" ? "animate-pulse" : ""} />
            <p className="text-[10px] font-black uppercase tracking-widest italic">
              {section === "open" ? "Open orders" : "Order history"}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-1 p-6 sm:p-10 sm:pt-4">
        {/* Unified Order Dashboard */}
        <DashboardGridCard 
          title={section === "open" ? "Open Orders" : "Closed Orders"}
          subtitle={`${totalCount} orders`}
          icon={ORDERS_ICON}
          className="flex-1"
          contentClassName="p-0 flex flex-col"
        >
          <div className="border-b border-app-border bg-app-surface-2/40 px-8 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                  Order Integrity
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  Open visibility into orders that still need booking details, payment follow-up, or aging review.
                </p>
              </div>
              <span className="rounded-full border border-app-border bg-app-surface px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {orderIntegritySummary.visibleOrders} visible orders
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-4">
              {[
                ["Waiting on details", orderIntegritySummary.waitingOnDetails],
                ["Balance still due", orderIntegritySummary.balanceStillDue],
                ["Needs action", pipelineStats?.needs_action ?? 0],
                ["Overdue follow-up", pipelineStats?.overdue ?? 0],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-app-border bg-app-surface px-3 py-3"
                >
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    {label}
                  </p>
                  <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="px-8 pt-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                View
              </span>
              {(
                [
                  { id: "open", label: "Open Orders" },
                  { id: "all", label: "Order History" },
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
                        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
                        : "border-app-border bg-app-surface text-app-text-muted hover:bg-app-bg hover:text-app-text",
                    )}
                    aria-pressed={active}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Header Filters Area */}
          <div className="px-8 py-5 border-b border-app-border bg-app-bg/20 flex flex-wrap items-center gap-4">
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
                    actions={{
                      onOpenInRegister,
                      onAttachToWedding: () => setAttachWeddingModalOpen(true),
                      onCancel: () => setCancelConfirmOpen(true),
                      onReturnAll: () => setReturnConfirmOpen(true),
                      deleteLine: (it: OrderItem) => void deleteLine(it),
                      addBySku: () => void addBySku(),
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
              <div className="flex flex-col items-center justify-center p-16 opacity-30 italic">
                <Search size={48} className="mb-4" />
                <p className="text-sm font-black uppercase tracking-widest italic">No matching orders found</p>
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
          addBySku: () => void addBySku(),
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
