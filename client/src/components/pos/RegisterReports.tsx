import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useMemo } from "react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  Loader2,
  Receipt,
  Calendar,
  DollarSign,
  Globe,
  Heart,
  Printer,
  Download,
  Package,
  Truck,
  CreditCard,
  Banknote,
  User,
  Clock,
  CloudSun,
  Search,
  ShieldAlert,
  RefreshCw,
  Eye,
} from "lucide-react";
import ReceiptSummaryModal from "./ReceiptSummaryModal";
import PosVoidTransactionModal, { type PosVoidTransactionTarget } from "./PosVoidTransactionModal";
import ProductHubDrawer from "../inventory/ProductHubDrawer";
import TransactionDetailDrawer from "../orders/TransactionDetailDrawer";
import { openProfessionalDailySalesPrint, openProfessionalZReportPrint } from "./zReportPrint";
import type { ReportPrintAction } from "../../lib/reportPrint";
import { useToast } from "../ui/ToastProviderLogic";
import { downloadTextFile } from "../../lib/desktopFileBridge";
import type { Customer } from "./CustomerSelector";

const baseUrl = getBaseUrl();

const isBookedToday = (occurredAtStr?: string | null) => {
  if (!occurredAtStr) return false;
  const occurredDate = new Date(occurredAtStr).toDateString();
  const todayDate = new Date().toDateString();
  return occurredDate === todayDate;
};

function registerLineKindLabel(kind?: string | null): string | null {
  if (kind === "rms_charge_payment") return "RMS Payment";
  if (kind === "alteration_service") return "Alteration";
  if (kind === "pos_gift_card_load") return "Gift Card";
  return null;
}

const isBeforeBatchCloseout = () => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  return hours < 21 || (hours === 21 && minutes < 30);
};

type PresetId = "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "custom";
type ZPresetId = "recent" | "today" | "yesterday" | "this_week" | "this_month" | "custom";

interface ActivityItemDetail {
  name: string;
  sku: string;
  quantity: number;
  reg_price: string;
  price: string;
  product_id: string;
  fulfillment?: string | null;
  is_internal?: boolean;
  line_kind?: string | null;
}

interface TransactionPayment {
  method: string;
  amount_label: string;
}

interface RegisterActivityItem {
  id: string;
  kind: string;
  occurred_at: string;
  title: string;
  subtitle?: string | null;
  transaction_id?: string | null;
  payment_id?: string | null;
  payment_allocation_id?: string | null;
  order_id?: string | null;
  wedding_party_id?: string | null;
  amount_label?: string | null;
  payment_summary?: string | null;
  sales_total?: string | null;
  tax_total?: string | null;
  is_takeaway?: boolean | null;
  channel?: string | null;
  wedding_party_name?: string | null;
  items?: ActivityItemDetail[] | null;
  customer_id?: string | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_name?: string | null;
  customer_code?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  deposits_paid?: string | null;
  balance_due?: string | null;
  fulfillment_type?: string | null;
  transaction_total?: string | null;
  short_id?: string | null;
  payments?: TransactionPayment[] | null;
  cashier_name?: string | null;
}

interface RegisterDaySummary {
  timezone: string;
  from_local: string;
  to_local: string;
  preset: string | null;
  is_historical: boolean;
  includes_today: boolean;
  from_eod_snapshot?: boolean;
  reporting_basis?: string;
  sales_count: number;
  sales_subtotal_no_tax: string;
  sales_tax_total: string;
  avg_sale_no_tax: string;
  online_order_count: number;
  pickup_count: number;
  special_order_sale_count: number;
  appointment_count: number;
  new_wedding_parties_count: number;
  merchant_fees_total: string;
  net_sales: string;
  cash_collected: string;
  deposits_collected: string;
  weather_days?: RegisterDayWeatherSummary[];
  weather_summary?: string | null;
  activities: RegisterActivityItem[];
  amount_label?: string;
}

interface RegisterDayWeatherSummary {
  date: string;
  condition: string;
  temp_high: string;
  temp_low: string;
  precipitation_inches: string;
  source: string;
}

interface RegisterSessionRow {
  id: string;
  register_lane: number;
  register_ordinal: number;
  opened_at: string;
  closed_at: string | null;
  qbo_sync_date?: string | null;
  qbo_status?: string | null;
  qbo_journal_entry_id?: string | null;
  qbo_error_message?: string | null;
  qbo_updated_at?: string | null;
  cashier_name: string;
  opening_float: string;
  expected_cash: string | null;
  actual_cash: string | null;
  discrepancy: string | null;
  cash_deposit_date?: string | null;
  cash_deposit_amount?: string | null;
  total_sales: string;
  closing_notes?: string | null;
  closing_comments?: string | null;
  z_report_json?: ZReportSnapshot | null;
}

interface ZReportSnapshot {
  session_id?: string;
  opening_float?: string;
  net_cash_adjustments?: string;
  expected_cash?: string;
  actual_cash?: string;
  discrepancy?: string;
  cash_deposit_date?: string | null;
  cash_deposit_amount?: string | null;
  closing_notes?: string | null;
  closing_comments?: string | null;
  tenders?: Array<{ payment_method: string; total_amount: string; tx_count: number }>;
  override_summary?: Array<{ reason: string; line_count: number; total_delta: string }>;
  tenders_by_lane?: Array<{
    register_lane: number;
    tenders: Array<{ payment_method: string; total_amount: string; tx_count: number }>;
  }>;
  manual_drawer_opens?: Array<{
    id: string;
    staff_id: string;
    staff_name: string;
    reason: string;
    created_at: string;
  }>;
  transactions?: Array<{
    created_at: string;
    payment_method: string;
    amount: string;
    payments?: Array<{
      payment_method: string;
      amount: string;
      check_number?: string | null;
    }> | null;
    customer_name: string;
    transaction_display_id?: string | null;
    transaction_status?: string | null;
    transaction_total?: string | null;
    transaction_paid?: string | null;
    transaction_balance_due?: string | null;
    items?: {
      name: string;
      sku: string;
      quantity: number;
      unit_price: string;
      original_unit_price?: string | null;
      overridden_unit_price?: string | null;
      fulfillment: string;
      is_internal: boolean;
      line_kind?: string | null;
    }[];
    register_lane?: number | null;
  }>;
}

interface OpenRegisterSessionRow {
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  cashier_name: string;
  opened_at: string;
  till_close_group_id: string;
  lifecycle_status: string;
}

interface RegisterCoordinationGroup {
  tillCloseGroupId: string;
  sessions: OpenRegisterSessionRow[];
}

interface GroupedDayActivity {
  date: string;
  label: string;
  activities: RegisterActivityItem[];
  total_sales: string;
  total_tax: string;
  count: number;
}

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "this_month", label: "This month" },
  { id: "this_year", label: "This year" },
  { id: "custom", label: "Custom" },
];

function kindPill(kind: string): string {
  switch (kind) {
    case "payment":
      return "bg-app-success/10 text-app-success ring-app-success/25";
    case "pickup":
      return "bg-app-info/10 text-app-info ring-app-info/25";
    default:
      return "bg-app-surface-2 text-app-text-muted ring-app-border";
  }
}

function paymentIcon(method: string) {
  const m = method.toLowerCase();
  if (m.includes("card") || m.includes("helcim")) return <CreditCard size={12} />;
  if (m.includes("cash")) return <Banknote size={12} />;
  if (m.includes("gift")) return <Package size={12} />;
  return <CreditCard size={12} />;
}

function fulfillmentDisplayLabel(value?: string | null): string | null {
  switch ((value || "").toLowerCase()) {
    case "takeaway":
      return "Takeaway";
    case "special_order":
      return "Special Order";
    case "custom":
      return "Custom Order";
    case "wedding_order":
      return "Wedding Order";
    case "layaway":
      return "Layaway";
    case "pickup":
      return "Pickup";
    default:
      return null;
  }
}

function activityFulfillmentLabel(row: RegisterActivityItem): string | null {
  const explicit = fulfillmentDisplayLabel(row.fulfillment_type);
  if (explicit) return explicit;
  const itemLabels = Array.from(
    new Set((row.items || []).map((item) => fulfillmentDisplayLabel(item.fulfillment)).filter(Boolean)),
  ) as string[];
  if (itemLabels.length === 1) return itemLabels[0] ?? null;
  if (itemLabels.length > 1) return itemLabels.join(" + ");
  if (row.is_takeaway) return "Takeaway";
  return null;
}

