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
  /** Takeaway lines can be fulfilled at checkout; special orders at pickup. */
  is_fulfilled?: boolean;
}

interface OrderDetail {
  order_id: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  exchange_group_id: string | null;
  wedding_member_id: string | null;
  customer: { id: string; first_name: string; last_name: string } | null;
  items: OrderItem[];
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
  const canSuitSwap = hasPermission("orders.suit_component_swap") && canModify;

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [sku, setSku] = useState("");
  const [audit, setAudit] = useState<OrderAuditEvent[]>([]);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 50;

  const [refundsDue, setRefundsDue] = useState<RefundQueueRow[]>([]);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
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
  const [exchangeOtherId, setExchangeOtherId] = useState("");
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [suitSwapTarget, setSuitSwapTarget] = useState<OrderItem | null>(null);
  const [suitSwapSku, setSuitSwapSku] = useState("");
  const [suitSwapNote, setSuitSwapNote] = useState("");
  const [suitSwapBusy, setSuitSwapBusy] = useState(false);

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

    const res = await fetch(`${baseUrl}/api/orders?${params.toString()}`, {
      headers: backofficeHeaders(),
    });
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

  const updateItem = async (
    item: OrderItem,
    patch: Partial<Pick<OrderItem, "quantity" | "unit_price" | "fulfillment">>,
  ) => {
    if (!detail || !canModify) return;
    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}/items/${item.order_item_id}`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Update failed", "error");
      return;
    }
    await loadDetail(detail.order_id);
    await loadOrders();
    void loadRefundsDue();
  };

  const orderAllowsLineSwap =
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

  const applyReturns = async () => {
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

  const linkExchange = async () => {
    if (!detail || !canModify) return;
    const other = exchangeOtherId.trim();
    if (!other) {
      toast("Enter the other order ID", "info");
      return;
    }
    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}/exchange-link`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ other_order_id: other }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Link failed", "error");
      return;
    }
    toast("Orders linked for exchange", "success");
    setExchangeOtherId("");
    await loadDetail(detail.order_id);
  };

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
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="w-96 shrink-0 flex flex-col border-r border-app-border bg-app-surface">
        <div className="border-b border-app-border bg-app-surface p-3 shrink-0">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Order Search & Filters
          </p>
          {canRefund && refundsDue.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-app-text">
              <p className="font-bold text-amber-800 dark:text-amber-200">
                {refundsDue.length} refund{refundsDue.length === 1 ? "" : "s"} due
              </p>
              <ul className="mt-1 max-h-24 space-y-1 overflow-y-auto">
                {refundsDue.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex justify-between gap-1">
                    <button
                      type="button"
                      className="truncate text-left font-mono text-[11px] text-app-accent hover:underline"
                      onClick={() => setSelectedId(r.order_id)}
                    >
                      {r.order_id.slice(0, 8)}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-app-accent hover:underline"
                      onClick={() => openRefundModalForOrder(r.order_id)}
                    >
                      Process
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order #, customer, wedding party..."
            className="ui-input mt-2 w-full text-xs"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="ui-input text-xs"
            >
              <option value="all">All kinds</option>
              <option value="regular_order">Regular</option>
              <option value="special_order">Special</option>
              <option value="wedding_order">Wedding</option>
              <option value="layaway">Layaway</option>
            </select>
            <select
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value)}
              className="ui-input text-xs"
            >
              <option value="all">All payment</option>
              <option value="paid">Paid</option>
              <option value="partial">Partial</option>
              <option value="unpaid">Unpaid</option>
            </select>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={salespersonFilter}
              onChange={(e) => setSalespersonFilter(e.target.value)}
              className="ui-input text-xs"
            >
              <option value="all">All salespeople</option>
              {salespersonOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              value={datePreset}
              onChange={(e) => setDatePreset(e.target.value)}
              className="ui-input text-xs"
            >
              <option value="all">All dates</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom range</option>
            </select>
          </div>
          {datePreset === "custom" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="ui-input text-xs"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="ui-input text-xs"
              />
            </div>
          )}
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
            className="ui-btn-secondary mt-2 w-full py-1.5 text-xs"
          >
            Clear filters
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows.map((r) => (
            <button
              key={r.order_id}
              type="button"
              onClick={() => setSelectedId(r.order_id)}
              className={`w-full border-b border-app-border px-4 py-3 text-left ${selectedId === r.order_id ? "bg-app-surface-2" : ""}`}
            >
              <p className="text-sm font-bold text-app-text">
                {r.customer_name ?? "Walk-in"} · {r.order_kind}
              </p>
              <p className="text-xs text-app-text-muted">
                #{r.order_id.slice(0, 8)} · {money(r.balance_due)} due
              </p>
            </button>
          ))}
        </div>
        <div className="sticky bottom-0 z-10 flex items-center justify-between border-t border-app-border bg-app-surface p-3">
          <span className="text-xs text-app-text-muted">{totalCount} max orders</span>
          <div className="flex gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded bg-app-surface-2 px-2 py-1 text-xs disabled:opacity-50"
            >
              Prev
            </button>
            <button
              disabled={(page + 1) * limit >= totalCount}
              onClick={() => setPage((p) => p + 1)}
              className="rounded bg-app-surface-2 px-2 py-1 text-xs disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!detail ? (
          <p className="text-sm text-app-text-muted">Select an order.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-black text-app-text">Order {detail.order_id.slice(0, 8)}</h2>
              <span className="text-xs text-app-text-muted">{detail.status}</span>
              {detail.exchange_group_id && (
                <span className="rounded bg-app-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase text-app-text-muted">
                  Exchange group
                </span>
              )}
              <button
                type="button"
                onClick={() => onOpenInRegister?.(detail.order_id)}
                className="ml-auto ui-btn-primary px-3 py-1.5 text-xs"
              >
                Pickup in Register
              </button>
              {canRefund && (
                <button
                  type="button"
                  onClick={() => openRefundModalForOrder(detail.order_id)}
                  className="ui-btn-secondary px-3 py-1.5 text-xs"
                >
                  Process refund
                </button>
              )}
              <button
                type="button"
                onClick={async () => {
                  const res = await fetch(
                    `${baseUrl}/api/orders/${detail.order_id}/receipt.zpl?mode=bag-tag`,
                    { headers: backofficeHeaders() },
                  );
                  if (res.ok) {
                    const zpl = await res.text();
                    console.log("ZPL Generated:", zpl);
                    toast("Bag tags ZPL ready (send via hardware bridge)", "success");
                  } else {
                    toast("Could not build bag tags", "error");
                  }
                }}
                className="ui-btn-secondary border-emerald-200 px-3 py-1.5 text-xs text-emerald-700"
              >
                Print Bag Tags
              </button>
              {canAttemptCancel && detail.status !== "cancelled" && (
                <button
                  type="button"
                  onClick={() => setCancelConfirmOpen(true)}
                  className="ui-btn-secondary px-3 py-1.5 text-xs"
                >
                  {orderUnpaid && canVoidUnpaid && !canCancel ? "Void order" : "Cancel"}
                </button>
              )}
              {canModify && detail.status === "open" && !detail.is_forfeited && (
                <button
                  type="button"
                  onClick={async () => {
                    const reason = window.prompt("Reason for forfeiture (e.g. non-payment):");
                    if (reason === null) return;
                    const res = await fetch(`${baseUrl}/api/orders/${detail.order_id}`, {
                      method: "PATCH",
                      headers: jsonHeaders(backofficeHeaders),
                      body: JSON.stringify({ 
                        status: "cancelled",
                        forfeiture_reason: reason.trim() || "Administrative forfeiture"
                      }),
                    });
                    if (res.ok) {
                        toast("Order forfeited. Inventory released and funds moved to forfeiture account.", "success");
                        await loadDetail(detail.order_id);
                        await loadOrders();
                    } else {
                        toast("Forfeiture failed", "error");
                    }
                  }}
                  className="ui-btn-secondary border-red-200 px-3 py-1.5 text-xs text-red-700"
                >
                  Forfeit
                </button>
              )}
            </div>
            {detail.is_forfeited && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    <p className="font-black uppercase tracking-widest">Order Forfeited</p>
                    <p className="mt-1">
                        Forfeited on {new Date(detail.forfeited_at!).toLocaleString()} 
                        {detail.forfeiture_reason ? ` · Reason: ${detail.forfeiture_reason}` : ""}
                    </p>
                </div>
            )}
            <p className="text-sm text-app-text-muted">
              Total {money(detail.total_price)} · Paid {money(detail.amount_paid)} · Balance{" "}
              {money(detail.balance_due)}
            </p>

            {canModify && (
              <div className="rounded-xl border border-app-border p-3">
                <p className="text-xs font-bold text-app-text">Link exchange (reporting)</p>
                <p className="mt-1 text-[11px] text-app-text-muted">
                  Enter the other order UUID to set the same exchange group on both orders.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    value={exchangeOtherId}
                    onChange={(e) => setExchangeOtherId(e.target.value)}
                    placeholder="Other order ID"
                    className="ui-input min-w-[200px] flex-1 text-xs font-mono"
                  />
                  <button type="button" onClick={() => void linkExchange()} className="ui-btn-secondary px-3 py-1.5 text-xs">
                    Link
                  </button>
                </div>
              </div>
            )}

            {canModify && (
              <div className="flex gap-2">
                <input
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="Add item by SKU..."
                  className="ui-input w-64"
                />
                <button type="button" onClick={() => void addBySku()} className="ui-btn-secondary px-3 py-1.5 text-xs">
                  Add Item
                </button>
              </div>
            )}
            {canSuitSwap && orderAllowsLineSwap && suitSwapTarget && (
              <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/15 p-3 text-xs">
                <p className="font-bold text-app-text">
                  Component swap: {suitSwapTarget.product_name} ({suitSwapTarget.sku})
                </p>
                <p className="mt-1 text-app-text-muted">
                  Scan or type the replacement SKU. Takeaway lines that are already fulfilled move floor stock
                  (old back, new out). Open takeaway carts only need available quantity on the replacement.
                  Discount-event linkage on this line is cleared; re-apply in POS if needed.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    value={suitSwapSku}
                    onChange={(e) => setSuitSwapSku(e.target.value)}
                    placeholder="Replacement SKU"
                    className="ui-input min-w-[180px] flex-1 font-mono"
                  />
                  <input
                    value={suitSwapNote}
                    onChange={(e) => setSuitSwapNote(e.target.value)}
                    placeholder="Optional note (audit)"
                    className="ui-input min-w-[160px] flex-1"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={suitSwapBusy || !suitSwapSku.trim()}
                    onClick={() => void submitSuitSwap()}
                    className="ui-btn-primary px-3 py-1.5 text-xs"
                  >
                    {suitSwapBusy ? "Working…" : "Confirm swap"}
                  </button>
                  <button
                    type="button"
                    disabled={suitSwapBusy}
                    onClick={() => {
                      setSuitSwapTarget(null);
                      setSuitSwapSku("");
                      setSuitSwapNote("");
                    }}
                    className="ui-btn-secondary px-3 py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {detail.items.map((it) => {
                const returned = it.quantity_returned ?? 0;
                const sellable = it.quantity - returned;
                return (
                  <div key={it.order_item_id} className="rounded-xl border border-app-border p-3">
                    <p className="font-semibold text-app-text">
                      {it.product_name} ({it.sku})
                      {returned > 0 && (
                        <span className="ml-2 text-xs font-normal text-app-text-muted">
                          Returned {returned} / {it.quantity}
                        </span>
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <label>Qty</label>
                      <input
                        type="number"
                        min={1}
                        defaultValue={it.quantity}
                        disabled={!canModify}
                        className="ui-input w-20 disabled:opacity-50"
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v > 0 && v !== it.quantity) {
                            void updateItem(it, { quantity: v });
                          }
                        }}
                      />
                      <label>Unit</label>
                      <input
                        type="number"
                        step="0.01"
                        defaultValue={Number(it.unit_price)}
                        disabled={!canModify}
                        className="ui-input w-28 disabled:opacity-50"
                        onBlur={(e) => {
                          const c = parseMoneyToCents(e.target.value);
                          if (
                            c >= 0 &&
                            c !== parseMoneyToCents(it.unit_price)
                          ) {
                            void updateItem(it, { unit_price: centsToFixed2(c) });
                          }
                        }}
                      />
                      <select
                        defaultValue={it.fulfillment}
                        disabled={!canModify}
                        className="ui-input w-36 disabled:opacity-50"
                        onChange={(e) => void updateItem(it, { fulfillment: e.target.value as FulfillmentKind })}
                      >
                        <option value="takeaway">Takeaway</option>
                        <option value="special_order">Special order</option>
                        <option value="wedding_order">Wedding order</option>
                      </select>
                      {canModify && (
                        <button
                          type="button"
                          onClick={() => void deleteLine(it)}
                          className="ui-btn-secondary px-2 py-1 text-[11px]"
                        >
                          Delete line
                        </button>
                      )}
                      {canSuitSwap && orderAllowsLineSwap && sellable > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setSuitSwapTarget(it);
                            setSuitSwapSku("");
                            setSuitSwapNote("");
                          }}
                          className="rounded border border-emerald-700/50 bg-emerald-900/20 px-2 py-1 text-[11px] font-semibold text-emerald-100"
                        >
                          Swap component
                        </button>
                      )}
                    </div>
                    {it.is_fulfilled && it.fulfillment === "takeaway" && (
                      <p className="mt-1 text-[10px] text-app-text-muted">Fulfilled at sale — swap adjusts on-hand stock.</p>
                    )}
                    {canModify && detail.status !== "cancelled" && sellable > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-app-border pt-2 text-xs">
                        <span className="text-app-text-muted">Return qty (max {sellable})</span>
                        <input
                          type="number"
                          min={0}
                          max={sellable}
                          value={returnQtyDraft[it.order_item_id] ?? ""}
                          onChange={(e) =>
                            setReturnQtyDraft((d) => ({ ...d, [it.order_item_id]: e.target.value }))
                          }
                          className="ui-input w-20"
                          placeholder="0"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {canModify && detail.status !== "cancelled" && (
              <button type="button" onClick={() => void applyReturns()} className="ui-btn-secondary px-3 py-1.5 text-xs">
                Apply line returns
              </button>
            )}
            <div className="rounded-xl border border-app-border p-3">
              <h3 className="text-sm font-bold text-app-text">Order Audit Trail</h3>
              <div className="mt-2 space-y-1">
                {audit.map((e) => (
                  <p key={e.id} className="text-xs text-app-text-muted">
                    {new Date(e.created_at).toLocaleString()} · {e.summary}
                  </p>
                ))}
                {audit.length === 0 && <p className="text-xs text-app-text-muted">No audit events yet.</p>}
              </div>
            </div>
          </div>
        )}
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

      <RegisterRequiredModal
        open={registerRequiredOpen}
        onClose={() => setRegisterRequiredOpen(false)}
        onGoToRegister={goToOpenRegister}
      />
    </div>
  );
}
