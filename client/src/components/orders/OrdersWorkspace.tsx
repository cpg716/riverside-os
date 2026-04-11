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
  ArrowRight,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  Flame,
  Heart,
  Package,
  Search,
  Wrench,
  AlertCircle,
  TrendingDown,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import AttachOrderToWeddingModal from "./AttachOrderToWeddingModal";

interface OrderPipelineStats {
  needs_action: number;
  ready_for_pickup: number;
  overdue: number;
  wedding_orders: number;
}

type Section = "open" | "all";
type FulfillmentKind = "takeaway" | "special_order" | "wedding_order";

interface OrderRow {
  order_id: string;
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
  order_id: string;
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

interface RefundQueueRow {
  id: string;
  order_id: string;
  customer_id: string | null;
  amount_due: string;
  amount_refunded: string;
  is_open: boolean;
  reason: string;
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

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

export default function OrdersWorkspace({
  activeSection = "open",
  onOpenInRegister,
  deepLinkOrderId = null,
  onDeepLinkOrderConsumed,
}: {
  activeSection?: string;
  onOpenInRegister?: (orderId: string) => void;
  /** When set, selects this order in the list and opens detail (e.g. from CRM hub). */
  deepLinkOrderId?: string | null;
  onDeepLinkOrderConsumed?: () => void;
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

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [sku, setSku] = useState("");
  const [audit, setAudit] = useState<OrderAuditEvent[]>([]);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 50;

  const [refundsDue, setRefundsDue] = useState<RefundQueueRow[]>([]);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundTargetOrderId, setRefundTargetOrderId] = useState<string | null>(null);
  const [pipelineStats, setPipelineStats] = useState<OrderPipelineStats | null>(null);
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

  const loadRefundsDue = useCallback(async () => {
    if (!canRefund) {
      setRefundsDue([]);
      return;
    }
    const res = await fetch(`${baseUrl}/api/orders/refunds/due`, {
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      setRefundsDue([]);
      return;
    }
    setRefundsDue((await res.json()) as RefundQueueRow[]);
  }, [baseUrl, backofficeHeaders, canRefund]);

  const loadPipelineStats = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/orders/pipeline-stats`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setPipelineStats((await res.json()) as OrderPipelineStats);
    } catch {
      /* ignore */
    }
  }, [baseUrl, backofficeHeaders]);

  const loadOrders = useCallback(async () => {
    const params = new URLSearchParams();
    if (section === "all") params.set("show_closed", "true");
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (kindFilter !== "all") params.set("kind_filter", kindFilter);
    if (paymentFilter !== "all") params.set("payment_filter", paymentFilter);
    if (salespersonFilter !== "all") params.set("salesperson_filter", salespersonFilter);

    let from = dateFrom;
    const to = dateTo;
    const now = new Date();
    const daysAgoString = (d: number) => {
      const past = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      return past.toISOString().split("T")[0];
    };

    if (datePreset === "today") {
      from = now.toISOString().split("T")[0];
    } else if (datePreset === "7d") {
      from = daysAgoString(7);
    } else if (datePreset === "30d") {
      from = daysAgoString(30);
    }

    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);

    setLoading(true);
    const res = await fetch(`${baseUrl}/api/orders?${params.toString()}`, {
      headers: backofficeHeaders(),
    });
    setLoading(false);
    if (!res.ok) {
      toast("Could not load orders (check staff code / PIN and orders.view).", "error");
      return;
    }
    const data = (await res.json()) as { items: OrderRow[]; total_count: number };
    setRows(data.items);
    setTotalCount(data.total_count);
    if (!selectedId && data.items.length > 0) setSelectedId(data.items[0].order_id);
  }, [baseUrl, backofficeHeaders, section, page, debouncedSearch, kindFilter, paymentFilter, salespersonFilter, datePreset, dateFrom, dateTo, selectedId, toast]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`${baseUrl}/api/orders/${id}`, {
      headers: backofficeHeaders(),
    });
    if (!res.ok) return;
    setDetail((await res.json()) as OrderDetail);
    const a = await fetch(`${baseUrl}/api/orders/${id}/audit`, {
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
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (!deepLinkOrderId) return;
    setSelectedId(deepLinkOrderId);
    onDeepLinkOrderConsumed?.();
  }, [deepLinkOrderId, onDeepLinkOrderConsumed]);

  useEffect(() => {
    void loadRefundsDue();
  }, [loadRefundsDue, selectedId, detail?.order_id]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
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
        `${baseUrl}/api/orders/${detail.order_id}/items/${suitSwapTarget.order_item_id}/suit-swap`,
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
      await loadDetail(detail.order_id);
      await loadOrders();
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
    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}/items`, {
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
    await loadDetail(detail.order_id);
    await loadOrders();
  };

  const orderUnpaid = detail
    ? parseMoneyToCents(detail.amount_paid) === 0
    : false;
  const canAttemptCancel =
    !!detail &&
    (canCancel || (canVoidUnpaid && orderUnpaid));

  const runCancelOrder = async () => {
    if (!detail || !canAttemptCancel) return;
    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}`, {
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
    await loadDetail(detail.order_id);
    await loadOrders();
    void loadRefundsDue();
  };

  const deleteLine = async (item: OrderItem) => {
    if (!detail || !canModify) return;
    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}/items/${item.order_item_id}`, {
      method: "DELETE",
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Delete failed", "error");
      return;
    }
    await loadDetail(detail.order_id);
    await loadOrders();
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
    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}/returns`, {
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
    await loadDetail(detail.order_id);
    await loadOrders();
    void loadRefundsDue();
  };

// linkExchange logic removed for build stabilization

  const openRefundModalForOrder = (orderId: string) => {
    const row = refundsDue.find((r) => r.order_id === orderId);
    const dueCents = row
      ? Math.max(
          0,
          parseMoneyToCents(row.amount_due) -
            parseMoneyToCents(row.amount_refunded),
        )
      : parseMoneyToCents(detail?.balance_due ?? 0);
    setRefundTargetOrderId(orderId);
    setRefundAmountStr(dueCents > 0 ? centsToFixed2(dueCents) : "");
    setRefundMethod("cash");
    setRefundGiftCode("");
    setRefundModalOpen(true);
  };

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
      const res = await fetch(`${baseUrl}/api/orders/${refundTargetOrderId}/refunds/process`, {
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
      if (detail?.order_id === refundTargetOrderId) await loadDetail(refundTargetOrderId);
      await loadOrders();
    } finally {
      setRefundBusy(false);
    }
  };

  const salespersonOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const n = (r.primary_salesperson_name ?? "").trim();
      if (n) set.add(n);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
      {/* Pipeline Strip */}
      <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
        {[
          { label: "Needs action", count: pipelineStats?.needs_action, icon: Activity, color: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/20" },
          { label: "Ready for Pickup", count: pipelineStats?.ready_for_pickup, icon: CheckCircle2, color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
          { label: "Wedding Orders", count: pipelineStats?.wedding_orders, icon: Heart, color: "text-rose-500", bg: "bg-rose-500/10", border: "border-rose-500/20" },
          { label: "Overdue (30d+)", count: pipelineStats?.overdue, icon: Flame, color: "text-orange-500", bg: "bg-orange-500/10", border: "border-orange-500/20" },
        ].map((stat, i) => (
          <div key={i} className={`flex min-w-[200px] flex-1 items-center gap-4 rounded-[20px] border ${stat.border} ${stat.bg} p-4 shadow-sm backdrop-blur-md`}>
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/50 shadow-sm dark:bg-black/20`}>
              <stat.icon size={24} className={stat.color} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">{stat.label}</p>
              <p className="text-2xl font-black tabular-nums text-app-text">{stat.count ?? "—"}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden p-4 sm:p-6 sm:pt-4">
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-[24px] border border-app-border bg-app-surface shadow-2xl">
          <div className="w-96 shrink-0 flex flex-col border-r border-app-border bg-app-surface-2/30 backdrop-blur-sm">
            <div className="bg-app-surface/40 p-5 shrink-0 backdrop-blur-xl">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-4 opacity-60">
                Order Management
              </p>
              
