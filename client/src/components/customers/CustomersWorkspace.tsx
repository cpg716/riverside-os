import { getBaseUrl } from "../../lib/apiConfig";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Gem,
  Search,
  Upload,
  Users,
  Wallet,
  Heart,
  CheckCircle2,
  Truck,
  ShoppingBag,
  ChevronRight,
  UserPlus,
  Activity,
  Clock,
  MapPin,
  ShieldCheck,
  X as CloseIcon,
} from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import {
  CustomerRelationshipHubDrawer,
  type HubTab,
} from "./CustomerRelationshipHubDrawer";
import DuplicateReviewQueueSection from "./DuplicateReviewQueueSection";
import RmsChargeAdminSection from "./RmsChargeAdminSection";
import ShipmentsHubSection from "./ShipmentsHubSection";
import LayawayWorkspace from "../pos/LayawayWorkspace";
import DetailDrawer from "../layout/DetailDrawer";
import FloatingBulkBar from "../ui/FloatingBulkBar";
import AddressAutocompleteInput from "../ui/AddressAutocompleteInput";
import { useToast } from "../ui/ToastProviderLogic";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

import ConfirmationModal from "../ui/ConfirmationModal";
import { parseCsv } from "../../lib/parseCsv";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import WeddingPartySearchInput from "../ui/WeddingPartySearchInput";
import {
  CUSTOMER_LIFECYCLE_OPTIONS,
  customerLifecycleBadgeClassName,
  customerLifecycleLabel,
  type CustomerLifecycleState,
} from "./customerLifecycle";
// Redundant CloseIcon import removed

const baseUrl = getBaseUrl();

interface CustomerPipelineStats {
  total_customers: number;
  vip_customers: number;
  with_balance: number;
  upcoming_weddings: number;
}

