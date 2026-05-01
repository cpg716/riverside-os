import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Gift,
  Heart,
  Mail,
  MessageSquarePlus,
  Printer,
  Receipt,
  Scissors,
  Search,
  ShoppingBag,
  Sparkles,
  UserPlus,
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import type { Customer } from "../pos/CustomerSelector";
import type {
  CustomerProfile,
  WeddingMembership,
} from "../pos/customerProfileTypes";
import CustomerMeasurementVaultForm from "./CustomerMeasurementVaultForm";
import {
  measurementDraftFromLatest,
  serializeMeasurementPatch,
} from "./CustomerMeasurementLogic";
import ShipmentsHubSection from "./ShipmentsHubSection";
import LayawayWorkspace from "../pos/LayawayWorkspace";
import AddressAutocompleteInput from "../ui/AddressAutocompleteInput";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import TransactionDetailDrawer from "../orders/TransactionDetailDrawer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  type CustomerLifecycleState,
} from "./customerLifecycle";

const defaultBase = getBaseUrl();

export interface CustomerHubStats {
  lifetime_spend_usd: string;
  balance_due_usd: string;
  wedding_party_count: number;
  last_activity_at: string | null;
  days_since_last_visit: number | null;
  marketing_needs_attention: boolean;
  loyalty_points: number;
  lifecycle_state: CustomerLifecycleState;
}

export interface CoupleMemberPreview {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  couple_id: string | null;
  couple_primary_id: string | null;
}

export interface CustomerHubData extends CustomerProfile {
  is_vip: boolean;
  stats: CustomerHubStats;
  partner: CoupleMemberPreview | null;
  couple_id: string | null;
  couple_primary_id: string | null;
  couple_linked_at: string | null;
}

export interface CustomerTimelineEvent {
  at: string;
  kind: string;
  summary: string;
  reference_id: string | null;
  reference_type: string | null;
  wedding_party_id: string | null;
}

export interface MeasurementRecord {
  id: string;
  neck: string | null;
  sleeve: string | null;
  chest: string | null;
  waist: string | null;
  seat: string | null;
  inseam: string | null;
  outseam: string | null;
  shoulder: string | null;
  retail_suit?: string | null;
  retail_waist?: string | null;
  retail_vest?: string | null;
  retail_shirt?: string | null;
  retail_shoe?: string | null;
  measured_at: string;
  source: string;
}

function fmtMoney(v: string | number): string {
  const cents = parseMoneyToCents(v);
  return formatUsdFromCents(cents);
}

