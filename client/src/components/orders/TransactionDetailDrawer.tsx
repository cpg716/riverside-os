import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Clock,
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  Printer,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import {
  customOrderDetailEntries,
  customVendorLabel,
  type CustomOrderDetails,
} from "../../lib/customOrders";
import { getAppIcon } from "../../lib/icons";

const RECEIPT_ICON = getAppIcon("receipt");
const REGISTER_ICON = getAppIcon("register");
const ORDERS_ICON = getAppIcon("orders");
const WEDDINGS_ICON = getAppIcon("weddings");
const CUSTOMERS_ICON = getAppIcon("customers");
import DetailDrawer from "../layout/DetailDrawer";
import ReceiptSummaryModal from "../pos/ReceiptSummaryModal";
import type { FulfillmentKind } from "../pos/types";
import VariantSearchInput from "../ui/VariantSearchInput";

function fmtMoney(v: string | number): string {
  return formatUsdFromCents(parseMoneyToCents(v));
}

const baseUrl = getBaseUrl();

export interface TransactionDrawerItem {
  transaction_line_id?: string;
  order_item_id?: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned?: number;
  unit_price: string;
  unit_cost?: string;
  state_tax?: string;
  local_tax?: string;
  fulfillment: string;
  is_fulfilled: boolean;
  is_internal?: boolean;
  custom_item_type?: string | null;
  custom_order_details?: CustomOrderDetails | null;
  salesperson_name?: string | null;
}

export interface TransactionDrawerDetail {
  transaction_id: string;
  transaction_display_id?: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  financial_summary?: {
    total_allocated_payments: string;
    total_applied_deposit_amount: string;
  };
  fulfillment_method?: string;
  ship_to?: Record<string, unknown> | null;
  shipping_amount_usd?: string | null;
  tracking_number?: string | null;
  tracking_url_provider?: string | null;
  shipping_label_url?: string | null;
  payment_methods_summary?: string;
  operator_name?: string | null;
  primary_salesperson_name?: string | null;
  wedding_member_id?: string | null;
  wedding_summary?: {
    wedding_party_id: string;
    wedding_member_id: string;
    party_name?: string | null;
    event_date?: string | null;
    member_role?: string | null;
  } | null;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    phone?: string | null;
    email?: string | null;
  } | null;
  items: TransactionDrawerItem[];
  is_tax_exempt?: boolean;
  tax_exempt_reason?: string | null;
  register_session_id?: string | null;
}

export interface TransactionDrawerAudit {
  id: string;
  event_kind: string;
  summary: string;
  created_at: string;
}

export interface TransactionDrawerOrderActions {
  onOpenInRegister?: (orderId: string) => void;
  onAttachToWedding?: () => void;
  onCancel?: () => void;
  onReturnAll?: () => void;
  onProcessRefund?: () => void;
  deleteLine?: (item: {
    order_item_id: string;
    sku: string;
    product_name: string;
    quantity: number;
    fulfillment: FulfillmentKind;
  }) => void;
  addBySku?: (skuOverride?: string) => Promise<boolean>;
  updateLine?: (
    item: {
      transaction_line_id: string;
      sku: string;
      product_name: string;
      quantity: number;
      unit_price: string;
      fulfillment: FulfillmentKind;
    },
    patch: {
      quantity?: number;
      unit_price?: string;
      fulfillment?: FulfillmentKind;
    },
  ) => Promise<void>;
  setSku?: (sku: string) => void;
  sku?: string;
  canModify?: boolean;
  canAttemptCancel?: boolean;
  canRefund?: boolean;
}

type EditableFulfillmentKind = Extract<
  FulfillmentKind,
  "special_order" | "custom" | "wedding_order" | "layaway" | "takeaway"
>;

const EDITABLE_FULFILLMENT_OPTIONS: Array<{
  value: EditableFulfillmentKind;
  label: string;
}> = [
  { value: "special_order", label: "Special" },
  { value: "custom", label: "Custom" },
  { value: "wedding_order", label: "Wedding" },
  { value: "layaway", label: "Layaway" },
  { value: "takeaway", label: "Takeaway" },
];

interface TransactionDetailDrawerProps {
  orderId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onOpenCustomerHub?: (customerId: string) => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
  detail?: TransactionDrawerDetail | null;
  audit?: TransactionDrawerAudit[];
  loading?: boolean;
  errorMessage?: string | null;
  orderActions?: TransactionDrawerOrderActions;
}

function formatAuditKind(kind: string): string {
  switch (kind) {
    case "checkout":
      return "Booked";
    case "pickup":
      return "Pickup completed";
    case "refund_processed":
      return "Refund processed";
    case "refund_queued":
      return "Refund queued";
    case "status_change":
      return "Status update";
    case "line_return":
      return "Return recorded";
    case "exchange_linked":
      return "Exchange linked";
    case "item_added":
      return "Item added";
    case "item_updated":
      return "Item updated";
    case "item_deleted":
      return "Item removed";
    case "suit_component_swap":
      return "Suit component swap";
    case "forfeiture":
      return "Layaway forfeited";
    default:
      return kind.replace(/_/g, " ");
  }
}

function formatStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function describeLifecycle(detail: TransactionDrawerDetail) {
  const paidCents = parseMoneyToCents(detail.amount_paid);
  const dueCents = parseMoneyToCents(detail.balance_due);
  const depositCents = parseMoneyToCents(
    detail.financial_summary?.total_applied_deposit_amount ?? "0",
  );
  const isWedding = Boolean(detail.wedding_summary);

  if (detail.status === "fulfilled") {
    return isWedding
      ? "Picked up. This wedding order is complete."
      : "Picked up. This order is complete.";
  }
  if (detail.status === "pending_measurement") {
    return isWedding
      ? "Waiting on measurements or booking details. Keep wedding-member follow-up in place before pickup can continue."
      : "Waiting on measurements or booking details before pickup can continue.";
  }
  if (dueCents <= 0) {
    return isWedding
      ? "Balance paid. Receiving and pickup release still stay with the linked wedding member workflow."
      : "Balance paid. Receiving and pickup release still stay with order status.";
  }
  if (depositCents > 0) {
    return isWedding
      ? `Deposit recorded on the linked wedding member. ${fmtMoney(detail.balance_due)} is still due before pickup is complete.`
      : `Deposit recorded. ${fmtMoney(detail.balance_due)} is still due before pickup is complete.`;
  }
  if (paidCents > 0) {
    return isWedding
      ? `Partial payment recorded for this wedding member. ${fmtMoney(detail.balance_due)} is still due before pickup is complete.`
      : `Partial payment recorded. ${fmtMoney(detail.balance_due)} is still due before pickup is complete.`;
  }
  return isWedding
    ? "No payment is recorded yet. Confirm wedding-member readiness before collecting money or promising pickup."
    : "No payment is recorded yet. Confirm receiving and readiness before collecting money.";
}

function describeOrderRules(detail: TransactionDrawerDetail): string[] {
  const isWedding = Boolean(detail.wedding_summary);
  const lines = [
    "The Transaction Record holds payment, receipt, refund, and balance details.",
    detail.status === "fulfilled"
      ? "Pickup is already complete for this record."
      : "Special, Custom, and Wedding lines stay in order pickup work; Layaways stay in Layaways.",
  ];

  if (detail.status === "pending_measurement") {
    lines.push(
      isWedding
        ? "Measurement and wedding-member readiness still have to clear before pickup can finish."
        : "Measurement or booking details still have to clear before pickup can finish.",
    );
  } else {
    lines.push(
      isWedding
        ? "A paid balance does not mean the linked wedding member is ready until receiving and pickup work are complete."
        : "A paid balance does not automatically mean the item is ready until receiving and pickup work are complete.",
    );
  }

  return lines;
}

function orderKindLabel(detail: TransactionDrawerDetail): string {
  if (detail.wedding_summary || detail.wedding_member_id) return "Wedding";
  if (detail.items.some((item) => item.fulfillment === "layaway")) return "Layaway";
  if (detail.items.some((item) => item.fulfillment === "custom")) return "Custom";
  if (detail.items.some((item) => item.fulfillment === "special_order")) return "Special";
  return "Transaction";
}

function fulfillmentSummary(detail: TransactionDrawerDetail) {
  const customerVisibleItems = detail.items.filter((item) => !item.is_internal);
  const fulfilledItems = customerVisibleItems.filter((item) => item.is_fulfilled);
  const pendingItems = customerVisibleItems.filter((item) => !item.is_fulfilled);
  const fulfilled = fulfilledItems.length;
  const pending = pendingItems.length;
  return {
    total: customerVisibleItems.length,
    fulfilled,
    pending,
    fulfilledUnits: fulfilledItems.reduce((sum, item) => sum + item.quantity, 0),
    pendingUnits: pendingItems.reduce((sum, item) => sum + item.quantity, 0),
    returnedUnits: customerVisibleItems.reduce(
      (sum, item) => sum + (item.quantity_returned ?? 0),
      0,
    ),
  };
}

function modeSummary(detail: TransactionDrawerDetail): {
  modeLabel: string;
  modeDetail: string;
} {
  if (detail.fulfillment_method === "ship") {
    return {
      modeLabel: "Shipping Work",
      modeDetail: detail.tracking_number
        ? "Shipping flow is active and a tracking number is on file."
        : "Shipping flow is active. Confirm address, label, and carrier progress.",
    };
  }
  return {
    modeLabel: "Pickup Work",
    modeDetail: "Pickup release still depends on readiness, not just payment status.",
  };
}