function downloadLightspeedImportIssuesCsv(
  issues: { row_index: number; customer_code: string | null; issue: string }[],
) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [
    "row_index,customer_code,issue",
    ...issues.map((i) =>
      [String(i.row_index), i.customer_code ?? "", i.issue].map(esc).join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `riverside-customers-import-issues-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Must match server `browse` max clamp (1000); keep ≤ 1000. */
const BROWSE_PAGE_SIZE = 500;

interface CustomersWorkspaceProps {
  onOpenWeddingParty: (partyId: string) => void;
  onStartSaleInPos: (c: Customer) => void;
  onNavigateRegister: () => void;
  onAddToWedding: () => void;
  onBookAppointment: () => void;
  /** Open Back Office Orders with this order selected (requires orders.view). */
  onOpenTransactionInBackoffice?: (orderId: string) => void;
  activeSection?: string;
  /** Reset sidebar subsection (e.g. after closing Add Customer from sidebar "add"). */
  onNavigateSubSection?: (id: string) => void;
  /** Notification / deep link: open hub for this customer. */
  messagingFocusCustomerId?: string | null;
  messagingFocusHubTab?: string;
  onMessagingFocusConsumed?: () => void;
  surface?: "backoffice" | "pos";
}

interface CustomerBrowseRow {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_vip: boolean;
  open_balance_due: string;
  lifetime_sales: string;
  open_orders_count: number;
  active_shipment_status: string | null;
  wedding_soon: boolean;
  wedding_active: boolean;
  wedding_party_name: string | null;
  wedding_party_id: string | null;
  lifecycle_state: CustomerLifecycleState;
}

interface CustomerQualitySummary {
  visibleCustomers: number;
  incompleteProfiles: number;
  missingPhone: number;
  missingEmail: number;
}

function moneyDec(s: string) {
  const t = String(s).trim();
  if (!t) return s;
  const normalized = t.replace(/,/g, "");
  if (!Number.isFinite(Number.parseFloat(normalized))) return s;
  return formatUsdFromCents(parseMoneyToCents(normalized));
}

function rowToCustomer(r: CustomerBrowseRow): Customer {
  return {
    id: r.id,
    customer_code: r.customer_code,
    first_name: r.first_name,
    last_name: r.last_name,
    company_name: r.company_name,
    email: r.email,
    phone: r.phone,
  };
}

function escapeCsvCell(v: string) {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function customerProfileComplete(row: CustomerBrowseRow) {
  return Boolean(row.phone?.trim()) && Boolean(row.email?.trim());
}

export default function CustomersWorkspace({
  onOpenWeddingParty,
  onStartSaleInPos,
  onNavigateRegister,
  onAddToWedding,
  onBookAppointment,
  onOpenTransactionInBackoffice,
  activeSection,
  onNavigateSubSection,
  messagingFocusCustomerId,
  messagingFocusHubTab,
  onMessagingFocusConsumed,
  surface = "backoffice",
}: CustomersWorkspaceProps) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [_q, _setQ] = useState("");
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const { toast } = useToast();
  const [showBulkWeddingPrompt, setShowBulkWeddingPrompt] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [pendingImportRows, setPendingImportRows] = useState<
    Record<string, string>[] | null
  >(null);

  const onPickImportFile = () => importFileRef.current?.click();

  const onImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const { rows } = parseCsv(text);
      if (rows.length === 0) {
        toast("No rows found in CSV.", "error");
        return;
      }
      setPendingImportRows(rows);
      setImportConfirmOpen(true);
    };
    reader.readAsText(f);
  };

  const runLightspeedImport = async () => {
    if (!pendingImportRows?.length) return;
    setImportLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/import/lightspeed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ rows: pendingImportRows }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        created?: number;
        updated?: number;
        skipped?: number;
        email_conflicts?: number;
        issues?: {
          row_index: number;
          customer_code: string | null;
          issue: string;
        }[];
      };
      if (!res.ok) {
        toast(body.error ?? `Import failed (${res.status})`, "error");
        return;
      }
      const issueList = body.issues ?? [];
      if (issueList.length > 0) {
        downloadLightspeedImportIssuesCsv(issueList);
      }
      toast(
        issueList.length > 0
          ? `Import complete: ${body.created ?? 0} created, ${body.updated ?? 0} updated, ${body.skipped ?? 0} skipped. Email conflicts: ${body.email_conflicts ?? 0}. Downloaded ${issueList.length} row issue(s) as CSV.`
          : `Import complete: ${body.created ?? 0} created, ${body.updated ?? 0} updated, ${body.skipped ?? 0} skipped. Email conflicts: ${body.email_conflicts ?? 0}.`,
        "success",
      );
      setImportConfirmOpen(false);
      setPendingImportRows(null);
      void refresh();
    } catch {
      toast("Network error during import.", "error");
    } finally {
      setImportLoading(false);
    }
  };

  // Sidebar "Add Customer" sub-section opens the add slideout.
  useEffect(() => {
    if (activeSection === "add") setShowAddDrawer(true);
  }, [activeSection]);

  useEffect(() => {
    const cid = messagingFocusCustomerId?.trim();
    if (!cid) return;
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/${encodeURIComponent(cid)}`,
          {
            headers: apiAuth(),
          },
        );
        if (!res.ok) {
          onMessagingFocusConsumed?.();
          return;
        }
        const c = (await res.json()) as {
          id: string;
          customer_code: string;
          first_name: string;
          last_name: string;
          company_name?: string | null;
          email?: string | null;
          phone?: string | null;
        };
        setPicked({
          id: String(c.id),
          customer_code: c.customer_code ?? "",
          first_name: c.first_name,
          last_name: c.last_name,
          company_name: c.company_name ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
        });
        if (messagingFocusHubTab === "messages") {
          setHubInitialTab("messages");
        }
        onMessagingFocusConsumed?.();
      } catch {
        onMessagingFocusConsumed?.();
      }
    })();
  }, [
    messagingFocusCustomerId,
    messagingFocusHubTab,
    apiAuth,
    onMessagingFocusConsumed,
  ]);

  const closeAddDrawer = useCallback(() => {
    setShowAddDrawer(false);
    if (activeSection === "add") onNavigateSubSection?.("all");
  }, [activeSection, onNavigateSubSection]);
  const [_qDebounced, setQDebounced] = useState("");
  const [vipOnly, setVipOnly] = useState(false);
  const [balanceDueOnly, setBalanceDueOnly] = useState(false);
  const [weddingSoonOnly, setWeddingSoonOnly] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState<
    CustomerLifecycleState | ""
  >("");
  const [rows, setRows] = useState<CustomerBrowseRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [_weddingPartyQuery, _setWeddingPartyQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [pipelineStats, setPipelineStats] =
    useState<CustomerPipelineStats | null>(null);
  const [picked, setPicked] = useState<Customer | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [_tableFocus, _setTableFocus] = useState(false);
  const [customerGroups, setCustomerGroups] = useState<
    { id: string; code: string; label: string }[]
  >([]);
  const [groupFilterCode, setGroupFilterCode] = useState("");
  const [bulkGroupId, setBulkGroupId] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeMasterId, setMergeMasterId] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [hubInitialTab, setHubInitialTab] = useState<HubTab | null>(null);
  const [mergePreview, setMergePreview] = useState<{
    orders: number;
    wedding_members: number;
    wedding_appointments: number;
    gift_cards: number;
    timeline_notes: number;
    customer_group_memberships: number;
    alteration_orders: number;
    loyalty_points_on_slave: number;
    store_credit_balance_on_slave: string | null;
  } | null>(null);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);

  useShellBackdropLayer(mergeOpen);
  const { dialogRef: mergeDialogRef, titleId: mergeTitleId } =
    useDialogAccessibility(mergeOpen, {
      onEscape: () => setMergeOpen(false),
      closeOnEscape: !mergeBusy,
    });

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(_q.trim()), 280);
    return () => clearTimeout(t);
  }, [_q]);

  const buildBrowseParams = useCallback(
    (offset: number) => {
      const p = new URLSearchParams();
      if (_qDebounced.length > 0) p.set("q", _qDebounced);
      if (vipOnly) p.set("vip_only", "true");
      if (balanceDueOnly) p.set("balance_due_only", "true");
      if (weddingSoonOnly) p.set("wedding_soon_only", "true");
      if (lifecycleFilter) p.set("lifecycle", lifecycleFilter);
      if (_weddingPartyQuery.trim().length > 0) {
        p.set("wedding_party_q", _weddingPartyQuery.trim());
      }
      if (groupFilterCode.trim().length > 0) {
        p.set("group_code", groupFilterCode.trim());
      }
      p.set("wedding_within_days", "30");
      p.set("limit", String(BROWSE_PAGE_SIZE));
      p.set("offset", String(offset));
      return p;
    },
    [
      _qDebounced,
      vipOnly,
      balanceDueOnly,
      weddingSoonOnly,
      lifecycleFilter,
      _weddingPartyQuery,
      groupFilterCode,
    ],
  );

  const fetchBrowsePage = useCallback(
    async (offset: number): Promise<CustomerBrowseRow[]> => {
      const res = await fetch(
        `${baseUrl}/api/customers/browse?${buildBrowseParams(offset).toString()}`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("browse failed");
      return (await res.json()) as CustomerBrowseRow[];
    },
    [buildBrowseParams, apiAuth],
  );

  const browseFiltersKey = useMemo(
    () =>
      JSON.stringify({
        q: _qDebounced,
        vipOnly,
        balanceDueOnly,
        weddingSoonOnly,
        lifecycleFilter,
        wp: _weddingPartyQuery.trim(),
        group: groupFilterCode.trim(),
      }),
    [
      _qDebounced,
      vipOnly,
      balanceDueOnly,
      weddingSoonOnly,
      lifecycleFilter,
      _weddingPartyQuery,
      groupFilterCode,
    ],
  );

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/customers/groups`, {
          headers: apiAuth(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          id: string;
          code: string;
          label: string;
        }[];
        setCustomerGroups(Array.isArray(data) ? data : []);
      } catch {
        /* ignore */
      }
    })();
  }, [apiAuth]);

  const loadFirstPage = useCallback(
    async (clearList: boolean) => {
      if (clearList) {
        setRows([]);
        setHasMore(false);
      }
      setLoading(true);
      try {
        const data = await fetchBrowsePage(0);
        setRows(data);
        setHasMore(data.length === BROWSE_PAGE_SIZE);
      } catch {
        setRows([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [fetchBrowsePage],
  );

  useEffect(() => {
    void loadFirstPage(true);
  }, [browseFiltersKey, loadFirstPage]);

  const fetchPipelineStats = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/pipeline-stats`, {
        headers: apiAuth(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as CustomerPipelineStats;
      setPipelineStats(data);
    } catch {
      /* ignore */
    }
  }, [apiAuth]);

  const refresh = useCallback(() => {
    void loadFirstPage(false);
    void fetchPipelineStats();
  }, [loadFirstPage, fetchPipelineStats]);

  useEffect(() => {
    void fetchPipelineStats();
  }, [fetchPipelineStats]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const data = await fetchBrowsePage(rows.length);
      setRows((prev) => [...prev, ...data]);
      setHasMore(data.length === BROWSE_PAGE_SIZE);
    } catch {
      toast("Could not load more customers.", "error");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, loading, rows.length, fetchBrowsePage, toast]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === rows.length && rows.length > 0) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(rows.map((r) => r.id)));
  };

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  const customerQualitySummary = useMemo<CustomerQualitySummary>(() => {
    return rows.reduce(
      (summary, row) => {
        const hasPhone = Boolean(row.phone?.trim());
        const hasEmail = Boolean(row.email?.trim());
        return {
          visibleCustomers: summary.visibleCustomers + 1,
          incompleteProfiles:
            summary.incompleteProfiles +
            (customerProfileComplete(row) ? 0 : 1),
          missingPhone: summary.missingPhone + (hasPhone ? 0 : 1),
          missingEmail: summary.missingEmail + (hasEmail ? 0 : 1),
        };
      },
      {
        visibleCustomers: 0,
        incompleteProfiles: 0,
        missingPhone: 0,
        missingEmail: 0,
      },
    );
  }, [rows]);

  const bulkAddToWedding = () => {
    if (selected.size === 0) return;
    setShowBulkWeddingPrompt(true);
  };

  const executeBulkAddToWedding = async (partyIdRaw: string) => {
    const partyId = partyIdRaw.trim();
    if (!partyId) return;

    let ok = 0;
    let dup = 0;
    let fail = 0;
    for (const id of selected) {
      const res = await fetch(
        `${baseUrl}/api/weddings/parties/${partyId}/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ customer_id: id }),
        },
      );
      if (res.ok) {
        ok += 1;
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 400 && body.error?.includes("already a member")) {
        dup += 1;
      } else {
        fail += 1;
      }
    }

    toast(
      `Successfully added ${ok} customers. (Skipped: ${dup}, Failed: ${fail})`,
      ok > 0 ? "success" : "error",
    );
    setSelected(new Set());
    void refresh();
    onOpenWeddingParty(partyId);
  };

  const bulkToggleVip = async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    const anyNonVip = rows.some((r) => ids.includes(r.id) && !r.is_vip);
    const isVip = anyNonVip;
    const res = await fetch(`${baseUrl}/api/customers/bulk-vip`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiAuth() },
      body: JSON.stringify({ customer_ids: ids, is_vip: isVip }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "VIP update failed", "error");
      return;
    }
    toast(
      `${ids.length} customers updated to ${isVip ? "VIP" : "Regular"}`,
      "success",
    );
    setSelected(new Set());
    void refresh();
  };

  const bulkAssignToGroup = async () => {
    const gid = bulkGroupId.trim();
    if (!gid || selected.size === 0) return;
    let ok = 0;
    let fail = 0;
    for (const cid of selected) {
      const res = await fetch(`${baseUrl}/api/customers/group-members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ customer_id: cid, group_id: gid }),
      });
      if (res.ok) ok += 1;
      else fail += 1;
    }
    toast(
      `Group assign: ${ok} ok${fail ? `, ${fail} failed` : ""}`,
      fail ? "error" : "success",
    );
    setSelected(new Set());
    void refresh();
  };

  const openMergeModal = () => {
    if (selected.size !== 2) return;
    const two = rows.filter((r) => selected.has(r.id));
    if (two.length !== 2) return;
    setMergeMasterId(two[0].id);
    setMergePreview(null);
    setMergeOpen(true);
  };

  useEffect(() => {
    if (!mergeOpen || !mergeMasterId || selected.size !== 2) return;
    const two = rows.filter((r) => selected.has(r.id));
    if (two.length !== 2) return;
    const slave = two.find((r) => r.id !== mergeMasterId)?.id;
    if (!slave) return;
    let cancelled = false;
    setMergePreviewLoading(true);
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/customers/merge`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({
            master_customer_id: mergeMasterId,
            slave_customer_id: slave,
            dry_run: true,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          preview?: {
            orders: number;
            wedding_members: number;
            wedding_appointments: number;
            gift_cards: number;
            timeline_notes: number;
            customer_group_memberships: number;
            alteration_orders: number;
            loyalty_points_on_slave: number;
            store_credit_balance_on_slave: string | null;
          };
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setMergePreview(null);
          return;
        }
        setMergePreview(body.preview ?? null);
      } catch {
        if (!cancelled) setMergePreview(null);
      } finally {
        if (!cancelled) setMergePreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mergeOpen, mergeMasterId, selected, rows, apiAuth]);

  const executeMerge = async () => {
    if (selected.size !== 2 || !mergeMasterId) return;
    const two = rows.filter((r) => selected.has(r.id));
    const slave = two.find((r) => r.id !== mergeMasterId)?.id;
    if (!slave) return;
    setMergeBusy(true);
    try {
      const h = new Headers({ "Content-Type": "application/json" });
      const base = apiAuth();
      if (base && typeof base === "object") {
        for (const [k, v] of Object.entries(base as Record<string, string>)) {
          if (v != null) h.set(k, String(v));
        }
      }
      const res = await fetch(`${baseUrl}/api/customers/merge`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          master_customer_id: mergeMasterId,
          slave_customer_id: slave,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(body.error ?? "Merge failed", "error");
        return;
      }
      toast("Customers merged", "success");
      setMergeOpen(false);
      setSelected(new Set());
      void refresh();
    } catch {
      toast("Merge network error", "error");
    } finally {
      setMergeBusy(false);
    }
  };

  const exportSelectedContacts = () => {
    if (selectedRows.length === 0) return;
    const header = [
      "customer_code",
      "first_name",
      "last_name",
      "company_name",
      "email",
      "phone",
      "open_balance_due",
      "is_vip",
      "wedding_soon_30d",
    ];
    const lines = [header.join(",")];
    for (const r of selectedRows) {
      lines.push(
        [
          escapeCsvCell(r.customer_code),
          escapeCsvCell(r.first_name),
          escapeCsvCell(r.last_name),
          escapeCsvCell(r.company_name ?? ""),
          escapeCsvCell(r.email ?? ""),
          escapeCsvCell(r.phone ?? ""),
          escapeCsvCell(r.open_balance_due),
          r.is_vip ? "true" : "false",
          r.wedding_soon ? "true" : "false",
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `riverside-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onTableKeyDown = (e: ReactKeyboardEvent) => {
    if (!_tableFocus) return;
    if (e.key === "Enter" && selected.size > 0) {
      const first = rows.find((r) => selected.has(r.id));
      if (first) {
        setHubInitialTab(null);
        setPicked(rowToCustomer(first));
      }
    }
  };

  const filterChip = (
    active: boolean,
    label: string,
    onClick: () => void,
    onRemove?: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
        active
          ? "ui-control-chip ui-control-chip-active shadow-sm"
          : "ui-control-chip"
      }`}
    >
      {label}
      {active && onRemove ? (
        <span
          role="presentation"
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove();
          }}
          className="rounded-full bg-app-surface px-1 text-[9px] text-app-text-muted"
        >
          ×
        </span>
      ) : null}
    </button>
  );

  if (activeSection === "ship") {
    if (!permissionsLoaded) {
      return (
        <div className="ui-page flex flex-1 items-center justify-center p-6 text-sm text-app-text-muted">
          Loading…
        </div>
      );
    }
    if (!hasPermission("shipments.view")) {
      return (
        <div className="ui-page p-6">
          <p className="text-sm text-app-text-muted">
            You don&apos;t have access to Shipments (shipments.view).
          </p>
        </div>
      );
    }
    return (
      <ShipmentsHubSection onOpenTransactionInBackoffice={onOpenTransactionInBackoffice} />
    );
  }

  if (activeSection === "layaways") {
    return (
      <div className="ui-page flex h-full flex-col overflow-hidden">
        <LayawayWorkspace onOpenTransaction={onOpenTransactionInBackoffice} />
      </div>
    );
  }

  if (activeSection === "rms-charge") {
    if (!permissionsLoaded) {
      return (
        <div className="ui-page flex flex-1 items-center justify-center p-6 text-sm text-app-text-muted">
          Loading…
        </div>
      );
    }
    if (
      !hasPermission("customers.rms_charge") &&
      !hasPermission("customers.rms_charge.view") &&
      !hasPermission("customers.rms_charge.manage_links") &&
      !hasPermission("customers.rms_charge.reporting") &&
      !hasPermission("customers.rms_charge.resolve_exceptions") &&
      !hasPermission("customers.rms_charge.reconcile") &&
      !hasPermission("pos.rms_charge.use") &&
      !hasPermission("pos.rms_charge.lookup")
    ) {
      return (
        <div className="ui-page p-6">
          <p className="text-sm text-app-text-muted">
            You don&apos;t have access to RMS charge reporting.
          </p>
        </div>
      );
    }
    return (
      <RmsChargeAdminSection
        surface={surface}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      />
    );
  }

  if (activeSection === "duplicate-review") {
    if (!permissionsLoaded) {
      return (
        <div className="ui-page flex flex-1 items-center justify-center p-6 text-sm text-app-text-muted">
          Loading…
        </div>
      );
    }
    if (!hasPermission("customers_duplicate_review")) {
      return (
        <div className="ui-page p-6">
          <p className="text-sm text-app-text-muted">
            You don&apos;t have access to the duplicate review queue.
          </p>
        </div>
      );
    }
    return (
      <DuplicateReviewQueueSection
        onNavigateAllCustomers={() => onNavigateSubSection?.("all")}
        onOpenWeddingParty={onOpenWeddingParty}
        onStartSale={onStartSaleInPos}
        onNavigateRegister={onNavigateRegister}
        onAddToWedding={onAddToWedding}
        onBookAppointment={onBookAppointment}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      />
    );
  }

  return (
    <div className="ui-page flex-1 p-0 bg-transparent flex flex-col">
      <div className="flex flex-1 flex-col bg-transparent">
        {/* Pipeline Strip */}
        <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
          {[
            {
              label: "Total CRM",
              count: pipelineStats?.total_customers,
              icon: Users,
              color: "text-app-info",
              bg: "bg-app-info/8",
              border: "border-app-info/16",
              tint: "ui-tint-info",
            },
            {
              label: "VIP Premium",
              count: pipelineStats?.vip_customers,
              icon: Gem,
              color: "text-app-warning",
              bg: "bg-app-warning/8",
              border: "border-app-warning/16",
              tint: "ui-tint-warning",
            },
            {
              label: "Balance Recovery",
              count: pipelineStats?.with_balance,
              icon: Wallet,
              color: "text-app-danger",
              bg: "bg-app-danger/8",
              border: "border-app-danger/16",
              tint: "ui-tint-danger",
            },
            {
              label: "Occasions (30d)",
              count: pipelineStats?.upcoming_weddings,
              icon: Heart,
              color: "text-app-accent",
              bg: "bg-app-accent/8",
              border: "border-app-accent/16",
              tint: "ui-tint-accent",
            },
          ].map((stat, i) => (
            <div
              key={i}
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
                  {stat.count ?? "—"}
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
                  Customer Completeness
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  Visible CRM rows missing the phone or email Riverside already uses for a complete customer profile.
                </p>
              </div>
              <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {customerQualitySummary.visibleCustomers} customers in view
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {[
                ["Profiles incomplete", customerQualitySummary.incompleteProfiles],
                ["Missing phone", customerQualitySummary.missingPhone],
                ["Missing email", customerQualitySummary.missingEmail],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="ui-metric-cell px-3 py-3"
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
        </div>

        <div className="flex flex-1 flex-col p-4 sm:p-8 animate-workspace-snap">
          <div className="ui-card flex flex-col">
            {/* Toolbar */}
            <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-app-border bg-app-surface-2 px-5 py-4">
              <div className="relative group min-w-[300px] flex-1">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors"
                  size={16}
                />
                <input
                  value={_q}
                  onChange={(e) => _setQ(e.target.value)}
                  placeholder="Search name, code, company, contact..."
                  className="ui-input w-full pl-10 text-sm font-bold shadow-sm focus:border-app-accent"
                />
              </div>

              <div className="flex items-center gap-2">
                <div className="relative group w-64">
                  {_weddingPartyQuery ? (
                    <div className="flex h-9 items-center justify-between rounded-xl border border-app-accent bg-app-accent/5 px-3">
                      <span className="truncate text-[10px] font-black uppercase tracking-widest text-app-accent">
                        Party: {_weddingPartyQuery}
                      </span>
                      <button
                        type="button"
                        onClick={() => _setWeddingPartyQuery("")}
                        className="ml-2 text-app-accent hover:text-app-text"
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  ) : (
                    <WeddingPartySearchInput
                      placeholder="Filter by party…"
                      onSelect={(p) =>
                        _setWeddingPartyQuery(p.party_name || p.groom_name)
                      }
                    />
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setShowAddDrawer(true)}
                  className="flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-xs font-black uppercase tracking-tight text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95"
                >
                  <UserPlus size={16} />
                  Add Customer
                </button>

                <button
                  type="button"
                  onClick={onPickImportFile}
                  className="flex items-center justify-center rounded-xl bg-app-surface-2 p-2.5 text-app-text-muted border border-app-border hover:bg-app-surface transition-colors"
                  title="Import CSV"
                >
                  <Upload size={18} />
                </button>
                <input
                  type="file"
                  ref={importFileRef}
                  className="hidden"
                  accept=".csv"
                  onChange={onImportFileChange}
                />

                <button
                  type="button"
                  onClick={() => void refresh()}
                  className={`flex items-center justify-center rounded-xl bg-app-surface-2 p-2.5 text-app-text-muted border border-app-border hover:bg-app-surface transition-colors ${loading ? "animate-spin" : ""}`}
                >
                  <Activity size={18} />
                </button>
              </div>
            </div>

            {/* Filter Row */}
            <div className="flex shrink-0 items-center justify-between border-b border-app-border bg-app-surface-3 px-5 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-50 mr-2">
                  Quick Filters
                </span>
                {filterChip(
                  vipOnly,
                  "VIP only",
                  () => setVipOnly((v) => !v),
                  () => setVipOnly(false),
                )}
                {filterChip(
                  balanceDueOnly,
                  "Balance due",
                  () => setBalanceDueOnly((v) => !v),
                  () => setBalanceDueOnly(false),
                )}
                {filterChip(
                  weddingSoonOnly,
                  "Upcoming Wedding",
                  () => setWeddingSoonOnly((v) => !v),
                  () => setWeddingSoonOnly(false),
                )}

                <div className="h-4 w-[1px] bg-app-border/40 mx-2" />

                <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-80">
                  Lifecycle
                  <select
                    value={lifecycleFilter}
                    onChange={(e) =>
                      setLifecycleFilter(
                        (e.target.value as CustomerLifecycleState | "") ?? "",
                      )
                    }
                    className="ui-input max-w-[140px] appearance-none py-1 text-xs font-black bg-transparent border-none text-app-accent underline underline-offset-4"
                  >
                    <option value="">All States</option>
                    {CUSTOMER_LIFECYCLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-80">
                  Segment
                  <select
                    value={groupFilterCode}
                    onChange={(e) => setGroupFilterCode(e.target.value)}
                    className="ui-input max-w-[140px] appearance-none py-1 text-xs font-black bg-transparent border-none text-app-accent underline underline-offset-4"
                  >
                    <option value="">All Groups</option>
                    {customerGroups.map((g) => (
                      <option key={g.id} value={g.code}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="text-[10px] font-black uppercase tracking-widest text-app-text-disabled">
                {rows.length} records detected
              </div>
            </div>

            {/* Main Table Content */}
            <div
              tabIndex={0}
              role="region"
              aria-label="Customer CRM Grid"
              onFocus={() => _setTableFocus(true)}
              onBlur={() => _setTableFocus(false)}
              onKeyDown={onTableKeyDown}
              className="ui-table-shell min-w-0 outline-none"
            >
              <table className="w-full border-separate border-spacing-0 text-left text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-app-surface-3 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted transition-colors">
                    <th className="w-12 px-5 py-4 border-b border-app-border">
                      <input
                        type="checkbox"
                        checked={
                          rows.length > 0 && selected.size === rows.length
                        }
                        onChange={toggleSelectAll}
                        className="h-4 w-4 rounded border-app-border text-app-accent focus:ring-0"
                      />
                    </th>
                    <th className="px-5 py-4 border-b border-app-border">
                      Customer & ID
                    </th>
                    <th className="px-5 py-4 border-b border-app-border">
                      Contact Details
                    </th>
                    <th className="px-5 py-4 border-b border-app-border text-right">
                      Open Balance
                    </th>
                    <th className="px-5 py-4 border-b border-app-border text-right">
                      Lifetime Sales
                    </th>
                    <th className="px-5 py-4 border-b border-app-border text-center">
                      Wedding Party
                    </th>
                    <th className="px-5 py-4 border-b border-app-border text-center">
                      Stats
                    </th>
                    <th className="w-16 px-5 py-4 border-b border-app-border text-center">
                      VIP
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/30">
                  {rows.map((r) => {
                    const hasBalance =
                      parseMoneyToCents(r.open_balance_due) > 0;
                    return (
                      <tr
                        key={r.id}
                        className={`group transition-all hover:bg-app-accent/[0.04] ${selected.has(r.id) ? "bg-app-accent/[0.08]" : ""}`}
                      >
                        <td className="px-5 py-4 align-middle">
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleSelect(r.id)}
                            className="h-4 w-4 rounded border-app-border text-app-accent focus:ring-0"
                          />
                        </td>
                        <td className="px-5 py-4 align-middle">
                          <button
                            type="button"
                            onClick={() => {
                              setHubInitialTab(null);
                              setPicked(rowToCustomer(r));
                            }}
                            className="flex flex-col text-left group-hover:translate-x-1 transition-transform"
                          >
                            <span className="text-sm font-black tracking-tight text-app-text group-hover:text-app-accent">
                              {r.first_name} {r.last_name}
                            </span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="font-mono text-[9px] uppercase tracking-widest text-app-text-disabled">
                                {r.customer_code}
                              </span>
                              {r.company_name && (
                                <>
                                  <span className="h-1 w-1 rounded-full bg-app-border" />
                                  <span className="text-[9px] font-black uppercase tracking-tight text-app-accent">
                                    {r.company_name}
                                  </span>
                                </>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span
                                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${customerLifecycleBadgeClassName(
                                  r.lifecycle_state,
                                )}`}
                              >
                                {customerLifecycleLabel(r.lifecycle_state)}
                              </span>
                              {!customerProfileComplete(r) ? (
                                <span className="inline-flex items-center rounded-full border border-app-warning/16 bg-app-warning/8 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-app-warning">
                                  Profile incomplete
                                </span>
                              ) : null}
                            </div>
                          </button>
                        </td>
                        <td className="px-5 py-4 align-middle">
                          <div className="flex flex-col">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-app-text">
                              {r.phone || (
                                <CheckCircle2
                                  size={12}
                                  className="text-app-text-disabled"
                                />
                              )}
                              {r.phone}
                            </span>
                            <span className="text-[10px] font-medium lowercase tracking-tight text-app-text-muted">
                              {r.email || "No email"}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-4 align-middle text-right">
                          <div
                            className={`font-mono text-sm font-black tabular-nums transition-colors ${hasBalance ? "text-app-danger" : "text-app-text-disabled"}`}
                          >
                            {moneyDec(r.open_balance_due)}
                          </div>
                          <div className="text-[8px] font-black uppercase tracking-[0.2em] text-app-text-disabled">
                            Balance Due
                          </div>
                        </td>
                        <td className="px-5 py-4 align-middle text-right">
                          <div className="font-mono text-sm font-black tabular-nums text-app-success">
                            {moneyDec(r.lifetime_sales)}
                          </div>
                          <div className="text-[8px] font-black uppercase tracking-[0.2em] text-app-text-disabled">
                            LTV Sales
                          </div>
                        </td>
                        <td className="px-5 py-4 align-middle text-center">
                          {r.wedding_active ? (
                            <button
                              type="button"
                              onClick={() =>
                                r.wedding_party_id &&
                                onOpenWeddingParty(r.wedding_party_id)
                              }
                              className="inline-flex items-center gap-2 rounded-full border border-app-danger/16 bg-app-danger/8 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-app-danger shadow-sm transition-all hover:bg-app-danger/12 active:scale-95"
                            >
                              <Heart size={10} fill="currentColor" />
                              {r.wedding_party_name || "Active Party"}
                            </button>
                          ) : r.wedding_soon ? (
                            <div className="inline-flex items-center gap-2 rounded-full border border-app-warning/16 bg-app-warning/8 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-app-warning">
                              <Clock size={10} />
                              Party Soon
                            </div>
                          ) : (
                            <span className="text-app-text-disabled">—</span>
                          )}
                        </td>
                        <td className="px-5 py-4 align-middle text-center">
                          <div className="flex items-center justify-center gap-3">
                            <div className="flex flex-col items-center group/ord">
                              <ShoppingBag
                                size={14}
                                className={`transition-colors ${r.open_orders_count > 0 ? "text-app-accent" : "text-app-text-disabled"}`}
                              />
                              <span className="text-[9px] font-black tabular-nums text-app-text-muted">
                                {r.open_orders_count > 0
                                  ? r.open_orders_count
                                  : 0}
                              </span>
                            </div>
                            <div className="h-6 w-[1px] bg-app-border/20" />
                            <div className="flex flex-col items-center">
                              <Truck
                                size={14}
                                className={`transition-colors ${r.active_shipment_status ? "text-app-info" : "text-app-text-disabled"}`}
                              />
                              <span className="text-[9px] font-black uppercase tracking-tighter text-app-text-muted">
                                {r.active_shipment_status
                                  ? r.active_shipment_status.replace(/_/g, " ")
                                  : "Ship"}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 align-middle text-center">
                          {r.is_vip ? (
                            <div className="flex items-center justify-center">
                              <div className="relative">
                                <Gem
                                  size={20}
                                  className="text-app-warning drop-shadow-sm animate-pulse"
                                />
                                <div className="absolute inset-0 rounded-full bg-app-warning/20 blur-lg" />
                              </div>
                            </div>
                          ) : (
                            <span className="text-app-text-disabled">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {hasMore && (
                <div className="flex flex-col items-center justify-center border-t border-app-border/50 bg-app-surface-2/50 py-8">
                  <button
                    type="button"
                    onClick={() => void loadMore()}
                    disabled={loadingMore || loading}
                    className="group relative flex items-center gap-3 rounded-2xl bg-app-surface border border-app-border px-8 py-3 text-xs font-black uppercase tracking-[0.2em] text-app-text shadow-lg transition-all hover:-translate-y-1 active:translate-y-0"
                  >
                    {loadingMore ? "Synchronizing..." : "Load more records"}
                    <ChevronRight
                      size={16}
                      className="group-hover:translate-x-1 transition-transform"
                    />
                  </button>
                  <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                    Showing {rows.length} of{" "}
                    {pipelineStats?.total_customers ?? "thousands"}
                  </p>
                </div>
              )}

              {!loading && rows.length === 0 && (
                <div className="flex flex-col items-center justify-center p-20 text-center">
                  <div className="mb-4 rounded-3xl bg-app-surface-2 p-6 border border-dashed border-app-border">
                    <Users
                      size={48}
                      className="text-app-text-muted opacity-20"
                    />
                  </div>
                  <h3 className="text-lg font-black text-app-text">
                    No matches found
                  </h3>
                  <p className="text-sm text-app-text-muted max-w-xs mx-auto">
                    Try adjusting your filters or search terms for a broader
                    overview of the CRM.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between px-2 shrink-0">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-app-success shadow-sm" />
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Live Sync Enabled
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-app-accent shadow-sm shadow-app-accent/50" />
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  High Density Grid
                </span>
              </div>
            </div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-disabled">
              Riverside OS CRM — Performance-First Architecture
            </p>
          </div>
        </div>
      </div>

      <FloatingBulkBar
        count={selected.size}
        onClearSelection={() => setSelected(new Set())}
        label="Customer bulk actions"
      >
        {hasPermission("customer_groups.manage") ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={bulkGroupId}
              onChange={(e) => setBulkGroupId(e.target.value)}
              className="ui-input max-w-[180px] py-2 text-xs font-semibold"
            >
              <option value="">Assign to group…</option>
              {customerGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void bulkAssignToGroup()}
              className="ui-btn-secondary px-3 py-2"
            >
              Apply group
            </button>
          </div>
        ) : null}
        {hasPermission("customers.merge") && selected.size === 2 ? (
          <button
            type="button"
            onClick={openMergeModal}
            className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-warning"
          >
            Merge 2 records
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void bulkAddToWedding()}
          className="ui-btn-primary px-3 py-2"
        >
          Add to wedding
        </button>
        <button
          type="button"
          onClick={() => void bulkToggleVip()}
          className="ui-btn-secondary px-3 py-2"
        >
          Toggle VIP
        </button>
        <button
          type="button"
          onClick={exportSelectedContacts}
          className="ui-btn-secondary px-3 py-2"
        >
          Export contact list
        </button>
        <button
          type="button"
          onClick={onAddToWedding}
          className="rounded-xl border border-dashed border-app-border bg-[color-mix(in_srgb,var(--app-accent)_12%,var(--app-surface-2))] px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors"
        >
          Open weddings
        </button>
      </FloatingBulkBar>

      {mergeOpen ? (
        <div className="ui-overlay-backdrop flex items-center justify-center p-4">
          <div
            ref={mergeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={mergeTitleId}
            tabIndex={-1}
            className="ui-modal w-full max-w-lg animate-in zoom-in-95 duration-200 outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ui-modal-header">
              <h3
                id={mergeTitleId}
                className="text-lg font-black uppercase tracking-tight text-app-text"
              >
                Merge customers
              </h3>
            </div>
            <div className="space-y-4 p-5 text-sm text-app-text">
              <p className="text-xs text-app-text-muted">
                The master record is kept; the other is removed after
                re-pointing orders and wedding links. This cannot be undone.
              </p>
              {mergePreviewLoading ? (
                <p className="text-xs text-app-text-muted">
                  Loading impact preview…
                </p>
              ) : mergePreview ? (
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3 text-xs text-app-text">
                  <p className="mb-2 font-black uppercase tracking-widest text-app-text-muted">
                    Records to re-point (slave)
                  </p>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    <li>Orders: {mergePreview.orders}</li>
                    <li>Wedding members: {mergePreview.wedding_members}</li>
                    <li>Appointments: {mergePreview.wedding_appointments}</li>
                    <li>Gift cards: {mergePreview.gift_cards}</li>
                    <li>Timeline notes: {mergePreview.timeline_notes}</li>
                    <li>
                      Group memberships:{" "}
                      {mergePreview.customer_group_memberships}
                    </li>
                    <li>Alterations: {mergePreview.alteration_orders}</li>
                    <li>
                      Loyalty pts (slave):{" "}
                      {mergePreview.loyalty_points_on_slave}
                    </li>
                    <li className="sm:col-span-2">
                      Store credit (slave):{" "}
                      {mergePreview.store_credit_balance_on_slave ?? "—"}
                    </li>
                  </ul>
                </div>
              ) : null}
              {selectedRows.slice(0, 2).map((r) => (
                <label
                  key={r.id}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-app-border p-3"
                >
                  <input
                    type="radio"
                    name="merge-master"
                    checked={mergeMasterId === r.id}
                    onChange={() => setMergeMasterId(r.id)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-bold">
                      {r.first_name} {r.last_name}
                    </p>
                    <p className="font-mono text-xs text-app-text-muted">
                      {r.customer_code}
                    </p>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-app-border p-4">
              <button
                type="button"
                disabled={mergeBusy}
                onClick={() => setMergeOpen(false)}
                className="ui-btn-secondary px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={mergeBusy || !mergeMasterId}
                onClick={() => void executeMerge()}
                className="min-h-11 rounded-xl border-b-8 border-app-success bg-app-success px-4 py-2 text-sm font-black uppercase tracking-wide text-white shadow-lg transition-all hover:brightness-110 active:translate-y-0.5 active:border-b-4 disabled:opacity-50"
              >
                {mergeBusy ? "Merging…" : "Merge"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {picked ? (
        <CustomerRelationshipHubDrawer
          customer={picked}
          open
          initialHubTab={hubInitialTab ?? undefined}
          onClose={() => {
            setPicked(null);
            setHubInitialTab(null);
          }}
          onOpenWeddingParty={onOpenWeddingParty}
          onStartSale={onStartSaleInPos}
          onNavigateRegister={onNavigateRegister}
          navigateAfterStartSale
          onAddToWedding={onAddToWedding}
          onBookAppointment={onBookAppointment}
          onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
          baseUrl={baseUrl}
        />
      ) : null}

      <AddCustomerDrawer
        isOpen={showAddDrawer}
        onClose={closeAddDrawer}
        onSaved={() => {
          closeAddDrawer();
          void refresh();
        }}
      />

      {showBulkWeddingPrompt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowBulkWeddingPrompt(false)}
          />
          <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-app-border bg-app-surface p-6 shadow-2xl ring-1 ring-black/10 transition-all animate-in zoom-in-95 duration-200">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent">
                <Users size={20} />
              </div>
              <h2 className="text-sm font-black uppercase tracking-widest text-app-text">
                Bulk Wedding Assignment
              </h2>
            </div>

            <p className="mb-6 text-xs text-app-text-muted">
              Select the wedding party to assign these **{selected.size}**
              customers to. Searching by groom name or party tag is recommended.
            </p>

            <div className="space-y-4">
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">
                Target Wedding Party
                <WeddingPartySearchInput
                  className="mt-1"
                  onSelect={(p) => {
                    void executeBulkAddToWedding(p.id);
                    setShowBulkWeddingPrompt(false);
                  }}
                  placeholder="Search by groom name..."
                />
              </label>

              <div className="mt-8 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowBulkWeddingPrompt(false)}
                  className="ui-btn-secondary px-6 py-2 text-[10px] font-black uppercase"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={importConfirmOpen}
        onClose={() => {
          if (importLoading) return;
          setImportConfirmOpen(false);
          setPendingImportRows(null);
        }}
        onConfirm={() => void runLightspeedImport()}
        title="Import Lightspeed customers"
        message={`Upload will upsert ${pendingImportRows?.length ?? 0} rows on customer_code (Lightspeed export). Existing Riverside codes are not overwritten by this file unless the code matches. Rows with missing codes or email conflicts are skipped or adjusted; a CSV of issues downloads automatically when present.`}
        confirmLabel="Run import"
        variant="info"
        loading={importLoading}
      />
    </div>
  );
}

/* ── Add Customer Drawer ─────────────────────────────────────────────────── */

interface AddCustomerForm {
  first_name: string;
  last_name: string;
  company_name: string;
  date_of_birth: string;
  anniversary_date: string;
  custom_field_1: string;
  custom_field_2: string;
  custom_field_3: string;
  custom_field_4: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  marketing_email_opt_in: boolean;
  marketing_sms_opt_in: boolean;
  transactional_sms_opt_in: boolean;
  phone_primary_label: string;
  phone_secondary_label: string;
  phone_secondary: string;
  is_vip: boolean;
  notes: string;
}

const EMPTY_ADD_CUSTOMER_FORM: AddCustomerForm = {
  first_name: "",
  last_name: "",
  company_name: "",
  date_of_birth: "",
  anniversary_date: "",
  custom_field_1: "",
  custom_field_2: "",
  custom_field_3: "",
  custom_field_4: "",
  email: "",
  phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postal_code: "",
  marketing_email_opt_in: false,
  marketing_sms_opt_in: false,
  transactional_sms_opt_in: false,
  phone_primary_label: "Primary",
  phone_secondary_label: "Secondary",
  phone_secondary: "",
  is_vip: false,
  notes: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const POSTAL_RE = /^\d{5}(?:-\d{4})?$/;
const STATE_ABBREVIATIONS: Record<string, string> = {
  ALABAMA: "AL",
  ALASKA: "AK",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL",
  GEORGIA: "GA",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
};

function formatPhoneInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function normalizeStateInput(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return STATE_ABBREVIATIONS[upper] ?? upper.slice(0, 2);
}

interface DuplicateCandidateRow {
  id: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  match_reason: string;
}

type AddCustomerDraft = Partial<
  Pick<
    AddCustomerForm,
    | "first_name"
    | "last_name"
    | "email"
    | "phone"
    | "address_line1"
    | "address_line2"
    | "city"
    | "state"
    | "postal_code"
  >
>;

function formatDuplicateAddress(candidate: DuplicateCandidateRow): string {
  return [
    candidate.address_line1,
    candidate.address_line2,
    [candidate.city, candidate.state].filter(Boolean).join(", "),
    candidate.postal_code,
  ]
    .filter(Boolean)
    .join(" ");
}

function duplicateReasonLabel(reason: string): string {
  switch (reason) {
    case "same_phone_digits":
      return "Phone match";
    case "same_email":
      return "Email match";
    case "same_name_zip":
      return "Name and ZIP match";
    case "same_name":
      return "Same name";
    default:
      return reason.replace(/_/g, " ");
  }
}

export function AddCustomerDrawer({
  isOpen,
  onClose,
  onSaved,
  initialDraft,
  onCreatedCustomer,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  initialDraft?: AddCustomerDraft;
  onCreatedCustomer?: (customer: Customer) => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [form, setForm] = useState<AddCustomerForm>(() => ({
    ...EMPTY_ADD_CUSTOMER_FORM,
  }));
  const [dupCandidates, setDupCandidates] = useState<DuplicateCandidateRow[]>(
    [],
  );
  const [dupLoading, setDupLoading] = useState(false);
  const [nameNeedsPhoneReview, setNameNeedsPhoneReview] = useState(false);
  const dupAbortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [emailPromptOpen, setEmailPromptOpen] = useState(false);
  const [emailPromptValue, setEmailPromptValue] = useState("");

  const set = (k: keyof AddCustomerForm, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const email = form.email.trim();
  const state = form.state.trim();
  const postal = form.postal_code.trim();
  const phoneDigits = form.phone.replace(/\D/g, "");

  const errors = {
    first_name:
      form.first_name.trim().length === 0 ? "First name is required." : "",
    last_name:
      form.last_name.trim().length === 0 ? "Last name is required." : "",
    email:
      email.length > 0 && !EMAIL_RE.test(email)
        ? "Enter a valid email address."
        : "",
    phone:
      phoneDigits.length > 0 && phoneDigits.length < 10
        ? "Phone must be 10 digits."
        : "",
    state:
      state.length > 0 && !STATE_RE.test(state)
        ? "Use 2-letter state code."
        : "",
    postal:
      postal.length > 0 && !POSTAL_RE.test(postal)
        ? "Use ZIP format 12345 or 12345-6789."
        : "",
  };

  const identityValid =
    !errors.first_name && !errors.last_name && !errors.phone;
  const formValid =
    identityValid &&
    !errors.email &&
    !errors.phone &&
    !errors.state &&
    !errors.postal;

  const resetForm = useCallback(() => {
    setForm({ ...EMPTY_ADD_CUSTOMER_FORM });
  }, []);

  const draftKey = JSON.stringify(initialDraft ?? {});

  useEffect(() => {
    if (!isOpen) return;
    setForm({
      ...EMPTY_ADD_CUSTOMER_FORM,
      ...(initialDraft ?? {}),
      phone: initialDraft?.phone
        ? formatPhoneInput(initialDraft.phone)
        : EMPTY_ADD_CUSTOMER_FORM.phone,
      state: initialDraft?.state
        ? initialDraft.state.toUpperCase()
        : EMPTY_ADD_CUSTOMER_FORM.state,
    });
    setTouched({});
    setErr(null);
    setDupCandidates([]);
    setNameNeedsPhoneReview(false);
  }, [isOpen, draftKey, initialDraft]);

  useEffect(() => {
    if (!isOpen) {
      setEmailPromptOpen(false);
      setEmailPromptValue("");
      setErr(null);
      setTouched({});
      setDupCandidates([]);
      setNameNeedsPhoneReview(false);
      dupAbortRef.current?.abort();
      resetForm();
    }
  }, [isOpen, resetForm]);

  useEffect(() => {
    if (!isOpen) return;
    const em = form.email.trim();
    const fn = form.first_name.trim();
    const ln = form.last_name.trim();
    const zip = form.postal_code.trim();
    const pd = form.phone.replace(/\D/g, "");
    const emailOk = em.length > 0 && EMAIL_RE.test(em);
    const phoneOk = pd.length >= 10;
    const nameOk = fn.length > 0 && ln.length > 0;
    const postalOk = zip.length > 0 && POSTAL_RE.test(zip);
    if (!emailOk && !phoneOk && !nameOk) {
      setDupCandidates([]);
      setNameNeedsPhoneReview(false);
      return;
    }
    dupAbortRef.current?.abort();
    const ac = new AbortController();
    dupAbortRef.current = ac;
    const t = window.setTimeout(() => {
      void (async () => {
        setDupLoading(true);
        try {
          const p = new URLSearchParams();
          if (emailOk) p.set("email", em);
          if (phoneOk) p.set("phone", pd);
          if (nameOk) {
            p.set("first_name", fn);
            p.set("last_name", ln);
          }
          if (postalOk) p.set("postal_code", zip);
          p.set("limit", "12");
          const res = await fetch(
            `${baseUrl}/api/customers/duplicate-candidates?${p.toString()}`,
            { headers: apiAuth(), signal: ac.signal },
          );
          if (ac.signal.aborted) return;
          if (!res.ok) {
            setDupCandidates([]);
            return;
          }
          const rows = (await res.json()) as DuplicateCandidateRow[];
          const safeRows = Array.isArray(rows) ? rows : [];
          const hasNameMatch = safeRows.some((r) =>
            r.match_reason.startsWith("same_name"),
          );
          const waitingForPhone =
            nameOk && !phoneOk && !emailOk && hasNameMatch;
          setNameNeedsPhoneReview(waitingForPhone);
          setDupCandidates(waitingForPhone ? [] : safeRows);
        } catch {
          if (!ac.signal.aborted) {
            setDupCandidates([]);
            setNameNeedsPhoneReview(false);
          }
        } finally {
          if (!ac.signal.aborted) setDupLoading(false);
        }
      })();
    }, 450);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [
    isOpen,
    form.email,
    form.phone,
    form.first_name,
    form.last_name,
    form.postal_code,
    apiAuth,
  ]);

  useEffect(() => {
    if (!emailPromptOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setEmailPromptOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [emailPromptOpen]);

  const submitToApi = async (
    resolvedEmail: string,
    skipEmailPrompt = false,
  ) => {
    setTouched({
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      state: true,
      postal: true,
    });
    if (!formValid) {
      setErr("Please fix validation errors before saving.");
      return;
    }
    if (!resolvedEmail.trim() && !skipEmailPrompt) {
      setEmailPromptValue(form.email.trim());
      setEmailPromptOpen(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const primaryPhone = form.phone.trim();
      const phoneLine2 = form.phone_secondary.trim();
      const phonePrimaryLabel = form.phone_primary_label.trim() || "Primary";
      const phoneSecondaryLabel =
        form.phone_secondary_label.trim() || "Secondary";
      const combinedPhone = phoneLine2
        ? `${phonePrimaryLabel}: ${primaryPhone} | ${phoneSecondaryLabel}: ${phoneLine2}`
        : `${phonePrimaryLabel}: ${primaryPhone}`;
      const payload: Record<string, unknown> = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: resolvedEmail.trim() || null,
        phone: combinedPhone,
        address_line1: form.address_line1.trim() || null,
        address_line2: form.address_line2.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        postal_code: form.postal_code.trim() || null,
        marketing_email_opt_in: form.marketing_email_opt_in,
        marketing_sms_opt_in: form.marketing_sms_opt_in,
        transactional_sms_opt_in: form.transactional_sms_opt_in,
      };
      const co = form.company_name.trim();
      if (co) payload.company_name = co;
      const dob = form.date_of_birth.trim();
      if (dob) payload.date_of_birth = dob;
      const ann = form.anniversary_date.trim();
      if (ann) payload.anniversary_date = ann;
      const cf1 = form.custom_field_1.trim();
      const cf2 = form.custom_field_2.trim();
      const cf3 = form.custom_field_3.trim();
      const cf4 = form.custom_field_4.trim();
      if (cf1) payload.custom_field_1 = cf1;
      if (cf2) payload.custom_field_2 = cf2;
      if (cf3) payload.custom_field_3 = cf3;
      if (cf4) payload.custom_field_4 = cf4;
      const res = await fetch(`${baseUrl}/api/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Failed to create customer");
      }
      const created = (await res.json()) as {
        id: string;
        customer_code?: string;
      };
      if (created.customer_code) {
        toast(`Customer created — code ${created.customer_code}`, "success");
      }
      onCreatedCustomer?.(created as Customer);
      if (form.is_vip) {
        if (!hasPermission("customers.hub_edit")) {
          toast("VIP flag not saved: missing customers.hub_edit.", "error");
        } else {
          const vipRes = await fetch(`${baseUrl}/api/customers/${created.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...apiAuth() },
            body: JSON.stringify({ is_vip: true }),
          });
          if (!vipRes.ok) {
            const vb = (await vipRes.json().catch(() => ({}))) as {
              error?: string;
            };
            toast(vb.error ?? "Could not set VIP flag", "error");
          }
        }
      }
      if (form.notes.trim()) {
        if (!hasPermission("customers.timeline")) {
          toast("Note not saved: missing customers.timeline.", "error");
        } else {
          const noteRes = await fetch(
            `${baseUrl}/api/customers/${created.id}/notes`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                body: form.notes.trim(),
                created_by_staff_id: null,
              }),
            },
          );
          if (!noteRes.ok) {
            const nb = (await noteRes.json().catch(() => ({}))) as {
              error?: string;
            };
            toast(nb.error ?? "Could not save note", "error");
          }
        }
      }
      resetForm();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create customer");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitToApi(form.email.trim());
  };

  return (
    <>
      <DetailDrawer
        isOpen={isOpen}
        onClose={onClose}
        title="Add Customer"
        subtitle="Name, contact, address, dates, notes, and preferences."
        panelMaxClassName="max-w-5xl"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="ui-btn-secondary flex-1 py-3"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="add-customer-form"
              disabled={busy}
              className="ui-btn-primary flex-1 py-3 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Create customer"}
            </button>
          </div>
        }
      >
        <form
          id="add-customer-form"
          className="space-y-3"
          onSubmit={(e) => void handleSubmit(e)}
        >
          {err ? (
            <p className="rounded-lg border border-app-danger/20 bg-app-danger/10 px-3 py-2 text-sm font-semibold text-app-danger">
              {err}
            </p>
          ) : null}

          {(dupLoading || nameNeedsPhoneReview || dupCandidates.length > 0) && (
            <div
              className="rounded-lg border border-app-warning/35 bg-app-warning/10 p-3"
              data-testid="crm-duplicate-candidates"
            >
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-warning">
                <ShieldCheck size={14} />
                Duplicate review
              </div>
              {dupLoading ? (
                <p className="text-xs font-semibold text-app-text-muted">
                  Checking customer matches...
                </p>
              ) : nameNeedsPhoneReview ? (
                <p className="rounded-lg border border-app-warning/30 bg-app-surface px-3 py-2 text-xs font-semibold text-app-text">
                  This name already exists. Enter a phone number first so we can
                  check for a direct phone match before showing same-name
                  profiles.
                </p>
              ) : (
                <ul className="space-y-2 text-xs text-app-text">
                  {dupCandidates.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-lg border border-app-border bg-app-surface-2 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-black text-app-text">
                            {[c.first_name, c.last_name]
                              .filter(Boolean)
                              .join(" ") || "(no name)"}
                          </p>
                          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                            {c.customer_code}
                          </p>
                        </div>
                        <span className="rounded-full bg-app-warning/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-warning">
                          {duplicateReasonLabel(c.match_reason)}
                        </span>
                      </div>
                      <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div>
                          <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Phone
                          </dt>
                          <dd className="font-semibold text-app-text">
                            {c.phone || "No phone"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Email
                          </dt>
                          <dd className="break-all font-semibold text-app-text">
                            {c.email || "No email"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Address
                          </dt>
                          <dd className="font-semibold text-app-text">
                            {formatDuplicateAddress(c) || "No address"}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
              {!dupLoading && dupCandidates.length > 0 ? (
                <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                  If this is the same person, review the existing profile and
                  update contact details there instead of creating a duplicate.
                </p>
              ) : null}
            </div>
          )}

          <section className="rounded-xl border border-app-border bg-app-surface p-3 shadow-sm">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                First name *
                <input
                  value={form.first_name}
                  onBlur={() => setTouched((t) => ({ ...t, first_name: true }))}
                  onChange={(e) => set("first_name", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  required
                />
                {touched.first_name && errors.first_name ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.first_name}
                  </span>
                ) : null}
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Last name *
                <input
                  value={form.last_name}
                  onBlur={() => setTouched((t) => ({ ...t, last_name: true }))}
                  onChange={(e) => set("last_name", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  required
                />
                {touched.last_name && errors.last_name ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.last_name}
                  </span>
                ) : null}
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Phone
                <input
                  type="tel"
                  value={form.phone}
                  onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
                  onChange={(e) => set("phone", formatPhoneInput(e.target.value))}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="(555) 000-0000"
                />
                {touched.phone && errors.phone ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.phone}
                  </span>
                ) : null}
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Email
                <input
                  type="email"
                  value={form.email}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  onChange={(e) => set("email", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="customer@email.com"
                />
                {touched.email && errors.email ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.email}
                  </span>
                ) : null}
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted xl:col-span-2">
                Company
                <input
                  value={form.company_name}
                  onChange={(e) => set("company_name", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="Business or organization"
                />
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Date of birth
                <input
                  type="date"
                  value={form.date_of_birth}
                  onChange={(e) => set("date_of_birth", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Wedding / anniversary
                <input
                  type="date"
                  value={form.anniversary_date}
                  onChange={(e) => set("anniversary_date", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
            </div>
          </section>

          <section
            className="space-y-2 rounded-xl border border-app-border bg-app-surface p-3 shadow-sm"
            aria-labelledby="add-cust-address"
          >
            <h3
              id="add-cust-address"
              className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted"
            >
              <MapPin size={15} className="text-app-info" />
              Address
            </h3>
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-[1.4fr_0.9fr_0.9fr_96px_120px]">
              <AddressAutocompleteInput
                value={form.address_line1}
                onChange={(value) => set("address_line1", value)}
                onSelectAddress={(suggestion) => {
                  setForm((f) => ({
                    ...f,
                    address_line1: suggestion.address_line1,
                    city: suggestion.city,
                    state: normalizeStateInput(suggestion.state),
                    postal_code: suggestion.postal_code,
                  }));
                  setTouched((t) => ({ ...t, state: true, postal: true }));
                }}
              />
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Address line 2
                <input
                  value={form.address_line2}
                  onChange={(e) => set("address_line2", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="Suite, unit"
                />
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                City
                <input
                  value={form.city}
                  onChange={(e) => set("city", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                State
                <input
                  value={form.state}
                  onBlur={() => setTouched((t) => ({ ...t, state: true }))}
                  onChange={(e) => set("state", normalizeStateInput(e.target.value))}
                  className="ui-input mt-1 w-full text-sm"
                  maxLength={2}
                />
                {touched.state && errors.state ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.state}
                  </span>
                ) : null}
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                ZIP / postal code
                <input
                  value={form.postal_code}
                  onBlur={() => setTouched((t) => ({ ...t, postal: true }))}
                  onChange={(e) => set("postal_code", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
                {touched.postal && errors.postal ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.postal}
                  </span>
                ) : null}
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-app-border bg-app-surface p-3 shadow-sm">
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Notes
              <textarea
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                rows={2}
                className="ui-input mt-1 w-full resize-none text-sm"
                placeholder="Fitting notes, preferences..."
              />
            </label>
          </section>

          <section
            className="space-y-2 rounded-xl border border-app-border bg-app-surface p-3 shadow-sm"
            aria-labelledby="add-cust-prefs"
          >
            <h3
              id="add-cust-prefs"
              className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted"
            >
              <ShieldCheck size={15} className="text-app-warning" />
              Preferences
            </h3>
            <div className="flex flex-wrap gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
                  <input
                    type="checkbox"
                    checked={form.marketing_email_opt_in}
                    onChange={(e) =>
                      set("marketing_email_opt_in", e.target.checked)
                    }
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                  Email opt-in
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
                  <input
                    type="checkbox"
                    checked={form.marketing_sms_opt_in}
                    onChange={(e) =>
                      set("marketing_sms_opt_in", e.target.checked)
                    }
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                  SMS opt-in
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
                  <input
                    type="checkbox"
                    checked={form.transactional_sms_opt_in}
                    onChange={(e) =>
                      set("transactional_sms_opt_in", e.target.checked)
                    }
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                  Operational SMS (pickup / alterations)
                </label>
            </div>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 px-4 py-3">
              <input
                type="checkbox"
                checked={form.is_vip}
                onChange={(e) => set("is_vip", e.target.checked)}
                className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
              />
              <div>
                <p className="text-sm font-semibold text-app-text">
                  VIP customer
                </p>
                <p className="text-xs text-app-text-muted">
                  Mark for priority service and special pricing.
                </p>
              </div>
            </label>
          </section>

          <details className="rounded-xl border border-app-border bg-app-surface-2 p-3 [&_summary::-webkit-details-marker]:hidden">
            <summary className="cursor-pointer select-none text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Custom fields
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {([1, 2, 3, 4] as const).map((n) => (
                <label
                  key={n}
                  className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                >
                  Custom field {n}
                  <input
                    value={
                      form[`custom_field_${n}` as keyof AddCustomerForm] as string
                    }
                    onChange={(e) =>
                      set(
                        `custom_field_${n}` as keyof AddCustomerForm,
                        e.target.value,
                      )
                    }
                    className="ui-input mt-1 w-full text-sm"
                  />
                </label>
              ))}
            </div>
          </details>
        </form>
      </DetailDrawer>

      {emailPromptOpen && isOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 backdrop-blur-md"
              onClick={() => setEmailPromptOpen(false)}
              role="presentation"
            >
              <div
                className="ui-modal max-w-lg shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-cust-email-prompt-title"
              >
                <div className="ui-modal-header">
                  <h3
                    id="add-cust-email-prompt-title"
                    className="text-base font-black text-app-text"
                  >
                    Did you ask for their email?
                  </h3>
                  <p className="text-sm text-app-text-muted">
                    Email is optional, but recommended for receipts and
                    reminders.
                  </p>
                </div>
                <div className="ui-modal-body">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Email (optional)
                    <input
                      type="email"
                      value={emailPromptValue}
                      onChange={(e) => setEmailPromptValue(e.target.value)}
                      className="ui-input mt-1 w-full text-sm"
                      placeholder="customer@email.com"
                    />
                  </label>
                </div>
                <div className="ui-modal-footer">
                  <button
                    type="button"
                    className="ui-btn-secondary flex-1 py-3"
                    onClick={() => {
                      setEmailPromptOpen(false);
                      void submitToApi("", true);
                    }}
                  >
                    Save without email
                  </button>
                  <button
                    type="button"
                    className="ui-btn-primary flex-1 py-3"
                    onClick={() => {
                      setEmailPromptOpen(false);
                      void submitToApi(emailPromptValue);
                    }}
                  >
                    Save with email
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