              <div className="relative group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors" size={16} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Order #, customer, or party..."
                  className="ui-input w-full pl-10 text-sm font-bold bg-white/50 backdrop-blur-sm border-app-border focus:border-app-accent shadow-sm"
                />
              </div>

              {canRefund && refundsDue.length > 0 && (
                <div className="mt-4 rounded-[18px] border border-amber-500/30 bg-amber-500/10 p-4 text-xs">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle size={14} className="text-amber-600" />
                    <p className="font-extrabold text-amber-900 dark:text-amber-100 uppercase tracking-tighter">
                      {refundsDue.length} Refund{refundsDue.length === 1 ? "" : "s"} Pending
                    </p>
                  </div>
                  <ul className="space-y-2">
                    {refundsDue.slice(0, 3).map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 p-2 rounded-xl bg-white/40 dark:bg-black/20 border border-amber-500/10">
                        <button
                          type="button"
                          className="truncate text-left font-mono font-bold text-app-accent hover:text-amber-600 transition-colors"
                          onClick={() => setSelectedId(r.order_id)}
                        >
                          #{r.order_id.slice(0, 8)}
                        </button>
                        <button
                          type="button"
                          className="px-2 py-1 rounded-lg bg-amber-500 text-white font-black uppercase text-[9px] shadow-sm hover:translate-y-[-1px] active:translate-y-0 transition-transform"
                          onClick={() => openRefundModalForOrder(r.order_id)}
                        >
                          Settle
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="ui-input text-[11px] font-black uppercase tracking-tighter bg-white/50"
                >
                  <option value="all">All kinds</option>
                  <option value="regular_order">Takeaway</option>
                  <option value="special_order">Order</option>
                  <option value="wedding_order">Wedding</option>
                  <option value="layaway">Layaway</option>
                  <option value="custom">Custom</option>
                </select>
                <select
                  value={paymentFilter}
                  onChange={(e) => setPaymentFilter(e.target.value)}
                  className="ui-input text-[11px] font-black uppercase tracking-tighter bg-white/50"
                >
                  <option value="all">All payment</option>
                  <option value="paid">Paid</option>
                  <option value="partial">Partial</option>
                  <option value="unpaid">Unpaid</option>
                </select>
              </div>
              
              <div className="mt-2 grid grid-cols-1 gap-2">
                <select
                  value={salespersonFilter}
                  onChange={(e) => setSalespersonFilter(e.target.value)}
                  className="ui-input text-[11px] font-black uppercase tracking-tighter bg-white/50"
                >
                  <option value="all">Every Seller</option>
                  {salespersonOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
              
              <div className="mt-2 grid grid-cols-1 gap-2">
                 <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setKindFilter("all");
                      setPaymentFilter("all");
                      setSalespersonFilter("all");
                      setDatePreset("all");
                      setDateFrom("");
                      setDateTo("");
                    }}
                    className="w-full py-2 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted bg-app-surface-2 hover:bg-app-surface border border-app-border transition-colors shadow-sm"
                  >
                    Clear All Filters
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
              {rows.length === 0 && !loading && (
                <div className="py-12 text-center">
                   <ShoppingBag size={48} className="mx-auto text-app-text-muted mb-4 opacity-20" />
                   <p className="text-sm font-black text-app-text-muted uppercase tracking-widest opacity-40">No matching orders</p>
                </div>
              )}
              {rows.map((r) => (
                <button
                  key={r.order_id}
                  type="button"
                  onClick={() => setSelectedId(r.order_id)}
                  className={`group w-full relative overflow-hidden rounded-[20px] p-4 text-left transition-all duration-300 ${
                    selectedId === r.order_id 
                      ? "bg-app-accent text-white shadow-lg shadow-app-accent/20 scale-[1.02] z-10" 
                      : "bg-white/40 dark:bg-black/10 border border-app-border hover:bg-white/80 dark:hover:bg-black/20 hover:border-app-accent/30"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                       <div className={`p-2 rounded-xl flex items-center justify-center shrink-0 ${selectedId === r.order_id ? "bg-white/20" : "bg-app-surface-2"}`}>
                          <OrderKindIcon kind={r.order_kind} className={selectedId === r.order_id ? "text-white" : ""} />
                       </div>
                       <div className="min-w-0">
                          <p className={`font-black uppercase tracking-tighter leading-none truncate ${selectedId === r.order_id ? "text-white" : "text-app-text"}`}>
                            {r.customer_name ?? "Walk-in"}
                          </p>
                          <p className={`text-[10px] font-bold mt-1 opacity-70 ${selectedId === r.order_id ? "text-white" : "text-app-text-muted"}`}>
                             #{r.order_id.slice(0, 8)}
                          </p>
                       </div>
                    </div>
                    {parseMoneyToCents(r.balance_due) > 0 && (
                      <span className={`shrink-0 text-[10px] font-black px-2 py-0.5 rounded-lg uppercase tracking-wider ${selectedId === r.order_id ? "bg-white/30 text-white" : "bg-red-500/10 text-red-600"}`}>
                         {money(r.balance_due)} Due
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-current/10">
                     <span className={`text-[9px] font-black uppercase tracking-widest opacity-60`}>
                        {new Date(r.booked_at).toLocaleDateString()}
                     </span>
                     <div className="flex items-center gap-1">
                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-tighter ${
                          r.status === 'open' 
                            ? (selectedId === r.order_id ? "bg-white/20" : "bg-emerald-500/10 text-emerald-600")
                            : (selectedId === r.order_id ? "bg-white/20" : "bg-app-surface border border-app-border text-app-text-muted")
                        }`}>
                           {r.status}
                        </span>
                     </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="shrink-0 p-4 border-t border-app-border bg-app-surface-2 hover:bg-app-surface transition-colors">
              <div className="flex items-center justify-between gap-4">
                 <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
                   {totalCount} Active
                 </p>
                <div className="flex gap-1">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                    className="p-2 rounded-xl border border-app-border bg-white/50 hover:bg-white disabled:opacity-30 transition-all shadow-sm"
                  >
                    <ArrowRight className="rotate-180" size={14} />
                  </button>
                  <button
                    disabled={(page + 1) * limit >= totalCount}
                    onClick={() => setPage((p) => p + 1)}
                    className="p-2 rounded-xl border border-app-border bg-white/50 hover:bg-white disabled:opacity-30 transition-all shadow-sm"
                  >
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-transparent relative">
             <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,var(--app-accent),transparent_30%)] opacity-[0.03] pointer-events-none" />
             {!detail ? (
          <div className="flex h-full items-center justify-center p-8 opacity-40">
            <div className="text-center">
              <ShoppingBag size={64} className="mx-auto mb-4 text-app-text-muted" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted">
                Select an order for fulfillment detail
              </p>
            </div>
          </div>
        ) : (
          <div className="relative z-10 space-y-6 p-4 sm:p-8 animate-workspace-snap">
            {/* Header / Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-6 pb-6 border-b border-app-border">
              <div className="flex items-center gap-4">
                <div className="h-14 w-14 rounded-2xl bg-app-accent flex items-center justify-center shadow-lg shadow-app-accent/20">
                   <OrderKindIcon kind={detail.wedding_member_id ? "wedding_order" : "special_order"} className="text-white" />
                </div>
                <div>
                  <h2 className="text-2xl font-black tracking-tight text-app-text leading-tight">
                    Order #{detail.order_id.slice(0, 8)}
                  </h2>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${
                      detail.status === 'open' ? "bg-emerald-500/10 text-emerald-600" : "bg-app-surface-2 text-app-text-muted"
                    }`}>
                      {detail.status}
                    </span>
                    <span className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider">
                      Booked {new Date(detail.booked_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenInRegister?.(detail.order_id)}
                  className="px-4 py-2 bg-app-accent text-white rounded-xl font-bold text-sm shadow-md hover:translate-y-[-1px] transition-all flex items-center gap-2"
                >
                  <ArrowRight size={16} />
                  Fulfill in Register
                </button>
                
                <div className="flex gap-1 bg-app-surface-2 p-1 rounded-xl border border-app-border">
                  <button
                    type="button"
                    onClick={() => openRefundModalForOrder(detail.order_id)}
                    className="p-2 rounded-lg hover:bg-white dark:hover:bg-app-surface text-app-text-muted hover:text-app-accent transition-colors"
                    title="Refund"
                  >
                    <TrendingDown size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await fetch(
                        `${baseUrl}/api/orders/${detail.order_id}/receipt.zpl?mode=bag-tag`,
                        { headers: backofficeHeaders() },
                      );
                      if (res.ok) {
                        toast("Bag tags ZPL ready", "success");
                      }
                    }}
                    className="p-2 rounded-lg hover:bg-white dark:hover:bg-app-surface text-app-text-muted hover:text-emerald-600 transition-colors"
                    title="Bag Tags"
                  >
                    <Package size={18} />
                  </button>
                  {canAttemptCancel && detail.status !== "cancelled" && (
                    <button
                      type="button"
                      onClick={() => setCancelConfirmOpen(true)}
                      className="p-2 rounded-lg hover:bg-white dark:hover:bg-app-surface text-app-text-muted hover:text-red-500 transition-colors"
                      title="Cancel"
                    >
                      <AlertCircle size={18} />
                    </button>
                  )}
                </div>

                {canModify && !detail.wedding_member_id && (
                  <button
                    type="button"
                    onClick={() => setAttachWeddingModalOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-app-surface border border-app-border text-app-text-muted hover:text-emerald-600 hover:border-emerald-500/30 transition-all font-bold text-sm shadow-sm"
                    title="Attach to Wedding Party"
                  >
                    <Heart size={16} className="text-emerald-500" />
                    Attach Wedding
                  </button>
                )}
              </div>
            </div>

            {/* Progress Stepper */}
            <div className="rounded-[28px] border border-app-border bg-app-surface-2/40 p-10 backdrop-blur-md">
               <div className="relative flex justify-between">
                  {/* Progress Line */}
                  <div className="absolute top-5 left-0 right-0 h-1 bg-app-border -z-1" />
                  <div 
                    className="absolute top-5 left-0 h-1 bg-emerald-500 transition-all duration-1000 -z-1" 
                    style={{ 
                      width: detail.status === 'closed' ? '100%' : (detail.items.every(i => i.is_fulfilled) ? '66%' : '33%')
                    }} 
                  />

                  {[
                    { label: "Booked", sub: new Date(detail.booked_at).toLocaleDateString(), active: true },
                    { 
                      label: "Arrival Ready", 
                      sub: detail.items.filter(i => i.is_fulfilled).length + "/" + detail.items.length + " in store", 
                      active: detail.items.some(i => i.is_fulfilled) 
                    },
                    { 
                      label: "Pending Pickup", 
                      sub: parseMoneyToCents(detail.balance_due) > 0 ? "Balance due" : "Paid in full", 
                      active: detail.items.every(i => i.is_fulfilled) 
                    },
                    { 
                      label: "Fulfilled", 
                      sub: detail.status === 'closed' ? "Complete" : "Ongoing", 
                      active: detail.status === 'closed' 
                    },
                  ].map((step, i) => (
                    <div key={i} className="flex flex-col items-center text-center">
                       <div className={`h-11 w-11 rounded-full border-4 ${step.active ? "bg-emerald-500 border-emerald-100 dark:border-emerald-950" : "bg-app-surface border-app-border"} flex items-center justify-center transition-colors duration-500`}>
                          {step.active ? <CheckCircle2 size={20} className="text-white" /> : <div className="h-2 w-2 rounded-full bg-app-border" />}
                       </div>
                       <p className={`mt-3 text-[11px] font-black uppercase tracking-widest ${step.active ? "text-app-text" : "text-app-text-muted"}`}>
                          {step.label}
                       </p>
                       <p className="text-[10px] font-bold text-app-text-muted opacity-60">
                          {step.sub}
                       </p>
                    </div>
                  ))}
               </div>
            </div>

            {/* Financial Detail Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
               {[
                 { label: "Total Sale", val: money(detail.total_price), color: "text-app-text" },
                 { label: "Amount Paid", val: money(detail.amount_paid), color: "text-emerald-600" },
                 { label: "Balance Due", val: money(detail.balance_due), color: parseMoneyToCents(detail.balance_due) > 0 ? "text-red-500" : "text-app-text-muted" },
               ].map((fin, i) => (
                 <div key={i} className="rounded-2xl border border-app-border bg-app-surface/90 p-5 shadow-sm backdrop-blur-sm">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-50 mb-1">{fin.label}</p>
                    <p className={`text-2xl font-black tabular-nums ${fin.color}`}>{fin.val}</p>
                 </div>
               ))}
            </div>

            {/* Itemized List */}
            <div className="rounded-[24px] border border-app-border bg-app-surface-2/20 overflow-hidden backdrop-blur-sm">
               <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Order Items</h3>
                    <span className="text-xs font-bold text-app-text-muted">{detail.items.length} units</span>
                  </div>
                  {canModify && detail.status !== "cancelled" && (
                    <div className="flex items-center gap-2">
                      <input
                        value={sku}
                        onChange={(e) => setSku(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void addBySku()}
                        placeholder="Add SKU..."
                        className="ui-input h-8 w-32 translate-y-[-1px] text-[10px] font-bold"
                      />
                      <button
                        type="button"
                        onClick={() => void addBySku()}
                        className="h-8 rounded-lg bg-emerald-600 px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm hover:brightness-110 active:scale-95 transition-all"
                      >
                        Add
                      </button>
                      {detail.status !== "cancelled" && (
                        <button
                          type="button"
                          onClick={() => setReturnConfirmOpen(true)}
                          className="h-8 rounded-lg bg-amber-500/10 px-3 text-[10px] font-black uppercase tracking-widest text-amber-600 border border-amber-500/20 hover:bg-amber-500/20 transition-all"
                        >
                          Return Items
                        </button>
                      )}
                    </div>
                  )}
               </div>
               
               <div className="divide-y divide-app-border">
                  {detail.items.map((it) => (
                    <div key={it.order_item_id} className="p-6 transition-colors hover:bg-white/40 dark:hover:bg-black/10">
                       <div className="flex items-start justify-between gap-4">
                          <div className="flex gap-4">
                             <div className="h-12 w-12 shrink-0 rounded-xl bg-app-surface flex items-center justify-center border border-app-border shadow-inner">
                                <OrderKindIcon kind={it.fulfillment} />
                             </div>
                             <div>
                                <p className="font-black text-app-text leading-tight">{it.product_name}</p>
                                <p className="text-xs font-mono text-app-text-muted mt-1 uppercase opacity-60">SKU {it.sku} · {it.quantity} Unit{it.quantity > 1 ? "s" : ""}</p>
                                
                                <div className="flex items-center gap-3 mt-3">
                                   <div className="flex items-center gap-1.5 rounded-lg bg-white/50 dark:bg-black/20 px-2.5 py-1 border border-app-border">
                                      <span className="text-[10px] font-black uppercase tracking-tighter text-app-text opacity-50">Price</span>
                                      <span className="text-xs font-black tabular-nums">{money(it.unit_price)}</span>
                                   </div>
                                   {it.is_fulfilled ? (
                                     <span className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-emerald-600 border border-emerald-500/20">
                                        <CheckCircle2 size={12} />
                                        <span className="text-[10px] font-black uppercase tracking-widest">In Store</span>
                                     </span>
                                   ) : (
                                     <span className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1 text-amber-600 border border-amber-500/20">
                                        <Clock size={12} />
                                        <span className="text-[10px] font-black uppercase tracking-widest">Ordered</span>
                                     </span>
                                   )}
                                </div>
                             </div>
                          </div>
                          
                          <div className="flex items-center gap-2">
                             {(it.fulfillment as string) === "takeaway" && _canSuitSwap && _orderAllowsLineSwap && (
                                <button
                                  type="button"
                                  onClick={() => setSuitSwapTarget(it)}
                                  className="p-2 rounded-xl bg-app-surface text-app-text-muted hover:text-purple-600 hover:border-purple-200 border border-app-border transition-all shadow-sm"
                                  title="Suit Swap"
                                >
                                  <ArrowLeftRight size={14} />
                                </button>
                             )}
                             {canModify && detail.status !== "cancelled" && (
                                <button
                                  type="button"
                                  onClick={() => void deleteLine(it)}
                                  className="p-2 rounded-xl bg-app-surface text-app-text-muted hover:text-red-500 hover:border-red-200 border border-app-border transition-all shadow-sm"
                                  title="Remove Line"
                                >
                                  <Trash2 size={14} />
                                </button>
                             )}
                          </div>
                       </div>
                    </div>
                  ))}
               </div>
            </div>

            {/* Audit Trail - Compact */}
            <div className="rounded-[24px] border border-app-border bg-app-surface/40 p-6 backdrop-blur-sm">
               <div className="flex items-center gap-2 mb-4">
                  <Activity size={16} className="text-app-text-muted" />
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-80">Order History Log</h3>
               </div>
               <div className="space-y-3 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-[2px] before:bg-app-border">
                 {audit.slice(0, 5).map((e) => (
                   <div key={e.id} className="pl-6 relative">
                      <div className="absolute left-[1px] top-[6px] h-2 w-2 rounded-full bg-app-border ring-4 ring-app-surface" />
                      <p className="text-xs font-bold text-app-text leading-none">{e.summary}</p>
                      <p className="text-[10px] text-app-text-muted mt-1 opacity-60">
                        {new Date(e.created_at).toLocaleString()}
                      </p>
                   </div>
                 ))}
                 {audit.length === 0 && <p className="text-xs text-app-text-muted pl-6">New order recorded recently.</p>}
               </div>
            </div>
          </div>
        )}
          </div>
        </div>
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
            await loadOrders();
            await loadPipelineStats();
          }}
          orderId={detail.order_id}
          customerName={rows.find(r => r.order_id === selectedId)?.customer_name ?? "Customer"}
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