function readinessSummary(
  detail: TransactionDrawerDetail,
  summary: ReturnType<typeof fulfillmentSummary>,
): {
  readinessLabel: string;
  readinessTone: "success" | "warning" | "info";
  remainingWorkLabel: string;
  releaseLabel: string;
  releaseTone: "success" | "warning" | "info";
} {
  const dueCents = parseMoneyToCents(detail.balance_due);
  const isShip = detail.fulfillment_method === "ship";

  let readinessLabel: string;
  let readinessTone: "success" | "warning" | "info";
  if (detail.status === "fulfilled" || summary.pending === 0) {
    readinessLabel = "Complete";
    readinessTone = "success";
  } else if (detail.status === "pending_measurement") {
    readinessLabel = "Waiting on Details";
    readinessTone = "warning";
  } else if (summary.fulfilled > 0) {
    readinessLabel = "Partially Fulfilled";
    readinessTone = "info";
  } else {
    readinessLabel = "Open";
    readinessTone = "warning";
  }

  let remainingWorkLabel: string;
  if (summary.pending === 0) {
    remainingWorkLabel = isShip
      ? "No customer-visible shipping work is still open."
      : "No customer-visible pickup work is still open.";
  } else if (summary.pending === 1) {
    remainingWorkLabel = isShip
      ? "1 line still needs shipping work."
      : "1 line still needs pickup-ready work.";
  } else {
    remainingWorkLabel = isShip
      ? `${summary.pending} lines still need shipping work.`
      : `${summary.pending} lines still need pickup-ready work.`;
  }

  if (dueCents > 0) {
    return {
      readinessLabel,
      readinessTone,
      remainingWorkLabel,
      releaseLabel: "Balance Due Before Release",
      releaseTone: "warning",
    };
  }

  if (summary.pending > 0) {
    return {
      readinessLabel,
      readinessTone,
      remainingWorkLabel,
      releaseLabel: isShip ? "Balance Clear, Work Still Open" : "Balance Clear, Pickup Still Blocked",
      releaseTone: "info",
    };
  }

  return {
    readinessLabel,
    readinessTone,
    remainingWorkLabel,
    releaseLabel: isShip ? "Ready for Shipping Release" : "Ready for Pickup Release",
    releaseTone: "success",
  };
}

function badgeClassName(kind: "success" | "info" | "warning" | "neutral" | "rose") {
  switch (kind) {
    case "success":
      return "border-app-success/20 bg-app-success/10 text-app-success";
    case "info":
      return "border-app-info/20 bg-app-info/10 text-app-info";
    case "warning":
      return "border-app-warning/20 bg-app-warning/10 text-app-warning";
    case "rose":
      return "border-app-danger/20 bg-app-danger/10 text-app-danger";
    default:
      return "border-app-border bg-app-surface-2 text-app-text-muted";
  }
}