function normalizeActivityId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function activityTransactionId(row: RegisterActivityItem): string | null {
  return normalizeActivityId(row.transaction_id) ?? normalizeActivityId(row.order_id);
}

function activitySubtotalBeforeTaxCents(row: Pick<RegisterActivityItem, "items" | "sales_total" | "tax_total" | "transaction_total">): number {
  const itemSubtotal = (row.items ?? [])
    .filter((item) => !item.is_internal)
    .reduce((sum, item) => sum + parseMoneyToCents(item.price) * item.quantity, 0);
  if (itemSubtotal !== 0 || (row.items?.length ?? 0) > 0) return itemSubtotal;

  const grossCents = parseMoneyToCents(row.transaction_total ?? row.sales_total ?? "0");
  const taxCents = parseMoneyToCents(row.tax_total ?? "0");
  return grossCents - taxCents;
}

function moneyFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${centsToFixed2(Math.abs(cents))}`;
}

function moneyFromValue(value: string | null | undefined): string {
  return moneyFromCents(parseMoneyToCents(value ?? "0"));
}

function activityVoidTarget(row: RegisterActivityItem): PosVoidTransactionTarget | null {
  const transactionId = activityTransactionId(row);
  if (!transactionId) return null;
  return {
    transactionId,
    receiptLabel: row.short_id || transactionId.slice(0, 8),
    customerLabel: row.customer_name || "Walk-in Customer",
    amountLabel: row.transaction_total
      ? `$${row.transaction_total}`
      : row.amount_label || row.sales_total || "$0.00",
    paymentSummary: row.payment_summary,
    fulfillmentLabel: activityFulfillmentLabel(row),
  };
}

function activitySearchText(row: RegisterActivityItem): string {
  return [
    row.title,
    row.kind,
    row.transaction_id,
    row.order_id,
    row.short_id,
    row.customer_name,
    row.customer_code,
    row.customer_phone,
    row.customer_email,
    row.payment_summary,
    row.wedding_party_name,
    row.fulfillment_type,
    ...(row.items ?? []).flatMap((item) => [
      item.name,
      item.sku,
      item.fulfillment,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function registerLifecycleLabel(status: string) {
  switch (status) {
    case "reconciling":
      return "Pending close";
    case "closed":
      return "Closed";
    case "open":
    default:
      return "Open drawer";
  }
}

function registerLifecycleTone(status: string) {
  switch (status) {
    case "reconciling":
      return "border-app-warning/20 bg-app-warning/10 text-app-warning";
    case "closed":
      return "border-app-success/20 bg-app-success/10 text-app-success";
    case "open":
    default:
      return "border-app-info/20 bg-app-info/10 text-app-info";
  }
}

function qboStatusLabel(status?: string | null) {
  switch ((status ?? "").toLowerCase()) {
    case "pending":
      return "QBO pending review";
    case "approved":
      return "QBO approved";
    case "synced":
      return "QBO posted";
    case "failed":
      return "QBO failed";
    default:
      return "QBO not staged";
  }
}

function qboStatusTone(status?: string | null) {
  switch ((status ?? "").toLowerCase()) {
    case "synced":
      return "border-app-success/25 bg-app-success/10 text-app-success";
    case "approved":
    case "pending":
      return "border-app-warning/25 bg-app-warning/10 text-app-warning";
    case "failed":
      return "border-app-danger/25 bg-app-danger/10 text-app-danger";
    default:
      return "border-app-border bg-app-surface-3 text-app-text-muted";
  }
}

function formatDepositDate(value?: string | null) {
  if (!value) return "No date";
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function primaryRegisterSession(
  sessions: OpenRegisterSessionRow[],
): OpenRegisterSessionRow | null {
  return sessions.find((session) => session.register_lane === 1) ?? sessions[0] ?? null;
}

async function openZReportFromSession(
  session: RegisterSessionRow,
  action: ReportPrintAction = "preview",
): Promise<boolean> {
  const snapshot = session.z_report_json;
  const cashTender = snapshot?.tenders?.find(
    (tender) => tender.payment_method.toLowerCase() === "cash",
  );
  return openProfessionalZReportPrint({
    title: "Z-Report",
    sessionId: snapshot?.session_id ?? session.id,
    action,
    registerOrdinal: session.register_ordinal,
    cashierLabel: session.cashier_name,
    openedAt: session.opened_at,
    openingCents: parseMoneyToCents(snapshot?.opening_float ?? session.opening_float),
    cashSalesCents: parseMoneyToCents(cashTender?.total_amount ?? "0"),
    netAdjustmentsCents: parseMoneyToCents(snapshot?.net_cash_adjustments ?? "0"),
    expectedCents: parseMoneyToCents(snapshot?.expected_cash ?? session.expected_cash ?? "0"),
    actualCents: parseMoneyToCents(snapshot?.actual_cash ?? session.actual_cash ?? "0"),
    discrepancyCents: parseMoneyToCents(snapshot?.discrepancy ?? session.discrepancy ?? "0"),
    cashDepositDate: snapshot?.cash_deposit_date ?? session.cash_deposit_date ?? null,
    cashDepositAmountCents: parseMoneyToCents(
      snapshot?.cash_deposit_amount ?? session.cash_deposit_amount ?? "0",
    ),
    closingNotes: snapshot?.closing_notes ?? session.closing_notes ?? null,
    closingComments: snapshot?.closing_comments ?? session.closing_comments ?? null,
    tenders: snapshot?.tenders ?? [],
    overrideSummary: snapshot?.override_summary ?? [],
    tendersByLane: snapshot?.tenders_by_lane ?? [],
    manualDrawerOpens: snapshot?.manual_drawer_opens ?? [],
    transactions:
      snapshot?.transactions?.map((transaction) => ({
        created_at: transaction.created_at,
        payment_method: transaction.payment_method,
        amount: transaction.amount,
        payments: transaction.payments ?? null,
        customer_name: transaction.customer_name,
        transaction_display_id: transaction.transaction_display_id,
        transaction_status: transaction.transaction_status,
        transaction_total: transaction.transaction_total,
        transaction_paid: transaction.transaction_paid,
        transaction_balance_due: transaction.transaction_balance_due,
        items: transaction.items ?? [],
        register_lane: transaction.register_lane ?? session.register_lane,
      })) ?? [],
  });
}

function activityCustomer(row: RegisterActivityItem): Customer | null {
  const id = row.customer_id?.trim();
  if (!id) return null;
  const fallbackLabel = row.customer_name?.trim() || row.customer_code?.trim() || "Customer";
  const fallbackParts = fallbackLabel.split(/\s+/).filter(Boolean);
  const firstName = row.customer_first_name?.trim() || fallbackParts[0] || fallbackLabel;
  const lastName = row.customer_last_name?.trim() || fallbackParts.slice(1).join(" ");
  return {
    id,
    customer_code: row.customer_code ?? "",
    first_name: firstName,
    last_name: lastName,
    email: row.customer_email ?? null,
    phone: row.customer_phone ?? null,
  };
}

export default function RegisterReports({
  sessionId,
  onOpenWeddingParty,
  onOpenCustomerHub,
  deepLinkTransactionId,
  onDeepLinkConsumed,
  onOpenRefundInRegister,
}: {
  sessionId: string | null;
  onOpenWeddingParty?: (partyId: string) => void;
  onOpenCustomerHub?: (customer: Customer) => void;
  deepLinkTransactionId?: string | null;
  onDeepLinkConsumed?: () => void;
  onOpenRefundInRegister?: (transactionId: string) => void;
}) {
  const [view, setView] = useState<"dashboard" | "activity" | "z-reports">("dashboard");
  const [preset, setPreset] = useState<PresetId>("today");
  const [reportBasis, setReportBasis] = useState<"booked" | "fulfilled">("booked");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [summary, setSummary] = useState<RegisterDaySummary | null>(null);
  const [summaryBooked, setSummaryBooked] = useState<RegisterDaySummary | null>(null);
  const [zLogs, setZLogs] = useState<RegisterSessionRow[]>([]);
  const [openSessions, setOpenSessions] = useState<OpenRegisterSessionRow[]>([]);
  const [openSessionsError, setOpenSessionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zLoading, setZLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [hubProductId, setHubProductId] = useState<string | null>(null);
  const [zPreset, setZPreset] = useState<ZPresetId>("recent");
  const [customFromZ, setCustomFromZ] = useState("");
  const [customToZ, setCustomToZ] = useState("");
  const [activitySearch, setActivitySearch] = useState("");

  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const apiAuth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const selectedSummary = reportBasis === "booked" ? summaryBooked : summary;
  const [voidTarget, setVoidTarget] = useState<PosVoidTransactionTarget | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);

  const buildActivityParams = useCallback((basis: "booked" | "fulfilled" = reportBasis) => {
    const params = new URLSearchParams();
    if (preset === "custom") {
      if (!customFrom || !customTo) {
        params.set("preset", "today");
      } else {
        params.set("preset", "custom");
        params.set("from", customFrom);
        params.set("to", customTo);
      }
    } else {
      params.set("preset", preset);
    }
    if (sessionId) params.set("register_session_id", sessionId);
    params.set("basis", basis);
    return params;
  }, [preset, customFrom, customTo, sessionId, reportBasis]);

  const fetchSummary = useCallback(async (basis?: "booked" | "fulfilled") => {
    const targetBasis = basis || reportBasis;
    setError(null);
    setLoading(true);
    try {
      const h = apiAuth();
      const params = buildActivityParams(targetBasis);
      const res = await fetch(`${baseUrl}/api/insights/register-day-activity?${params}`, { headers: h });
      if (res.status === 403) {
        setError(sessionId ? "Register session is not open." : "register.reports permission required.");
        return null;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Failed to load activity");
      }
      return (await res.json()) as RegisterDaySummary;
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred");
      return null;
    } finally {
      setLoading(false);
    }
  }, [apiAuth, buildActivityParams, sessionId, reportBasis]);

  useEffect(() => {
    const load = async () => {
      const bookedData = await fetchSummary("booked");
      if (bookedData) setSummaryBooked(bookedData);
      const fulfilledData = await fetchSummary("fulfilled");
      if (fulfilledData) setSummary(fulfilledData);
    };
    load();
  }, [fetchSummary, preset, customFrom, customTo]);

  const buildZLogParams = useCallback(() => {
    const params = new URLSearchParams({ limit: "40" });
    if (zPreset === "custom") {
      if (customFromZ && customToZ) {
        params.set("preset", "custom");
        params.set("from", customFromZ);
        params.set("to", customToZ);
      } else {
        params.set("preset", "recent");
      }
    } else if (zPreset === "recent") {
      params.set("preset", "recent");
    } else {
      params.set("preset", zPreset);
    }
    return params;
  }, [zPreset, customFromZ, customToZ]);

  const fetchZLogs = useCallback(async () => {
    setZLoading(true);
    try {
      const h = apiAuth();
      const params = buildZLogParams();
      const res = await fetch(`${baseUrl}/api/insights/register-sessions?${params}`, { headers: h });
      if (!res.ok) throw new Error("Failed to fetch Z-Logs");
      const data = (await res.json()) as RegisterSessionRow[];
      setZLogs(Array.isArray(data) ? data : []);
    } catch {
      setZLogs([]);
    } finally {
      setZLoading(false);
    }
  }, [apiAuth, buildZLogParams]);

  const fetchOpenSessions = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/sessions/list-open`, {
        headers: apiAuth(),
      });
      if (res.status === 401 || res.status === 403) {
        setOpenSessions([]);
        setOpenSessionsError("Register coordination visibility requires attach access.");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch open register sessions");
      const data = (await res.json()) as OpenRegisterSessionRow[];
      setOpenSessions(Array.isArray(data) ? data : []);
      setOpenSessionsError(null);
    } catch (error) {
      setOpenSessions([]);
      setOpenSessionsError(
        error instanceof Error ? error.message : "Could not load active register sessions.",
      );
    }
  }, [apiAuth]);

  useEffect(() => {
    if (view === "z-reports") {
      void fetchZLogs();
      void fetchOpenSessions();
    }
  }, [view, zPreset, customFromZ, customToZ, fetchZLogs, fetchOpenSessions]);

  const rangeLabel = useMemo(() => {
    if (!selectedSummary) return "";
    if (selectedSummary.from_local === selectedSummary.to_local) return selectedSummary.from_local;
    return `${selectedSummary.from_local} → ${selectedSummary.to_local}`;
  }, [selectedSummary]);

  useEffect(() => {
    if (deepLinkTransactionId) {
      setReceiptOrderId(deepLinkTransactionId);
      onDeepLinkConsumed?.();
    }
  }, [deepLinkTransactionId, onDeepLinkConsumed]);

  const groupedActivities = useMemo((): GroupedDayActivity[] => {
    const source = reportBasis === "booked" ? summaryBooked : summary;
    if (!source?.activities?.length) return [];
    const needle = activitySearch.trim().toLowerCase();
    const groups: Record<string, RegisterActivityItem[]> = {};
    source.activities
      .filter((a) => !needle || activitySearchText(a).includes(needle))
      .forEach((a) => {
      const date = new Date(a.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      if (!groups[date]) groups[date] = [];
      groups[date].push(a);
    });
    return Object.entries(groups).map(([date, acts]) => ({
      date,
      label: date,
      activities: acts,
      total_sales: acts.reduce((sum, a) => sum + (parseFloat(a.sales_total || "0") || 0), 0).toFixed(2),
      total_tax: acts.reduce((sum, a) => sum + (parseFloat(a.tax_total || "0") || 0), 0).toFixed(2),
      count: acts.length,
    }));
  }, [summary, summaryBooked, reportBasis, activitySearch]);
  const activitySourceCount = (reportBasis === "booked" ? summaryBooked : summary)?.activities?.length ?? 0;

  const coordinationGroups = useMemo((): RegisterCoordinationGroup[] => {
    const grouped = new Map<string, OpenRegisterSessionRow[]>();
    openSessions.forEach((session) => {
      const existing = grouped.get(session.till_close_group_id) ?? [];
      existing.push(session);
      grouped.set(session.till_close_group_id, existing);
    });
    return Array.from(grouped.entries())
      .map(([tillCloseGroupId, sessions]) => ({
        tillCloseGroupId,
        sessions: sessions.sort((left, right) => left.register_lane - right.register_lane),
      }))
      .sort((left, right) => left.sessions[0]!.register_lane - right.sessions[0]!.register_lane);
  }, [openSessions]);

  const coordinationSummary = useMemo(() => {
    const openDrawerCount = coordinationGroups.length;
    const reconcilingGroups = coordinationGroups.filter((group) =>
      group.sessions.some((session) => session.lifecycle_status === "reconciling"),
    );
    return {
      activeSessions: openSessions.length,
      openDrawers: openDrawerCount,
      pendingCloses: reconcilingGroups.length,
      reconcilingGroups,
    };
  }, [openSessions, coordinationGroups]);

  const weatherDays = summaryBooked?.weather_days?.length
    ? summaryBooked.weather_days
    : summary?.weather_days ?? [];
  const weatherSummaryLabel =
    summaryBooked?.weather_summary ?? summary?.weather_summary ?? null;

  const formatWeatherNumber = (value: string, digits: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(digits) : value;
  };

  const handleReportOutput = (action: ReportPrintAction) => {
    const printSummary = selectedSummary;
    if (!printSummary) return;
    const printRangeLabel =
      printSummary.from_local === printSummary.to_local
        ? printSummary.from_local
        : `${printSummary.from_local} → ${printSummary.to_local}`;
    void openProfessionalDailySalesPrint({
      title: `Daily Sales - ${printRangeLabel}`,
      rangeLabel: printRangeLabel,
      action,
      summary: {
        sales_count: printSummary.sales_count,
        sales_subtotal_no_tax: printSummary.sales_subtotal_no_tax,
        sales_tax_total: printSummary.sales_tax_total,
        net_sales: printSummary.net_sales,
        appointment_count: printSummary.appointment_count,
        online_order_count: printSummary.online_order_count,
        new_wedding_parties_count: printSummary.new_wedding_parties_count,
        merchant_fees_total: printSummary.merchant_fees_total,
        cash_collected: printSummary.cash_collected,
        deposits_collected: printSummary.deposits_collected,
      },
      activities: printSummary.activities.map(a => ({
        ...a,
        subtotal_before_tax: centsToFixed2(activitySubtotalBeforeTaxCents(a)),
        tax_total: a.tax_total,
        items: a.items?.map(i => ({
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
          reg_price: i.reg_price || i.price,
          price: i.price,
          fulfillment: i.fulfillment,
        })),
        fulfillment_label: activityFulfillmentLabel(a),
        is_takeaway: a.is_takeaway,
        channel: a.channel,
      }))
    });
  };

  const handleExportCSV = async () => {
    if (!selectedSummary?.activities.length) return;
    const rows = selectedSummary.activities.flatMap(a => {
      const itemRows = (a.items || []).map((item, idx) => ({
        "Date": new Date(a.occurred_at).toLocaleDateString(),
        "Time": new Date(a.occurred_at).toLocaleTimeString(),
        "Kind": a.kind,
        "Order ID": a.order_id || "",
        "Customer Name": a.customer_name || "",
        "Customer #": a.customer_code || "",
        "Wedding Party": a.wedding_party_name || "",
        "Item": item.name,
        "SKU": item.sku,
        "Qty": item.quantity,
        "Reg Price": item.reg_price,
        "Sale Price": item.price,
        "Takeaway": a.is_takeaway ? "Yes" : "No",
        "Fulfillment": a.fulfillment_type || "",
        "Deposit Paid": idx === 0 ? (a.deposits_paid || "0") : "",
        "Balance Due": idx === 0 ? (a.balance_due || "0") : "",
        "Transaction Total": idx === 0 ? (a.transaction_total || a.amount_label || "0") : "",
        "Sales Total": idx === 0 ? (a.sales_total || "0") : "",
        "Tax": idx === 0 ? (a.tax_total || "0") : "",
        "Net Total": idx === 0 ? (a.amount_label || "0") : "",
      }));
      return itemRows;
    });

    // Calculate totals
    const totalSales = selectedSummary.activities.reduce((sum, a) => sum + (parseFloat(a.sales_total || "0") || 0), 0);
    const totalTax = selectedSummary.activities.reduce((sum, a) => sum + (parseFloat(a.tax_total || "0") || 0), 0);
    const totalNet = selectedSummary.activities.reduce((sum, a) => sum + (parseFloat(a.amount_label || "0") || 0), 0);

    const totalRow = {
      "Date": "TOTAL",
      "Time": "",
      "Kind": "",
      "Order ID": "",
      "Customer Name": "",
      "Customer #": "",
      "Wedding Party": "",
      "Item": "",
      "SKU": "",
      "Qty": "",
      "Reg Price": "",
      "Sale Price": "",
      "Takeaway": "",
      "Fulfillment": "",
      "Deposit Paid": "",
      "Balance Due": "",
      "Transaction Total": totalSales.toFixed(2),
      "Sales Total": totalSales.toFixed(2),
      "Tax": totalTax.toFixed(2),
      "Net Total": totalNet.toFixed(2),
    };

    const headers = ["Date", "Time", "Kind", "Order ID", "Customer Name", "Customer #", "Wedding Party", "Item", "SKU", "Qty", "Reg Price", "Sale Price", "Takeaway", "Fulfillment", "Deposit Paid", "Balance Due", "Transaction Total", "Sales Total", "Tax", "Net Total"];
    const csv = [headers.join(","), ...rows.map(r => headers.map(h => {
      const v = r[h as keyof typeof r]?.toString() || "";
      return v.includes(",") ? `"${v}"` : v;
    }).join(",")), headers.map(h => {
      const v = totalRow[h as keyof typeof totalRow]?.toString() || "";
      return v.includes(",") ? `"${v}"` : v;
    }).join(",")].join("\n");

    await downloadTextFile(`daily-sales-${preset}.csv`, csv, "text/csv;charset=utf-8", [
      { name: "CSV", extensions: ["csv"] },
    ]);
  };

  const submitVoidTransaction = useCallback(
    async (args: { managerStaffId: string; managerPin: string; reason: string }) => {
      if (!voidTarget) return false;
      if (!sessionId) {
        toast("Open or attach to a register before voiding a completed transaction.", "error");
        return false;
      }
      setVoidBusy(true);
      try {
        const res = await fetch(`${baseUrl}/api/transactions/${voidTarget.transactionId}/void`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...apiAuth(),
          },
          body: JSON.stringify({
            register_session_id: sessionId,
            manager_staff_id: args.managerStaffId,
            manager_pin: args.managerPin,
            reason: args.reason,
          }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          toast(payload.error || "Transaction void could not be completed.", "error");
          return false;
        }
        const payload = (await res.json()) as {
          status: string;
          transaction_id: string;
          reversal_status?: string;
          refundable_amount?: string;
          pop_cash_drawer?: boolean;
        };

        if (payload.pop_cash_drawer) {
          try {
            const { printReceiptBase64 } = await import("../../lib/receiptPrint");
            await printReceiptBase64("G3AAMvo=");
          } catch (e) {
            console.error("Cash drawer pop failed during void", e);
          }
        }

        const amount = payload.refundable_amount ? `$${payload.refundable_amount}` : "the paid balance";
        toast(
          payload.reversal_status === "no_refund_due"
            ? "Transaction voided. No refund balance remains."
            : `Transaction voided. Refund workflow opened for ${amount}.`,
          "success",
        );
        setVoidTarget(null);
        if (payload.reversal_status === "pending_refund" && onOpenRefundInRegister) {
          onOpenRefundInRegister(payload.transaction_id);
        } else {
          const bookedData = await fetchSummary("booked");
          if (bookedData) setSummaryBooked(bookedData);
          const fulfilledData = await fetchSummary("fulfilled");
          if (fulfilledData) setSummary(fulfilledData);
        }
        return true;
      } catch {
        toast("Transaction void is unavailable. Try again or call a manager.", "error");
        return false;
      } finally {
        setVoidBusy(false);
      }
    },
    [apiAuth, fetchSummary, sessionId, toast, voidTarget, onOpenRefundInRegister],
  );

  return (
    <div className="flex flex-1 flex-col bg-app-bg p-4 sm:p-6">
      {detailOrderId && (
        <TransactionDetailDrawer
          orderId={detailOrderId}
          isOpen={!!detailOrderId}
          onClose={() => setDetailOrderId(null)}
        />
      )}
      <ReceiptSummaryModal
        transactionId={receiptOrderId}
        onClose={() => setReceiptOrderId(null)}
        baseUrl={baseUrl}
        registerSessionId={sessionId}
        getAuthHeaders={apiAuth}
      />
      <PosVoidTransactionModal
        open={!!voidTarget}
        target={voidTarget}
        busy={voidBusy}
        onClose={() => {
          if (!voidBusy) setVoidTarget(null);
        }}
        onVoid={submitVoidTransaction}
      />

      {/* Header */}
      <div className="mb-4 flex shrink-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">Register</p>
            <h2 className="text-2xl font-black tracking-tight text-app-text">Daily Sales</h2>
            {selectedSummary && (
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                {rangeLabel}
                <span className="mx-1.5 opacity-40">·</span>
                <span className="font-mono">{selectedSummary.timezone}</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-1 rounded-2xl border border-app-border bg-app-surface-2 p-1 shadow-inner">
          <button type="button" onClick={() => setView("dashboard")} className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${view === "dashboard" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:bg-app-surface/60 hover:text-app-text"}`}>
            Dashboard
          </button>
          <button type="button" onClick={() => setView("activity")} className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${view === "activity" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:bg-app-surface/60 hover:text-app-text"}`}>
            Activity
          </button>
          <button type="button" onClick={() => setView("z-reports")} className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${view === "z-reports" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:bg-app-surface/60 hover:text-app-text"}`}>
            Z-Reports
          </button>
        </div>
      </div>

      {/* Filters */}
      {view === "activity" && (
        <div className="mb-4 shrink-0 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">View Mode</span>
            <div className="flex gap-1 rounded-2xl border border-app-border bg-app-surface-2 p-1">
              <button type="button" onClick={() => setReportBasis("fulfilled")} className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${reportBasis === "fulfilled" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
                Fulfilled (Pickup)
              </button>
              <button type="button" onClick={() => setReportBasis("booked")} className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${reportBasis === "booked" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
                Booked (Sale)
              </button>
            </div>
            <div className="rounded-xl border border-app-info/20 bg-app-info/10 px-3 py-2 text-xs font-semibold text-app-text-muted">
              {reportBasis === "booked"
                ? "Booked shows sales by checkout date. Use this for register activity and Z-close comparison."
                : "Fulfilled shows pickup/release activity. Use this for revenue recognition review, not drawer close totals."}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" onClick={() => setPreset(p.id)} className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-all ${preset === p.id ? "bg-app-accent text-white shadow-md shadow-app-accent/25" : "border border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/40 hover:text-app-text"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "dashboard" && (
        <div className="mb-4 shrink-0 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" onClick={() => setPreset(p.id)} className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-all ${preset === p.id ? "bg-app-accent text-white shadow-md shadow-app-accent/25" : "border border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/40 hover:text-app-text"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {view !== "z-reports" && preset === "custom" && (
        <div className="mb-4 flex shrink-0 flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            From
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="ui-input rounded-xl px-3 py-2 text-sm font-semibold" />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            To
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="ui-input rounded-xl px-3 py-2 text-sm font-semibold" />
          </label>
          <button type="button" onClick={() => { fetchSummary("booked"); fetchSummary("fulfilled"); }} className="rounded-xl bg-app-success px-4 py-2 text-sm font-black text-white shadow-[0_4px_0_0_color-mix(in_srgb,var(--app-success)_58%,black)] transition hover:brightness-105">
            Apply
          </button>
        </div>
      )}

      {!sessionId && view !== "z-reports" && (
        <div className="mb-4 rounded-xl border border-app-warning/20 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
          <span className="font-bold">Store-wide view.</span> Managers with register.reports see every lane.
        </div>
      )}

      {/* Content Area */}
      <div className="ui-card ui-tint-neutral flex flex-1 flex-col rounded-[24px]">

        {/* Dashboard View */}
        {view === "dashboard" && (
          loading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : (
            <div className="flex flex-col gap-2 p-3">
              <div className="flex gap-2 mb-2">
                <button type="button" onClick={() => handleReportOutput("preview")} className="ui-btn-secondary flex items-center gap-1.5 border-app-accent/20 px-3 py-1.5 text-xs font-black text-app-accent hover:bg-app-accent hover:text-white">
                  <Eye size={12} />View
                </button>
                <button type="button" onClick={() => handleReportOutput("print")} className="ui-btn-secondary flex items-center gap-1.5 border-app-success/20 px-3 py-1.5 text-xs font-black text-app-success hover:bg-app-success hover:text-white">
                  <Printer size={12} />Print
                </button>
                <button type="button" onClick={handleExportCSV} className="ui-btn-secondary flex items-center gap-1.5 border-app-border px-3 py-1.5 text-xs font-black text-app-text hover:bg-app-surface">
                  <Download size={12} />CSV
                </button>
              </div>

              {weatherDays.length > 0 ? (
                <div className="ui-panel ui-tint-info p-3">
                  <div className="mb-2 flex items-center gap-1.5">
                    <CloudSun className="h-3 w-3 text-app-info" />
                    <span className="text-xs font-bold text-app-info">Weather</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                      {weatherDays[0]?.source}
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {weatherDays.slice(0, 6).map((day) => (
                      <div key={day.date} className="ui-metric-cell ui-tint-info p-2">
                        <div className="text-xs font-bold text-app-text-muted">{day.date}</div>
                        <p className="mt-1 text-base font-black text-app-text">{day.condition}</p>
                        <p className="mt-1 text-xs font-semibold text-app-text-muted">
                          High {formatWeatherNumber(day.temp_high, 0)}° · Low {formatWeatherNumber(day.temp_low, 0)}° · Rain {formatWeatherNumber(day.precipitation_inches, 2)} in
                        </p>
                      </div>
                    ))}
                  </div>
                  {weatherDays.length > 6 ? (
                    <p className="mt-2 text-xs font-semibold text-app-text-muted">
                      Showing first 6 weather days. Use Back Office Reports for the full date range.
                    </p>
                  ) : weatherSummaryLabel ? (
                    <p className="mt-2 text-xs font-semibold text-app-text-muted">{weatherSummaryLabel}</p>
                  ) : null}
                </div>
              ) : null}

              {/* Booked Summary - First and Default */}
              {summaryBooked && (
                <div className="ui-panel ui-tint-success p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <DollarSign className="h-3 w-3 text-app-success" />
	                    <span className="text-xs font-bold text-app-success">Booked Sales</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="ui-metric-cell ui-tint-success p-2">
	                      <div className="text-xs font-bold text-app-success">Sales</div>
                      <p className="text-lg font-black text-app-text">{summaryBooked.sales_count}</p>
                    </div>
                    <div className="ui-metric-cell ui-tint-success p-2">
	                      <div className="text-xs font-bold text-app-success">Sales Total</div>
                      <p className="text-lg font-black text-app-text">${centsToFixed2(parseMoneyToCents(summaryBooked.sales_subtotal_no_tax))}</p>
                    </div>
                    <div className="ui-metric-cell ui-tint-warning p-2">
	                      <div className="text-xs font-bold text-app-warning">Tax</div>
                      <p className="text-lg font-black text-app-text">${centsToFixed2(parseMoneyToCents(summaryBooked.sales_tax_total))}</p>
                    </div>
                    <div className="ui-metric-cell ui-tint-danger p-2">
	                      <div className="text-xs font-bold text-app-danger">Fees</div>
                      <p className="text-lg font-black text-app-text">${centsToFixed2(parseMoneyToCents(summaryBooked.merchant_fees_total))}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div className="ui-metric-cell ui-tint-info p-2">
                      <div className="flex items-center justify-between">
	                        <span className="text-xs font-bold text-app-info">Cash Taken</span>
                        <span className="text-lg font-black text-app-text">${summaryBooked.cash_collected}</span>
                      </div>
                    </div>
                    <div className="ui-metric-cell ui-tint-success p-2">
                      <div className="flex items-center justify-between">
	                        <span className="text-xs font-bold text-app-success">Deposits Taken</span>
                        <span className="text-lg font-black text-app-text">${summaryBooked.deposits_collected}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Fulfilled Summary */}
              {summary && (
                <div className="ui-panel ui-tint-info p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Truck className="h-3 w-3 text-app-info" />
	                    <span className="text-xs font-bold text-app-info">Completed</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="ui-metric-cell ui-tint-info p-2">
	                      <div className="text-xs font-bold text-app-info">Orders</div>
                      <p className="text-lg font-black text-app-text">{summary.pickup_count || 0}</p>
                    </div>
                    <div className="ui-metric-cell ui-tint-info p-2">
	                      <div className="text-xs font-bold text-app-info">Revenue</div>
                      <p className="text-lg font-black text-app-text">${centsToFixed2(parseMoneyToCents(summary.sales_subtotal_no_tax))}</p>
                    </div>
                    <div className="ui-metric-cell ui-tint-info p-2">
	                      <div className="text-xs font-bold text-app-info">Tax</div>
                      <p className="text-lg font-black text-app-text">${centsToFixed2(parseMoneyToCents(summary.sales_tax_total))}</p>
                    </div>
                    <div className="ui-metric-cell ui-tint-success p-2">
	                      <div className="text-xs font-bold text-app-success">Net</div>
                      <p className="text-lg font-black text-app-text">${centsToFixed2(parseMoneyToCents(summary.net_sales))}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Additional Metrics - Compact */}
              <div className="grid grid-cols-4 gap-2">
                <div className="ui-metric-cell ui-tint-neutral p-2">
	                  <div className="flex items-center gap-1 text-xs font-bold text-app-text-muted"><Calendar className="h-3 w-3" />Appts</div>
                  <p className="text-base font-black">{summaryBooked?.appointment_count || 0}</p>
                </div>
                <div className="ui-metric-cell ui-tint-info p-2">
	                  <div className="flex items-center gap-1 text-xs font-bold text-app-text-muted"><Globe className="h-3 w-3" />Online</div>
                  <p className="text-base font-black">{summaryBooked?.online_order_count || 0}</p>
                </div>
                <div className="ui-metric-cell ui-tint-accent p-2">
	                  <div className="flex items-center gap-1 text-xs font-bold text-app-text-muted"><Heart className="h-3 w-3" />Weddings</div>
                  <p className="text-base font-black">{summaryBooked?.new_wedding_parties_count || 0}</p>
                </div>
                <div className="ui-metric-cell ui-tint-warning p-2">
	                  <div className="flex items-center gap-1 text-xs font-bold text-app-text-muted"><Package className="h-3 w-3" />Orders</div>
                  <p className="text-base font-black">{summaryBooked?.special_order_sale_count || 0}</p>
                </div>
              </div>
              {/* Combined Totals Placeholder - already handled by individual summary boxes */}
            </div>
          )
        )}

        {/* Activity View */}
        {view === "activity" && (
          loading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <p className="font-bold text-app-text">{error}</p>
              <button type="button" onClick={() => { fetchSummary("booked"); fetchSummary("fulfilled"); }} className="mt-4 text-sm font-bold text-app-accent hover:underline">Try again</button>
            </div>
          ) : activitySourceCount === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-app-text-muted">No activity in this range.</div>
          ) : (
            <div className="flex flex-col gap-4 p-3 sm:p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <label className="relative min-w-0 md:w-[420px]">
                  <Search
                    size={15}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={activitySearch}
                    onChange={(event) => setActivitySearch(event.target.value)}
                    placeholder="Search name, phone, email, customer #, receipt barcode, or item"
                    className="ui-input h-11 w-full rounded-xl pl-9 pr-3 text-sm font-semibold"
                    aria-label="Search daily sales activity"
                  />
                </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => handleReportOutput("preview")} className="ui-btn-secondary flex items-center gap-2 border-app-accent/20 px-3 py-1.5 text-xs font-black text-app-accent hover:bg-app-accent hover:text-white">
                  <Eye size={12} />View
                </button>
                <button type="button" onClick={() => handleReportOutput("print")} className="ui-btn-secondary flex items-center gap-2 border-app-success/20 px-3 py-1.5 text-xs font-black text-app-success hover:bg-app-success hover:text-white">
                  <Printer size={12} />Print
                </button>
                <button type="button" onClick={handleExportCSV} className="ui-btn-secondary flex items-center gap-2 border-app-border px-3 py-1.5 text-xs font-black text-app-text hover:bg-app-surface">
                  <Download size={12} />Export
                </button>
              </div>
              </div>
              {groupedActivities.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center py-20 text-app-text-muted">
                  No daily sales activity matches this search.
                </div>
              ) : groupedActivities.map((group) => (
                <div key={group.date} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between border-b border-app-border pb-2">
                    <div>
                      <span className="text-xs font-black uppercase tracking-wider text-app-text">{group.label}</span>
                      <span className="ml-2 text-[10px] text-app-text-muted">({group.count} transactions)</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-black text-app-text-muted">Total: </span>
                      <span className="text-sm font-black text-app-accent">${group.total_sales}</span>
                    </div>
                  </div>
                  {group.activities.map((row) => (
                    <div
                      key={row.id}
                      className="ui-card ui-tint-neutral group relative mb-4 flex flex-col transition-all"
                    >
                      <div className="flex flex-col lg:flex-row lg:items-stretch divide-y lg:divide-y-0 lg:divide-x divide-app-border">
                        {/* 1. Transaction Overview (Left) */}
                        <div className="flex flex-col justify-between bg-app-surface-2/60 p-5 lg:w-1/4">
                          <div>
                            <div className="flex items-center gap-2 mb-3">
                               <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ring-1 shadow-sm ${kindPill(row.kind)}`}>
                                 {row.title}
                               </span>
                               <span className="text-[10px] font-bold text-app-text-muted flex items-center gap-1 opacity-60">
                                 <Clock size={10} />
                                 {new Date(row.occurred_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                               </span>
                            </div>
                            <div className="flex flex-col gap-1">
                               {activityCustomer(row) && onOpenCustomerHub ? (
                                 <button
                                   type="button"
                                   onClick={(e) => {
                                     e.stopPropagation();
                                     const customer = activityCustomer(row);
                                     if (customer) onOpenCustomerHub(customer);
                                   }}
                                   className="group/customer flex min-w-0 items-start gap-2 text-left text-base font-black tracking-tight text-app-text transition-colors hover:text-app-accent"
                                 >
                                   <User size={16} className="mt-0.5 shrink-0 text-app-text-muted opacity-30" />
                                   <span className="truncate underline-offset-4 group-hover/customer:underline">
                                     {row.customer_name || "Walk-in Customer"}
                                   </span>
                                 </button>
                               ) : (
                                 <h4 className="text-base font-black text-app-text tracking-tight flex items-start gap-2">
                                   <User size={16} className="text-app-text-muted opacity-30 mt-0.5 shrink-0" />
                                   <span className="truncate">{row.customer_name || "Walk-in Customer"}</span>
                                 </h4>
                               )}
                               <div className="flex flex-wrap items-center gap-1.5 mt-1">
	                                 {row.customer_code && (activityCustomer(row) && onOpenCustomerHub ? (
                                     <button
                                       type="button"
                                       onClick={(e) => {
                                         e.stopPropagation();
                                         const customer = activityCustomer(row);
                                         if (customer) onOpenCustomerHub(customer);
                                       }}
                                       className="ui-pill bg-app-surface-3 text-xs font-bold text-app-text-muted transition-colors hover:bg-app-accent/10 hover:text-app-accent"
                                     >
                                       #{row.customer_code}
                                     </button>
                                   ) : (
                                     <span className="ui-pill bg-app-surface-3 text-xs font-bold text-app-text-muted">#{row.customer_code}</span>
                                   ))}
                                 {row.wedding_party_name && (
                                   <button
                                     type="button"
                                     onClick={(e) => {
                                       e.stopPropagation();
                                       if (row.wedding_party_id && onOpenWeddingParty) onOpenWeddingParty(row.wedding_party_id);
                                     }}
	                                     className="flex min-h-8 items-center gap-1 rounded bg-app-danger/6 px-2 py-0.5 text-xs font-bold text-app-danger ring-1 ring-app-danger/20 transition-colors hover:bg-app-danger/10"
                                   >
                                     <Heart size={10} /> {row.wedding_party_name}
                                   </button>
                                 )}
                               </div>
                               <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                                  <span className="font-mono text-[10px] font-black text-app-text uppercase tracking-tighter bg-app-surface-2 px-1.5 py-0.5 rounded">#{row.short_id || activityTransactionId(row)?.slice(0, 8)}</span>
                                  {activityFulfillmentLabel(row) && (
                                    <span className="rounded bg-app-warning/10 px-1.5 py-0.5 text-xs font-bold leading-none text-app-warning">
                                      {activityFulfillmentLabel(row)}
                                    </span>
                                  )}
	                                  {row.channel === 'web' && <span className="flex items-center gap-1 rounded bg-app-info/10 px-1.5 py-0.5 text-xs font-bold leading-none text-app-info"><Globe size={10}/> Online</span>}
                               </div>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-2 border-t border-app-border/40 pt-4">
	                             <button type="button" onClick={() => {
                                const transactionId = activityTransactionId(row);
                                if (transactionId) setReceiptOrderId(transactionId);
                              }} disabled={!activityTransactionId(row)} className="ui-btn-secondary flex min-h-11 w-full items-center justify-center gap-2 py-2 text-sm font-bold shadow-sm transition-all hover:bg-app-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
                                <Receipt size={14} />
                                Receipt
                             </button>
                             <button
                               type="button"
                               onClick={() => {
                                 const transactionId = activityTransactionId(row);
                                 if (transactionId) setDetailOrderId(transactionId);
                               }}
                               disabled={!activityTransactionId(row)}
                               className="ui-btn-secondary flex min-h-11 w-full items-center justify-center gap-2 py-2 text-sm font-bold shadow-sm transition-all hover:bg-app-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                             >
                               <Search size={14} /> Detail
                             </button>
                             {(() => {
                                const transactionId = activityTransactionId(row);
                                if (row.kind === "payment") return null;
                                const canVoid = isBookedToday(row.occurred_at) && isBeforeBatchCloseout();
                                return canVoid ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const target = activityVoidTarget(row);
                                      if (target) setVoidTarget(target);
                                    }}
                                    disabled={!transactionId}
                                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-app-danger/30 bg-app-danger/10 px-3 py-2 text-sm font-black text-app-danger shadow-sm transition-all hover:bg-app-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    <ShieldAlert size={14} /> Void
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (transactionId && onOpenRefundInRegister) {
                                        onOpenRefundInRegister(transactionId);
                                      }
                                    }}
                                    disabled={!transactionId}
                                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-black text-emerald-500 shadow-sm transition-all hover:bg-emerald-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    <RefreshCw size={14} /> Refund
                                  </button>
                                );
                              })()}
                            </div>
                        </div>

                        {/* 2. Items Ledger (Middle) */}
                        <div className="p-5 flex-1 lg:max-w-xl">
                           <div className="mb-3 flex items-center justify-between">
	                              <h5 className="text-sm font-black text-app-text-muted">Line Items</h5>
	                              <span className="text-xs font-semibold text-app-text-muted opacity-70">({row.items?.length || 0} units)</span>
                           </div>
                           <table className="w-full text-left">
                              <thead>
	                                 <tr className="border-b border-app-border/40 pb-2 text-xs font-bold text-app-text-muted">
                                    <th className="pb-2">Description / SKU</th>
                                    <th className="pb-2 text-center">Qty</th>
                                    <th className="pb-2 text-center">Reg</th>
                                    <th className="pb-2 text-center">Sale</th>
                                    <th className="pb-2 text-right">Fulfillment</th>
                                 </tr>
                              </thead>
                              <tbody className="divide-y divide-app-border/20">
                                 {row.items?.map((it, i) => {
                                  const lineKindLabel = registerLineKindLabel(it.line_kind);
                                  return (
                                    <tr key={i} className="text-[11px] hover:bg-app-surface-2/30 transition-colors">
                                       <td className="py-2.5 pr-4">
                                          <div className="font-black text-app-text leading-snug">{it.name}</div>
	                                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-xs text-app-text-muted opacity-70">
                                            <span>{it.sku}</span>
                                            {lineKindLabel ? (
                                              <span className="rounded bg-app-info/10 px-1.5 py-0.5 font-sans text-[9px] font-black uppercase tracking-widest text-app-info">
                                                {lineKindLabel}
                                              </span>
                                            ) : null}
                                          </div>
                                       </td>
                                       <td className="py-2.5 text-center align-top font-bold text-app-text">{it.quantity}</td>
                                       <td className="py-2.5 text-center align-top text-app-text-muted/60 line-through font-medium tracking-tighter tabular-nums">${it.reg_price}</td>
                                       <td className="py-2.5 text-center align-top font-black text-app-text tracking-tighter tabular-nums">${it.price}</td>
                                       <td className="py-2.5 text-right align-top">
	                                          <span className={`rounded px-2 py-0.5 text-xs font-bold ${
                                             it.fulfillment === 'takeaway' ? 'bg-app-warning/10 text-app-warning' :
                                             it.fulfillment === 'special_order' || it.fulfillment === 'custom' ? 'bg-app-info/10 text-app-info' :
                                             it.fulfillment === 'layaway' ? 'bg-app-accent/10 text-app-accent' : it.fulfillment === 'pickup' ? 'bg-app-success/10 text-app-success' :
                                             'bg-app-surface-2 text-app-text-muted font-bold'
                                          }`}>
	                                             {it.fulfillment === 'takeaway' ? 'Taken' : it.fulfillment === 'special_order' || it.fulfillment === 'custom' ? 'Ordered' : it.fulfillment === 'layaway' ? 'Layaway' : it.fulfillment === 'pickup' ? 'Pickup' : it.fulfillment || 'Unknown'}
                                          </span>
                                       </td>
                                    </tr>
                                  );
                                 })}
                                 {!row.items?.length && (
                                   <tr>
                                      <td colSpan={5} className="py-8 text-center text-xs italic text-app-text-muted opacity-40">No item details recorded for this transaction</td>
                                   </tr>
                                 )}
                              </tbody>
                           </table>
                        </div>

                        {/* 3. Financial Breakdown (Right) */}
                        <div className="flex flex-col justify-between bg-app-surface-2/60 p-5 lg:w-1/4">
                           <div className="space-y-3">
	                              <div className="flex flex-col items-end gap-0.5">
	                                 <span className="text-xs font-bold text-app-text-muted">Subtotal Before Tax</span>
	                                 <span className="text-base font-black text-app-text tabular-nums leading-none tracking-tighter">
	                                   {moneyFromCents(activitySubtotalBeforeTaxCents(row))}
	                                 </span>
	                                 {row.tax_total ? (
	                                   <span className="text-[11px] font-bold text-app-text-muted tabular-nums">
	                                     Tax {moneyFromValue(row.tax_total)}
	                                   </span>
	                                 ) : null}
	                              </div>

	                              <div className="flex flex-col items-end gap-0.5 pt-2 border-t border-app-border/40">
		                                 <span className="text-xs font-bold text-app-text-muted">Sales Total (Booked)</span>
	                                 <span className="text-lg font-black text-app-text tabular-nums leading-none tracking-tighter">
	                                   ${row.sales_total || "0.00"}
	                                 </span>
	                              </div>

	                              <div className="flex flex-col items-end gap-0.5 pt-2 border-t border-app-border/40">
	                                 <span className="text-xs font-bold text-app-success">Deposits Taken / Transaction Total</span>
                                 <span className="text-base font-black text-app-text tabular-nums leading-none tracking-tighter">
                                   ${row.transaction_total || "0.00"}
                                 </span>
	                                 <div className="mt-1 flex flex-col items-end gap-0.5 text-xs font-semibold text-app-text-muted opacity-80">
                                    {row.payments?.length
                                       ? row.payments.map((payment, idx) => (
                                          <span key={`${payment.method}-${idx}`} className="inline-flex items-center gap-1 uppercase tracking-tighter tabular-nums">
                                             {paymentIcon(payment.method)}
                                             <span>{payment.method} ${payment.amount_label}</span>
                                          </span>
                                       ))
                                       : row.payment_summary && (
                                          <span className="inline-flex items-center gap-1 uppercase tracking-tighter tabular-nums">
                                             {paymentIcon(row.payment_summary)}
                                             <span>{row.payment_summary}</span>
                                          </span>
                                       )}
                                 </div>
                              </div>
                           </div>

                           <div className="mt-6 pt-4 border-t-2 border-app-border flex flex-col items-end">
	                              <span className="mb-1 text-xs font-bold text-app-text-muted">Balance Due</span>
                              <span className="text-3xl font-black text-app-accent tabular-nums tracking-tighter leading-none">
                                 ${row.balance_due || "0.00"}
                              </span>
                           </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {/* Grand Total */}
              {reportBasis === "booked" ? summaryBooked && (
                <div className="ui-panel ui-tint-success mt-4 flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-black uppercase text-app-success">Daily Total ({summaryBooked.activities.length} transactions)</span>
                  <div className="text-right">
                    <span className="text-xs font-black text-app-text-muted">Subtotal: ${centsToFixed2(parseMoneyToCents(summaryBooked.sales_subtotal_no_tax))}</span>
                    <span className="mx-2">|</span>
                    <span className="text-sm font-black text-app-text">Total: {summaryBooked.amount_label}</span>
                  </div>
                </div>
              ) : summary && (
                <div className="ui-panel ui-tint-info mt-4 flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-black uppercase text-app-info">Daily Total ({summary.activities.length} transactions)</span>
                  <div className="text-right">
                    <span className="text-xs font-black text-app-text-muted">Subtotal: ${centsToFixed2(parseMoneyToCents(summary.sales_subtotal_no_tax))}</span>
                    <span className="mx-2">|</span>
                    <span className="text-sm font-black text-app-text">Total: {summary.amount_label}</span>
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* Z-Reports View */}
        {view === "z-reports" && (
          zLoading ? (
            <div className="flex flex-1 items-center justify-center py-20">
              <Loader2 className="h-9 w-9 animate-spin text-app-accent" />
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-app-surface-2 px-4 py-3 sm:px-6">
	                <div className="no-scrollbar flex flex-wrap gap-1 rounded-xl border border-app-border bg-app-surface-2 p-1">
                  {[
                    { id: "recent" as const, label: "Recent" },
                    { id: "today" as const, label: "Today" },
                    { id: "yesterday" as const, label: "Yesterday" },
                    { id: "this_week" as const, label: "Week" },
                    { id: "this_month" as const, label: "Month" },
                    { id: "custom" as const, label: "Custom" },
                  ].map((p) => (
	                    <button key={p.id} type="button" onClick={() => setZPreset(p.id)} className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${zPreset === p.id ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {zPreset === "custom" && (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <input type="date" value={customFromZ} onChange={(e) => setCustomFromZ(e.target.value)} className="ui-input rounded-lg px-3 py-2 text-sm" />
                    <span className="text-app-text-muted">to</span>
                    <input type="date" value={customToZ} onChange={(e) => setCustomToZ(e.target.value)} className="ui-input rounded-lg px-3 py-2 text-sm" />
                    <button type="button" onClick={() => void fetchZLogs()} className="rounded-lg bg-app-success px-4 py-2 text-sm font-bold text-white hover:brightness-105">Apply</button>
                  </div>
                )}
              </div>
              <div className="border-b border-app-border bg-app-surface-2 px-4 py-4 sm:px-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
	                    <p className="text-xs font-bold text-app-text-muted">
                      Register coordination
                    </p>
                    <p className="mt-1 text-sm font-semibold text-app-text">
                      See which drawers are still open, which till group is already closing, and where staff should avoid duplicate close work.
                    </p>
                  </div>
                  <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-3">
                    {[
                      ["Active sessions", String(coordinationSummary.activeSessions)],
                      ["Open drawers", String(coordinationSummary.openDrawers)],
                      ["Pending closes", String(coordinationSummary.pendingCloses)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="ui-metric-cell ui-tint-neutral px-3 py-3 text-center"
                      >
	                        <p className="text-xs font-bold text-app-text-muted">
                          {label}
                        </p>
                        <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                {coordinationSummary.pendingCloses > 0 ? (
                  <div className="mt-3 rounded-xl border border-app-warning/20 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
	                    <p className="text-xs font-bold">
                      Pending close in progress
                    </p>
                    <p className="mt-1 font-semibold leading-relaxed">
                      One or more till groups are already reconciling. Finish the active close from Register #1 before another staff member starts a second Z-close attempt.
                    </p>
                  </div>
                ) : null}
                <div className="ui-panel ui-tint-info mt-3 px-4 py-3 text-sm text-app-text-muted">
	                  <p className="text-xs font-bold text-app-text">
                    Shared drawer rule
                  </p>
                  <p className="mt-1 leading-relaxed">
                    Each till group has one physical drawer. Satellite lanes stay visible here, but final Z-close still runs once from Register #1 for the whole group.
                  </p>
                </div>
                <div className="mt-3 rounded-xl border border-app-warning/20 bg-app-warning/10 px-4 py-3 text-sm text-app-text-muted">
                  <p className="text-xs font-bold text-app-text">
                    Accounting handoff after close
                  </p>
                  <p className="mt-1 leading-relaxed">
                    A saved Z-report confirms the register close. QBO staging is reviewed separately in the QBO workspace; accounting should confirm the journal is pending, failed, or posted before clearing the day.
                  </p>
                </div>
                {openSessionsError ? (
                  <p className="mt-3 text-xs font-semibold text-app-text-muted">
                    {openSessionsError}
                  </p>
                ) : coordinationGroups.length === 0 ? (
                  <p className="mt-3 text-xs font-semibold text-app-text-muted">
                    No open drawers are visible right now.
                  </p>
                ) : (
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {coordinationGroups.map((group) => {
                      const isReconciling = group.sessions.some(
                        (session) => session.lifecycle_status === "reconciling",
                      );
                      const primarySession = primaryRegisterSession(group.sessions);
                      return (
                        <div
                          key={group.tillCloseGroupId}
                          className="ui-card ui-tint-neutral px-4 py-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
	                              <p className="text-xs font-bold text-app-text-muted">
                                Drawer group
                              </p>
                              <p className="mt-1 text-sm font-black text-app-text">
                                {primarySession
                                  ? `Register #${primarySession.register_lane} close anchor`
                                  : "Shared till group"}
                              </p>
                              <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
	                                Shift {group.tillCloseGroupId.slice(0, 8)}…
                              </p>
                            </div>
                            <span
	                              className={`rounded-full border px-3 py-1 text-xs font-bold ${
                                isReconciling
                                  ? "border-app-warning/20 bg-app-warning/10 text-app-warning"
                                  : "border-app-info/20 bg-app-info/10 text-app-info"
                              }`}
                            >
                              {isReconciling ? "Closing now" : "Open"}
                            </span>
                          </div>
                          <div className="mt-3 space-y-2">
                            {group.sessions.map((session) => (
                              <div
                                key={session.session_id}
                                className="ui-metric-cell ui-tint-neutral flex items-center justify-between gap-3 px-3 py-3"
                              >
                                <div>
                                  <p className="text-sm font-black text-app-text">
                                    Register #{session.register_lane}
                                  </p>
                                  <p className="text-[11px] font-semibold text-app-text-muted">
                                    {session.cashier_name} · opened{" "}
                                    {new Date(session.opened_at).toLocaleString(undefined, {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    })}
                                  </p>
                                </div>
                                <span
	                                  className={`rounded-full border px-2.5 py-1 text-xs font-bold ${registerLifecycleTone(
                                    session.lifecycle_status,
                                  )}`}
                                >
                                  {registerLifecycleLabel(session.lifecycle_status)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <p className="mt-3 text-[11px] font-medium leading-relaxed text-app-text-muted">
                            {isReconciling
	                              ? "This group is already closing. Avoid starting another close from a linked register."
                              : "Close this shared drawer from Register #1 when every linked lane in the till group is ready."}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {zLogs.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-20 text-app-text-muted">
                  No register sessions recorded in this range.
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-app-border overflow-y-auto">
                  {zLogs.map((session) => {
                    const depositDate = session.z_report_json?.cash_deposit_date ?? session.cash_deposit_date ?? null;
                    const depositAmount = session.z_report_json?.cash_deposit_amount ?? session.cash_deposit_amount ?? "0";
                    return (
                    <li key={session.id} className="flex items-center gap-4 px-4 py-4 sm:px-6 hover:bg-app-surface-2/70">
                      <div className="flex-1">
                        <p className="text-xs font-bold text-app-text-muted">
                          Register #{session.register_lane} · Session #{session.register_ordinal}
                        </p>
                        <p className="font-black text-app-text">{session.cashier_name}</p>
                        <p className="text-sm text-app-text-muted">
                          Opened {new Date(session.opened_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-app-text-muted">Closed</p>
                        <p className="font-bold text-app-text">
                          {session.closed_at
                            ? new Date(session.closed_at).toLocaleString(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : "Still open"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="mb-1">
	                          <span className="rounded-full border border-app-border bg-app-surface-3 px-2.5 py-1 text-xs font-bold text-app-text-muted">
                            Z-close anchor
                          </span>
                        </p>
                        <p className="text-xl font-black tabular-nums text-app-accent">${centsToFixed2(parseMoneyToCents(session.total_sales))}</p>
                        <p className="text-xs text-app-text-muted">Exp. cash ${centsToFixed2(parseMoneyToCents(session.expected_cash ?? "0"))}</p>
                        <p className="text-xs font-semibold text-app-text-muted">
                          Deposit {formatDepositDate(depositDate)} · ${centsToFixed2(parseMoneyToCents(depositAmount))}
                        </p>
                        <div className="mt-2 flex flex-col items-end gap-1">
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${qboStatusTone(session.qbo_status)}`}>
                            {qboStatusLabel(session.qbo_status)}
                          </span>
                          {session.qbo_sync_date ? (
                            <span className="text-[10px] font-semibold text-app-text-muted">
                              Business date {session.qbo_sync_date}
                            </span>
                          ) : null}
                          {session.qbo_journal_entry_id ? (
                            <span className="text-[10px] font-mono text-app-text-muted">
                              JE {session.qbo_journal_entry_id}
                            </span>
                          ) : null}
                          {session.qbo_error_message ? (
                            <span className="max-w-48 text-right text-[10px] font-semibold text-app-danger">
                              {session.qbo_error_message}
                            </span>
                          ) : null}
                        </div>
                        {session.discrepancy &&
                        Math.abs(parseMoneyToCents(session.discrepancy)) > 0 ? (
                          <p className="text-xs font-black text-app-warning">
                            Discrepancy ${centsToFixed2(parseMoneyToCents(session.discrepancy))}
                          </p>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            void openZReportFromSession(session)
                              .then((opened) => {
                                if (opened) {
                                  toast("Z-report opened for review.", "success");
                                  return;
                                }
                                toast("Z-report could not open. Check the Reports printer setup.", "error");
                              })
                              .catch((error) => {
                                toast(
                                  error instanceof Error
                                    ? error.message
                                    : "Z-report could not open.",
                                  "error",
                                );
                              });
                          }}
                          className="mt-2 rounded-lg border border-app-accent/25 bg-app-accent/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-accent hover:bg-app-accent hover:text-white"
                        >
                          Open Report
                        </button>
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )
        )}
      </div>

      <ProductHubDrawer
        isOpen={!!hubProductId}
        productId={hubProductId}
        onClose={() => setHubProductId(null)}
        baseUrl={baseUrl}
      />
    </div>
  );
}
