import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Clock,
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  Printer,
  ShieldCheck,
  ArrowLeftRight,
  Trash2,
  X,
  Shirt,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import {
  customOrderDetailEntries,
  customOrderSubtypeForSku,
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
import CustomItemPromptModal from "../pos/CustomItemPromptModal";
import type { FulfillmentKind } from "../pos/types";
import VariantSearchInput from "../ui/VariantSearchInput";
import RosieInsightSummary from "../help/RosieInsightSummary";
import TransactionAttributionModal from "../pos/TransactionAttributionModal";

function fmtMoney(v: string | number): string {
  return formatUsdFromCents(parseMoneyToCents(v));
}

const baseUrl = getBaseUrl();

interface StaffApproverRow {
  id: string;
  full_name: string;
}

export interface TransactionDrawerItem {
  transaction_line_id?: string;
  order_item_id?: string;
  product_id: string;
  variant_id: string;
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
  order_lifecycle_status?: string;
  alteration_status?: string | null;
  is_fulfilled: boolean;
  is_internal?: boolean;
  custom_item_type?: string | null;
  custom_order_details?: CustomOrderDetails | null;
  salesperson_name?: string | null;
  vendor_name?: string | null;
  po_number?: string | null;
  vendor_eta?: string | null;
  vendor_reference?: string | null;
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
  linked_alteration_summary?: {
    open_count: number;
    overdue_count: number;
    ready_count: number;
    picked_up_count: number;
  };
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
  void_record?: {
    id: string;
    original_status: string;
    original_total_price: string;
    original_amount_paid: string;
    original_balance_due: string;
    voided_by_staff_name?: string | null;
    manager_staff_name?: string | null;
    reason: string;
    reversal_status: string;
    refundable_amount: string;
    refund_queue_id?: string | null;
    tender_summary?: Array<{ payment_method?: string; amount?: string }> | null;
    inventory_summary?: {
      returned_line_count?: number;
      restocked_units?: number;
    } | null;
    created_at: string;
  } | null;
}

export interface TransactionDrawerAudit {
  id: string;
  event_kind: string;
  summary: string;
  created_at: string;
}

export interface TransactionDrawerOrderActions {
  onOpenInRegister?: (orderId: string, forPickup?: boolean, returnLineId?: string) => void;
  onAttachToWedding?: () => void;
  onCancel?: () => void;
  onReturnAll?: () => void;
  onReturnLine?: (transactionId: string, transactionLineId: string) => void;
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
      variant_id?: string;
      order_lifecycle_status?: string;
      custom_order_details?: CustomOrderDetails;
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
  recordContext?: "transaction" | "order";
  onOpenCustomerHub?: (customerId: string) => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
  detail?: TransactionDrawerDetail | null;
  audit?: TransactionDrawerAudit[];
  loading?: boolean;
  errorMessage?: string | null;
  orderActions?: TransactionDrawerOrderActions;
  onLifecycleChanged?: () => Promise<void> | void;
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
    case "transaction_voided":
      return "Transaction voided";
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

type BadgeTone = "success" | "info" | "warning" | "neutral" | "rose";

function orderKindLabel(detail: TransactionDrawerDetail): string {
  if (detail.wedding_summary || detail.wedding_member_id) return "Wedding";
  if (detail.items.some((item) => item.fulfillment === "layaway"))
    return "Layaway";
  if (detail.items.some((item) => item.fulfillment === "custom"))
    return "Custom";
  if (detail.items.some((item) => item.fulfillment === "special_order"))
    return "Special";
  return "Transaction";
}

function lifecycleStatusLabel(
  value?: string | null,
  alterationStatus?: string | null,
) {
  if (value === "received" && alterationStatus) {
    if (alterationStatus === "intake") {
      return "Scheduled for Alterations";
    }
    if (
      alterationStatus === "in_work" ||
      alterationStatus === "verify_completed"
    ) {
      return "In Alterations";
    }
  }
  switch (value) {
    case "needs_measurements":
      return "Needs measurements";
    case "ntbo":
      return "Ready to order";
    case "ordered":
      return "Ordered";
    case "received":
      return "Received";
    case "ready_for_pickup":
      return "Ready for pickup";
    case "picked_up":
      return "Picked up";
    default:
      return null;
  }
}

const ORDER_LIFECYCLE_STEPS = [
  { key: "needs_measurements", label: "Needs Details" },
  { key: "ntbo", label: "Ready to Order" },
  { key: "ordered", label: "Ordered" },
  { key: "received", label: "Received" },
  { key: "ready_for_pickup", label: "Ready for Pickup" },
  { key: "picked_up", label: "Picked Up" },
] as const;

type LifecycleStepKey = (typeof ORDER_LIFECYCLE_STEPS)[number]["key"];

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function fulfillmentLabel(value: string): string {
  switch (value) {
    case "special_order":
      return "Special order";
    case "custom":
      return "Custom order";
    case "wedding_order":
      return "Wedding order";
    case "layaway":
      return "Layaway";
    case "takeaway":
      return "Takeaway";
    default:
      return value.replace(/_/g, " ");
  }
}

function isLifecycleStepKey(
  value: string | null | undefined,
): value is LifecycleStepKey {
  return ORDER_LIFECYCLE_STEPS.some((step) => step.key === value);
}

function lifecycleStatusTone(
  value?: string | null,
  alterationStatus?: string | null,
  isFulfilled = false,
): BadgeTone {
  if (isFulfilled || value === "picked_up" || value === "ready_for_pickup") {
    return "success";
  }
  if (
    value === "received" &&
    (alterationStatus === "intake" ||
      alterationStatus === "in_work" ||
      alterationStatus === "verify_completed")
  ) {
    return "warning";
  }
  if (value === "received" || value === "ordered") {
    return "info";
  }
  return "warning";
}

function orderLifecycleCounts(detail: TransactionDrawerDetail) {
  const counts = ORDER_LIFECYCLE_STEPS.reduce(
    (acc, step) => ({ ...acc, [step.key]: 0 }),
    {} as Record<LifecycleStepKey, number>,
  );

  detail.items
    .filter((item) => !item.is_internal && item.fulfillment !== "takeaway")
    .forEach((item) => {
      const stepKey = item.is_fulfilled
        ? "picked_up"
        : isLifecycleStepKey(item.order_lifecycle_status)
          ? item.order_lifecycle_status
          : "needs_measurements";
      if (isLifecycleStepKey(stepKey)) {
        counts[stepKey] += 1;
      }
    });

  return {
    ...counts,
    needsReadyCheck: detail.items.filter(
      (item) =>
        !item.is_internal &&
        !item.is_fulfilled &&
        item.order_lifecycle_status === "received",
    ).length,
    readyNow: detail.items.filter(
      (item) =>
        !item.is_internal &&
        !item.is_fulfilled &&
        item.order_lifecycle_status === "ready_for_pickup",
    ).length,
  };
}

function lineNextAction(
  item: TransactionDrawerItem,
  detail: TransactionDrawerDetail,
): string {
  if (item.is_fulfilled || item.order_lifecycle_status === "picked_up") {
    return detail.fulfillment_method === "ship"
      ? "Completed for shipping."
      : "Pickup is complete.";
  }
  if (item.fulfillment === "takeaway") {
    return "Takeaway item; no order tracking needed.";
  }
  if (item.order_lifecycle_status === "needs_measurements") {
    return "Collect measurements/details before ordering.";
  }
  if (item.order_lifecycle_status === "ntbo") {
    return "Create or attach the vendor order.";
  }
  if (item.order_lifecycle_status === "ordered") {
    return "Waiting for receiving before customer-ready work.";
  }
  if (item.order_lifecycle_status === "received") {
    if (
      item.alteration_status === "intake" ||
      item.alteration_status === "in_work" ||
      item.alteration_status === "verify_completed"
    ) {
      return "Complete alteration work, then run Mark Ready + Notify.";
    }
    return "Run Mark Ready + Notify to queue pickup SMS/email.";
  }
  if (item.order_lifecycle_status === "ready_for_pickup") {
    return parseMoneyToCents(detail.balance_due) > 0
      ? "Ready, but balance must clear before release."
      : "Ready for customer pickup.";
  }
  return "Choose Details Needed or Ready to Order before release.";
}

function lineNotificationState(item: TransactionDrawerItem): string {
  if (item.is_fulfilled || item.order_lifecycle_status === "picked_up") {
    return "Completed.";
  }
  if (item.order_lifecycle_status === "ready_for_pickup") {
    return "Customer notice sent or queued.";
  }
  if (item.order_lifecycle_status === "received") {
    return "Not sent until staff runs Mark Ready + Notify.";
  }
  return "No customer notice yet.";
}

function deriveLifecycleOverview(
  detail: TransactionDrawerDetail,
  summary: ReturnType<typeof fulfillmentSummary>,
  counts: ReturnType<typeof orderLifecycleCounts>,
): {
  label: string;
  tone: BadgeTone;
  activeStep: LifecycleStepKey;
  nextAction: string;
} {
  if (detail.status === "cancelled") {
    return {
      label: "Cancelled",
      tone: "rose",
      activeStep: "needs_measurements",
      nextAction: "No pickup work should continue on a cancelled transaction.",
    };
  }
  if (summary.pending === 0 || detail.status === "fulfilled") {
    return {
      label: "Closed / Picked Up",
      tone: "success",
      activeStep: "picked_up",
      nextAction: "No open order work remains.",
    };
  }
  if (counts.readyNow > 0) {
    return {
      label: "Ready for Pickup",
      tone: "success",
      activeStep: "ready_for_pickup",
      nextAction: "Review balance and release ready items.",
    };
  }
  if (counts.needsReadyCheck > 0) {
    return {
      label: "Needs Staff Check",
      tone: "warning",
      activeStep: "received",
      nextAction: "Staff must run Mark Ready + Notify for received items.",
    };
  }
  if (counts.ordered > 0) {
    return {
      label: "Ordered",
      tone: "info",
      activeStep: "ordered",
      nextAction: "Receive vendor goods before pickup work starts.",
    };
  }
  if (counts.ntbo > 0) {
    return {
      label: "Ready to Order",
      tone: "warning",
      activeStep: "ntbo",
      nextAction: "Create or attach the vendor order before receiving.",
    };
  }
  return {
    label: "Needs Details",
    tone: "warning",
    activeStep: "needs_measurements",
    nextAction: "Finish details before ordering or promising pickup.",
  };
}

function fulfillmentSummary(detail: TransactionDrawerDetail) {
  const customerVisibleItems = detail.items.filter((item) => !item.is_internal);
  const fulfilledItems = customerVisibleItems.filter(
    (item) => item.is_fulfilled,
  );
  const pendingItems = customerVisibleItems.filter(
    (item) => !item.is_fulfilled,
  );
  const readyPendingItems = pendingItems.filter(
    (item) => item.order_lifecycle_status === "ready_for_pickup",
  );
  const blockedPendingItems = pendingItems.filter(
    (item) => item.order_lifecycle_status !== "ready_for_pickup",
  );
  const fulfilled = fulfilledItems.length;
  const pending = pendingItems.length;
  return {
    total: customerVisibleItems.length,
    fulfilled,
    pending,
    readyPending: readyPendingItems.length,
    blockedPending: blockedPendingItems.length,
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
      ? "No shipping work is still open."
      : "No pickup work is still open.";
  } else if (summary.pending === 1) {
    remainingWorkLabel = isShip
      ? "1 item still needs shipping work."
      : "1 item still needs pickup work.";
  } else {
    remainingWorkLabel = isShip
      ? `${summary.pending} items still need shipping work.`
      : `${summary.pending} items still need pickup work.`;
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

  if (summary.blockedPending > 0) {
    return {
      readinessLabel,
      readinessTone,
      remainingWorkLabel,
      releaseLabel: isShip
        ? "Balance Clear, Work Still Open"
        : "Balance Clear, Pickup Still Blocked",
      releaseTone: "info",
    };
  }

  if (summary.readyPending > 0) {
    return {
      readinessLabel: "Ready Items Available",
      readinessTone: "success",
      remainingWorkLabel,
      releaseLabel: isShip
        ? "Ready for Shipping Release"
        : "Ready for Pickup Release",
      releaseTone: "success",
    };
  }

  return {
    readinessLabel,
    readinessTone,
    remainingWorkLabel,
    releaseLabel: isShip
      ? "Ready for Shipping Release"
      : "Ready for Pickup Release",
    releaseTone: "success",
  };
}

function daysFromToday(value: string): number | null {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function daysSince(value: string): number | null {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - target.getTime()) / 86_400_000);
}

function formatWeddingProximity(days: number): string {
  if (days === 0) return "Wedding is today.";
  if (days === 1) return "Wedding is tomorrow.";
  return `Wedding is in ${days} days.`;
}

function linkedAlterationBullet(
  count: number,
  singular: string,
  plural: string,
): string {
  return count === 1 ? singular : plural.replace("{count}", String(count));
}

function buildReadinessCheck(
  detail: TransactionDrawerDetail,
  summary: ReturnType<typeof fulfillmentSummary>,
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const dueCents = parseMoneyToCents(detail.balance_due);
  const isShip = detail.fulfillment_method === "ship";
  const hasLayawayLine = detail.items.some(
    (item) => !item.is_internal && item.fulfillment === "layaway",
  );

  if (dueCents > 0) {
    blockers.push(
      hasLayawayLine
        ? `Layaway balance due before release: ${fmtMoney(detail.balance_due)}.`
        : `Balance due before release: ${fmtMoney(detail.balance_due)}.`,
    );
  }

  if (detail.status === "pending_measurement") {
    blockers.push("Measurements/details still need follow-up.");
  }

  if (summary.blockedPending > 0) {
    const workType = isShip ? "shipping" : "pickup";
    blockers.push(
      summary.blockedPending === 1
        ? `1 ${workType} item is not ready.`
        : `${summary.blockedPending} ${workType} items are not ready.`,
    );
  }

  const linkedAlterations = detail.linked_alteration_summary;
  const overdueAlterations = linkedAlterations?.overdue_count ?? 0;
  const openAlterations = Math.max(
    0,
    (linkedAlterations?.open_count ?? 0) - overdueAlterations,
  );
  const readyAlterations = linkedAlterations?.ready_count ?? 0;

  if (overdueAlterations > 0) {
    blockers.push(
      linkedAlterationBullet(
        overdueAlterations,
        "1 linked alteration is overdue.",
        "{count} linked alterations are overdue.",
      ),
    );
  }

  if (openAlterations > 0) {
    blockers.push(
      linkedAlterationBullet(
        openAlterations,
        "1 linked alteration is still open.",
        "{count} linked alterations are still open.",
      ),
    );
  }

  const weddingDays = detail.wedding_summary?.event_date
    ? daysFromToday(detail.wedding_summary.event_date)
    : null;
  if (weddingDays !== null && weddingDays >= 0 && weddingDays <= 30) {
    warnings.push(formatWeddingProximity(weddingDays));
  }

  const openAgeDays = daysSince(detail.booked_at);
  if (
    openAgeDays !== null &&
    openAgeDays > 30 &&
    !["fulfilled", "cancelled"].includes(detail.status)
  ) {
    warnings.push(`Open more than 30 days; booked ${openAgeDays} days ago.`);
  }

  if (readyAlterations > 0) {
    warnings.push(
      linkedAlterationBullet(
        readyAlterations,
        "1 linked alteration is ready.",
        "{count} linked alterations are ready.",
      ),
    );
  }

  return {
    blockers: blockers.slice(0, 6),
    warnings: warnings.slice(0, Math.max(0, 6 - blockers.length)),
  };
}

function badgeClassName(kind: BadgeTone) {
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

function addressLines(
  shipTo: Record<string, unknown> | null | undefined,
): string[] {
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
  recordContext = "transaction",
  onOpenCustomerHub,
  onOpenTransactionInBackoffice,
  detail: controlledDetail,
  audit: controlledAudit,
  loading: controlledLoading,
  errorMessage: controlledErrorMessage,
  orderActions,
  onLifecycleChanged,
}: TransactionDetailDrawerProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [internalDetail, setInternalDetail] =
    useState<TransactionDrawerDetail | null>(null);
  const [internalAudit, setInternalAudit] = useState<TransactionDrawerAudit[]>(
    [],
  );
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalErrorMessage, setInternalErrorMessage] = useState<
    string | null
  >(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [suitSwapTarget, setSuitSwapTarget] =
    useState<TransactionDrawerItem | null>(null);
  const [suitSwapSku, setSuitSwapSku] = useState("");
  const [suitSwapNote, setSuitSwapNote] = useState("");
  const [suitSwapBusy, setSuitSwapBusy] = useState(false);
  const [suitSwapError, setSuitSwapError] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("1");
  const [editUnitPrice, setEditUnitPrice] = useState("");
  const [editFulfillment, setEditFulfillment] =
    useState<EditableFulfillmentKind>("special_order");
  const [editVariantId, setEditVariantId] = useState("");
  const [editVariantSku, setEditVariantSku] = useState("");
  const [editVariantLabel, setEditVariantLabel] = useState<string | null>(null);
  const [editLifecycleStatus, setEditLifecycleStatus] = useState("ntbo");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [readyTarget, setReadyTarget] = useState<TransactionDrawerItem | null>(
    null,
  );
  const [readyChecklist, setReadyChecklist] = useState({
    received: false,
    prep: false,
    customer: false,
  });
  const [managerStaffId, setManagerStaffId] = useState(
    () => localStorage.getItem("ros_last_staff_id") || "",
  );
  const [managerPin, setManagerPin] = useState("");
  const [staffApprovers, setStaffApprovers] = useState<StaffApproverRow[]>([]);
  const [readyBusy, setReadyBusy] = useState(false);
  const [readyError, setReadyError] = useState<string | null>(null);
  const [showPickupReleaseModal, setShowPickupReleaseModal] = useState(false);
  const [pickupOverride, setPickupOverride] = useState(false);
  const [pickupOverrideReason, setPickupOverrideReason] = useState("");
  const [pickupTargetLineIds, setPickupTargetLineIds] = useState<
    string[] | null
  >(null);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [pickupError, setPickupError] = useState<string | null>(null);
  const [customEditItem, setCustomEditItem] =
    useState<TransactionDrawerItem | null>(null);
  const [attributionOpen, setAttributionOpen] = useState(false);
  useShellBackdropLayer(
    Boolean(readyTarget) || showPickupReleaseModal || Boolean(customEditItem),
  );

  const usesControlledData =
    controlledDetail !== undefined ||
    controlledAudit !== undefined ||
    controlledLoading !== undefined ||
    controlledErrorMessage !== undefined;

  const detail = usesControlledData
    ? (controlledDetail ?? null)
    : internalDetail;
  const audit = usesControlledData ? (controlledAudit ?? []) : internalAudit;
  const loading = usesControlledData
    ? (controlledLoading ?? false)
    : internalLoading;
  const errorMessage = usesControlledData
    ? (controlledErrorMessage ?? null)
    : internalErrorMessage;
  const recordTitle =
    recordContext === "order" ? "Order Detail" : "Transaction Record";
  const recordLoadLabel =
    recordContext === "order" ? "order detail" : "transaction record";
  const drawerRoot =
    typeof document !== "undefined"
      ? document.getElementById("drawer-root")
      : null;

  const load = useCallback(async () => {
    if (!orderId || usesControlledData) return;
    setInternalLoading(true);
    setInternalErrorMessage(null);
    try {
      const [detailRes, auditRes] = await Promise.all([
        fetch(`${baseUrl}/api/transactions/${orderId}`, { headers: auth() }),
        fetch(`${baseUrl}/api/transactions/${orderId}/audit`, {
          headers: auth(),
        }),
      ]);

      if (!detailRes.ok) {
        setInternalDetail(null);
        setInternalAudit([]);
        setInternalErrorMessage(
          `We couldn't load this ${recordLoadLabel} right now.`,
        );
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
      setInternalErrorMessage(
        `We couldn't load this ${recordLoadLabel} right now.`,
      );
    } finally {
      setInternalLoading(false);
    }
  }, [orderId, auth, recordLoadLabel, usesControlledData]);

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

  const summary = useMemo(
    () => (detail ? fulfillmentSummary(detail) : null),
    [detail],
  );
  const lifecycleCounts = useMemo(
    () => (detail ? orderLifecycleCounts(detail) : null),
    [detail],
  );
  const lifecycleOverview = useMemo(
    () =>
      detail && summary && lifecycleCounts
        ? deriveLifecycleOverview(detail, summary, lifecycleCounts)
        : null,
    [detail, lifecycleCounts, summary],
  );
  const shippingLines = useMemo(
    () => addressLines(detail?.ship_to),
    [detail?.ship_to],
  );
  const readiness = useMemo(
    () => (detail && summary ? readinessSummary(detail, summary) : null),
    [detail, summary],
  );
  const readinessCheck = useMemo(
    () => (detail && summary ? buildReadinessCheck(detail, summary) : null),
    [detail, summary],
  );
  const pickupReleaseLines = useMemo(() => {
    const openLines =
      detail?.items.filter(
        (item) =>
          !item.is_internal && !item.is_fulfilled && item.transaction_line_id,
      ) ?? [];
    return {
      open: openLines,
      ready: openLines.filter(
        (item) => item.order_lifecycle_status === "ready_for_pickup",
      ),
      blocked: openLines.filter(
        (item) => item.order_lifecycle_status !== "ready_for_pickup",
      ),
    };
  }, [detail?.items]);
  const beginLineEdit = useCallback((item: TransactionDrawerItem) => {
    if (!item.transaction_line_id) return;
    setEditingLineId(item.transaction_line_id);
    setEditQuantity(String(item.quantity));
    setEditUnitPrice(String(item.unit_price));
    setEditFulfillment(
      (item.fulfillment as EditableFulfillmentKind) ?? "special_order",
    );
    setEditVariantId(item.variant_id);
    setEditVariantSku(item.sku);
    setEditVariantLabel(item.variation_label ?? null);
    setEditLifecycleStatus(item.order_lifecycle_status ?? "ntbo");
    setEditError(null);
  }, []);
  const cancelLineEdit = useCallback(() => {
    if (editBusy) return;
    setEditingLineId(null);
    setEditError(null);
  }, [editBusy]);

  const beginSuitSwap = useCallback((item: TransactionDrawerItem) => {
    setSuitSwapTarget(item);
    setSuitSwapSku("");
    setSuitSwapNote("");
    setSuitSwapError(null);
  }, []);

  const closeSuitSwap = useCallback(() => {
    if (suitSwapBusy) return;
    setSuitSwapTarget(null);
    setSuitSwapError(null);
  }, [suitSwapBusy]);

  const openReadyModal = useCallback((item: TransactionDrawerItem) => {
    setReadyTarget(item);
    setReadyChecklist({ received: false, prep: false, customer: false });
    setManagerPin("");
    setReadyError(null);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
        headers: auth(),
      });
      if (res.ok) {
        setStaffApprovers((await res.json()) as StaffApproverRow[]);
      }
    })();
  }, [auth, isOpen]);

  const closeReadyModal = useCallback(() => {
    if (readyBusy) return;
    setReadyTarget(null);
    setReadyError(null);
  }, [readyBusy]);

  const closePickupReleaseModal = useCallback(() => {
    if (pickupBusy) return;
    setShowPickupReleaseModal(false);
    setPickupTargetLineIds(null);
    setPickupError(null);
  }, [pickupBusy]);

  const submitReadyTransition = useCallback(async () => {
    if (!readyTarget?.transaction_line_id) return;
    if (
      !readyChecklist.received ||
      !readyChecklist.prep ||
      !readyChecklist.customer
    ) {
      setReadyError(
        "Confirm the received, prep, and customer-notification checks before marking ready.",
      );
      return;
    }
    setReadyBusy(true);
    setReadyError(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/order-lifecycle/items/${readyTarget.transaction_line_id}/transition`,
        {
          method: "POST",
          headers: {
            ...auth(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            next_status: "ready_for_pickup",
            reason: "Ready-for-pickup checklist confirmed",
            manager_staff_id: managerStaffId || undefined,
            manager_pin: managerPin.trim() || undefined,
            metadata: {
              checklist: {
                received: readyChecklist.received,
                prep: readyChecklist.prep,
                customer: readyChecklist.customer,
              },
              product_name: readyTarget.product_name,
              sku: readyTarget.sku,
            },
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReadyError(
          body.error ?? "Could not mark this item ready for pickup.",
        );
        return;
      }
      toast("Item marked ready for pickup.", "success");
      setReadyTarget(null);
      await onLifecycleChanged?.();
      if (!usesControlledData) {
        await load();
      }
    } finally {
      setReadyBusy(false);
    }
  }, [
    auth,
    load,
    managerStaffId,
    managerPin,
    onLifecycleChanged,
    readyChecklist,
    readyTarget,
    toast,
    usesControlledData,
  ]);

  const submitPickupRelease = useCallback(async () => {
    if (!detail || !summary) return;
    const dueCents = parseMoneyToCents(detail.balance_due);
    if (dueCents > 0) {
      setPickupError("Collect the Balance Due before pickup release.");
      return;
    }
    const candidateLines = pickupTargetLineIds
      ? pickupReleaseLines.open.filter((item) =>
          item.transaction_line_id
            ? pickupTargetLineIds.includes(item.transaction_line_id)
            : false,
        )
      : pickupReleaseLines.open;
    const targetLines = pickupOverride
      ? candidateLines
      : candidateLines.filter(
          (item) => item.order_lifecycle_status === "ready_for_pickup",
        );
    const deliveredItemIds = targetLines
      .map((item) => item.transaction_line_id)
      .filter((id): id is string => Boolean(id));
    if (deliveredItemIds.length === 0) {
      setPickupError("No ready pickup items are selected for release.");
      return;
    }
    const reason = pickupOverrideReason.trim();
    if (pickupOverride && reason.length < 12) {
      setPickupError(
        "Enter a clear readiness override reason before releasing blocked items.",
      );
      return;
    }
    setPickupBusy(true);
    setPickupError(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/transactions/${detail.transaction_id}/pickup`,
        {
          method: "POST",
          headers: {
            ...auth(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            delivered_item_ids: deliveredItemIds,
            actor: recordTitle,
            override_readiness: pickupOverride,
            override_reason: pickupOverride ? reason : undefined,
            register_session_id: detail.register_session_id ?? undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPickupError(body.error ?? "Pickup release could not be completed.");
        return;
      }
      toast(
        pickupOverride
          ? "Pickup released with readiness override recorded."
          : "Ready pickup items released.",
        "success",
      );
      setShowPickupReleaseModal(false);
      setPickupTargetLineIds(null);
      setPickupOverride(false);
      setPickupOverrideReason("");
      await onLifecycleChanged?.();
      if (!usesControlledData) {
        await load();
      }
    } finally {
      setPickupBusy(false);
    }
  }, [
    auth,
    detail,
    load,
    onLifecycleChanged,
    pickupOverride,
    pickupOverrideReason,
    pickupReleaseLines.open,
    pickupTargetLineIds,
    recordTitle,
    summary,
    toast,
    usesControlledData,
  ]);

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

  const submitSuitSwap = async () => {
    if (!suitSwapTarget || !suitSwapSku.trim() || !detail) return;
    setSuitSwapBusy(true);
    setSuitSwapError(null);
    try {
      const scanRes = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(suitSwapSku.trim())}`,
        { headers: auth() },
      );
      if (!scanRes.ok) {
        throw new Error("Could not resolve replacement SKU.");
      }
      const scanned = await scanRes.json();
      const res = await fetch(
        `${baseUrl}/api/transactions/${detail.transaction_id}/items/${suitSwapTarget.transaction_line_id}/suit-swap`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...auth(),
          },
          body: JSON.stringify({
            in_variant_id: scanned.variant_id,
            note: suitSwapNote.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Suit Swap failed");
      }
      const out = await res.json();
      toast(`Suit Swap complete: ${out.old_sku} → ${out.new_sku}`, "success");
      setSuitSwapTarget(null);
      if (onLifecycleChanged) {
        await onLifecycleChanged();
      }
      void load();
    } catch (error) {
      setSuitSwapError(
        error instanceof Error ? error.message : "Suit Swap failed",
      );
    } finally {
      setSuitSwapBusy(false);
    }
  };

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
        setEditError("Price is required.");
        return;
      }

      const patch: {
        quantity?: number;
        unit_price?: string;
        fulfillment?: FulfillmentKind;
        variant_id?: string;
        order_lifecycle_status?: string;
        custom_order_details?: CustomOrderDetails;
      } = {};
      if (quantity !== item.quantity) patch.quantity = quantity;
      if (nextPrice !== String(item.unit_price)) patch.unit_price = nextPrice;
      if (editFulfillment !== item.fulfillment)
        patch.fulfillment = editFulfillment;
      if (editVariantId && editVariantId !== item.variant_id)
        patch.variant_id = editVariantId;
      if (editLifecycleStatus !== (item.order_lifecycle_status ?? "ntbo")) {
        patch.order_lifecycle_status = editLifecycleStatus;
      }
      if (
        patch.quantity === undefined &&
        patch.unit_price === undefined &&
        patch.fulfillment === undefined &&
        patch.variant_id === undefined &&
        patch.order_lifecycle_status === undefined
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
            : "We couldn't save that item right now.",
        );
      } finally {
        setEditBusy(false);
      }
    },
    [
      editFulfillment,
      editLifecycleStatus,
      editQuantity,
      editUnitPrice,
      editVariantId,
      orderActions,
    ],
  );

  const submitCustomOrderDetails = useCallback(
    async (data: { customOrderDetails?: CustomOrderDetails | null }) => {
      if (!customEditItem?.transaction_line_id || !orderActions?.updateLine)
        return false;
      if (!data.customOrderDetails) {
        return false;
      }
      setEditBusy(true);
      try {
        await orderActions.updateLine(
          {
            transaction_line_id: customEditItem.transaction_line_id,
            sku: customEditItem.sku,
            product_name: customEditItem.product_name,
            quantity: customEditItem.quantity,
            unit_price: String(customEditItem.unit_price),
            fulfillment: customEditItem.fulfillment as FulfillmentKind,
          },
          {
            custom_order_details: data.customOrderDetails,
          },
        );
        setCustomEditItem(null);
        return true;
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : "Custom order details could not be saved.",
          "error",
        );
        return false;
      } finally {
        setEditBusy(false);
      }
    },
    [customEditItem, orderActions, toast],
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
              : detail.status === "cancelled"
                ? "rose"
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

  const pickupBalanceDueCents = detail
    ? parseMoneyToCents(detail.balance_due)
    : 0;
  const pickupModalOpenLines = pickupTargetLineIds
    ? pickupReleaseLines.open.filter((item) =>
        item.transaction_line_id
          ? pickupTargetLineIds.includes(item.transaction_line_id)
          : false,
      )
    : pickupReleaseLines.open;
  const pickupModalReadyLines = pickupModalOpenLines.filter(
    (item) => item.order_lifecycle_status === "ready_for_pickup",
  );
  const pickupModalBlockedLines = pickupModalOpenLines.filter(
    (item) => item.order_lifecycle_status !== "ready_for_pickup",
  );
  const pickupCanSubmit =
    Boolean(detail) &&
    pickupBalanceDueCents <= 0 &&
    (pickupOverride
      ? pickupModalOpenLines.length > 0
      : pickupModalReadyLines.length > 0);

  return (
    <>
      <DetailDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={recordTitle}
        subtitle={subtitle}
        panelMaxClassName="max-w-3xl"
        actions={mapOrderActionButtons(detail, orderActions)}
        footer={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <button
              type="button"
              onClick={() => setShowReceiptModal(true)}
              disabled={!detail}
              className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg transition-all duration-150 hover:bg-emerald-500 active:translate-y-0.5 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer size={16} />
              Reprint Receipt
            </button>
            <div className="hidden lg:block" aria-hidden />
            {detail && orderActions?.onOpenInRegister ? (
              <button
                type="button"
                onClick={() =>
                  orderActions.onOpenInRegister?.(detail.transaction_id)
                }
                className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg transition-all duration-150 hover:bg-emerald-500 active:translate-y-0.5 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/25"
              >
                <REGISTER_ICON size={16} />
                Open in Register
              </button>
            ) : null}
            {onOpenTransactionInBackoffice && detail ? (
              <button
                type="button"
                onClick={() =>
                  onOpenTransactionInBackoffice(detail.transaction_id)
                }
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
            {lifecycleOverview && lifecycleCounts ? (
              <section className="ui-panel ui-tint-info p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <ORDERS_ICON size={16} className="text-app-text-muted" />
                      <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                        Order Progress
                      </h3>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-app-text">
                      {lifecycleOverview.nextAction}
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${badgeClassName(
                      lifecycleOverview.tone,
                    )}`}
                  >
                    {lifecycleOverview.label}
                  </span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {ORDER_LIFECYCLE_STEPS.map((step) => {
                    const isActive = step.key === lifecycleOverview.activeStep;
                    const count = lifecycleCounts[step.key];
                    return (
                      <div
                        key={step.key}
                        className={`rounded-xl border p-3 ${
                          isActive
                            ? "border-app-accent/30 bg-app-accent/10"
                            : count > 0
                              ? "border-app-info/20 bg-app-info/5"
                              : "border-app-border/60 bg-app-surface/70"
                        }`}
                      >
                        <p
                          className={`text-[10px] font-black uppercase tracking-widest ${
                            isActive ? "text-app-accent" : "text-app-text-muted"
                          }`}
                        >
                          {step.label}
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text">
                          {count}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

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
                      {fmtMoney(
                        detail.financial_summary
                          ?.total_applied_deposit_amount ?? "0",
                      )}
                    </p>
                  </div>
                </div>
                <div className="mt-3 space-y-2 border-t border-app-border/50 pt-3">
                  <div className="flex items-start justify-between gap-3 text-[11px]">
                    <span className="font-black uppercase tracking-widest text-app-text-muted">
                      Transaction Payments
                    </span>
                    <span className="text-right font-semibold text-app-text">
                      {fmtMoney(
                        detail.financial_summary?.total_allocated_payments ??
                          "0",
                      )}
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
                      Tax exempt
                      {detail.tax_exempt_reason
                        ? `: ${detail.tax_exempt_reason}`
                        : ""}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="ui-panel ui-tint-neutral p-4">
                <div className="flex items-center gap-2">
                  <ORDERS_ICON size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    {detail.fulfillment_method === "ship"
                      ? "Shipping Check"
                      : "Pickup Check"}
                  </h3>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Open Items
                    </p>
                    <p className="mt-1 text-sm font-black text-app-warning">
                      {summary?.pending ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Ready
                    </p>
                    <p className="mt-1 text-sm font-black text-app-success">
                      {summary?.readyPending ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Not Ready
                    </p>
                    <p className="mt-1 text-sm font-black text-app-warning">
                      {summary?.blockedPending ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Completed
                    </p>
                    <p className="mt-1 text-sm font-black text-app-success">
                      {summary?.fulfilled ?? 0}
                    </p>
                  </div>
                </div>
                <div className="ui-panel ui-tint-info mt-3 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Next Staff Action
                  </p>
                  <p className="mt-2 text-[12px] font-semibold text-app-text">
                    {lifecycleOverview?.nextAction}
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
              </div>
            </section>

            {detail.void_record ? (
              <section className="rounded-2xl border border-app-danger/25 bg-app-danger/8 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <ShieldCheck size={16} className="text-app-danger" />
                      <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                        Void Record
                      </h3>
                    </div>
                    <p className="mt-2 text-[12px] font-semibold text-app-text-muted">
                      This Transaction Record was voided, not deleted. Refund or
                      reversal evidence remains traceable through the refund
                      workflow and payment rows.
                    </p>
                  </div>
                  <span
                    className={`w-fit rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${badgeClassName(
                      detail.void_record.reversal_status === "completed" ||
                        detail.void_record.reversal_status === "no_refund_due"
                        ? "success"
                        : "warning",
                    )}`}
                  >
                    {detail.void_record.reversal_status.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-app-border/70 bg-app-surface px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Refundable
                    </p>
                    <p className="mt-1 font-mono text-sm font-black text-app-danger">
                      {fmtMoney(detail.void_record.refundable_amount)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-app-border/70 bg-app-surface px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Original Total
                    </p>
                    <p className="mt-1 font-mono text-sm font-black text-app-text">
                      {fmtMoney(detail.void_record.original_total_price)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-app-border/70 bg-app-surface px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Restocked Units
                    </p>
                    <p className="mt-1 font-mono text-sm font-black text-app-text">
                      {detail.void_record.inventory_summary?.restocked_units ??
                        0}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Approved By
                    </p>
                    <p className="mt-1 text-[12px] font-semibold text-app-text">
                      {detail.void_record.manager_staff_name ??
                        "Manager Access"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Voided At
                    </p>
                    <p className="mt-1 text-[12px] font-semibold text-app-text">
                      {new Date(detail.void_record.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-xl border border-app-border/70 bg-app-surface p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Reason
                  </p>
                  <p className="mt-2 text-[12px] font-semibold text-app-text">
                    {detail.void_record.reason}
                  </p>
                </div>
              </section>
            ) : null}

            {readinessCheck ? (
              <section className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    Readiness Check
                  </h3>
                </div>
                {readinessCheck.blockers.length > 0 ||
                readinessCheck.warnings.length > 0 ? (
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {readinessCheck.blockers.length > 0 ? (
                      <div className="rounded-xl border border-app-warning/20 bg-app-warning/8 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-warning">
                          Blocks Release
                        </p>
                        <ul className="mt-2 space-y-2 text-[12px] font-semibold text-app-text">
                          {readinessCheck.blockers.map((item) => (
                            <li key={item} className="flex gap-2">
                              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-app-warning" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {readinessCheck.warnings.length > 0 ? (
                      <div className="rounded-xl border border-app-info/20 bg-app-info/8 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-info">
                          Watch
                        </p>
                        <ul className="mt-2 space-y-2 text-[12px] font-semibold text-app-text">
                          {readinessCheck.warnings.map((item) => (
                            <li key={item} className="flex gap-2">
                              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-app-info" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-3 rounded-xl border border-app-border/70 bg-app-surface p-3 text-[12px] font-semibold text-app-text-muted">
                    No release blockers found from current order details.
                  </p>
                )}
                <RosieInsightSummary
                  surface="transaction_readiness"
                  title="Readiness Check"
                  getHeaders={auth}
                  facts={{
                    title: "Readiness Check",
                    bullets: [
                      ...readinessCheck.blockers.map((label, index) => ({
                        id: `blocker-${index}`,
                        label,
                        severity: "warning",
                      })),
                      ...readinessCheck.warnings.map((label, index) => ({
                        id: `warning-${index}`,
                        label,
                        severity: "info",
                      })),
                    ],
                  }}
                />
              </section>
            ) : null}

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
                      {detail.wedding_summary.party_name ??
                        "Linked wedding party"}
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
                        ? new Date(
                            detail.wedding_summary.event_date,
                          ).toLocaleDateString()
                        : "Not set"}
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            <section
              className={
                detail.fulfillment_method === "ship"
                  ? "grid gap-4 lg:grid-cols-2"
                  : "grid gap-4"
              }
            >
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
                  <p className="mt-3 text-sm text-app-text-muted">
                    No customer linked.
                  </p>
                )}
              </div>

              {detail.fulfillment_method === "ship" ? (
                <div className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
                  <div className="flex items-center gap-2">
                    <MapPin size={16} className="text-app-text-muted" />
                    <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                      Shipping
                    </h3>
                  </div>
                  <div className="mt-3 space-y-2 text-[12px] font-semibold text-app-text">
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
                      <p className="text-app-text-muted">
                        No shipping address snapshot stored.
                      </p>
                    )}
                    {detail.tracking_number ? (
                      <p>
                        Tracking:{" "}
                        <span className="font-black">
                          {detail.tracking_number}
                        </span>
                      </p>
                    ) : null}
                    {detail.tracking_url_provider ? (
                      <p className="text-app-text-muted">
                        Carrier link: {detail.tracking_url_provider}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ORDERS_ICON size={16} className="text-app-text-muted" />
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                    Items (
                    {detail.items.filter((item) => !item.is_internal).length})
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
                    title: "Open Order Items",
                    description:
                      detail.fulfillment_method === "ship"
                        ? "These items still need shipping work."
                        : "These items still need details, ordering, receiving, or pickup work.",
                    items: detail.items.filter(
                      (item) => !item.is_internal && !item.is_fulfilled,
                    ),
                  },
                  {
                    key: "fulfilled",
                    title: "Completed Items",
                    description:
                      detail.fulfillment_method === "ship"
                        ? "These items are already completed for shipping."
                        : "These items are already picked up.",
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
                          {countLabel(group.items.length, "item")}
                        </span>
                      </div>
                      {group.items.map((item) => {
                        const itemId =
                          item.order_item_id ?? item.transaction_line_id;
                        const returnedQty = item.quantity_returned ?? 0;
                        const lifecycleLabel =
                          lifecycleStatusLabel(
                            item.order_lifecycle_status,
                            item.alteration_status,
                          ) ??
                          (item.fulfillment !== "takeaway"
                            ? "Details needed"
                            : null);
                        const lifecycleTone = lifecycleStatusTone(
                          item.order_lifecycle_status,
                          item.alteration_status,
                          item.is_fulfilled,
                        );
                        const nextAction = lineNextAction(item, detail);
                        const notificationState = lineNotificationState(item);
                        const canEditCustomOrderDetails = Boolean(
                          item.custom_item_type &&
                            customOrderSubtypeForSku(item.sku),
                        );
                        const canMarkReady = Boolean(
                          item.order_lifecycle_status === "received" &&
                            item.transaction_line_id &&
                            !item.is_fulfilled,
                        );
                        const returnableQty = Math.max(0, item.quantity - returnedQty);
                        const canReturnLine = Boolean(
                          orderActions?.canModify &&
                            detail.status !== "cancelled" &&
                            orderActions.onReturnLine &&
                            item.transaction_line_id &&
                            returnableQty > 0,
                        );
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
                                    {fulfillmentLabel(item.fulfillment)}
                                  </span>
                                  {lifecycleLabel &&
                                  item.fulfillment !== "takeaway" ? (
                                    <span
                                      className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${badgeClassName(
                                        lifecycleTone,
                                      )}`}
                                    >
                                      {lifecycleLabel}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                                  {item.sku}
                                  {item.variation_label
                                    ? ` · ${item.variation_label}`
                                    : ""}
                                  {item.salesperson_name
                                    ? ` · ${item.salesperson_name}`
                                    : ""}
                                  {item.vendor_name
                                    ? ` · ${item.vendor_name}`
                                    : ""}
                                  {item.po_number ? ` · ${item.po_number}` : ""}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-4 text-[11px] font-semibold text-app-text">
                                  <span>Qty {item.quantity}</span>
                                  <span>Price {fmtMoney(item.unit_price)}</span>
                                  {returnedQty > 0 ? (
                                    <span>Returned {returnedQty}</span>
                                  ) : null}
                                </div>
                                <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3">
                                  <div className="rounded-lg border border-app-border/60 bg-app-surface-2/70 p-2">
                                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                      Order Step
                                    </p>
                                    <p className="mt-1 font-black text-app-text">
                                      {lifecycleLabel ?? "No order step"}
                                    </p>
                                  </div>
                                  <div className="rounded-lg border border-app-border/60 bg-app-surface-2/70 p-2">
                                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                      Next Action
                                    </p>
                                    <p className="mt-1 font-semibold text-app-text">
                                      {nextAction}
                                    </p>
                                  </div>
                                  <div className="rounded-lg border border-app-border/60 bg-app-surface-2/70 p-2">
                                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                      Ready Notice
                                    </p>
                                    <p className="mt-1 font-semibold text-app-text">
                                      {notificationState}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                {canReturnLine ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      orderActions?.onReturnLine?.(
                                        detail.transaction_id,
                                        item.transaction_line_id!,
                                      )
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-app-accent/20 bg-app-accent/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent transition-colors hover:bg-app-accent/15"
                                  >
                                    <ArrowLeftRight size={14} />
                                    Return / Exchange
                                  </button>
                                ) : null}
                                {canMarkReady ? (
                                  <button
                                    type="button"
                                    onClick={() => openReadyModal(item)}
                                    className="rounded-lg border border-emerald-500/20 bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition-colors hover:bg-emerald-700"
                                  >
                                    Mark Ready + Notify
                                  </button>
                                ) : null}
                                {orderActions?.canModify &&
                                detail.status !== "cancelled" &&
                                !item.is_fulfilled &&
                                orderActions.updateLine &&
                                item.transaction_line_id ? (
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => beginLineEdit(item)}
                                      className="rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent transition-colors hover:bg-app-accent/10"
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => beginSuitSwap(item)}
                                      className="rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-600 transition-colors hover:bg-emerald-600/10"
                                    >
                                      Suit Swap
                                    </button>
                                  </div>
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
                                        fulfillment:
                                          item.fulfillment as FulfillmentKind,
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
                                      onChange={(event) =>
                                        setEditQuantity(event.target.value)
                                      }
                                      disabled={editBusy}
                                      className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                                    />
                                  </label>
                                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                    Price Each
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      value={editUnitPrice}
                                      onChange={(event) =>
                                        setEditUnitPrice(event.target.value)
                                      }
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
                                          event.target
                                            .value as EditableFulfillmentKind,
                                        )
                                      }
                                      disabled={editBusy}
                                      className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                                    >
                                      {EDITABLE_FULFILLMENT_OPTIONS.map(
                                        (option) => (
                                          <option
                                            key={option.value}
                                            value={option.value}
                                          >
                                            {option.label}
                                          </option>
                                        ),
                                      )}
                                    </select>
                                  </label>
                                  <div className="sm:col-span-3">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                      Size / Variation
                                    </p>
                                    <p className="mt-1 text-[11px] font-semibold text-app-text">
                                      {editVariantSku}
                                      {editVariantLabel
                                        ? ` · ${editVariantLabel}`
                                        : ""}
                                    </p>
                                    <div className="mt-2">
                                      <VariantSearchInput
                                        placeholder="Search this item for the correct size or variation"
                                        productId={item.product_id}
                                        onSelect={(variant) => {
                                          if (
                                            variant.product_id !==
                                            item.product_id
                                          ) {
                                            setEditError(
                                              "Use Delete and Add when changing to a different item.",
                                            );
                                            return;
                                          }
                                          setEditVariantId(variant.variant_id);
                                          setEditVariantSku(variant.sku);
                                          setEditVariantLabel(
                                            variant.variation_label ?? null,
                                          );
                                          setEditError(null);
                                        }}
                                      />
                                    </div>
                                  </div>
                                  {item.order_lifecycle_status ===
                                    "needs_measurements" ||
                                  item.order_lifecycle_status === "ntbo" ? (
                                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted sm:col-span-3">
                                      Order Step
                                      <select
                                        value={editLifecycleStatus}
                                        onChange={(event) =>
                                          setEditLifecycleStatus(
                                            event.target.value,
                                          )
                                        }
                                        disabled={editBusy}
                                        className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                                      >
                                        <option value="needs_measurements">
                                          Needs Measurements
                                        </option>
                                        <option value="ntbo">
                                          Ready to Order
                                        </option>
                                      </select>
                                    </label>
                                  ) : null}
                                </div>
                                {editError ? (
                                  <p className="mt-3 text-[11px] font-semibold text-rose-700">
                                    {editError}
                                  </p>
                                ) : (
                                  <p className="mt-3 text-[11px] font-semibold text-app-text-muted">
                                    Save to update totals and item status.
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
                                    {editBusy ? "Saving…" : "Save Item"}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                            {item.custom_item_type ? (
                              <div className="mt-3 rounded-xl border border-app-border/70 bg-app-surface-2/70 p-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                      Custom Order Details
                                    </p>
                                    <p className="mt-1 text-[11px] font-black text-app-text">
                                      {item.custom_item_type}
                                    </p>
                                    {item.custom_order_details
                                      ?.vendor_form_family ? (
                                      <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                                        {customVendorLabel(
                                          item.custom_order_details
                                            .vendor_form_family,
                                        )}
                                      </p>
                                    ) : null}
                                  </div>
                                  {orderActions?.canModify &&
                                  detail.status !== "cancelled" &&
                                  !item.is_fulfilled &&
                                  orderActions.updateLine &&
                                  canEditCustomOrderDetails &&
                                  item.transaction_line_id ? (
                                    <button
                                      type="button"
                                      onClick={() => setCustomEditItem(item)}
                                      className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent transition-colors hover:border-app-accent/30 hover:bg-app-accent/10"
                                    >
                                      Edit Custom Order
                                    </button>
                                  ) : null}
                                </div>
                                <div className="mt-2 grid gap-1 text-[11px] font-semibold text-app-text-muted sm:grid-cols-2">
                                  {customOrderDetailEntries(
                                    item.custom_order_details,
                                  ).map((entry) => (
                                    <p key={entry.label}>
                                      {entry.label}: {entry.value}
                                    </p>
                                  ))}
                                  {customOrderDetailEntries(
                                    item.custom_order_details,
                                  ).length === 0 ? (
                                    <p className="sm:col-span-2">
                                      No custom measurements or vendor notes
                                      were saved for this item.
                                    </p>
                                  ) : null}
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
                  Staff Details
                </h3>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Operator
                  </p>
                  <p className="mt-1 text-[12px] font-semibold text-app-text">
                    {detail.operator_name ?? "—"}
                  </p>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Primary Salesperson
                    </p>
                    <button
                      type="button"
                      onClick={() => setAttributionOpen(true)}
                      className="text-[10px] font-bold uppercase tracking-widest text-app-accent hover:underline"
                    >
                      Correct
                    </button>
                  </div>
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
                  <p className="text-sm text-app-text-muted">
                    No recorded activity yet.
                  </p>
                ) : (
                  audit.map((event) => (
                    <div key={event.id} className="relative">
                      <div className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-app-surface bg-app-border" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {new Date(event.created_at).toLocaleString()} ·{" "}
                        {formatAuditKind(event.event_kind)}
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

      {showPickupReleaseModal && detail && drawerRoot
        ? createPortal(
            <div className="ui-overlay-backdrop z-200 flex items-center justify-center p-4">
              <div className="ui-modal w-full max-w-2xl">
                <div className="ui-modal-header flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Pickup Release
                    </p>
                    <h3 className="mt-1 text-xl font-black text-app-text">
                      {detail.transaction_display_id ??
                        detail.transaction_id.slice(0, 8)}
                    </h3>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">
                      Recognition, inventory, commission, and reporting move
                      when pickup is released.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closePickupReleaseModal}
                    disabled={pickupBusy}
                    className="rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                    aria-label="Close pickup release"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="ui-modal-body space-y-4">
                  {pickupBalanceDueCents > 0 ? (
                    <div className="rounded-xl border border-app-danger/25 bg-app-danger/10 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
                        Balance Blocks Pickup
                      </p>
                      <p className="mt-2 text-sm font-bold text-app-text">
                        {fmtMoney(detail.balance_due)} is still due. Collect the
                        balance before release.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-app-success/25 bg-app-success/10 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-success">
                        Balance Clear
                      </p>
                      <p className="mt-2 text-sm font-bold text-app-text">
                        Payment is clear. Release only items that are ready, or
                        record an override.
                      </p>
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Ready Items
                      </p>
                      <p className="mt-1 text-lg font-black text-app-success">
                        {pickupModalReadyLines.length}
                      </p>
                    </div>
                    <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Blocked Items
                      </p>
                      <p className="mt-1 text-lg font-black text-app-warning">
                        {pickupModalBlockedLines.length}
                      </p>
                    </div>
                    <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Releasing
                      </p>
                      <p className="mt-1 text-lg font-black text-app-text">
                        {pickupOverride
                          ? pickupModalOpenLines.length
                          : pickupModalReadyLines.length}
                      </p>
                    </div>
                  </div>

                  {pickupModalReadyLines.length > 0 ? (
                    <div className="rounded-xl border border-app-success/20 bg-app-success/8 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-success">
                        Ready to Release
                      </p>
                      <ul className="mt-2 space-y-2 text-sm font-semibold text-app-text">
                        {pickupModalReadyLines.slice(0, 5).map((item) => (
                          <li
                            key={item.transaction_line_id}
                            className="flex justify-between gap-3"
                          >
                            <span>{item.product_name}</span>
                            <span className="shrink-0 text-app-text-muted">
                              {item.sku}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {pickupModalBlockedLines.length > 0 ? (
                    <div className="rounded-xl border border-app-warning/25 bg-app-warning/10 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-warning">
                        Still Blocked
                      </p>
                      <ul className="mt-2 space-y-2 text-sm font-semibold text-app-text">
                        {pickupModalBlockedLines.slice(0, 5).map((item) => (
                          <li
                            key={item.transaction_line_id}
                            className="flex justify-between gap-3"
                          >
                            <span>{item.product_name}</span>
                            <span className="shrink-0 text-app-text-muted">
                              {lifecycleStatusLabel(
                                item.order_lifecycle_status,
                                item.alteration_status,
                              ) ?? "Not ready"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {pickupModalBlockedLines.length > 0 ? (
                    <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                      <label className="flex items-start gap-3 text-sm font-bold text-app-text">
                        <input
                          type="checkbox"
                          checked={pickupOverride}
                          onChange={(event) =>
                            setPickupOverride(event.target.checked)
                          }
                          disabled={pickupBusy || pickupBalanceDueCents > 0}
                          className="mt-0.5 h-4 w-4"
                        />
                        Record readiness override and release blocked items
                      </label>
                      {pickupOverride ? (
                        <label className="mt-3 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Override Reason
                          <textarea
                            value={pickupOverrideReason}
                            onChange={(event) =>
                              setPickupOverrideReason(event.target.value)
                            }
                            disabled={pickupBusy}
                            className="mt-1 min-h-24 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm font-semibold normal-case tracking-normal text-app-text outline-none"
                            placeholder="Explain why blocked items are being released now."
                          />
                        </label>
                      ) : (
                        <p className="mt-2 text-xs font-semibold text-app-text-muted">
                          Without override, only Ready for Pickup items will be
                          released.
                        </p>
                      )}
                    </div>
                  ) : null}

                  {pickupError ? (
                    <p className="rounded-xl border border-app-danger/25 bg-app-danger/10 p-3 text-sm font-bold text-app-danger">
                      {pickupError}
                    </p>
                  ) : null}
                </div>
                <div className="ui-modal-footer flex gap-3">
                  <button
                    type="button"
                    onClick={closePickupReleaseModal}
                    disabled={pickupBusy}
                    className="ui-btn-secondary flex-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitPickupRelease()}
                    disabled={pickupBusy || !pickupCanSubmit}
                    className="flex-1 rounded-xl border-b-4 border-app-success bg-app-success px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                  >
                    {pickupBusy
                      ? "Releasing..."
                      : pickupOverride
                        ? "Release with Override"
                        : "Release Ready Items"}
                  </button>
                </div>
              </div>
            </div>,
            drawerRoot,
          )
        : null}

      {suitSwapTarget && drawerRoot
        ? createPortal(
            <div className="ui-overlay-backdrop z-200 flex items-center justify-center p-4">
              <div className="ui-modal w-full max-w-lg">
                <div className="ui-modal-header flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shirt className="h-5 w-5 text-emerald-600 animate-pulse" />
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Suit Component Swap
                      </p>
                      <h3 className="mt-1 text-lg font-black text-app-text">
                        Swap Component: {suitSwapTarget.product_name}
                      </h3>
                      <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                        Current SKU: {suitSwapTarget.sku} · Qty{" "}
                        {suitSwapTarget.quantity}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeSuitSwap}
                    disabled={suitSwapBusy}
                    className="rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                    aria-label="Close suit swap"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="ui-modal-body space-y-4">
                  <p className="text-xs text-app-text-muted leading-relaxed">
                    A Suit Component Swap exchanges parts of a suit (e.g. swap
                    pants, vests, coats). The removed item returns to floor
                    stock inventory, and the new item is pulled from inventory.
                    Price, cost, and NYS/Erie taxes are automatically
                    recalculated.
                  </p>

                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Replacement SKU
                      <input
                        className="ui-input mt-1 w-full font-mono text-sm"
                        value={suitSwapSku}
                        onChange={(e) => setSuitSwapSku(e.target.value)}
                        placeholder="Scan or type replacement SKU"
                        disabled={suitSwapBusy}
                      />
                    </label>
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Swap Note
                      <input
                        className="ui-input mt-1 w-full text-sm"
                        value={suitSwapNote}
                        onChange={(e) => setSuitSwapNote(e.target.value)}
                        placeholder="e.g., Exchanged pants size 32 for 34"
                        disabled={suitSwapBusy}
                      />
                    </label>
                  </div>

                  {suitSwapError && (
                    <p className="text-xs font-semibold text-rose-600">
                      {suitSwapError}
                    </p>
                  )}
                </div>
                <div className="ui-modal-footer flex gap-2">
                  <button
                    type="button"
                    onClick={closeSuitSwap}
                    disabled={suitSwapBusy}
                    className="flex-1 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitSuitSwap()}
                    disabled={suitSwapBusy || !suitSwapSku.trim()}
                    className="flex-1 rounded-xl border-b-4 border-app-success bg-app-success px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                  >
                    {suitSwapBusy ? "Swapping..." : "Confirm Suit Swap"}
                  </button>
                </div>
              </div>
            </div>,
            drawerRoot,
          )
        : null}

      {readyTarget && drawerRoot
        ? createPortal(
            <div className="ui-overlay-backdrop z-200 flex items-center justify-center p-4">
              <div className="ui-modal w-full max-w-lg">
                <div className="ui-modal-header flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Ready for Pickup Checklist
                    </p>
                    <h3 className="mt-1 text-xl font-black text-app-text">
                      {readyTarget.product_name}
                    </h3>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">
                      {readyTarget.sku}
                      {readyTarget.vendor_name
                        ? ` · ${readyTarget.vendor_name}`
                        : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeReadyModal}
                    disabled={readyBusy}
                    className="rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                    aria-label="Close ready checklist"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="ui-modal-body space-y-3">
                  <p className="rounded-xl border border-app-info/20 bg-app-info/10 p-3 text-sm font-semibold text-app-text">
                    This only marks the item operationally ready. Customer
                    pickup still has to use the normal pickup workflow.
                  </p>
                  {[
                    [
                      "received",
                      "Item is physically received and matched to the order",
                    ],
                    [
                      "prep",
                      "Final prep, fitting, or alteration review is complete",
                    ],
                    ["customer", "Customer pickup expectations are clear"],
                  ].map(([key, label]) => (
                    <label
                      key={key}
                      className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3 text-sm font-bold text-app-text"
                    >
                      <input
                        type="checkbox"
                        checked={
                          readyChecklist[key as keyof typeof readyChecklist]
                        }
                        onChange={(event) =>
                          setReadyChecklist((prev) => ({
                            ...prev,
                            [key]: event.target.checked,
                          }))
                        }
                        disabled={readyBusy}
                        className="h-4 w-4"
                      />
                      {label}
                    </label>
                  ))}
                  <div className="grid gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3 sm:grid-cols-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Staff Approver
                      <select
                        value={managerStaffId}
                        onChange={(event) => {
                          setManagerStaffId(event.target.value);
                          localStorage.setItem("ros_last_staff_id", event.target.value);
                        }}
                        disabled={readyBusy}
                        className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                      >
                        <option value="">Optional</option>
                        {staffApprovers.map((staff) => (
                          <option key={staff.id} value={staff.id}>
                            {staff.full_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Manager Access PIN
                      <input
                        value={managerPin}
                        onChange={(event) => setManagerPin(event.target.value)}
                        disabled={readyBusy}
                        className="mt-1 h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold outline-none"
                        placeholder="Optional"
                        type="password"
                        inputMode="numeric"
                      />
                    </label>
                    <p className="sm:col-span-2 text-xs font-semibold text-app-text-muted">
                      Use Manager Access only when your current Staff Access
                      cannot perform lifecycle repair or when bypassing ready checks.
                    </p>
                  </div>
                  {readyError ? (
                    <p className="rounded-xl border border-app-danger/25 bg-app-danger/10 p-3 text-sm font-bold text-app-danger">
                      {readyError}
                    </p>
                  ) : null}
                </div>
                <div className="ui-modal-footer flex gap-3">
                  <button
                    type="button"
                    onClick={closeReadyModal}
                    disabled={readyBusy}
                    className="ui-btn-secondary flex-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitReadyTransition()}
                    disabled={readyBusy}
                    className="flex-1 rounded-xl border-b-4 border-app-success bg-app-success px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                  >
                    {readyBusy ? "Saving..." : "Mark Ready"}
                  </button>
                </div>
              </div>
            </div>,
            drawerRoot,
          )
        : null}

      {showReceiptModal && orderId ? (
        <ReceiptSummaryModal
          transactionId={orderId}
          onClose={() => setShowReceiptModal(false)}
          baseUrl={baseUrl}
          getAuthHeaders={auth}
        />
      ) : null}

      {customEditItem ? (
        <CustomItemPromptModal
          isOpen={Boolean(customEditItem)}
          mode="editDetails"
          sku={customEditItem.sku}
          initialDetails={customEditItem.custom_order_details ?? null}
          initialPrice={String(customEditItem.unit_price)}
          onClose={() => setCustomEditItem(null)}
          onConfirm={submitCustomOrderDetails}
        />
      ) : null}

      {attributionOpen && orderId ? (
        <TransactionAttributionModal
          orderId={orderId}
          onClose={() => setAttributionOpen(false)}
          onSaved={() => {
            setAttributionOpen(false);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