function fmtLifetimeCompact(s: string): string {
  const cents = parseMoneyToCents(s);
  const n = cents / 100;
  if (!Number.isFinite(n)) return "—";
  if (n >= 100_000) return `$${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return formatUsdFromCents(cents);
}

function lastVisitLabel(days: number | null): string {
  if (days === null) return "No visits yet";
  if (days <= 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function readableDateTime(value: string | null | undefined): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function humanizeToken(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "Unknown";
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function transactionStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "completed":
    case "complete":
      return "Completed";
    case "cancelled":
    case "canceled":
      return "Canceled";
    case "refunded":
      return "Refunded";
    case "pending_measurement":
      return "Waiting on measurements";
    default:
      return humanizeToken(status);
  }
}

function saleChannelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "web":
      return "Online";
    case "register":
      return "Store";
    case undefined:
    case null:
    case "":
      return "Unknown";
    default:
      return humanizeToken(channel);
  }
}

function isOpenAlterationStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return !!normalized && !["completed", "complete", "cancelled", "canceled", "picked_up"].includes(normalized);
}

function giftCardEventLabel(kind: string): string {
  switch (kind) {
    case "issued":
      return "Card issued";
    case "loaded":
      return "Card loaded";
    case "redeemed":
      return "Card used";
    case "voided":
      return "Card voided";
    default:
      return humanizeToken(kind);
  }
}

function formatMessagePreview(body: string, channel: string): string {
  if (channel === "email" && body.includes("<")) {
    return body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return body.trim();
}

function customerTimelineKindLabel(kind: string): string {
  switch (kind) {
    case "sale":
      return "Purchase";
    case "payment":
      return "Payment";
    case "wedding":
      return "Wedding activity";
    case "note":
      return "Note";
    case "measurement":
      return "Measurements";
    case "appointment":
      return "Appointment";
    case "shipping":
      return "Shipment update";
    default:
      return humanizeToken(kind);
  }
}

/** Server: `inbound` = customer; `automated` = system templates; `outbound` = ROS staff or Podium app sender name. */
function podiumThreadSentByLabel(m: {
  direction: string;
  staff_full_name?: string | null;
  podium_sender_name?: string | null;
}): string {
  const d = m.direction;
  if (d === "inbound") return "Customer";
  if (d === "automated") return "Automated";
  if (d === "outbound") {
    const ros = m.staff_full_name?.trim();
    if (ros) return ros;
    const podium = m.podium_sender_name?.trim();
    if (podium) return podium;
    return "Podium";
  }
  return d;
}

export type HubTab =
  | "weddings"
  | "messages"
  | "measurements"
  | "alterations"
  | "loyalty"
  | "profile"
  | "transactions"
  | "orders"
  | "layaways"
  | "shipments";

const ORDER_HISTORY_PAGE = 50;

interface CustomerOrderHistoryItem {
  transaction_id: string;
  transaction_display_id: string;
  booked_at: string;
  status: string;
  /** `register` | `web` from server `sale_channel`. */
  sale_channel?: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  item_count: number;
  primary_salesperson_name?: string | null;
  is_fulfillment_order?: boolean;
  is_counterpoint_import?: boolean;
  counterpoint_customer_code?: string | null;
}

interface CustomerOpenSummary {
  orders: number | null;
  layaways: number | null;
  alterations: number | null;
}

interface LoyaltyLedgerEntry {
  id: string;
  reason: string;
  delta_points: number;
  balance_after: number;
  transaction_id?: string | null;
  transaction_display_id?: string | null;
  created_at: string;
  activity_label: string;
  activity_detail: string;
}

interface LoyaltyIssuanceRow {
  id: string;
  customer_id: string;
  card_id: string | null;
  card_code: string | null;
  first_name?: string | null;
  last_name?: string | null;
  reward_amount: string | number;
  points_deducted: number;
  applied_to_sale: string | number;
  created_at: string;
}

interface LoyaltyGiftCardEvent {
  id: string;
  event_kind: string;
  amount: string | number;
  balance_after: string | number;
  transaction_id: string | null;
  notes: string | null;
  created_at: string;
}

interface LoyaltyCardActivity {
  cardCode: string;
  issuanceId: string;
  events: LoyaltyGiftCardEvent[];
}

interface CustomerAlterationSummary {
  id: string;
  status: string;
  due_at: string | null;
  notes: string | null;
  linked_transaction_display_id: string | null;
  source_type: string | null;
  item_description: string | null;
  work_requested: string | null;
  source_sku: string | null;
  charge_amount: string | number | null;
  created_at: string;
}

function alterationStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function alterationSourceLabel(sourceType: string | null | undefined): string {
  switch (sourceType) {
    case "current_cart_item":
      return "Current sale";
    case "past_transaction_line":
      return "Past purchase";
    case "catalog_item":
      return "Stock/catalog";
    case "custom_item":
      return "Custom/manual";
    default:
      return "Alteration";
  }
}

function shortDate(value: string | null | undefined): string {
  if (!value) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export interface CustomerRelationshipHubDrawerProps {
  customer: Customer;
  open: boolean;
  /** When set (e.g. notification deep link), selects this hub tab once per open. */
  initialHubTab?: HubTab | "relationship";
  onClose: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onStartSale: (c: Customer) => void;
  onNavigateRegister?: () => void;
  navigateAfterStartSale?: boolean;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenOrderInBackoffice?: (orderId: string) => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
  onSwitchCustomer?: (c: Customer) => void;
  baseUrl?: string;
  onRefresh?: () => void;
  panelMaxClassName?: string;
}

export function CustomerRelationshipHubDrawer({
  customer,
  open,
  initialHubTab,
  onClose,
  onOpenWeddingParty,
  onStartSale,
  onNavigateRegister,
  navigateAfterStartSale = true,
  onAddToWedding,
  onBookAppointment,
  onOpenOrderInBackoffice,
  onOpenTransactionInBackoffice,
  onSwitchCustomer,
  baseUrl = defaultBase,
  panelMaxClassName = "max-w-6xl",
}: CustomerRelationshipHubDrawerProps) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const onHubShipmentFocusConsumed = useCallback(() => {
    setHubShipmentFocusId(null);
  }, []);
  const canHubView = hasPermission("customers.hub_view");
  const canHubEdit = hasPermission("customers.hub_edit");
  const canTimeline = hasPermission("customers.timeline");
  const canMeasurements = hasPermission("customers.measurements");
  const canOrdersView = hasPermission("orders.view");
  const canShipmentsView = hasPermission("shipments.view");
  const canAlterationsView = hasPermission("alterations.manage");
  const isCompactHub = useMediaQuery("(max-width: 1279px)");
  const backofficeOrderOpener =
    onOpenOrderInBackoffice ?? onOpenTransactionInBackoffice;
  const [tab, setTab] = useState<HubTab>("profile");
  const { toast } = useToast();
  const [hub, setHub] = useState<CustomerHubData | null>(null);
  const [timeline, setTimeline] = useState<CustomerTimelineEvent[]>([]);
  const [vault, setVault] = useState<{
    latest: MeasurementRecord | null;
    history: MeasurementRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [storeCreditBal, setStoreCreditBal] = useState<string | null>(null);
  const [openDepositBal, setOpenDepositBal] = useState<string | null>(null);
  const [openSummary, setOpenSummary] = useState<CustomerOpenSummary>({
    orders: null,
    layaways: null,
    alterations: null,
  });
  const [loyaltyLedger, setLoyaltyLedger] = useState<LoyaltyLedgerEntry[]>([]);
  const [loyaltyIssuances, setLoyaltyIssuances] = useState<LoyaltyIssuanceRow[]>([]);
  const [loyaltyCardActivity, setLoyaltyCardActivity] = useState<LoyaltyCardActivity[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [highlightMissingProfileFields, setHighlightMissingProfileFields] =
    useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [actorStaffId, setActorStaffId] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const [profileDraft, setProfileDraft] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    address_line1: "",
    address_line2: "",
    city: "",
    state: "",
    postal_code: "",
    company_name: "",
    date_of_birth: "",
    anniversary_date: "",
    custom_field_1: "",
    custom_field_2: "",
    custom_field_3: "",
    custom_field_4: "",
    marketing_email_opt_in: false,
    marketing_sms_opt_in: false,
    transactional_sms_opt_in: false,
    transactional_email_opt_in: false,
    profile_discount_percent: "0",
    tax_exempt: false,
    tax_exempt_id: "",
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [measDraft, setMeasDraft] = useState<Record<string, string>>({});
  const [measSaving, setMeasSaving] = useState(false);
  const profileDraftInit = useRef(false);
  const [ordersDateFrom, setOrdersDateFrom] = useState("");
  const [ordersDateTo, setOrdersDateTo] = useState("");
  /** From timeline shipping row → open Shipments tab with this id (consumed by ShipmentsHubSection). */
  const [hubShipmentFocusId, setHubShipmentFocusId] = useState<string | null>(
    null,
  );
  const [selectedTransactionId, setSelectedTransactionId] = useState<
    string | null
  >(null);
  const [orderHistoryRows, setOrderHistoryRows] = useState<
    CustomerOrderHistoryItem[]
  >([]);
  const [orderHistoryTotal, setOrderHistoryTotal] = useState(0);
  const [orderHistoryLoading, setOrderHistoryLoading] = useState(false);
  const [orderHistoryMoreBusy, setOrderHistoryMoreBusy] = useState(false);
  const [customerAlterations, setCustomerAlterations] = useState<
    CustomerAlterationSummary[]
  >([]);
  const [customerAlterationsLoading, setCustomerAlterationsLoading] =
    useState(false);
  const [customerAlterationsSearch, setCustomerAlterationsSearch] =
    useState("");
  const ordersFilterRef = useRef({ from: "", to: "" });
  ordersFilterRef.current = { from: ordersDateFrom, to: ordersDateTo };
  const [podiumUrlDraft, setPodiumUrlDraft] = useState("");
  const [podiumComposeSubject, setPodiumComposeSubject] = useState("");
  const [podiumComposeHtml, setPodiumComposeHtml] = useState("");
  const [podiumComposeBusy, setPodiumComposeBusy] = useState(false);
  const [podiumThread, setPodiumThread] = useState<
    {
      id: string;
      conversation_id: string;
      direction: string;
      channel: string;
      body: string;
      staff_id: string | null;
      staff_full_name: string | null;
      podium_sender_name: string | null;
      created_at: string;
    }[]
  >([]);
  const [podiumThreadLoading, setPodiumThreadLoading] = useState(false);
  const [smsReplyDraft, setSmsReplyDraft] = useState("");
  const [smsReplyBusy, setSmsReplyBusy] = useState(false);
  const appliedInitialHubTab = useRef<string | null>(null);
  const [podiumUrlSaving, setPodiumUrlSaving] = useState(false);
  const [coupleLinkingBusy, setCoupleLinkingBusy] = useState(false);
  /** When true, shows the couple partner selection popover/modal. */
  const [showCouplePicker, setShowCouplePicker] = useState(false);
  const [showCreatePartner, setShowCreatePartner] = useState(false);
  const [partnerDraft, setPartnerDraft] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
  });
  const [duplicateEnqueueBusy, setDuplicateEnqueueBusy] = useState(false);

  useEffect(() => {
    if (!hub) return;
    setPodiumUrlDraft(hub.podium_conversation_url ?? "");
  }, [hub]);

  useEffect(() => {
    if (!open) profileDraftInit.current = false;
  }, [open]);

  useEffect(() => {
    if (tab !== "profile") profileDraftInit.current = false;
  }, [tab]);

  useEffect(() => {
    if (profileDraft.phone.trim() && profileDraft.email.trim()) {
      setHighlightMissingProfileFields(false);
    }
  }, [profileDraft.phone, profileDraft.email]);

  useEffect(() => {
    if (!hub || tab !== "profile" || profileDraftInit.current) return;
    setProfileDraft({
      first_name: hub.first_name ?? "",
      last_name: hub.last_name ?? "",
      email: hub.email ?? "",
      phone: hub.phone ?? "",
      address_line1: hub.address_line1 ?? "",
      address_line2: hub.address_line2 ?? "",
      city: hub.city ?? "",
      state: hub.state ?? "",
      postal_code: hub.postal_code ?? "",
      company_name: hub.company_name ?? "",
      date_of_birth: hub.date_of_birth
        ? String(hub.date_of_birth).slice(0, 10)
        : "",
      anniversary_date: hub.anniversary_date
        ? String(hub.anniversary_date).slice(0, 10)
        : "",
      custom_field_1: hub.custom_field_1 ?? "",
      custom_field_2: hub.custom_field_2 ?? "",
      custom_field_3: hub.custom_field_3 ?? "",
      custom_field_4: hub.custom_field_4 ?? "",
      marketing_email_opt_in: hub.marketing_email_opt_in,
      marketing_sms_opt_in: hub.marketing_sms_opt_in,
      transactional_sms_opt_in: hub.transactional_sms_opt_in ?? false,
      transactional_email_opt_in: hub.transactional_email_opt_in ?? false,
      profile_discount_percent: String(hub.profile_discount_percent ?? "0"),
      tax_exempt: hub.tax_exempt ?? false,
      tax_exempt_id: hub.tax_exempt_id ?? "",
    });
    profileDraftInit.current = true;
  }, [hub, tab]);

  const loadHub = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${baseUrl}/api/customers/${customer.id}/hub`, {
        headers: apiAuth(),
      });
      if (res.ok) {
        setHub((await res.json()) as CustomerHubData);
      } else {
        // Fallback path keeps drawer usable even if /hub stats fail.
        const profileRes = await fetch(
          `${baseUrl}/api/customers/${customer.id}/profile`,
          { headers: apiAuth() },
        );
        if (!profileRes.ok) throw new Error("Could not load customer hub");
        const profile = (await profileRes.json()) as CustomerProfile;
        setHub({
          ...profile,
          is_vip: profile.is_vip ?? false,
          stats: {
            lifetime_spend_usd: "0.00",
            balance_due_usd: "0.00",
            wedding_party_count: profile.weddings.length,
            last_activity_at: null,
            days_since_last_visit: null,
            marketing_needs_attention:
              !profile.marketing_email_opt_in &&
              !profile.marketing_sms_opt_in &&
              !(profile.transactional_sms_opt_in ?? false),
            loyalty_points: 0,
            lifecycle_state: "new",
          },
          partner: null,
          couple_id: null,
          couple_primary_id: null,
          couple_linked_at: null,
        });
      }
    } catch {
      setErr("Could not load this customer profile.");
      setHub(null);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, customer.id, apiAuth]);

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/timeline`,
        {
          headers: apiAuth(),
        },
      );
      if (!res.ok) throw new Error("timeline");
      const data = (await res.json()) as { events: CustomerTimelineEvent[] };
      setTimeline(data.events ?? []);
    } catch {
      setTimeline([]);
    } finally {
      setTimelineLoading(false);
    }
  }, [baseUrl, customer.id, apiAuth]);

  const loadVault = useCallback(async () => {
    setVaultLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/measurements`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("vault");
      setVault(
        (await res.json()) as {
          latest: MeasurementRecord | null;
          history: MeasurementRecord[];
        },
      );
    } catch {
      setVault({ latest: null, history: [] });
    } finally {
      setVaultLoading(false);
    }
  }, [baseUrl, customer.id, apiAuth]);

  const fetchOrderHistoryPage = useCallback(
    async (
      offset: number,
      from: string,
      to: string,
      recordScope: "transactions" | "orders",
    ) => {
      const p = new URLSearchParams();
      p.set("limit", String(ORDER_HISTORY_PAGE));
      p.set("offset", String(offset));
      p.set("record_scope", recordScope);
      if (from.trim()) p.set("from", from.trim());
      if (to.trim()) p.set("to", to.trim());
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/transaction-history?${p}`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("transaction-history");
      return (await res.json()) as {
        items: CustomerOrderHistoryItem[];
        total_count: number;
      };
    },
    [baseUrl, customer.id, apiAuth],
  );

  const loadOrderHistoryFirstPage = useCallback(async () => {
    setOrderHistoryLoading(true);
    const { from, to } = ordersFilterRef.current;
    const recordScope: "transactions" | "orders" =
      tab === "orders" ? "orders" : "transactions";
    try {
      const data = await fetchOrderHistoryPage(0, from, to, recordScope);
      setOrderHistoryRows(data.items);
      setOrderHistoryTotal(data.total_count);
    } catch {
      setOrderHistoryRows([]);
      setOrderHistoryTotal(0);
      toast("Could not load order history.", "error");
    } finally {
      setOrderHistoryLoading(false);
    }
  }, [fetchOrderHistoryPage, tab, toast]);

  const loadMoreOrderHistory = useCallback(async () => {
    if (orderHistoryRows.length >= orderHistoryTotal) return;
    setOrderHistoryMoreBusy(true);
    const { from, to } = ordersFilterRef.current;
    const recordScope: "transactions" | "orders" =
      tab === "orders" ? "orders" : "transactions";
    try {
      const data = await fetchOrderHistoryPage(
        orderHistoryRows.length,
        from,
        to,
        recordScope,
      );
      setOrderHistoryRows((prev) => [...prev, ...data.items]);
    } catch {
      toast("Could not load more orders.", "error");
    } finally {
      setOrderHistoryMoreBusy(false);
    }
  }, [
    fetchOrderHistoryPage,
    orderHistoryRows.length,
    orderHistoryTotal,
    tab,
    toast,
  ]);

  const loadCustomerAlterations = useCallback(async () => {
    setCustomerAlterationsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("customer_id", customer.id);
      const term = customerAlterationsSearch.trim();
      if (term) params.set("search", term);
      const res = await fetch(`${baseUrl}/api/alterations?${params}`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("alterations");
      setCustomerAlterations((await res.json()) as CustomerAlterationSummary[]);
    } catch {
      setCustomerAlterations([]);
      toast("Could not load customer alterations.", "error");
    } finally {
      setCustomerAlterationsLoading(false);
    }
  }, [apiAuth, baseUrl, customer.id, customerAlterationsSearch, toast]);

  const loadOpenSummary = useCallback(async () => {
    try {
      const ordersParams = new URLSearchParams({
        customer_id: customer.id,
        status_scope: "open",
        limit: "1",
      });
      const layawayParams = new URLSearchParams({
        customer_id: customer.id,
        kind_filter: "layaway",
        show_closed: "false",
        limit: "1",
      });
      const alterationsParams = new URLSearchParams({
        customer_id: customer.id,
      });
      const [ordersRes, layawaysRes, alterationsRes] = await Promise.all([
        fetch(`${baseUrl}/api/transactions?${ordersParams}`, {
          headers: apiAuth(),
        }),
        fetch(`${baseUrl}/api/transactions?${layawayParams}`, {
          headers: apiAuth(),
        }),
        fetch(`${baseUrl}/api/alterations?${alterationsParams}`, {
          headers: apiAuth(),
        }),
      ]);
      const orders = ordersRes.ok
        ? ((await ordersRes.json()) as { total_count?: number }).total_count ?? null
        : null;
      const layaways = layawaysRes.ok
        ? ((await layawaysRes.json()) as { total_count?: number }).total_count ?? null
        : null;
      const alterations = alterationsRes.ok
        ? ((await alterationsRes.json()) as CustomerAlterationSummary[]).filter((row) =>
            isOpenAlterationStatus(row.status),
          ).length
        : null;
      setOpenSummary({ orders, layaways, alterations });
    } catch {
      setOpenSummary({ orders: null, layaways: null, alterations: null });
    }
  }, [apiAuth, baseUrl, customer.id]);

  const loadLoyaltyActivity = useCallback(async () => {
    setLoyaltyLoading(true);
    try {
      const ledgerRes = await fetch(
        `${baseUrl}/api/loyalty/ledger?customer_id=${encodeURIComponent(customer.id)}`,
        { headers: apiAuth() },
      );
      const ledger = ledgerRes.ok
        ? ((await ledgerRes.json()) as LoyaltyLedgerEntry[])
        : [];
      setLoyaltyLedger(Array.isArray(ledger) ? ledger : []);

      const issuancesRes = await fetch(`${baseUrl}/api/loyalty/recent-issuances`, {
        headers: apiAuth(),
      });
      const allIssuances = issuancesRes.ok
        ? ((await issuancesRes.json()) as LoyaltyIssuanceRow[])
        : [];
      const customerIds = new Set(
        [customer.id, hub?.id, hub?.couple_primary_id].filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ),
      );
      const issuances = Array.isArray(allIssuances)
        ? allIssuances.filter((row) => customerIds.has(row.customer_id))
        : [];
      setLoyaltyIssuances(issuances);

      const cardsWithCodes = issuances
        .map((row) => ({
          issuanceId: row.id,
          cardCode: row.card_code?.trim() ?? "",
        }))
        .filter((row) => row.cardCode.length > 0);
      const cardActivity = await Promise.all(
        cardsWithCodes.map(async (card) => {
          try {
            const res = await fetch(
              `${baseUrl}/api/gift-cards/code/${encodeURIComponent(card.cardCode)}/events`,
              { headers: apiAuth() },
            );
            const events = res.ok
              ? ((await res.json()) as LoyaltyGiftCardEvent[])
              : [];
            return { ...card, events: Array.isArray(events) ? events : [] };
          } catch {
            return { ...card, events: [] };
          }
        }),
      );
      setLoyaltyCardActivity(cardActivity);
    } catch {
      setLoyaltyLedger([]);
      setLoyaltyIssuances([]);
      setLoyaltyCardActivity([]);
    } finally {
      setLoyaltyLoading(false);
    }
  }, [apiAuth, baseUrl, customer.id, hub?.couple_primary_id, hub?.id]);

  useEffect(() => {
    if (
      !open ||
      (tab !== "orders" && tab !== "transactions") ||
      !permissionsLoaded ||
      !canOrdersView
    )
      return;
    void loadOrderHistoryFirstPage();
  }, [
    open,
    tab,
    customer.id,
    loadOrderHistoryFirstPage,
    permissionsLoaded,
    canOrdersView,
  ]);

  useEffect(() => {
    if (!open || tab !== "alterations" || !permissionsLoaded || !canAlterationsView) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadCustomerAlterations();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [
    open,
    tab,
    permissionsLoaded,
    canAlterationsView,
    loadCustomerAlterations,
  ]);

  useEffect(() => {
    if (!open) {
      setErr(null);
      setHubShipmentFocusId(null);
      setOpenSummary({ orders: null, layaways: null, alterations: null });
      setLoyaltyLedger([]);
      setLoyaltyIssuances([]);
      setLoyaltyCardActivity([]);
      return;
    }
    if (!permissionsLoaded) {
      setLoading(true);
      return;
    }
    if (!canHubView) {
      setLoading(false);
      setHub(null);
      setErr("Manager access is needed to open this customer profile.");
      setTimeline([]);
      setTimelineLoading(false);
      setTab("profile");
      setNoteDraft("");
      return;
    }
    setErr(null);
    void loadHub();
    if (canTimeline) {
      void loadTimeline();
    } else {
      setTimeline([]);
      setTimelineLoading(false);
    }
    void loadOpenSummary();
    setNoteDraft("");
    setHubShipmentFocusId(null);
  }, [
    open,
    customer.id,
    permissionsLoaded,
    canHubView,
    canTimeline,
    loadHub,
    loadTimeline,
    loadOpenSummary,
  ]);

  useEffect(() => {
    if (!open || !permissionsLoaded || !canHubView) {
      if (!open) {
        setStoreCreditBal(null);
        setOpenDepositBal(null);
      }
      return;
    }
    void (async () => {
      try {
        const [scRes, odRes] = await Promise.all([
          fetch(`${baseUrl}/api/customers/${customer.id}/store-credit`, {
            headers: apiAuth(),
          }),
          fetch(`${baseUrl}/api/customers/${customer.id}/open-deposit`, {
            headers: apiAuth(),
          }),
        ]);
        if (!scRes.ok) {
          setStoreCreditBal(null);
        } else {
          const d = (await scRes.json()) as { balance?: string };
          setStoreCreditBal(d.balance != null ? String(d.balance) : "0.00");
        }
        if (!odRes.ok) {
          setOpenDepositBal(null);
        } else {
          const d = (await odRes.json()) as { balance?: string };
          setOpenDepositBal(d.balance != null ? String(d.balance) : "0.00");
        }
      } catch {
        setStoreCreditBal(null);
        setOpenDepositBal(null);
      }
    })();
  }, [open, customer.id, baseUrl, apiAuth, permissionsLoaded, canHubView]);

  useEffect(() => {
    if (!open || tab !== "measurements" || !canMeasurements) return;
    void loadVault();
  }, [open, tab, loadVault, canMeasurements]);

  useEffect(() => {
    if (!permissionsLoaded) return;
    if (tab === "transactions" && !canOrdersView) setTab("profile");
    if (tab === "orders" && !canOrdersView) setTab("profile");
    if (tab === "layaways" && !canOrdersView) setTab("profile");
    if (tab === "shipments" && !canShipmentsView) setTab("profile");
    if (tab === "measurements" && !canMeasurements) setTab("profile");
    if (tab === "alterations" && !canAlterationsView) setTab("profile");
  }, [
    permissionsLoaded,
    tab,
    canOrdersView,
    canShipmentsView,
    canMeasurements,
    canAlterationsView,
  ]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const r = await fetch(`${baseUrl}/api/sessions/current`, {
          headers: apiAuth(),
        });
        if (r.ok) {
          const s = (await r.json()) as { register_primary_staff_id?: string };
          setActorStaffId(s.register_primary_staff_id ?? null);
        } else setActorStaffId(null);
      } catch {
        setActorStaffId(null);
      }
    })();
  }, [open, baseUrl, apiAuth]);

  useEffect(() => {
    if (!open) {
      appliedInitialHubTab.current = null;
      return;
    }
    const marker = `${customer.id}:${initialHubTab ?? ""}`;
    if (initialHubTab && appliedInitialHubTab.current !== marker) {
      setTab(
        initialHubTab === "relationship"
          ? "profile"
          : initialHubTab === "messages"
            ? "transactions"
            : initialHubTab,
      );
      appliedInitialHubTab.current = marker;
    }
  }, [open, customer.id, initialHubTab]);

  const loadPodiumThread = useCallback(async () => {
    setPodiumThreadLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/podium/messages`,
        { headers: apiAuth() },
      );
      if (!res.ok) {
        setPodiumThread([]);
        return;
      }
      const data = (await res.json()) as typeof podiumThread;
      setPodiumThread(Array.isArray(data) ? data : []);
    } catch {
      setPodiumThread([]);
    } finally {
      setPodiumThreadLoading(false);
    }
  }, [baseUrl, customer.id, apiAuth]);

  useEffect(() => {
    if (!open || tab !== "messages") return;
    void loadPodiumThread();
  }, [open, tab, loadPodiumThread]);

  useEffect(() => {
    if (!open || tab !== "loyalty" || !permissionsLoaded || !canHubView || !hub) {
      return;
    }
    void loadLoyaltyActivity();
  }, [
    open,
    tab,
    permissionsLoaded,
    canHubView,
    hub,
    loadLoyaltyActivity,
  ]);

  const title = hub
    ? `${hub.first_name} ${hub.last_name}`.trim()
    : `${customer.first_name} ${customer.last_name}`.trim();
  const subtitle = hub
    ? [hub.customer_code, hub.phone ?? hub.email].filter(Boolean).join(" · ")
    : [customer.customer_code, customer.phone ?? customer.email]
        .filter(Boolean)
        .join(" · ") || "Customer";

  const balanceDue = hub
    ? parseMoneyToCents(hub.stats.balance_due_usd) > 0
    : false;
  const showHubSummary = tab === "profile";
  const missingProfileFields = {
    phone: !profileDraft.phone.trim(),
    email: !profileDraft.email.trim(),
  };
  const profileMissingHint =
    missingProfileFields.phone && missingProfileFields.email
      ? "Add phone and email to complete this profile."
      : missingProfileFields.phone
        ? "Add phone to complete this profile."
        : missingProfileFields.email
          ? "Add email to complete this profile."
          : "";

  const openHubStatTarget = (target: HubTab | "profile_missing") => {
    if (target === "profile_missing") {
      setTab("profile");
      setHighlightMissingProfileFields(true);
      return;
    }
    setHighlightMissingProfileFields(false);
    setTab(target);
  };

  const savePodiumConversationUrl = async () => {
    if (!canHubEdit) return;
    setPodiumUrlSaving(true);
    try {
      const trimmed = podiumUrlDraft.trim();
      const ok = await patchCustomer({
        podium_conversation_url: trimmed.length > 0 ? trimmed : null,
      });
      if (ok) toast("Podium conversation link saved", "success");
    } finally {
      setPodiumUrlSaving(false);
    }
  };

  const sendPodiumEmail = async () => {
    if (!canHubEdit || !hub?.email) return;
    const sub = podiumComposeSubject.trim();
    const html = podiumComposeHtml.trim();
    if (!sub || !html) {
      toast("Subject and message body are required.", "error");
      return;
    }
    setPodiumComposeBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/podium/email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ subject: sub, html_body: html }),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not send email. Try again.", "error");
        return;
      }
      toast("Email sent via Podium", "success");
      setPodiumComposeSubject("");
      setPodiumComposeHtml("");
      void loadPodiumThread();
    } finally {
      setPodiumComposeBusy(false);
    }
  };

  const sendPodiumSmsReply = async () => {
    if (!canHubEdit) return;
    const t = smsReplyDraft.trim();
    if (!t) {
      toast("Enter an SMS reply.", "error");
      return;
    }
    setSmsReplyBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/podium/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ channel: "sms", body: t }),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not send SMS. Try again.", "error");
        return;
      }
      toast("SMS sent via Podium", "success");
      setSmsReplyDraft("");
      void loadPodiumThread();
    } finally {
      setSmsReplyBusy(false);
    }
  };

  const patchCustomer = async (
    patch: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!canHubEdit) return false;
    const res = await fetch(`${baseUrl}/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...apiAuth() },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      toast("Could not save customer changes. Try again.", "error");
      return false;
    }
    await loadHub();
    return true;
  };

  const saveProfileDetails = async () => {
    if (!canHubEdit) return;
    const profileDiscount = Number.parseFloat(profileDraft.profile_discount_percent || "0");
    if (!Number.isFinite(profileDiscount) || profileDiscount < 0 || profileDiscount > 100) {
      toast("Profile discount must be between 0 and 100 percent", "error");
      return;
    }
    if (profileDraft.tax_exempt && !profileDraft.tax_exempt_id.trim()) {
      toast("Enter the tax ID before marking this customer tax exempt", "error");
      return;
    }
    setProfileSaving(true);
    try {
      const body: Record<string, unknown> = {
        first_name: profileDraft.first_name.trim(),
        last_name: profileDraft.last_name.trim(),
        email: profileDraft.email.trim() || null,
        phone: profileDraft.phone.trim() || null,
        address_line1: profileDraft.address_line1.trim() || null,
        address_line2: profileDraft.address_line2.trim() || null,
        city: profileDraft.city.trim() || null,
        state: profileDraft.state.trim() || null,
        postal_code: profileDraft.postal_code.trim() || null,
        company_name: profileDraft.company_name.trim() || null,
        custom_field_1: profileDraft.custom_field_1.trim() || null,
        custom_field_2: profileDraft.custom_field_2.trim() || null,
        custom_field_3: profileDraft.custom_field_3.trim() || null,
        custom_field_4: profileDraft.custom_field_4.trim() || null,
        marketing_email_opt_in: profileDraft.marketing_email_opt_in,
        marketing_sms_opt_in: profileDraft.marketing_sms_opt_in,
        transactional_sms_opt_in: profileDraft.transactional_sms_opt_in,
        transactional_email_opt_in: profileDraft.transactional_email_opt_in,
        profile_discount_percent: profileDiscount.toFixed(2),
        tax_exempt: profileDraft.tax_exempt,
        tax_exempt_id: profileDraft.tax_exempt ? profileDraft.tax_exempt_id.trim() : null,
      };
      const dob = profileDraft.date_of_birth.trim();
      const ann = profileDraft.anniversary_date.trim();
      if (dob) body.date_of_birth = dob;
      if (ann) body.anniversary_date = ann;
      const res = await fetch(`${baseUrl}/api/customers/${customer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not save profile details. Try again.", "error");
        return;
      }
      const row = (await res.json()) as {
        first_name: string;
        last_name: string;
        email: string | null;
        phone: string | null;
        address_line1: string | null;
        address_line2: string | null;
        city: string | null;
        state: string | null;
        postal_code: string | null;
        company_name: string | null;
        date_of_birth: string | null;
        anniversary_date: string | null;
        custom_field_1: string | null;
        custom_field_2: string | null;
        custom_field_3: string | null;
        custom_field_4: string | null;
        marketing_email_opt_in: boolean;
        marketing_sms_opt_in: boolean;
        transactional_sms_opt_in: boolean | null;
        transactional_email_opt_in: boolean | null;
        profile_discount_percent?: string | number | null;
        tax_exempt?: boolean | null;
        tax_exempt_id?: string | null;
      };
      setProfileDraft({
        first_name: row.first_name ?? "",
        last_name: row.last_name ?? "",
        email: row.email ?? "",
        phone: row.phone ?? "",
        address_line1: row.address_line1 ?? "",
        address_line2: row.address_line2 ?? "",
        city: row.city ?? "",
        state: row.state ?? "",
        postal_code: row.postal_code ?? "",
        company_name: row.company_name ?? "",
        date_of_birth: row.date_of_birth
          ? String(row.date_of_birth).slice(0, 10)
          : "",
        anniversary_date: row.anniversary_date
          ? String(row.anniversary_date).slice(0, 10)
          : "",
        custom_field_1: row.custom_field_1 ?? "",
        custom_field_2: row.custom_field_2 ?? "",
        custom_field_3: row.custom_field_3 ?? "",
        custom_field_4: row.custom_field_4 ?? "",
        marketing_email_opt_in: row.marketing_email_opt_in,
        marketing_sms_opt_in: row.marketing_sms_opt_in,
        transactional_sms_opt_in: row.transactional_sms_opt_in ?? false,
        transactional_email_opt_in: row.transactional_email_opt_in ?? false,
        profile_discount_percent: String(row.profile_discount_percent ?? "0"),
        tax_exempt: row.tax_exempt ?? false,
        tax_exempt_id: row.tax_exempt_id ?? "",
      });
      toast("Profile details saved", "success");
      await loadHub();
    } finally {
      setProfileSaving(false);
    }
  };

  const linkCouple = async (partner: Customer) => {
    if (!hasPermission("customers.couple_manage")) return;
    setCoupleLinkingBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/couple-link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ partner_id: partner.id }),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not link these customer profiles.", "error");
        return;
      }
      toast("Joint couple account created", "success");
      setShowCouplePicker(false);
      await loadHub();
    } catch {
      toast("Error linking accounts", "error");
    } finally {
      setCoupleLinkingBusy(false);
    }
  };

  const unlinkCouple = async () => {
    if (!hasPermission("customers.couple_manage")) return;
    if (
      !confirm(
        "Unlink these accounts? Sales history will remain with the primary account.",
      )
    )
      return;
    setCoupleLinkingBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/couple-link`,
        {
          method: "DELETE",
          headers: apiAuth(),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not unlink these customer profiles.", "error");
        return;
      }
      toast("Accounts unlinked", "success");
      await loadHub();
    } catch {
      toast("Error unlinking accounts", "error");
    } finally {
      setCoupleLinkingBusy(false);
    }
  };

  const createAndLinkPartner = async () => {
    if (!hasPermission("customers.couple_manage")) return;
    const { first_name, last_name } = partnerDraft;
    if (!first_name.trim() || !last_name.trim()) {
      toast("Partner first and last name are required.", "error");
      return;
    }
    setCoupleLinkingBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/couple-link-new`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify(partnerDraft),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not create and link this partner profile.", "error");
        return;
      }
      toast("New partner created and linked", "success");
      setShowCreatePartner(false);
      setPartnerDraft({ first_name: "", last_name: "", email: "", phone: "" });
      await loadHub();
    } catch {
      toast("Error creating partner", "error");
    } finally {
      setCoupleLinkingBusy(false);
    }
  };

  const enqueueDuplicateReviewPair = async (other: Customer) => {
    if (other.id === customer.id) {
      toast("Select a different customer than this profile.", "error");
      return;
    }
    setDuplicateEnqueueBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/duplicate-review-queue/enqueue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({
            customer_a_id: customer.id,
            customer_b_id: other.id,
          }),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not add possible duplicate.", "error");
        return;
      }
      toast("Possible duplicate added for review.", "success");
    } catch {
      toast("Could not add possible duplicate.", "error");
    } finally {
      setDuplicateEnqueueBusy(false);
    }
  };

  const postNote = async () => {
    if (!canTimeline) return;
    const t = noteDraft.trim();
    if (!t) return;
    setNoteSaving(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/${customer.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          body: t,
          created_by_staff_id: actorStaffId,
        }),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not save note.", "error");
        return;
      }
      toast("Note added to timeline", "success");
      setNoteDraft("");
      await loadTimeline();
      await loadHub();
    } finally {
      setNoteSaving(false);
    }
  };

  useEffect(() => {
    setMeasDraft(measurementDraftFromLatest(vault?.latest ?? null));
  }, [vault?.latest]);

  const saveMeasurements = async () => {
    if (!canMeasurements) return;
    setMeasSaving(true);
    try {
      const body = serializeMeasurementPatch(measDraft);
      if (Object.keys(body).length === 0) {
        toast("Enter at least one measurement to save", "info");
        return;
      }
      const res = await fetch(
        `${baseUrl}/api/customers/${customer.id}/measurements`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not save measurements. Try again.", "error");
        return;
      }
      toast("Measurements saved", "success");
      await loadVault();
    } finally {
      setMeasSaving(false);
    }
  };

  const printMeasurements = () => {
    const w = window.open("", "_blank");
    if (!w || !printRef.current) return;
    w.document.write(
      `<html><head><title>Measurements — ${title}</title></head><body>${printRef.current.innerHTML}</body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
    w.close();
  };

  const tabBtn = (id: HubTab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors ${
        tab === id
          ? "bg-app-accent text-white"
          : "bg-app-surface-2 text-app-text-muted hover:text-app-text"
      }`}
    >
      {label}
    </button>
  );

  const weddings: WeddingMembership[] = hub?.weddings ?? [];
  const activeWedding = weddings.find((w) => w.active);
  const pastWeddings = weddings.filter((w) => !w.active);
  const loyaltyEarnedPoints = loyaltyLedger
    .filter((row) => row.delta_points > 0)
    .reduce((sum, row) => sum + row.delta_points, 0);
  const loyaltyUsedPoints = loyaltyLedger
    .filter((row) => row.delta_points < 0)
    .reduce((sum, row) => sum + Math.abs(row.delta_points), 0);
  const loyaltyRewardCardsUsed = loyaltyCardActivity.reduce(
    (sum, card) =>
      sum + card.events.filter((event) => event.event_kind === "redeemed").length,
    0,
  );

  const kindDot = useMemo(
    () =>
      ({
        sale: "bg-emerald-500",
        payment: "bg-sky-500",
        wedding: "bg-app-accent",
        note: "bg-amber-500",
        measurement: "bg-violet-500",
        appointment: "bg-indigo-500",
        shipping: "bg-teal-500",
      }) as Record<string, string>,
    [],
  );
  const linkedPartnerName = hub?.partner
    ? `${hub.partner.first_name} ${hub.partner.last_name}`.trim() ||
      hub.partner.customer_code
    : "";
  const currentProfileRole =
    hub && hub.couple_id
      ? hub.id === hub.couple_primary_id
        ? "Parent profile"
        : "Linked profile"
      : null;

  if (!open) return null;

  return (
    <DetailDrawer
      isOpen={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      panelMaxClassName={panelMaxClassName}
      titleClassName="!normal-case !tracking-tight"
      actions={
        <div className="flex flex-wrap gap-2">
          {tabBtn("profile", "Profile")}
          {canOrdersView ? tabBtn("transactions", "History") : null}
          {canOrdersView ? tabBtn("orders", "Orders") : null}
          {canOrdersView ? tabBtn("layaways", "Layaways") : null}
          {canAlterationsView ? tabBtn("alterations", "Alterations") : null}
          {tabBtn("loyalty", "Loyalty")}
          {canMeasurements ? tabBtn("measurements", "Measurements") : null}
          {tabBtn("weddings", "Weddings")}
        </div>
      }
    >
      {tab === "transactions" || tab === "orders" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <h3 className="mb-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
              <Receipt size={14} aria-hidden />
              {tab === "transactions" ? "History" : "Orders"}
            </h3>
            <p className="mb-3 text-xs text-app-text-muted">
              {tab === "transactions"
                ? "Customer notes, visits, and past purchases when available."
                : "Open and recent special orders, custom work, and wedding items for this customer."}{" "}
              Showing {customer.first_name} {customer.last_name} ·{" "}
              {customer.customer_code}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                From
                <input
                  type="date"
                  value={ordersDateFrom}
                  onChange={(e) => setOrdersDateFrom(e.target.value)}
                  className="ui-input mt-1 block px-2 py-1.5 font-sans text-xs"
                />
              </label>
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                To
                <input
                  type="date"
                  value={ordersDateTo}
                  onChange={(e) => setOrdersDateTo(e.target.value)}
                  className="ui-input mt-1 block px-2 py-1.5 font-sans text-xs"
                />
              </label>
              <button
                type="button"
                onClick={() => void loadOrderHistoryFirstPage()}
                className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                Apply range
              </button>
            </div>
          </div>

          {tab === "transactions" ? (
            <section className="rounded-2xl border border-app-border bg-app-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Interaction timeline
                </h3>
                {canTimeline && timeline.length > 0 ? (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                    Newest first
                  </p>
                ) : null}
              </div>
              {!canTimeline ? (
                <p className="text-sm text-app-text-muted">
                  Manager access is needed to view this customer&apos;s notes and visits.
                </p>
              ) : timelineLoading ? (
                <p className="text-sm text-app-text-muted">
                  Loading customer interactions…
                </p>
              ) : timeline.length === 0 ? (
                <p className="text-sm text-app-text-muted">
                  No customer interactions recorded yet.
                </p>
              ) : (
                <ul className="space-y-0">
                  {timeline.map((ev, i) => (
                    <li
                      key={`${ev.at}-${i}`}
                      className="grid grid-cols-[14px_1fr] gap-3 pb-5 last:pb-0"
                    >
                      <span
                        className={`mt-1.5 h-3 w-3 rounded-full border-2 border-app-surface shadow-sm ${
                          kindDot[ev.kind] ?? "bg-app-text-muted"
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          {readableDateTime(ev.at)} ·{" "}
                          {customerTimelineKindLabel(ev.kind)}
                        </p>
                        {ev.kind === "shipping" &&
                        ev.reference_type === "shipment" &&
                        ev.reference_id &&
                        canShipmentsView ? (
                          <button
                            type="button"
                            className="mt-1 w-full text-left text-sm font-semibold text-app-accent hover:underline"
                            onClick={() => {
                              setHubShipmentFocusId(ev.reference_id!);
                              setTab("shipments");
                            }}
                          >
                            {ev.summary}
                          </button>
                        ) : (
                          <p className="mt-1 text-sm font-semibold text-app-text">
                            {ev.summary}
                          </p>
                        )}
                        {ev.wedding_party_id ? (
                          <button
                            type="button"
                            className="mt-2 text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                            onClick={() => {
                              onOpenWeddingParty(ev.wedding_party_id!);
                              onClose();
                            }}
                          >
                            Open wedding
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {orderHistoryLoading && orderHistoryRows.length === 0 ? (
            <p className="text-sm text-app-text-muted">
              Loading {tab === "transactions" ? "history" : "orders"}…
            </p>
          ) : null}

          {orderHistoryRows.length === 0 && !orderHistoryLoading ? (
            <p className="text-sm text-app-text-muted">
              No {tab === "transactions" ? "history" : "orders"} in this
              range.
            </p>
          ) : null}

          {orderHistoryRows.length > 0 ? (
            isCompactHub ? (
              <div className="space-y-2">
                {orderHistoryRows.map((row) => (
                  <article
                    key={row.transaction_id}
                    className="rounded-xl border border-app-border bg-app-surface p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-black text-app-text">
                          {row.transaction_display_id}
                        </p>
                        <p className="mt-1 text-[11px] text-app-text-muted">
                          {readableDateTime(row.booked_at)}
                        </p>
                      </div>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {transactionStatusLabel(row.status)}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <p>
                        <span className="font-black text-app-text-muted">Channel:</span>{" "}
                        {saleChannelLabel(row.sale_channel)}
                      </p>
                      <p className="text-right tabular-nums">
                        <span className="font-black text-app-text-muted">Lines:</span>{" "}
                        {row.item_count}
                      </p>
                      <p className="font-mono tabular-nums">
                        <span className="font-black text-app-text-muted">Total:</span>{" "}
                        {fmtMoney(row.total_price)}
                      </p>
                      <p className="text-right font-mono tabular-nums">
                        <span className="font-black text-app-text-muted">Paid:</span>{" "}
                        {fmtMoney(row.amount_paid)}
                      </p>
                      <p className="font-mono tabular-nums">
                        <span className="font-black text-app-text-muted">Balance:</span>{" "}
                        {fmtMoney(row.balance_due)}
                      </p>
                      <p className="truncate text-right">
                        <span className="font-black text-app-text-muted">Salesperson:</span>{" "}
                        {row.primary_salesperson_name ?? "—"}
                      </p>
                    </div>
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTransactionId(row.transaction_id);
                        }}
                        className="min-h-11 rounded-lg border border-app-success/20 bg-app-success/10 px-3 py-2 text-xs font-black uppercase tracking-wide text-app-success"
                      >
                        {tab === "transactions" ? "Open Transaction" : "Open Order"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-app-border">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    <tr>
                      <th className="px-3 py-2">Booked</th>
                      <th className="px-3 py-2">
                          {tab === "transactions" ? "Transaction" : "Order"}
                      </th>
                      <th className="px-3 py-2">Channel</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Paid</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                      <th className="px-3 py-2 text-right">Lines</th>
                      <th className="px-3 py-2">Salesperson</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border/60">
                    {orderHistoryRows.map((row) => (
                      <tr
                        key={row.transaction_id}
                        className="hover:bg-app-surface-2/50"
                      >
                        <td className="px-3 py-2 text-xs text-app-text-muted">
                          {readableDateTime(row.booked_at)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <div className="flex items-center gap-2">
                            <span>{row.transaction_display_id}</span>
                            {row.is_counterpoint_import ? (
                              <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-zinc-600">
                                Imported from Counterpoint
                              </span>
                            ) : null}
                          </div>
                          {row.counterpoint_customer_code ? (
                            <div className="mt-1 text-[9px] font-bold text-app-text-muted">
                              Counterpoint customer {row.counterpoint_customer_code}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">
                          {saleChannelLabel(row.sale_channel)}
                        </td>
                        <td className="px-3 py-2 text-xs font-semibold">
                          {transactionStatusLabel(row.status)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {fmtMoney(row.total_price)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-app-text-muted">
                          {fmtMoney(row.amount_paid)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {fmtMoney(row.balance_due)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.item_count}
                        </td>
                        <td className="px-3 py-2 text-xs text-app-text-muted">
                          {row.primary_salesperson_name ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTransactionId(row.transaction_id);
                            }}
                            className="rounded-lg border border-app-success/20 bg-app-success/10 px-2 py-1 text-[10px] font-black uppercase tracking-tight text-app-success"
                          >
                            {tab === "transactions"
                              ? "Open Transaction"
                              : "Open Order"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          {orderHistoryRows.length > 0 &&
          orderHistoryRows.length < orderHistoryTotal ? (
            <button
              type="button"
              disabled={orderHistoryMoreBusy}
              onClick={() => void loadMoreOrderHistory()}
              className="w-full rounded-xl border border-app-border py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 disabled:opacity-50"
            >
              {orderHistoryMoreBusy ? "Loading…" : "Load more"}
            </button>
          ) : null}

          {orderHistoryRows.length > 0 ? (
            <p className="text-center text-[11px] text-app-text-muted">
              Showing {orderHistoryRows.length} of {orderHistoryTotal}{" "}
              {tab === "transactions" ? "history records" : "orders"}
            </p>
          ) : null}
        </div>
      ) : tab === "shipments" ? (
        <div className="flex min-h-[320px] flex-1 flex-col">
          <ShipmentsHubSection
            baseUrl={baseUrl}
            customerIdFilter={customer.id}
            embedded
            openShipmentId={hubShipmentFocusId}
            onOpenShipmentIdConsumed={onHubShipmentFocusConsumed}
          />
        </div>
      ) : tab === "layaways" ? (
        <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-2xl border border-app-border">
          <LayawayWorkspace
            customerId={customer.id}
            embedded
            onOpenTransaction={(transactionId) => setSelectedTransactionId(transactionId)}
          />
        </div>
      ) : tab === "alterations" ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  <Scissors size={14} aria-hidden />
                  Customer alterations
                </h3>
                <p className="mt-1 text-xs text-app-text-muted">
                  Open and recent garment work for {customer.first_name}{" "}
                  {customer.last_name}. Intake still starts in Register.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadCustomerAlterations()}
                className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                Refresh
              </button>
            </div>
            <div className="relative mt-3">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
                aria-hidden
              />
              <input
                value={customerAlterationsSearch}
                onChange={(event) =>
                  setCustomerAlterationsSearch(event.target.value)
                }
                className="ui-input w-full rounded-xl py-2 pl-9 text-sm"
                placeholder="Search garment, work, notes, SKU, phone..."
                aria-label="Search customer alterations"
              />
            </div>
          </section>

          {customerAlterationsLoading && customerAlterations.length === 0 ? (
            <p className="text-sm text-app-text-muted">
              Loading alterations…
            </p>
          ) : null}

          {!customerAlterationsLoading && customerAlterations.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-app-border bg-app-surface-2/70 p-4 text-sm text-app-text-muted">
              No alteration work found for this customer.
            </p>
          ) : null}

          {customerAlterations.length > 0 ? (
            <div className="space-y-2">
              {customerAlterations.map((row) => (
                <div
                  key={row.id}
                  className="rounded-2xl border border-app-border bg-app-surface p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {alterationStatusLabel(row.status)}
                        </span>
                        <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {alterationSourceLabel(row.source_type)}
                        </span>
                        {row.charge_amount != null &&
                        Number(row.charge_amount) > 0 ? (
                          <span className="rounded-lg border border-app-warning/20 bg-app-warning/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-warning">
                            Charge noted {fmtMoney(row.charge_amount)}
                          </span>
                        ) : (
                          <span className="rounded-lg border border-app-success/20 bg-app-success/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-success">
                            Free / included
                          </span>
                        )}
                      </div>
                      <p className="break-words text-sm font-black text-app-text">
                        {row.item_description || "Garment not specified"}
                      </p>
                      <p className="mt-1 break-words text-sm font-semibold text-app-text-muted">
                        {row.work_requested || "Work details not specified"}
                      </p>
                      {row.notes ? (
                        <p className="mt-2 break-words rounded-xl border border-app-border/60 bg-app-surface-2 px-3 py-2 text-xs italic text-app-text-muted">
                          {row.notes}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                      <p>Due {shortDate(row.due_at)}</p>
                      {row.linked_transaction_display_id ? (
                        <p className="mt-1 font-mono">
                          {row.linked_transaction_display_id}
                        </p>
                      ) : null}
                      {row.source_sku ? (
                        <p className="mt-1 font-mono">SKU {row.source_sku}</p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : tab === "loyalty" ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  <Gift size={14} aria-hidden />
                  Loyalty
                </h3>
                <p className="mt-1 text-xs text-app-text-muted">
                  Points earned, reward cards issued, and reward cards used.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadLoyaltyActivity()}
                className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                Refresh
              </button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Current points", `${(hub?.stats.loyalty_points ?? 0).toLocaleString()} pts`],
                ["Historical earned", `${loyaltyEarnedPoints.toLocaleString()} pts`],
                ["Points used", `${loyaltyUsedPoints.toLocaleString()} pts`],
                ["Rewards issued", String(loyaltyIssuances.length)],
                ["Reward card uses", String(loyaltyRewardCardsUsed)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-app-border bg-app-surface px-3 py-2"
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
          </section>

          {loyaltyLoading ? (
            <p className="text-sm text-app-text-muted">
              Loading loyalty history…
            </p>
          ) : null}

          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <h3 className="mb-3 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
              Points history
            </h3>
            {loyaltyLedger.length === 0 && !loyaltyLoading ? (
              <p className="text-sm text-app-text-muted">
                No loyalty point activity recorded yet.
              </p>
            ) : (
              <div className="space-y-2">
                {loyaltyLedger.map((row) => (
                  <article
                    key={row.id}
                    className="rounded-xl border border-app-border bg-app-surface-2/70 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-app-text">
                          {row.activity_label}
                        </p>
                        <p className="mt-1 text-xs text-app-text-muted">
                          {row.activity_detail}
                        </p>
                        {row.transaction_display_id ? (
                          <p className="mt-1 font-mono text-[10px] font-bold text-app-text-muted">
                            {row.transaction_display_id}
                          </p>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <p
                          className={`text-sm font-black tabular-nums ${
                            row.delta_points >= 0 ? "text-app-success" : "text-app-danger"
                          }`}
                        >
                          {row.delta_points > 0 ? "+" : ""}
                          {row.delta_points.toLocaleString()} pts
                        </p>
                        <p className="mt-1 text-[10px] font-bold text-app-text-muted">
                          {readableDateTime(row.created_at)}
                        </p>
                        <p className="mt-1 text-[10px] font-bold text-app-text-muted">
                          Balance {row.balance_after.toLocaleString()} pts
                        </p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <h3 className="mb-3 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
              Loyalty gift cards
            </h3>
            {loyaltyIssuances.length === 0 && !loyaltyLoading ? (
              <p className="text-sm text-app-text-muted">
                No loyalty reward cards issued for this customer yet.
              </p>
            ) : (
              <div className="space-y-3">
                {loyaltyIssuances.map((issuance) => {
                  const cardEvents =
                    loyaltyCardActivity.find(
                      (card) => card.issuanceId === issuance.id,
                    )?.events ?? [];
                  return (
                    <article
                      key={issuance.id}
                      className="rounded-xl border border-app-border bg-app-surface-2/70 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-black text-app-text">
                            {fmtMoney(issuance.reward_amount)} reward issued
                          </p>
                          <p className="mt-1 text-xs text-app-text-muted">
                            {issuance.points_deducted.toLocaleString()} points deducted on{" "}
                            {readableDateTime(issuance.created_at)}
                          </p>
                          {issuance.card_code ? (
                            <p className="mt-2 font-mono text-xs font-black text-app-accent">
                              {issuance.card_code}
                            </p>
                          ) : null}
                        </div>
                        <p className="rounded-full border border-app-border bg-app-surface px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Issued to gift card
                        </p>
                      </div>
                      {cardEvents.length > 0 ? (
                        <div className="mt-3 space-y-1 border-t border-app-border pt-3">
                          {cardEvents.map((event) => (
                            <div
                              key={event.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-xs"
                            >
                              <span className="font-semibold text-app-text">
                                {giftCardEventLabel(event.event_kind)}
                              </span>
                              <span className="text-app-text-muted">
                                {fmtMoney(event.amount)} · balance{" "}
                                {fmtMoney(event.balance_after)} ·{" "}
                                {readableDateTime(event.created_at)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : !permissionsLoaded || loading || !hub ? (
        <p className="text-sm text-app-text-muted">
          {!permissionsLoaded
            ? "Checking access…"
            : loading
              ? "Loading customer hub…"
              : (err ?? "No data.")}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {showHubSummary ? (
            <div className="flex flex-wrap items-center gap-2">
              {hub.is_vip ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-app-warning/20 bg-app-warning/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-warning">
                  <Sparkles size={12} aria-hidden />
                  VIP
                </span>
              ) : null}
              {hub.customer_created_source === "online_store" ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-app-info/20 bg-app-info/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-info">
                  Online signup
                </span>
              ) : null}
              {(hub.stats.loyalty_points ?? 0) > 0 ? (
                <span className="flex items-center gap-1 rounded-full bg-app-accent/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-app-accent">
                  ★ {(hub.stats.loyalty_points ?? 0).toLocaleString()} pts
                </span>
              ) : null}
              {balanceDue ? (
                <span className="rounded-full border border-app-accent/40 bg-app-accent/15 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent shadow-app-accent/30">
                  Balance due {fmtMoney(hub.stats.balance_due_usd)}
                </span>
              ) : null}
              {storeCreditBal != null &&
              parseMoneyToCents(storeCreditBal) > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-app-accent/20 bg-app-accent/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent">
                  Store credit {fmtMoney(storeCreditBal)}
                </span>
              ) : null}
              {openDepositBal != null &&
              parseMoneyToCents(openDepositBal) > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-app-success/20 bg-app-success/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-success">
                  Deposit waiting {fmtMoney(openDepositBal)}
                </span>
              ) : null}
              {activeWedding ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenWeddingParty(activeWedding.wedding_party_id);
                    onClose();
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-app-accent/40 bg-app-accent/20 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text"
                >
                  <CalendarDays size={12} aria-hidden />
                  Wedding Active: {activeWedding.party_name}
                </button>
              ) : null}
            </div>
          ) : null}

          {showHubSummary ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
              {[
                {
                  label: `Lifetime${hub.couple_id ? " (Joint)" : ""}`,
                  value: fmtLifetimeCompact(hub.stats.lifetime_spend_usd),
                  target: "transactions" as HubTab,
                  disabled: !canOrdersView,
                },
                {
                  label: "Open orders",
                  value: openSummary.orders == null ? "View" : String(openSummary.orders),
                  target: "orders" as HubTab,
                  disabled: !canOrdersView,
                },
                {
                  label: "Open layaways",
                  value: openSummary.layaways == null ? "View" : String(openSummary.layaways),
                  target: "layaways" as HubTab,
                  disabled: !canOrdersView,
                },
                {
                  label: "Open alterations",
                  value: openSummary.alterations == null ? "View" : String(openSummary.alterations),
                  target: "alterations" as HubTab,
                  disabled: !canAlterationsView,
                },
                {
                  label: "Last visit",
                  value: lastVisitLabel(hub.stats.days_since_last_visit),
                  target: "transactions" as HubTab,
                  disabled: !canOrdersView,
                },
                {
                  label: "Loyalty",
                  value: `${(hub.stats.loyalty_points ?? 0).toLocaleString()} pts`,
                  target: "loyalty" as HubTab,
                  disabled: false,
                },
                {
                  label: "Profile",
                  value: hub.profile_complete ? "Complete" : "Incomplete",
                  target: hub.profile_complete ? "profile" as HubTab : "profile_missing" as const,
                  disabled: false,
                },
              ].map(({ label, value, target, disabled }) => (
                <button
                  key={label}
                  type="button"
                  disabled={disabled}
                  onClick={() => openHubStatTarget(target)}
                  className={`rounded-2xl border px-4 py-3 ${
                    label === "Profile" && hub.profile_complete
                      ? "border-app-success/20 bg-app-success/10"
                      : "border-app-border bg-app-surface-2/90"
                  } text-left transition hover:border-app-accent/40 hover:bg-app-accent/5 disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    {label}
                  </p>
                  <p
                    className={`mt-1 text-lg font-black tabular-nums ${
                      label === "Profile" && hub.profile_complete
                        ? "text-app-success"
                        : "text-app-text"
                    }`}
                  >
                    {value}
                  </p>
                </button>
              ))}
            </div>
          ) : null}

          {showHubSummary ? (
            <div className="order-4 flex flex-wrap gap-2 border-t border-app-border pt-4">
              <button
                type="button"
                onClick={() => {
                  onStartSale({
                    id: hub.id,
                    customer_code: hub.customer_code,
                    first_name: hub.first_name,
                    last_name: hub.last_name,
                    company_name: hub.company_name,
                    email: hub.email,
                    phone: hub.phone,
                    profile_discount_percent: hub.profile_discount_percent,
                    tax_exempt: hub.tax_exempt,
                    tax_exempt_id: hub.tax_exempt_id,
                  });
                  if (navigateAfterStartSale) onNavigateRegister?.();
                  onClose();
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white"
              >
                <ShoppingBag size={16} aria-hidden />
                Start sale
              </button>
              {onAddToWedding ? (
                <button
                  type="button"
                  onClick={() => {
                    onAddToWedding();
                    onClose();
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text"
                >
                  <UserPlus size={16} aria-hidden />
                  Add to wedding
                </button>
              ) : null}
              {onBookAppointment ? (
                <button
                  type="button"
                  onClick={() => {
                    onBookAppointment();
                    onClose();
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-app-accent/35 bg-app-accent/10 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text"
                >
                  <CalendarDays size={16} aria-hidden />
                  Book appointment
                </button>
              ) : null}
            </div>
          ) : null}

          {tab === "profile" && (
            <div className="order-3 space-y-6">
              {hub.couple_id ? (
                <section className="rounded-2xl border-2 border-app-accent/30 bg-app-accent/5 p-4 relative overflow-hidden">
                  <Heart className="absolute -right-4 -bottom-4 h-24 w-24 text-app-accent/10 -rotate-12" />
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-accent">
                      Linked profiles
                    </h3>
                    <button
                      type="button"
                      disabled={
                        coupleLinkingBusy ||
                        !hasPermission("customers.couple_manage")
                      }
                      onClick={unlinkCouple}
                      className="text-[10px] font-bold text-app-error hover:underline disabled:opacity-50"
                    >
                      Unlink accounts
                    </button>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 flex items-center justify-center rounded-full bg-app-accent/20 text-app-accent font-black">
                      <Heart size={20} fill="currentColor" />
                    </div>
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => {
                          if (!hub.partner) return;
                          const p = hub.partner!;
                          const mockPartner: Customer = {
                            id: p.id,
                            first_name: p.first_name,
                            last_name: p.last_name,
                            email: p.email,
                            phone: p.phone,
                            customer_code: p.customer_code,
                            couple_id: p.couple_id,
                            wedding_active: false,
                          };
                          if (onSwitchCustomer) {
                            onSwitchCustomer(mockPartner);
                          } else {
                            toast(
                              "Open this linked profile from the Customers list.",
                              "info",
                            );
                          }
                        }}
                        className="font-bold text-app-text hover:underline text-left block"
                      >
                        Open {linkedPartnerName}
                      </button>
                      <p className="text-xs text-app-text-muted">
                        {currentProfileRole}. Parent profile keeps loyalty
                        points and store credit.
                      </p>
                      {hub.partner?.customer_code ? (
                        <p className="mt-1 font-mono text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Linked with {hub.partner.customer_code}
                        </p>
                      ) : null}
                    </div>
                    {currentProfileRole ? (
                      <div className="ml-auto flex flex-col items-end gap-1">
                        <span className="px-2 py-0.5 rounded-full bg-app-surface-active text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          {currentProfileRole}
                        </span>
                        <div className="group relative">
                          <span className="cursor-help underline decoration-dotted text-app-text-muted text-[10px]">
                            What is this?
                          </span>
                          <div className="absolute right-0 bottom-full mb-2 w-48 scale-0 group-hover:scale-100 origin-bottom-right transition-transform bg-app-surface border border-app-border p-3 text-xs text-app-text shadow-xl rounded-xl z-50">
                            The parent profile keeps loyalty points and store
                            credit. Linked profiles remain openable from either
                            side.
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : (
                hasPermission("customers.couple_manage") && (
                  <section className="rounded-2xl border border-dashed border-app-border bg-app-surface/50 p-6 flex flex-col items-center justify-center text-center gap-4">
                    <div className="h-12 w-12 flex items-center justify-center rounded-full bg-app-surface-active text-app-text-muted">
                      <Heart size={24} />
                    </div>
                    <div>
                      <h3 className="font-bold text-app-text">
                        Link a Partner
                      </h3>
                      <p className="text-sm text-app-text-muted max-w-sm mt-1">
                        Combine profiles specifically for couples. One joint
                        history, individual contact/fitting details.
                      </p>
                      <div className="w-full max-w-sm">
                        {!showCouplePicker && !showCreatePartner ? (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setShowCouplePicker(true)}
                              className="ui-button-secondary flex-1"
                            >
                              Find existing profile...
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowCreatePartner(true)}
                              className="ui-button-primary bg-emerald-600 border-emerald-700 flex-1"
                            >
                              Add as new customer
                            </button>
                          </div>
                        ) : showCouplePicker ? (
                          <div className="space-y-3">
                            <CustomerSearchInput
                              onSelect={linkCouple}
                              placeholder="Type name or email..."
                              autoFocus
                              excludeCustomerId={customer.id}
                            />
                            <button
                              type="button"
                              onClick={() => setShowCouplePicker(false)}
                              className="text-xs font-semibold text-app-text-muted hover:text-app-text w-full text-center"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-4 text-left bg-app-surface border border-app-border p-4 rounded-xl">
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label className="text-[10px] font-black uppercase text-app-text-muted">
                                  First Name
                                </label>
                                <input
                                  className="ui-input w-full"
                                  value={partnerDraft.first_name}
                                  onChange={(e) =>
                                    setPartnerDraft({
                                      ...partnerDraft,
                                      first_name: e.target.value,
                                    })
                                  }
                                  placeholder="Required"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-[10px] font-black uppercase text-app-text-muted">
                                  Last Name
                                </label>
                                <input
                                  className="ui-input w-full"
                                  value={partnerDraft.last_name}
                                  onChange={(e) =>
                                    setPartnerDraft({
                                      ...partnerDraft,
                                      last_name: e.target.value,
                                    })
                                  }
                                  placeholder="Required"
                                />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-black uppercase text-app-text-muted">
                                Email
                              </label>
                              <input
                                className="ui-input w-full"
                                value={partnerDraft.email}
                                onChange={(e) =>
                                  setPartnerDraft({
                                    ...partnerDraft,
                                    email: e.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-black uppercase text-app-text-muted">
                                Phone
                              </label>
                              <input
                                className="ui-input w-full"
                                value={partnerDraft.phone}
                                onChange={(e) =>
                                  setPartnerDraft({
                                    ...partnerDraft,
                                    phone: e.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="flex gap-2 pt-2">
                              <button
                                type="button"
                                disabled={coupleLinkingBusy}
                                onClick={createAndLinkPartner}
                                className="ui-button-primary flex-1"
                              >
                                {coupleLinkingBusy
                                  ? "Creating..."
                                  : "Create & Link"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowCreatePartner(false)}
                                className="ui-button-secondary"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                )
              )}

              {canTimeline ? (
                <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                  <h3 className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                    <MessageSquarePlus size={14} aria-hidden />
                    Notes
                  </h3>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={3}
                    placeholder="Add a staff note..."
                    className="ui-input w-full resize-y p-3 text-sm"
                  />
                  <button
                    type="button"
                    disabled={noteSaving || !noteDraft.trim()}
                    onClick={() => void postNote()}
                    className="mt-2 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40"
                  >
                    {noteSaving ? "Saving…" : "Save note"}
                  </button>
                </section>
              ) : null}

            </div>
          )}

          {tab === "messages" && (
            <div className="space-y-6">
              <section className="rounded-2xl border border-app-border bg-app-surface p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                    <MessageSquarePlus size={14} aria-hidden />
                    This customer’s messages
                  </h3>
                  <button
                    type="button"
                    onClick={() => void loadPodiumThread()}
                    className="ui-btn-secondary px-2 py-1 text-[9px] font-black uppercase tracking-widest"
                  >
                    Refresh
                  </button>
                </div>
                {podiumThreadLoading ? (
                  <p className="text-xs text-app-text-muted">
                    Loading messages…
                  </p>
                ) : podiumThread.length === 0 ? (
                  <p className="text-xs text-app-text-muted">
                    No messages yet. New SMS or email messages for this customer appear here.
                  </p>
                ) : (
                  <ul className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
                    {podiumThread.map((m) => {
                      const inbound = m.direction === "inbound";
                      const auto = m.direction === "automated";
                      const preview = formatMessagePreview(m.body, m.channel);
                      const sentBy = podiumThreadSentByLabel(m);
                      return (
                        <li
                          key={m.id}
                          className={`flex ${inbound ? "justify-start" : "justify-end"}`}
                        >
                          <div
                            className={`max-w-[92%] rounded-xl border px-3 py-2 text-xs ${
                              inbound
                                ? "border-app-border bg-app-surface-2 text-app-text"
                                : auto
                                  ? "border-app-border/60 bg-app-surface-2/50 text-app-text-muted"
                                  : "border-app-success/20 bg-app-success/10 text-app-text"
                            }`}
                          >
                            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              <span>{m.channel}</span>
                              <span className="text-app-text/90 normal-case tracking-normal">
                                {sentBy}
                              </span>
                              <span className="ml-auto font-normal normal-case tracking-normal">
                                {new Date(m.created_at).toLocaleString()}
                              </span>
                            </div>
                            <p className="whitespace-pre-wrap break-words">
                              {preview}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Reply SMS
                </h3>
                {!hub.phone ? (
                  <p className="mb-2 text-xs font-semibold text-app-warning">
                    Add a phone number on the Profile tab to reply by SMS.
                  </p>
                ) : null}
                <textarea
                  className="ui-input mb-2 min-h-[72px] w-full resize-y p-2 text-sm"
                  value={smsReplyDraft}
                  onChange={(e) => setSmsReplyDraft(e.target.value)}
                  disabled={!canHubEdit || !hub.phone}
                  placeholder="Type SMS reply…"
                />
                <button
                  type="button"
                  disabled={
                    smsReplyBusy ||
                    !canHubEdit ||
                    !hub.phone ||
                    !smsReplyDraft.trim()
                  }
                  onClick={() => void sendPodiumSmsReply()}
                  className="rounded-xl border-b-8 border-app-success bg-app-success px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40"
                >
                  {smsReplyBusy ? "Sending…" : "Send SMS"}
                </button>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-4">
                <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  Send email
                </h3>
                <p className="mb-3 text-xs text-app-text-muted leading-relaxed">
                  Sends to the email on this customer&apos;s profile.
                </p>
                {!hub.email ? (
                  <p className="mb-3 text-sm font-semibold text-app-warning">
                    Add an email address on the Profile tab before sending.
                  </p>
                ) : null}
                <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Subject
                </label>
                <input
                  className="ui-input mb-3 w-full px-3 py-2 text-sm"
                  value={podiumComposeSubject}
                  onChange={(e) => setPodiumComposeSubject(e.target.value)}
                  disabled={!canHubEdit || !hub.email}
                  placeholder="Regarding your recent visit…"
                />
                <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Email message
                </label>
                <textarea
                  className="ui-input mb-3 min-h-[120px] w-full resize-y p-3 font-mono text-xs"
                  value={podiumComposeHtml}
                  onChange={(e) => setPodiumComposeHtml(e.target.value)}
                  disabled={!canHubEdit || !hub.email}
                  placeholder="Write the email message…"
                  spellCheck={false}
                />
                <button
                  type="button"
                  disabled={
                    podiumComposeBusy ||
                    !canHubEdit ||
                    !hub.email ||
                    !podiumComposeSubject.trim() ||
                    !podiumComposeHtml.trim()
                  }
                  onClick={() => void sendPodiumEmail()}
                  className="rounded-xl border-b-8 border-app-success bg-app-success px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40"
                >
                  {podiumComposeBusy ? "Sending…" : "Send via Podium"}
                </button>
                {!canHubEdit ? (
                  <p className="mt-2 text-xs text-app-text-muted">
                    Manager access is needed to send from this customer profile.
                  </p>
                ) : null}
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                <h3 className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  <Mail size={14} aria-hidden />
                  Open in Podium
                </h3>
                <p className="mb-3 text-xs text-app-text-muted leading-relaxed">
                  Optional shortcut to this customer&apos;s thread in Podium.
                </p>
                <input
                  type="url"
                  value={podiumUrlDraft}
                  onChange={(e) => setPodiumUrlDraft(e.target.value)}
                  disabled={!canHubEdit}
                  placeholder="https://…"
                  className="ui-input mb-3 w-full px-3 py-2 text-sm"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {canHubEdit ? (
                    <button
                      type="button"
                      disabled={podiumUrlSaving}
                      onClick={() => void savePodiumConversationUrl()}
                      className="rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40"
                    >
                      {podiumUrlSaving ? "Saving…" : "Save link"}
                    </button>
                  ) : null}
                  {hub.podium_conversation_url ? (
                    <a
                      href={hub.podium_conversation_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] font-black uppercase tracking-widest text-app-accent underline"
                    >
                      Open saved link
                    </a>
                  ) : null}
                </div>
              </section>
            </div>
          )}

          {tab === "weddings" && (
            <div className="space-y-6">
              <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                <h3 className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  <Sparkles size={14} aria-hidden />
                  Current wedding
                </h3>
                {!activeWedding ? (
                  <p className="text-sm text-app-text-muted">
                    This customer is not currently linked to an active wedding
                    party.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-accent/25 bg-app-accent/5 px-4 py-3">
                    <div>
                      <p className="text-base font-black text-app-text">
                        {activeWedding.party_name}
                      </p>
                      <p className="text-sm text-app-text-muted">
                        {activeWedding.role} · {activeWedding.event_date} ·{" "}
                        {activeWedding.status}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenWeddingParty(activeWedding.wedding_party_id);
                        onClose();
                      }}
                      className="shrink-0 rounded-xl border border-app-border px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent/40 hover:bg-app-accent/10"
                    >
                      Open current party
                    </button>
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                <h3 className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  <CalendarDays size={14} aria-hidden />
                  Previous weddings
                </h3>
                {pastWeddings.length === 0 ? (
                  <p className="text-sm text-app-text-muted">
                    No previous wedding parties on record.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {pastWeddings.map((w) => (
                      <li
                        key={w.wedding_member_id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2"
                      >
                        <div>
                          <p className="font-bold text-app-text">
                            {w.party_name}
                          </p>
                          <p className="text-xs text-app-text-muted">
                            {w.role} · {w.event_date} · {w.status}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenWeddingParty(w.wedding_party_id);
                            onClose();
                          }}
                          className="shrink-0 rounded-lg border border-app-border px-3 py-1.5 text-[10px] font-black uppercase tracking-tight text-app-text hover:border-app-accent/40 hover:bg-app-accent/10"
                        >
                          Open party
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {tab === "measurements" && (
            <div className="space-y-6">
              {vaultLoading ? (
                <p className="text-sm text-app-text-muted">
                  Loading measurements…
                </p>
              ) : (
                <>
                  <div ref={printRef} className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-lg font-black text-app-text">
                        This customer’s measurements — {title}
                      </h3>
                      <button
                        type="button"
                        onClick={() => printMeasurements()}
                        className="inline-flex items-center gap-2 rounded-xl border border-app-border px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text"
                      >
                        <Printer size={16} aria-hidden />
                        Print measurements
                      </button>
                    </div>
                    <section>
                      <h4 className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Current measurements
                      </h4>
                      <CustomerMeasurementVaultForm
                        draft={measDraft}
                        disabled={!canMeasurements}
                        onDraftChange={(key, value) =>
                          setMeasDraft((d) => ({ ...d, [key]: value }))
                        }
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={measSaving || !canMeasurements}
                          onClick={() => void saveMeasurements()}
                          className="ui-btn-primary px-4 py-2 text-xs font-black uppercase"
                        >
                          {measSaving ? "Saving…" : "Save measurements"}
                        </button>
                        {!vault?.latest ? (
                          <span className="text-xs text-app-text-muted">
                            No measurements saved yet.
                          </span>
                        ) : null}
                      </div>
                      {vault?.latest ? (
                        <p className="mt-2 text-xs text-app-text-muted">
                          Source:{" "}
                          {vault.latest.source === "current_block"
                            ? "Wedding / tailoring block"
                            : "Archive"}{" "}
                          ·{" "}
                          {new Date(vault.latest.measured_at).toLocaleString()}
                        </p>
                      ) : null}
                    </section>
                    <section>
                      <h4 className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Archive
                      </h4>
                      {vault && vault.history.length > 0 ? (
                        isCompactHub ? (
                          <div className="space-y-2">
                            {vault.history.map((row) => (
                              <article
                                key={row.id}
                                className="rounded-xl border border-app-border bg-app-surface p-3 text-xs"
                              >
                                <p className="mb-2 font-black uppercase tracking-widest text-app-text-muted">
                                  {new Date(row.measured_at).toLocaleDateString()}
                                </p>
                                <div className="grid grid-cols-2 gap-2 font-mono">
                                  <p>
                                    <span className="font-black text-app-text-muted">Neck:</span>{" "}
                                    {row.neck ?? "—"}
                                  </p>
                                  <p>
                                    <span className="font-black text-app-text-muted">Chest:</span>{" "}
                                    {row.chest ?? "—"}
                                  </p>
                                  <p>
                                    <span className="font-black text-app-text-muted">Waist:</span>{" "}
                                    {row.waist ?? "—"}
                                  </p>
                                  <p>
                                    <span className="font-black text-app-text-muted">Sleeve:</span>{" "}
                                    {row.sleeve ?? "—"}
                                  </p>
                                  <p className="col-span-2">
                                    <span className="font-black text-app-text-muted">Inseam:</span>{" "}
                                    {row.inseam ?? "—"}
                                  </p>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-app-border">
                            <table className="w-full min-w-[400px] text-left text-sm md:min-w-[520px]">
                              <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                <tr>
                                  <th className="px-3 py-2">Date</th>
                                  <th className="px-3 py-2">Neck</th>
                                  <th className="px-3 py-2">Chest</th>
                                  <th className="px-3 py-2">Waist</th>
                                  <th className="px-3 py-2">Sleeve</th>
                                  <th className="px-3 py-2">Inseam</th>
                                </tr>
                              </thead>
                              <tbody>
                                {vault.history.map((row) => (
                                  <tr
                                    key={row.id}
                                    className="border-b border-app-border/50"
                                  >
                                    <td className="px-3 py-2 text-xs text-app-text-muted">
                                      {new Date(
                                        row.measured_at,
                                      ).toLocaleDateString()}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs">
                                      {row.neck ?? "—"}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs">
                                      {row.chest ?? "—"}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs">
                                      {row.waist ?? "—"}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs">
                                      {row.sleeve ?? "—"}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs">
                                      {row.inseam ?? "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      ) : (
                        <p className="text-sm text-app-text-muted">
                          No archived measurement rows yet.
                        </p>
                      )}
                    </section>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "profile" && (
            <div className="order-1 space-y-6">
              <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
                <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Customer profile
                      </h3>
                      {highlightMissingProfileFields && profileMissingHint ? (
                        <p className="mt-1 text-xs font-semibold text-app-warning">
                          {profileMissingHint}
                        </p>
                      ) : null}
                    </div>
                    <div className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-right">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Customer code
                      </p>
                      <p className="font-mono text-sm font-black text-app-text">
                        {hub.customer_code}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      First name
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.first_name}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            first_name: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Last name
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.last_name}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            last_name: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted sm:col-span-2">
                      Company
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.company_name}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            company_name: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label
                      className={`block rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted ${
                        highlightMissingProfileFields && missingProfileFields.phone
                          ? "bg-app-warning/10 p-2 ring-2 ring-app-warning/40"
                          : ""
                      }`}
                    >
                      Phone
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.phone}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            phone: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label
                      className={`block rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted ${
                        highlightMissingProfileFields && missingProfileFields.email
                          ? "bg-app-warning/10 p-2 ring-2 ring-app-warning/40"
                          : ""
                      }`}
                    >
                      Email
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.email}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            email: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <AddressAutocompleteInput
                      value={profileDraft.address_line1}
                      readOnly={!canHubEdit}
                      className="sm:col-span-2"
                      inputClassName="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      onChange={(value) =>
                        setProfileDraft((d) => ({
                          ...d,
                          address_line1: value,
                        }))
                      }
                      onSelectAddress={(suggestion) =>
                        setProfileDraft((d) => ({
                          ...d,
                          address_line1: suggestion.address_line1,
                          city: suggestion.city,
                          state: suggestion.state,
                          postal_code: suggestion.postal_code,
                        }))
                      }
                    />
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted sm:col-span-2">
                      Address line 2
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.address_line2}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            address_line2: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      City
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.city}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            city: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      State
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.state}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            state: e.target.value.toUpperCase(),
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Postal code
                      <input
                        readOnly={!canHubEdit}
                        value={profileDraft.postal_code}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            postal_code: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Date of birth
                      <input
                        type="date"
                        readOnly={!canHubEdit}
                        value={profileDraft.date_of_birth}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            date_of_birth: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Wedding / anniversary date
                      <input
                        type="date"
                        readOnly={!canHubEdit}
                        value={profileDraft.anniversary_date}
                        onChange={(e) =>
                          setProfileDraft((d) => ({
                            ...d,
                            anniversary_date: e.target.value,
                          }))
                        }
                        className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                      />
                    </label>
                  </div>
                </section>

                <div className="space-y-4">
                  <label
                    className={`flex items-center gap-2 rounded-2xl border border-app-border bg-app-surface-2/80 p-4 text-sm font-bold text-app-text ${canHubEdit ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
                  >
                    <input
                      type="checkbox"
                      disabled={!canHubEdit}
                      checked={hub.is_vip}
                      onChange={(e) =>
                        void patchCustomer({ is_vip: e.target.checked })
                      }
                    />
                    <Heart size={16} className="text-amber-500" aria-hidden />
                    VIP customer
                  </label>

                  <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                    <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Register defaults
                    </h3>
                    <div className="space-y-3">
                      <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Automatic discount %
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          readOnly={!canHubEdit}
                          value={profileDraft.profile_discount_percent}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              profile_discount_percent: e.target.value,
                            }))
                          }
                          className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                        />
                        <span className="mt-1 block text-[10px] normal-case tracking-normal text-app-text-muted">
                          Applies to regular-priced merchandise only.
                        </span>
                      </label>
                      <label
                        className={`flex items-center gap-2 text-sm font-semibold text-app-text ${canHubEdit ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!canHubEdit}
                          checked={profileDraft.tax_exempt}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              tax_exempt: e.target.checked,
                              tax_exempt_id: e.target.checked ? d.tax_exempt_id : "",
                            }))
                          }
                        />
                        Tax exempt
                      </label>
                      <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Tax ID
                        <input
                          readOnly={!canHubEdit || !profileDraft.tax_exempt}
                          value={profileDraft.tax_exempt_id}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              tax_exempt_id: e.target.value,
                            }))
                          }
                          className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-60"
                        />
                      </label>
                    </div>
                  </section>

                  <section
                    className={`rounded-2xl border p-4 ${
                      hub.stats.marketing_needs_attention
                        ? "border-app-accent/40 bg-app-accent/10"
                        : "border-app-border bg-app-surface-2/80"
                    }`}
                  >
                    <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Contact preferences
                    </h3>
                    <div className="space-y-3 text-sm">
                      <label
                        className={`flex items-center gap-2 font-semibold text-app-text ${canHubEdit ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!canHubEdit}
                          checked={profileDraft.marketing_email_opt_in}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              marketing_email_opt_in: e.target.checked,
                            }))
                          }
                        />
                        Email opt-in
                      </label>
                      <label
                        className={`flex items-center gap-2 font-semibold text-app-text ${canHubEdit ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!canHubEdit}
                          checked={profileDraft.marketing_sms_opt_in}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              marketing_sms_opt_in: e.target.checked,
                            }))
                          }
                        />
                        SMS opt-in
                      </label>
                      <label
                        className={`flex items-center gap-2 font-semibold text-app-text ${canHubEdit ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!canHubEdit}
                          checked={profileDraft.transactional_sms_opt_in}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              transactional_sms_opt_in: e.target.checked,
                            }))
                          }
                        />
                        Operational SMS
                      </label>
                      <label
                        className={`flex items-center gap-2 font-semibold text-app-text ${canHubEdit ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!canHubEdit}
                          checked={profileDraft.transactional_email_opt_in}
                          onChange={(e) =>
                            setProfileDraft((d) => ({
                              ...d,
                              transactional_email_opt_in: e.target.checked,
                            }))
                          }
                        />
                        Operational email
                      </label>
                    </div>
                    {hub.stats.marketing_needs_attention ? (
                      <p className="mt-3 text-xs font-bold text-app-accent">
                        No marketing channels enabled yet.
                      </p>
                    ) : null}
                  </section>

                  <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                    <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Extended profile
                    </h3>
                    <div className="space-y-3">
                      {(
                        [
                          ["custom_field_1", "Custom field 1"],
                          ["custom_field_2", "Custom field 2"],
                          ["custom_field_3", "Custom field 3"],
                          ["custom_field_4", "Custom field 4"],
                        ] as const
                      ).map(([key, label]) => (
                        <label
                          key={key}
                          className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                        >
                          {label}
                          <input
                            readOnly={!canHubEdit}
                            value={profileDraft[key]}
                            onChange={(e) =>
                              setProfileDraft((d) => ({
                                ...d,
                                [key]: e.target.value,
                              }))
                            }
                            className="ui-input mt-1 w-full p-2.5 text-sm font-semibold text-app-text read-only:opacity-80"
                          />
                        </label>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
              {permissionsLoaded &&
              hasPermission("customers_duplicate_review") ? (
                <section
                  className="rounded-2xl border border-app-accent/20 bg-app-accent/10 p-4"
                  data-testid="crm-hub-duplicate-review-enqueue"
                >
                  <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-accent">
                    Possible duplicates
                  </h3>
                  <p className="mb-3 text-xs text-app-text">
                    Search for the matching customer so a manager can review the
                    two records before any merge.
                  </p>
                  <div className="mt-2">
                    <CustomerSearchInput
                      onSelect={enqueueDuplicateReviewPair}
                      placeholder="Search for twin record by name or code…"
                      className="w-full"
                      disabled={duplicateEnqueueBusy}
                    />
                  </div>
                </section>
              ) : null}
              {canHubEdit ? (
                <button
                  type="button"
                  disabled={profileSaving}
                  onClick={() => void saveProfileDetails()}
                  className="rounded-xl bg-app-accent px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40"
                >
                  {profileSaving ? "Saving…" : "Save profile"}
                </button>
              ) : (
                <p className="text-xs text-app-text-muted">
                  Manager access is needed to edit this customer profile.
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <TransactionDetailDrawer
        orderId={selectedTransactionId}
        isOpen={selectedTransactionId !== null}
        onClose={() => setSelectedTransactionId(null)}
        onOpenTransactionInBackoffice={backofficeOrderOpener}
      />
    </DetailDrawer>
  );
}
