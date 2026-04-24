import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Heart,
  Mail,
  MessageSquarePlus,
  Printer,
  Receipt,
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
import AddressAutocompleteInput from "../ui/AddressAutocompleteInput";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import TransactionDetailDrawer from "../orders/TransactionDetailDrawer";
import {
  customerLifecycleBadgeClassName,
  customerLifecycleDescription,
  customerLifecycleLabel,
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
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
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
      return "Timeline note";
    case "measurement":
      return "Measurements";
    case "appointment":
      return "Appointment";
    case "shipping":
      return "Shipment update";
    default:
      return kind.replace(/_/g, " ");
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
  | "profile"
  | "transactions"
  | "orders"
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
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Load failed");
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
    if (!open) {
      setErr(null);
      setHubShipmentFocusId(null);
      return;
    }
    if (!permissionsLoaded) {
      setLoading(true);
      return;
    }
    if (!canHubView) {
      setLoading(false);
      setHub(null);
      setErr(
        "You do not have permission to open the customer hub (customers.hub_view).",
      );
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
    if (tab === "shipments" && !canShipmentsView) setTab("profile");
    if (tab === "measurements" && !canMeasurements) setTab("profile");
  }, [
    permissionsLoaded,
    tab,
    canOrdersView,
    canShipmentsView,
    canMeasurements,
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
      setTab(initialHubTab === "relationship" ? "profile" : initialHubTab);
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
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(b.error ?? "Could not send email via Podium", "error");
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
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(b.error ?? "Could not send SMS", "error");
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
      const b = await res.json().catch(() => ({}));
      toast((b as { error?: string }).error ?? "Update failed", "error");
      return false;
    }
    await loadHub();
    return true;
  };

  const saveProfileDetails = async () => {
    if (!canHubEdit) return;
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
        const b = await res.json().catch(() => ({}));
        toast((b as { error?: string }).error ?? "Update failed", "error");
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
        const b = await res.json().catch(() => ({}));
        toast((b as { error?: string }).error ?? "Linking failed", "error");
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
        const b = await res.json().catch(() => ({}));
        toast((b as { error?: string }).error ?? "Unlinking failed", "error");
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
        const b = await res.json().catch(() => ({}));
        toast(
          (b as { error?: string }).error ?? "Creation and linking failed",
          "error",
        );
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
        const b = await res.json().catch(() => ({}));
        toast((b as { error?: string }).error ?? "Enqueue failed", "error");
        return;
      }
      toast("Duplicates enqueued for staff review", "success");
    } catch {
      toast("Error enqueuing duplicates", "error");
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
        const b = await res.json().catch(() => ({}));
        toast(
          (b as { error?: string }).error ?? "Could not save note",
          "error",
        );
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
        const b = await res.json().catch(() => ({}));
        toast((b as { error?: string }).error ?? "Save failed", "error");
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
          {canHubView ? tabBtn("messages", "Messages") : null}
          {canOrdersView ? tabBtn("transactions", "Transactions") : null}
          {canOrdersView ? tabBtn("orders", "Orders") : null}
          {canShipmentsView ? tabBtn("shipments", "Shipments") : null}
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
              {tab === "transactions" ? "Transaction history" : "Order history"}
            </h3>
            <p className="mb-3 text-xs text-app-text-muted">
              {tab === "transactions"
                ? "Every sale record for this customer. Open any row for receipt and salesperson corrections."
                : "Order-linked records for this customer. Open the full record first, then move into the editable order workspace when needed."}{" "}
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

          {orderHistoryLoading && orderHistoryRows.length === 0 ? (
            <p className="text-sm text-app-text-muted">
              Loading {tab === "transactions" ? "transactions" : "orders"}…
            </p>
          ) : null}

          {orderHistoryRows.length === 0 && !orderHistoryLoading ? (
            <p className="text-sm text-app-text-muted">
              No {tab === "transactions" ? "transactions" : "orders"} in this
              range.
            </p>
          ) : null}

          {orderHistoryRows.length > 0 ? (
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
                        {new Date(row.booked_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <div className="flex items-center gap-2">
                          <span>{row.transaction_display_id}</span>
                          {row.is_counterpoint_import ? (
                            <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-zinc-600">
                              CP
                            </span>
                          ) : null}
                        </div>
                        {row.counterpoint_customer_code ? (
                          <div className="mt-1 text-[9px] font-bold text-app-text-muted">
                            CP #{row.counterpoint_customer_code}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs text-app-text-muted">
                        {row.sale_channel === "web"
                          ? "Web"
                          : row.sale_channel === "register"
                            ? "Store"
                            : (row.sale_channel ?? "—")}
                      </td>
                      <td className="px-3 py-2 text-xs font-semibold">
                        {row.status}
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
                        {tab === "transactions" || tab === "orders" ? (
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
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
              {tab === "transactions" ? "transactions" : "orders"}
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
      ) : !permissionsLoaded || loading || !hub ? (
        <p className="text-sm text-app-text-muted">
          {!permissionsLoaded
            ? "Checking access…"
            : loading
              ? "Loading customer hub…"
              : (err ?? "No data.")}
        </p>
      ) : (
        <div className="space-y-6">
          {showHubSummary ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${customerLifecycleBadgeClassName(
                  hub.stats.lifecycle_state,
                )}`}
              >
                Lifecycle: {customerLifecycleLabel(hub.stats.lifecycle_state)}
              </span>
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
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {[
                [
                  `Lifetime${hub.couple_id ? " (Joint)" : ""}`,
                  fmtLifetimeCompact(hub.stats.lifetime_spend_usd),
                ],
                [
                  "Lifecycle",
                  customerLifecycleLabel(hub.stats.lifecycle_state),
                ],
                ["Profile", hub.profile_complete ? "OK" : "Incomplete"],
                ["Last visit", lastVisitLabel(hub.stats.days_since_last_visit)],
                ["Weddings", String(hub.stats.wedding_party_count)],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className={`rounded-2xl border px-4 py-3 ${
                    k === "Profile" && hub.profile_complete
                      ? "border-app-success/20 bg-app-success/10"
                      : k === "Lifecycle"
                        ? customerLifecycleBadgeClassName(
                            hub.stats.lifecycle_state,
                          )
                      : "border-app-border bg-app-surface-2/90"
                  }`}
                >
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    {k}
                  </p>
                  <p
                    className={`mt-1 text-lg font-black tabular-nums ${
                      k === "Profile" && hub.profile_complete
                        ? "text-app-success"
                        : "text-app-text"
                    }`}
                  >
                    {v}
                  </p>
                  {k === "Lifecycle" ? (
                    <p className="mt-1 text-[10px] font-medium normal-case tracking-normal opacity-80">
                      {customerLifecycleDescription(hub.stats.lifecycle_state)}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {showHubSummary ? (
            <div className="flex flex-wrap gap-2 border-b border-app-border pb-4">
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
            <div className="space-y-6">
              <section className="rounded-2xl border border-app-info/20 bg-app-info/10 p-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-app-info">
                  Customer review and support follow-up
                </h3>
                <p className="mt-1 text-xs text-app-text">
                  Use this hub to review the customer profile, notes, orders,
                  measurements, weddings, and message history. Use the RMS
                  Charge workspace when you need to verify linked financing
                  accounts, review RMS posting history, or work RMS issues and
                  reconciliation.
                </p>
              </section>
              <section className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Joint account and customer notes
                </h3>
                <p className="mt-1 text-xs text-app-text-muted">
                  Keep linked partner details, interaction history, and staff
                  notes directly inside the main customer profile.
                </p>
              </section>
              {hub.couple_id ? (
                <section className="rounded-2xl border-2 border-app-accent/30 bg-app-accent/5 p-4 relative overflow-hidden">
                  <Heart className="absolute -right-4 -bottom-4 h-24 w-24 text-app-accent/10 -rotate-12" />
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-app-accent">
                      Joint Couple Account
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
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          const p = hub.partner!;
                          const mockPartner: Customer = {
                            id: p.id,
                            first_name: p.first_name,
                            last_name: p.last_name,
                            email: p.email,
                            phone: p.phone,
                            customer_code: "",
                            wedding_active: false,
                          };
                          if (onSwitchCustomer) {
                            onSwitchCustomer(mockPartner);
                          } else {
                            toast(
                              "Switching not available in this context",
                              "info",
                            );
                          }
                        }}
                        className="font-bold text-app-text hover:underline text-left block"
                      >
                        Linked with {hub.partner?.first_name}{" "}
                        {hub.partner?.last_name}
                      </button>
                      <p className="text-xs text-app-text-muted">
                        Joint sales history, loyalty, and orders active.
                      </p>
                    </div>
                    {hub.id !== hub.couple_primary_id && (
                      <div className="ml-auto flex flex-col items-end gap-1">
                        <span className="px-2 py-0.5 rounded-full bg-app-surface-active text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Archived Profile
                        </span>
                        <div className="group relative">
                          <span className="cursor-help underline decoration-dotted text-app-text-muted text-[10px]">
                            What is this?
                          </span>
                          <div className="absolute right-0 bottom-full mb-2 w-48 scale-0 group-hover:scale-100 origin-bottom-right transition-transform bg-app-surface border border-app-border p-3 text-xs text-app-text shadow-xl rounded-xl z-50">
                            This profile acts as an alias for the joint account.
                            Sales history is stored on the primary profile
                            balance.
                          </div>
                        </div>
                      </div>
                    )}
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
              <section>
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
                    You do not have permission to view the timeline
                    (customers.timeline).
                  </p>
                ) : timelineLoading ? (
                  <p className="text-sm text-app-text-muted">
                    Loading timeline…
                  </p>
                ) : timeline.length === 0 ? (
                  <p className="text-sm text-app-text-muted">
                    No customer history recorded yet.
                  </p>
                ) : (
                  <ul className="relative space-y-0 border-l-2 border-app-border pl-6">
                    {timeline.map((ev, i) => (
                      <li key={`${ev.at}-${i}`} className="relative pb-6">
                        <span
                          className={`absolute -left-[9px] top-1.5 h-3 w-3 rounded-full border-2 border-app-surface shadow-sm ${
                            kindDot[ev.kind] ?? "bg-app-text-muted"
                          }`}
                        />
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          {new Date(ev.at).toLocaleString()} ·{" "}
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
                            Open wedding workspace
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {canTimeline ? (
                <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                  <h3 className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                    <MessageSquarePlus size={14} aria-hidden />
                    Add note
                  </h3>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={3}
                    placeholder="Prefers slim fit, likes blue tones…"
                    className="ui-input w-full resize-y p-3 text-sm"
                  />
                  <button
                    type="button"
                    disabled={noteSaving || !noteDraft.trim()}
                    onClick={() => void postNote()}
                    className="mt-2 rounded-xl bg-app-accent px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40"
                  >
                    {noteSaving ? "Saving…" : "Post to timeline"}
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
                    Thread (Podium)
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
                    No messages yet. Inbound SMS/email appears here after the
                    Podium webhook is configured.
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
                  Send email (Podium)
                </h3>
                <p className="mb-3 text-xs text-app-text-muted leading-relaxed">
                  Delivers to the email on this customer&apos;s profile via
                  Podium (
                  <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                    POST /v4/messages
                  </code>
                  ). Requires Integrations: operational email enabled and server
                  Podium credentials.
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
                  HTML body
                </label>
                <textarea
                  className="ui-input mb-3 min-h-[120px] w-full resize-y p-3 font-mono text-xs"
                  value={podiumComposeHtml}
                  onChange={(e) => setPodiumComposeHtml(e.target.value)}
                  disabled={!canHubEdit || !hub.email}
                  placeholder="<p>Hello …</p>"
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
                    Sending requires customers.hub_edit.
                  </p>
                ) : null}
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                <h3 className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
                  <Mail size={14} aria-hidden />
                  Podium Web (link)
                </h3>
                <p className="mb-3 text-xs text-app-text-muted leading-relaxed">
                  Optional shortcut to this customer&apos;s thread in Podium Web
                  Inbox.
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
                        Measurements — {title}
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
                        Latest block
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
                            No block yet — saving creates the vault row.
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
            <div className="space-y-6">
              <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
                <section className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Profile
                      </h3>
                      <p className="mt-1 text-xs text-app-text-muted">
                        Standard customer account details for sales, messaging,
                        appointments, and historical matching.
                      </p>
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
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
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
                    <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
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
                    Duplicate review queue
                  </h3>
                  <p className="mb-3 text-xs text-app-text">
                    Search for the twin record to mark them as a potential
                    duplicate pair for management review (merge stays a separate
                    step).
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
                  Profile edits require customers.hub_edit.
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