function addressLines(shipTo: Record<string, unknown> | null | undefined): string[] {
  if (!shipTo) return [];
  const get = (key: string) => {
    const value = shipTo[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const name = get("name");
  const street1 = get("street1");
  const street2 = get("street2");
  const city = get("city");
  const state = get("state");
  const zip = get("zip");
  const country = get("country");
  const locality = [city, state, zip].filter(Boolean).join(", ");
  return [name, street1, street2, locality || null, country].filter(
    (line): line is string => Boolean(line),
  );
}

function mapOrderActionButtons(
  detail: TransactionDrawerDetail | null,
  orderActions?: TransactionDrawerOrderActions,
) {
  if (!detail || !orderActions) return null;
  return (
    <>
      {orderActions.onOpenInRegister ? (
        <button
          type="button"
          onClick={() => orderActions.onOpenInRegister?.(detail.transaction_id)}
          className="rounded-xl border border-emerald-500/20 bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white"
        >
          Open in Register
        </button>
      ) : null}
      {orderActions.canModify &&
      !detail.wedding_member_id &&
      detail.status !== "cancelled" &&
      orderActions.onAttachToWedding ? (
        <button
          type="button"
          onClick={orderActions.onAttachToWedding}
          className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
        >
          Attach Wedding
        </button>
      ) : null}
      {orderActions.canAttemptCancel &&
      detail.status !== "cancelled" &&
      orderActions.onCancel ? (
        <button
          type="button"
          onClick={orderActions.onCancel}
          className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-danger"
        >
          Cancel Transaction
        </button>
      ) : null}
      {orderActions.canModify &&
      detail.status !== "cancelled" &&
      orderActions.onReturnAll ? (
        <button
          type="button"
          onClick={orderActions.onReturnAll}
          className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted"
        >
          Return All
        </button>
      ) : null}
      {orderActions.canRefund && orderActions.onProcessRefund ? (
        <button
          type="button"
          onClick={orderActions.onProcessRefund}
          className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
        >
          Process Refund
        </button>
      ) : null}
    </>
  );
}

export default function TransactionDetailDrawer({
  orderId,
  isOpen,
  onClose,
  onOpenCustomerHub,
  onOpenTransactionInBackoffice,
  detail: controlledDetail,
  audit: controlledAudit,
  loading: controlledLoading,
  errorMessage: controlledErrorMessage,
  orderActions,
}: TransactionDetailDrawerProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [internalDetail, setInternalDetail] = useState<TransactionDrawerDetail | null>(null);
  const [internalAudit, setInternalAudit] = useState<TransactionDrawerAudit[]>([]);
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalErrorMessage, setInternalErrorMessage] = useState<string | null>(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("1");
  const [editUnitPrice, setEditUnitPrice] = useState("");
  const [editFulfillment, setEditFulfillment] =
    useState<EditableFulfillmentKind>("special_order");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const usesControlledData =
    controlledDetail !== undefined ||
    controlledAudit !== undefined ||
    controlledLoading !== undefined ||
    controlledErrorMessage !== undefined;

  const detail = usesControlledData ? controlledDetail ?? null : internalDetail;
  const audit = usesControlledData ? controlledAudit ?? [] : internalAudit;
  const loading = usesControlledData ? controlledLoading ?? false : internalLoading;
  const errorMessage = usesControlledData
    ? controlledErrorMessage ?? null
    : internalErrorMessage;

  const load = useCallback(async () => {
    if (!orderId || usesControlledData) return;
    setInternalLoading(true);
    setInternalErrorMessage(null);
    try {
      const [detailRes, auditRes] = await Promise.all([
        fetch(`${baseUrl}/api/transactions/${orderId}`, { headers: auth() }),
        fetch(`${baseUrl}/api/transactions/${orderId}/audit`, { headers: auth() }),
      ]);

      if (!detailRes.ok) {
        setInternalDetail(null);
        setInternalAudit([]);
        setInternalErrorMessage("We couldn't load this transaction record right now.");
        return;
      }

      setInternalDetail((await detailRes.json()) as TransactionDrawerDetail);

      if (auditRes.ok) {
        setInternalAudit((await auditRes.json()) as TransactionDrawerAudit[]);
      } else {
        setInternalAudit([]);
      }
    } catch {
      setInternalDetail(null);
      setInternalAudit([]);
      setInternalErrorMessage("We couldn't load this transaction record right now.");
    } finally {
      setInternalLoading(false);
    }
  }, [orderId, auth, usesControlledData]);

  useEffect(() => {
    if (isOpen && orderId) {
      void load();
      return;
    }
    if (!usesControlledData) {
      setInternalDetail(null);
      setInternalAudit([]);
      setInternalErrorMessage(null);
    }
  }, [isOpen, orderId, load, usesControlledData]);

  const summary = useMemo(() => (detail ? fulfillmentSummary(detail) : null), [detail]);
  const shippingLines = useMemo(() => addressLines(detail?.ship_to), [detail?.ship_to]);
  const mode = useMemo(() => (detail ? modeSummary(detail) : null), [detail]);
  const readiness = useMemo(
    () => (detail && summary ? readinessSummary(detail, summary) : null),
    [detail, summary],
  );
  const beginLineEdit = useCallback((item: TransactionDrawerItem) => {
    if (!item.transaction_line_id) return;
    setEditingLineId(item.transaction_line_id);
    setEditQuantity(String(item.quantity));
    setEditUnitPrice(String(item.unit_price));
    setEditFulfillment(
      (item.fulfillment as EditableFulfillmentKind) ?? "special_order",
    );
    setEditError(null);
  }, []);
  const cancelLineEdit = useCallback(() => {
    if (editBusy) return;
    setEditingLineId(null);
    setEditError(null);
  }, [editBusy]);

  useEffect(() => {
    if (!detail || !editingLineId) return;
    const stillExists = detail.items.some(
      (item) => item.transaction_line_id === editingLineId,
    );
    if (!stillExists) {
      setEditingLineId(null);
      setEditError(null);
    }
  }, [detail, editingLineId]);

  const submitLineEdit = useCallback(
    async (item: TransactionDrawerItem) => {
      if (!orderActions?.updateLine || !item.transaction_line_id) return;
      const quantity = Number.parseInt(editQuantity.trim(), 10);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setEditError("Quantity must be a whole number greater than zero.");
        return;
      }
      const nextPrice = editUnitPrice.trim();
      if (!nextPrice) {
        setEditError("Unit price is required.");
        return;
      }

      const patch: {
        quantity?: number;
        unit_price?: string;
        fulfillment?: FulfillmentKind;
      } = {};
      if (quantity !== item.quantity) patch.quantity = quantity;
      if (nextPrice !== String(item.unit_price)) patch.unit_price = nextPrice;
      if (editFulfillment !== item.fulfillment) patch.fulfillment = editFulfillment;
      if (
        patch.quantity === undefined &&
        patch.unit_price === undefined &&
        patch.fulfillment === undefined
      ) {
        setEditingLineId(null);
        return;
      }

      setEditBusy(true);
      setEditError(null);
      try {
        await orderActions.updateLine(
          {
            transaction_line_id: item.transaction_line_id,
            sku: item.sku,
            product_name: item.product_name,
            quantity: item.quantity,
            unit_price: String(item.unit_price),
            fulfillment: item.fulfillment as FulfillmentKind,
          },
          {
            ...patch,
          },
        );
        setEditingLineId(null);
      } catch (error) {
        setEditError(
          error instanceof Error
            ? error.message
            : "We couldn't save that line right now.",
        );
      } finally {
        setEditBusy(false);
      }
    },
    [editFulfillment, editQuantity, editUnitPrice, orderActions],
  );

  const subtitle = detail ? (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          {detail.transaction_display_id ?? detail.transaction_id.slice(0, 8)}
        </span>
        <span
          className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
            detail.wedding_summary ? "rose" : "info",
          )}`}
        >
          {orderKindLabel(detail)}
        </span>
        <span
          className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
            detail.status === "fulfilled"
              ? "success"
              : parseMoneyToCents(detail.balance_due) > 0
                ? "warning"
                : "neutral",
          )}`}
        >
          {formatStatusLabel(detail.status)}
        </span>
      </div>
      <p className="text-[11px] font-semibold text-app-text-muted">
        Booked {new Date(detail.booked_at).toLocaleString()}
      </p>
    </div>
  ) : null;

	  const handleAddBySku = useCallback(async () => {
	    if (!orderActions?.addBySku) return;
	    await orderActions.addBySku();
	  }, [orderActions]);

  return (
    <>
      <DetailDrawer
        isOpen={isOpen}
        onClose={onClose}
        title="Transaction Record"
        subtitle={subtitle}
        panelMaxClassName="max-w-3xl"
        actions={mapOrderActionButtons(detail, orderActions)}
        footer={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => setShowReceiptModal(true)}
              disabled={!detail}
              className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg transition-all duration-150 hover:bg-emerald-500 active:translate-y-0.5 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer size={16} />
              Reprint Receipt
            </button>
            {detail && orderActions?.onOpenInRegister ? (
              <button
                type="button"
                onClick={() => orderActions.onOpenInRegister?.(detail.transaction_id)}
                className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg transition-all duration-150 hover:bg-emerald-500 active:translate-y-0.5 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/25"
              >
                <REGISTER_ICON size={16} />
                Open in Register
              </button>
            ) : null}
            {onOpenTransactionInBackoffice && detail ? (
              <button
                type="button"
                onClick={() => onOpenTransactionInBackoffice(detail.transaction_id)}
                className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-app-accent/80 bg-app-accent py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg transition-all duration-150 hover:opacity-90 active:translate-y-0.5 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/25"
              >
                <ExternalLink size={16} />
                Full Operations
              </button>
            ) : null}
          </div>
        }
      >
        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-24 animate-pulse rounded-2xl border border-app-border bg-app-surface-2/70"
              />
            ))}
          </div>
        ) : errorMessage ? (
          <div className="ui-panel ui-tint-danger p-5 text-sm font-semibold text-app-danger">
            {errorMessage}
          </div>
        ) : !detail ? (
          <div className="ui-panel ui-tint-neutral p-6 text-sm text-app-text-muted">
            Transaction record is unavailable.
          </div>
        ) : (
          <div className="space-y-5">
            <section className="grid gap-4 lg:grid-cols-2">
              <div className="ui-panel ui-tint-info p-4">
                <div className="flex items-center gap-2">
                  <RECEIPT_ICON size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    Financial Snapshot
                  </h3>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Total
                    </p>
                    <p className="mt-1 text-xl font-black text-app-text">
                      {fmtMoney(detail.total_price)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Balance Due
                    </p>
                    <p className="mt-1 text-xl font-black text-app-warning">
                      {fmtMoney(detail.balance_due)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Paid
                    </p>
                    <p className="mt-1 text-sm font-black text-app-success">
                      {fmtMoney(detail.amount_paid)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Deposit on Transaction
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {fmtMoney(detail.financial_summary?.total_applied_deposit_amount ?? "0")}
                    </p>
                  </div>
                </div>
                <div className="mt-3 space-y-2 border-t border-app-border/50 pt-3">
                  <div className="flex items-start justify-between gap-3 text-[11px]">
                    <span className="font-black uppercase tracking-widest text-app-text-muted">
                      Transaction Payments
                    </span>
                    <span className="text-right font-semibold text-app-text">
                      {fmtMoney(detail.financial_summary?.total_allocated_payments ?? "0")}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-[11px]">
                    <span className="font-black uppercase tracking-widest text-app-text-muted">
                      Tender Summary
                    </span>
                    <span className="max-w-[60%] text-right font-semibold text-app-text">
                      {detail.payment_methods_summary || "—"}
                    </span>
                  </div>
                  {detail.is_tax_exempt ? (
                    <div className="ui-panel ui-tint-warning p-3 text-[11px] font-semibold text-app-text">
                      Tax exempt{detail.tax_exempt_reason ? `: ${detail.tax_exempt_reason}` : ""}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="ui-panel ui-tint-neutral p-4">
                <div className="flex items-center gap-2">
                  <ORDERS_ICON size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    Order Status
                  </h3>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span
                    className={`rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName("info")}`}
                  >
                    {mode?.modeLabel ?? "Pickup Work"}
                  </span>
                  <span
                    className={`rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
                      readiness?.readinessTone ?? "neutral",
                    )}`}
                  >
                    {readiness?.readinessLabel ?? "Open"}
                  </span>
                  <span
                    className={`rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
                      readiness?.releaseTone ?? "neutral",
                    )}`}
                  >
                    {readiness?.releaseLabel ?? "Review Release State"}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Mode
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {detail.fulfillment_method === "ship" ? "Ship" : "Pickup"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Visible Lines
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {summary?.total ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Fulfilled
                    </p>
                    <p className="mt-1 text-sm font-black text-app-success">
                      {summary?.fulfilled ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Still Open
                    </p>
                    <p className="mt-1 text-sm font-black text-app-warning">
                      {summary?.pending ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Open Units
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {summary?.pendingUnits ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Completed Units
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {summary?.fulfilledUnits ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Returned Units
                    </p>
                    <p className="mt-1 text-sm font-black text-app-text">
                      {summary?.returnedUnits ?? 0}
                    </p>
                  </div>
                </div>
                <div className="ui-panel ui-tint-info mt-3 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Mode Cue
                  </p>
                  <p className="mt-2 text-[12px] font-semibold text-app-text">
                    {mode?.modeDetail}
                  </p>
                </div>
                <div className="mt-3 rounded-xl border border-app-border/70 bg-app-surface p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Remaining Work
                  </p>
                  <p className="mt-2 text-[12px] font-semibold text-app-text">
                    {readiness?.remainingWorkLabel}
                  </p>
                </div>
                <div className="mt-3 rounded-xl border border-app-border/70 bg-app-surface p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Status Note
                  </p>
                  <p className="mt-2 text-[12px] font-semibold text-app-text">
                    {describeLifecycle(detail)}
                  </p>
                </div>
              </div>
            </section>

            {detail.wedding_summary ? (
              <section className="rounded-2xl border border-rose-500/20 bg-rose-500/8 p-4">
                <div className="flex items-center gap-2">
                  <WEDDINGS_ICON size={16} className="text-rose-500" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-rose-700">
                    Wedding Link
                  </h3>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Party
                    </p>
                    <p className="mt-1 text-sm font-bold text-app-text">
                      {detail.wedding_summary.party_name ?? "Linked wedding party"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Member Role
                    </p>
                    <p className="mt-1 text-sm font-bold text-app-text">
                      {detail.wedding_summary.member_role ?? "Wedding member"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Event Date
                    </p>
                    <p className="mt-1 text-sm font-bold text-app-text">
                      {detail.wedding_summary.event_date
                        ? new Date(detail.wedding_summary.event_date).toLocaleDateString()
                        : "Not set"}
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <CUSTOMERS_ICON size={16} className="text-app-text-muted" />
                    <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                      Customer
                    </h3>
                  </div>
                  {detail.customer?.id && onOpenCustomerHub ? (
                    <button
                      type="button"
                      onClick={() => onOpenCustomerHub(detail.customer!.id)}
                      className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                    >
                      View Hub <ExternalLink size={12} />
                    </button>
                  ) : null}
                </div>
                {detail.customer ? (
                  <div className="mt-3 space-y-2 text-sm text-app-text">
                    <p className="font-black">
                      {detail.customer.first_name} {detail.customer.last_name}
                    </p>
                    {detail.customer.phone ? (
                      <p className="flex items-center gap-2 text-[12px] font-semibold text-app-text-muted">
                        <Phone size={14} />
                        {detail.customer.phone}
                      </p>
                    ) : null}
                    {detail.customer.email ? (
                      <p className="flex items-center gap-2 text-[12px] font-semibold text-app-text-muted">
                        <Mail size={14} />
                        {detail.customer.email}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-app-text-muted">No customer linked.</p>
                )}
              </div>

              <div className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
                <div className="flex items-center gap-2">
                  <MapPin size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    {detail.fulfillment_method === "ship" ? "Shipping" : "Pickup"}
                  </h3>
                </div>
                <div className="mt-3 space-y-2 text-[12px] font-semibold text-app-text">
                  {detail.fulfillment_method === "ship" ? (
                    <>
                      <p>
                        Shipping amount:{" "}
                        <span className="font-black">
                          {fmtMoney(detail.shipping_amount_usd ?? "0")}
                        </span>
                      </p>
                      {shippingLines.length > 0 ? (
                        <div className="rounded-xl border border-app-border/70 bg-app-surface p-3">
                          {shippingLines.map((line) => (
                            <p key={line}>{line}</p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-app-text-muted">No shipping address snapshot stored.</p>
                      )}
                      {detail.tracking_number ? (
                        <p>
                          Tracking: <span className="font-black">{detail.tracking_number}</span>
                        </p>
                      ) : null}
                      {detail.tracking_url_provider ? (
                        <p className="text-app-text-muted">
                          Carrier link: {detail.tracking_url_provider}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-app-text-muted">
                        Pickup release still depends on readiness, not just payment status.
                      </p>
                      <div className="rounded-xl border border-app-border/70 bg-app-surface p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Release Check
                        </p>
                        <p className="mt-2 text-[12px] font-semibold text-app-text">
                          {readiness?.releaseLabel ?? "Review balance and readiness before release."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ORDERS_ICON size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    Items ({detail.items.filter((item) => !item.is_internal).length})
                  </h3>
                </div>
                {orderActions?.canModify &&
                detail.status !== "cancelled" &&
                orderActions.setSku &&
                orderActions.addBySku ? (
	                  <div className="flex min-w-[280px] items-center gap-2">
	                    <VariantSearchInput
	                      className="h-9 min-w-[220px] rounded-lg border border-app-border bg-app-surface px-3 text-[11px] font-semibold outline-none"
	                      placeholder="Search item or SKU..."
	                      onSelect={(variant) => {
	                        orderActions.setSku?.(variant.sku);
	                        void orderActions.addBySku?.(variant.sku);
	                      }}
	                    />
	                    <button
	                      type="button"
                      onClick={() => {
                        void handleAddBySku();
                      }}
                      className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent transition-all duration-150 hover:border-app-accent/30 hover:bg-app-surface-2 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20"
                    >
                      Add
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mt-4 space-y-3">
                {[
                  {
                    key: "open",
                    title: "Still Open",
                    description:
                      detail.fulfillment_method === "ship"
                        ? "These lines still need shipping work."
                        : "These lines still need pickup-ready work.",
                    items: detail.items.filter(
                      (item) => !item.is_internal && !item.is_fulfilled,
                    ),
                  },
                  {
                    key: "fulfilled",
                    title: "Already Fulfilled",
                    description:
                      detail.fulfillment_method === "ship"
                        ? "These lines are already completed for shipping."
                        : "These lines are already completed for pickup.",
                    items: detail.items.filter(
                      (item) => !item.is_internal && item.is_fulfilled,
                    ),
                  },
                ]
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <div key={group.key} className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border/60 bg-app-surface-2/70 px-3 py-2">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                            {group.title}
                          </p>
                          <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                            {group.description}
                          </p>
                        </div>
                        <span
                          className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
                            group.key === "fulfilled" ? "success" : "warning",
                          )}`}
                        >
                          {group.items.length} {group.items.length === 1 ? "line" : "lines"}
                        </span>
                      </div>
                      {group.items.map((item) => {
                    const itemId = item.order_item_id ?? item.transaction_line_id;
                    const returnedQty = item.quantity_returned ?? 0;
                    return (
                      <div
                        key={itemId ?? `${item.sku}-${item.product_name}`}
                        className={`rounded-xl border p-4 ${
                          item.is_fulfilled
                            ? "border-emerald-500/15 bg-emerald-500/5"
                            : "border-app-border bg-app-surface"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-black text-app-text">
                                {item.product_name}
                              </p>
                              <span
                                className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
                                  item.is_fulfilled ? "success" : "warning",
                                )}`}
                              >
                                {item.is_fulfilled ? "Fulfilled" : "Open"}
                              </span>
                              <span
                                className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
                                  item.fulfillment === "wedding_order"
                                    ? "rose"
                                    : item.fulfillment === "custom"
                                      ? "info"
                                      : "neutral",
                                )}`}
                              >
                                {item.fulfillment.replace(/_/g, " ")}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                              {item.sku}
                              {item.variation_label ? ` · ${item.variation_label}` : ""}
                              {item.salesperson_name ? ` · ${item.salesperson_name}` : ""}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-4 text-[11px] font-semibold text-app-text">
                              <span>Qty {item.quantity}</span>
                              <span>Unit {fmtMoney(item.unit_price)}</span>
                              {returnedQty > 0 ? <span>Returned {returnedQty}</span> : null}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            {orderActions?.canModify &&
                            detail.status !== "cancelled" &&
                            !item.is_fulfilled &&
                            orderActions.updateLine &&
                            item.transaction_line_id ? (
                              <button
                                type="button"
                                onClick={() => beginLineEdit(item)}
                                className="rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent transition-colors hover:bg-app-accent/10"
                              >
                                Edit
                              </button>
                            ) : null}
                            {orderActions?.canModify &&
                            detail.status !== "cancelled" &&
                            orderActions.deleteLine &&
                            itemId ? (
                              <button
                                type="button"
                                onClick={() =>
                                  orderActions.deleteLine?.({
                                    order_item_id: itemId,
                                    sku: item.sku,
                                    product_name: item.product_name,
                                    quantity: item.quantity,
                                    fulfillment: item.fulfillment as FulfillmentKind,
                                  })
                                }
                                className="rounded-lg p-2 text-app-text-muted transition-colors hover:bg-rose-500/10 hover:text-rose-600"
                                aria-label={`Delete ${item.product_name}`}
                              >
                                <Trash2 size={16} />
                              </button>
                            ) : null}
                          </div>
                        </div>
                        {editingLineId === item.transaction_line_id ? (
                          <div className="mt-4 rounded-xl border border-app-accent/20 bg-app-accent/5 p-4">
                            <div className="grid gap-3 sm:grid-cols-3">
                              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Quantity
                                <input
                                  type="number"
                                  min="1"
                                  step="1"
                                  value={editQuantity}
                                  onChange={(event) => setEditQuantity(event.target.value)}
                                  disabled={editBusy}
                                  className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                                />
                              </label>
                              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Unit Price
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={editUnitPrice}
                                  onChange={(event) => setEditUnitPrice(event.target.value)}
                                  disabled={editBusy}
                                  className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                                />
                              </label>
                              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Pickup Type
                                <select
                                  value={editFulfillment}
                                  onChange={(event) =>
                                    setEditFulfillment(
                                      event.target.value as EditableFulfillmentKind,
                                    )
                                  }
                                  disabled={editBusy}
                                  className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                                >
                                  {EDITABLE_FULFILLMENT_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            {editError ? (
                              <p className="mt-3 text-[11px] font-semibold text-rose-700">
                                {editError}
                              </p>
                            ) : (
                              <p className="mt-3 text-[11px] font-semibold text-app-text-muted">
                                Save updates before leaving the drawer to keep transaction totals and item status in sync.
                              </p>
                            )}
                            <div className="mt-4 flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={cancelLineEdit}
                                disabled={editBusy}
                                className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void submitLineEdit(item)}
                                disabled={editBusy}
                                className="rounded-lg border border-emerald-500/20 bg-emerald-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-60"
                              >
                                {editBusy ? "Saving…" : "Save Line"}
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {item.custom_item_type ? (
                          <div className="mt-3 rounded-xl border border-app-border/70 bg-app-surface-2/70 p-3">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Custom Details
                            </p>
                            <p className="mt-1 text-[11px] font-black text-app-text">
                              {item.custom_item_type}
                            </p>
                            {item.custom_order_details?.vendor_form_family ? (
                              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                                {customVendorLabel(item.custom_order_details.vendor_form_family)}
                              </p>
                            ) : null}
                            <div className="mt-2 grid gap-1 text-[11px] font-semibold text-app-text-muted sm:grid-cols-2">
                              {customOrderDetailEntries(item.custom_order_details).map((entry) => (
                                <p key={entry.label}>
                                  {entry.label}: {entry.value}
                                </p>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                      })}
                    </div>
                  ))}
              </div>
            </section>

            <section className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-app-text-muted" />
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                  Transaction and Pickup Notes
                </h3>
              </div>
              <div className="mt-4 space-y-2 text-[12px] font-semibold text-app-text-muted">
                {describeOrderRules(detail).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
              <div className="mt-4 grid gap-3 border-t border-app-border/50 pt-4 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Operator
                  </p>
                  <p className="mt-1 text-[12px] font-semibold text-app-text">
                    {detail.operator_name ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Primary Salesperson
                  </p>
                  <p className="mt-1 text-[12px] font-semibold text-app-text">
                    {detail.primary_salesperson_name ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Register Session
                  </p>
                  <p className="mt-1 text-[12px] font-semibold text-app-text">
                    {detail.register_session_id ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Tender Summary
                  </p>
                  <p className="mt-1 text-[12px] font-semibold text-app-text">
                    {detail.payment_methods_summary || "—"}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    Timeline
                  </h3>
                </div>
                {audit.length > 0 ? (
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Newest first
                  </p>
                ) : null}
              </div>
              <div className="mt-4 relative space-y-4 border-l-2 border-app-border/60 pl-4 py-1">
                {audit.length === 0 ? (
                  <p className="text-sm text-app-text-muted">No recorded activity yet.</p>
                ) : (
                  audit.map((event) => (
                    <div key={event.id} className="relative">
                      <div className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-app-surface bg-app-border" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {new Date(event.created_at).toLocaleString()} · {formatAuditKind(event.event_kind)}
                      </p>
                      <p className="mt-1 text-[12px] font-bold leading-tight text-app-text">
                        {event.summary}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </DetailDrawer>

      {showReceiptModal && orderId ? (
        <ReceiptSummaryModal
          transactionId={orderId}
          onClose={() => setShowReceiptModal(false)}
          baseUrl={baseUrl}
          getAuthHeaders={auth}
        />
      ) : null}
    </>
  );
}
