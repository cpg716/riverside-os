import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Gem, Search, Upload } from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import CustomerRelationshipHubDrawer from "./CustomerRelationshipHubDrawer";
import DuplicateReviewQueueSection from "./DuplicateReviewQueueSection";
import RmsChargeAdminSection from "./RmsChargeAdminSection";
import ShipmentsHubSection from "./ShipmentsHubSection";
import DetailDrawer from "../layout/DetailDrawer";
import FloatingBulkBar from "../ui/FloatingBulkBar";
import { useToast } from "../ui/ToastProvider";
import { useShellBackdropLayer } from "../layout/ShellBackdropContext";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import PromptModal from "../ui/PromptModal";
import ConfirmationModal from "../ui/ConfirmationModal";
import { parseCsv } from "../../lib/parseCsv";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
  onOpenOrderInBackoffice?: (orderId: string) => void;
  activeSection?: string;
  /** Reset sidebar subsection (e.g. after closing Add Customer from sidebar "add"). */
  onNavigateSubSection?: (id: string) => void;
  /** Notification / deep link: open hub for this customer. */
  messagingFocusCustomerId?: string | null;
  messagingFocusHubTab?: string;
  onMessagingFocusConsumed?: () => void;
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
  wedding_soon: boolean;
  wedding_active: boolean;
  wedding_party_name: string | null;
  wedding_party_id: string | null;
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

export default function CustomersWorkspace({
  onOpenWeddingParty,
  onStartSaleInPos,
  onNavigateRegister,
  onAddToWedding,
  onBookAppointment,
  onOpenOrderInBackoffice,
  activeSection,
  onNavigateSubSection,
  messagingFocusCustomerId,
  messagingFocusHubTab,
  onMessagingFocusConsumed,
}: CustomersWorkspaceProps) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [q, setQ] = useState("");
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
        issues?: { row_index: number; customer_code: string | null; issue: string }[];
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
        const res = await fetch(`${baseUrl}/api/customers/${encodeURIComponent(cid)}`, {
          headers: apiAuth(),
        });
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
    baseUrl,
    apiAuth,
    onMessagingFocusConsumed,
  ]);

  const closeAddDrawer = useCallback(() => {
    setShowAddDrawer(false);
    if (activeSection === "add") onNavigateSubSection?.("all");
  }, [activeSection, onNavigateSubSection]);
  const [qDebounced, setQDebounced] = useState("");
  const [vipOnly, setVipOnly] = useState(false);
  const [balanceDueOnly, setBalanceDueOnly] = useState(false);
  const [weddingSoonOnly, setWeddingSoonOnly] = useState(false);
  const [rows, setRows] = useState<CustomerBrowseRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [weddingPartyQuery, setWeddingPartyQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Customer | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [tableFocus, setTableFocus] = useState(false);
  const [customerGroups, setCustomerGroups] = useState<
    { id: string; code: string; label: string }[]
  >([]);
  const [groupFilterCode, setGroupFilterCode] = useState("");
  const [bulkGroupId, setBulkGroupId] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeMasterId, setMergeMasterId] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [hubInitialTab, setHubInitialTab] = useState<
    "relationship" | "messages" | null
  >(null);
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
  const { dialogRef: mergeDialogRef, titleId: mergeTitleId } = useDialogAccessibility(mergeOpen, {
    onEscape: () => setMergeOpen(false),
    closeOnEscape: !mergeBusy,
  });

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 280);
    return () => clearTimeout(t);
  }, [q]);

  const buildBrowseParams = useCallback(
    (offset: number) => {
      const p = new URLSearchParams();
      if (qDebounced.length > 0) p.set("q", qDebounced);
      if (vipOnly) p.set("vip_only", "true");
      if (balanceDueOnly) p.set("balance_due_only", "true");
      if (weddingSoonOnly) p.set("wedding_soon_only", "true");
      if (weddingPartyQuery.trim().length > 0) {
        p.set("wedding_party_q", weddingPartyQuery.trim());
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
      qDebounced,
      vipOnly,
      balanceDueOnly,
      weddingSoonOnly,
      weddingPartyQuery,
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
    [baseUrl, buildBrowseParams, apiAuth],
  );

  const browseFiltersKey = useMemo(
    () =>
      JSON.stringify({
        q: qDebounced,
        vipOnly,
        balanceDueOnly,
        weddingSoonOnly,
        wp: weddingPartyQuery.trim(),
        group: groupFilterCode.trim(),
      }),
    [
      qDebounced,
      vipOnly,
      balanceDueOnly,
      weddingSoonOnly,
      weddingPartyQuery,
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
  }, [baseUrl, apiAuth]);

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

  const refresh = useCallback(() => {
    void loadFirstPage(false);
  }, [loadFirstPage]);

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
      if (
        res.status === 400 &&
        body.error?.includes("already a member")
      ) {
        dup += 1;
      } else {
        fail += 1;
      }
    }
    
    toast(`Successfully added ${ok} customers. (Skipped: ${dup}, Failed: ${fail})`, ok > 0 ? "success" : "error");
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
    toast(`${ids.length} customers updated to ${isVip ? 'VIP' : 'Regular'}`, "success");
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
  }, [mergeOpen, mergeMasterId, selected, rows, baseUrl, apiAuth]);

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
    if (!tableFocus) return;
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
      <ShipmentsHubSection
        onOpenOrderInBackoffice={onOpenOrderInBackoffice}
      />
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
    if (!hasPermission("customers.rms_charge")) {
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
        onOpenOrderInBackoffice={onOpenOrderInBackoffice}
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
        onOpenOrderInBackoffice={onOpenOrderInBackoffice}
      />
    );
  }

  return (
    <div className="ui-page">
      <div className="flex items-center justify-between px-1 pb-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">Customers</p>
          <h2 className="text-2xl font-black tracking-tight text-app-text">All Customers</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-3 text-xs text-app-text-muted">
            <span className="rounded-xl border border-app-border bg-[color-mix(in_srgb,var(--app-accent)_10%,var(--app-surface-2))] px-3 py-1 font-semibold text-app-text">
              {rows.length} loaded
              {hasMore ? " · more available" : ""}
            </span>
            <span className="rounded-xl border border-app-border bg-[color-mix(in_srgb,var(--app-accent-2)_14%,var(--app-surface-2))] px-3 py-1 font-semibold text-app-text">
              {rows.filter((r) => r.is_vip).length} VIP
            </span>
            <span className="rounded-xl border border-app-border bg-[color-mix(in_srgb,#f0b978_16%,var(--app-surface-2))] px-3 py-1 font-semibold text-app-text">
              {rows.filter((r) => r.wedding_soon).length} weddings soon
            </span>
          </div>
        </div>
      </div>

      <section className="ui-card p-5">
        <div className="ui-toolbar bg-[color-mix(in_srgb,var(--app-accent-2)_12%,var(--app-surface-2))]">
          <div className="relative min-w-[200px] flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
              size={18}
              aria-hidden
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, code, company, phone, email…"
              className="ui-input w-full py-3 pl-10 pr-4 text-sm font-medium"
            />
          </div>
          <input
            value={weddingPartyQuery}
            onChange={(e) => setWeddingPartyQuery(e.target.value)}
            placeholder="Filter by wedding party..."
            className="ui-input w-[260px] py-3 text-sm"
          />
          <button
            type="button"
            onClick={() => setShowAddDrawer(true)}
            className="ui-btn-primary px-5 py-3"
          >
            + Add Customer
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={onImportFileChange}
          />
          <button
            type="button"
            onClick={onPickImportFile}
            className="ui-btn-secondary inline-flex items-center gap-2 px-5 py-3"
          >
            <Upload size={16} aria-hidden />
            Import Lightspeed CSV
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="ui-btn-secondary px-5 py-3"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div className="mt-3 ui-filter-row">
          <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Filters
          </span>
          {filterChip(vipOnly, "VIP only", () => setVipOnly((v) => !v), () =>
            setVipOnly(false),
          )}
          {filterChip(
            balanceDueOnly,
            "Balance due",
            () => setBalanceDueOnly((v) => !v),
            () => setBalanceDueOnly(false),
          )}
          {filterChip(
            weddingSoonOnly,
            "Wedding ≤30d",
            () => setWeddingSoonOnly((v) => !v),
            () => setWeddingSoonOnly(false),
          )}
          <label className="ml-1 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Group
            <select
              value={groupFilterCode}
              onChange={(e) => setGroupFilterCode(e.target.value)}
              className="ui-input max-w-[200px] py-1.5 text-xs font-semibold normal-case text-app-text"
            >
              <option value="">All</option>
              {customerGroups.map((g) => (
                <option key={g.id} value={g.code}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="ui-card flex min-h-0 flex-1 flex-col p-5">
        <div className="mb-3 shrink-0">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
            Customer list subsection
          </p>
        </div>
        <div
          tabIndex={0}
          role="region"
          aria-label="Customer list"
          onFocus={() => setTableFocus(true)}
          onBlur={() => setTableFocus(false)}
          onKeyDown={onTableKeyDown}
          className="ui-table-shell min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-x-contain outline-none ring-app-border focus-visible:ring-2"
        >
          <table className="w-full min-w-[640px] border-collapse text-left text-sm md:min-w-[720px] xl:min-w-[820px]">
            <thead className="sticky top-0 z-[1] bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted backdrop-blur-sm">
              <tr>
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={
                      rows.length > 0 && selected.size === rows.length
                    }
                    onChange={toggleSelectAll}
                    aria-label="Select all"
                    className="h-4 w-4 rounded border-app-border text-[var(--app-accent)]"
                  />
                </th>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">VIP</th>
                <th className="px-4 py-3 text-right">Open balance</th>
                <th className="px-4 py-3 text-center">Wedding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-app-border transition-colors hover:bg-app-surface-2"
                >
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      className="h-4 w-4 rounded border-app-border text-[var(--app-accent)]"
                      aria-label={`Select ${r.first_name} ${r.last_name}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-app-text-muted tabular-nums">
                    {r.customer_code}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => {
                        setHubInitialTab(null);
                        setPicked(rowToCustomer(r));
                      }}
                      className="text-left font-bold text-app-text transition-colors hover:text-[var(--app-accent)]"
                    >
                      <span className="block">
                        {r.first_name} {r.last_name}
                      </span>
                      {r.company_name ? (
                        <span className="mt-0.5 block text-[11px] font-semibold text-app-text-muted">
                          {r.company_name}
                        </span>
                      ) : null}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-app-text-muted">
                    {r.phone ?? r.email ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {r.is_vip ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-900">
                        VIP
                      </span>
                    ) : (
                      <span className="text-app-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-app-text">
                    {moneyDec(r.open_balance_due)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {r.wedding_active ? (
                      <button
                        type="button"
                        onClick={() => r.wedding_party_id && onOpenWeddingParty(r.wedding_party_id)}
                        className="inline-flex items-center gap-1 rounded-full border border-app-accent/35 bg-app-accent/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent"
                        title={r.wedding_party_name ?? "Active wedding"}
                      >
                        <Gem size={11} aria-hidden />
                        {r.wedding_party_name ?? "Wedding"}
                      </button>
                    ) : r.wedding_soon ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <Gem size={11} aria-hidden />
                        Soon
                      </span>
                    ) : (
                      <span className="text-app-text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore ? (
            <div className="flex flex-col items-center gap-2 border-t border-app-border py-4">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore || loading}
                className="ui-btn-secondary px-6 py-2 text-xs font-black uppercase tracking-widest"
              >
                {loadingMore ? "Loading…" : "Load more customers"}
              </button>
              <p className="text-center text-[10px] text-app-text-muted">
                Same filters and sort; each request loads up to {BROWSE_PAGE_SIZE} additional rows.
              </p>
            </div>
          ) : null}
          {!loading && rows.length === 0 ? (
            <p className="p-6 text-sm text-app-text-muted">No customers match.</p>
          ) : null}
        </div>

        <p className="mt-3 shrink-0 text-[10px] text-app-text-muted">
          Combine filters for segments (e.g. balance due + wedding in the next
          30 days). Click the table area (or tab to it), then press Enter to open
          the hub for the first selected row.
        </p>
      </section>

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
            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-900"
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
              <h3 id={mergeTitleId} className="text-lg font-black uppercase tracking-tight text-app-text">
                Merge customers
              </h3>
            </div>
            <div className="space-y-4 p-5 text-sm text-app-text">
              <p className="text-xs text-app-text-muted">
                The master record is kept; the other is removed after re-pointing
                orders and wedding links. This cannot be undone.
              </p>
              {mergePreviewLoading ? (
                <p className="text-xs text-app-text-muted">Loading impact preview…</p>
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
                    <li>Group memberships: {mergePreview.customer_group_memberships}</li>
                    <li>Alterations: {mergePreview.alteration_orders}</li>
                    <li>Loyalty pts (slave): {mergePreview.loyalty_points_on_slave}</li>
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
                className="min-h-11 rounded-xl border-b-8 border-emerald-800 bg-emerald-600 px-4 py-2 text-sm font-black uppercase tracking-wide text-white shadow-lg shadow-emerald-900/20 transition-all hover:brightness-110 active:translate-y-0.5 active:border-b-4 disabled:opacity-50"
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
          onOpenOrderInBackoffice={onOpenOrderInBackoffice}
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

      <PromptModal
        isOpen={showBulkWeddingPrompt}
        onClose={() => setShowBulkWeddingPrompt(false)}
        onSubmit={executeBulkAddToWedding}
        title="Add to Wedding"
        message={`Assign ${selected.size} selected customers to a wedding party. Enter the ID below:`}
        placeholder="Enter Wedding Party ID (UUID)"
        confirmLabel="Assign Members"
      />

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

function formatPhoneInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

interface DuplicateCandidateRow {
  id: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  match_reason: string;
}

function AddCustomerDrawer({
  isOpen,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
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

  const identityValid = !errors.first_name && !errors.last_name && !errors.phone;
  const formValid =
    identityValid &&
    !errors.email &&
    !errors.phone &&
    !errors.state &&
    !errors.postal;

  const resetForm = useCallback(() => {
    setForm({ ...EMPTY_ADD_CUSTOMER_FORM });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setEmailPromptOpen(false);
      setEmailPromptValue("");
      setErr(null);
      setTouched({});
      setDupCandidates([]);
      dupAbortRef.current?.abort();
      resetForm();
    }
  }, [isOpen, resetForm]);

  useEffect(() => {
    if (!isOpen) return;
    const em = form.email.trim();
    const fn = form.first_name.trim();
    const ln = form.last_name.trim();
    const pd = form.phone.replace(/\D/g, "");
    const emailOk = em.length > 0 && EMAIL_RE.test(em);
    const phoneOk = pd.length >= 10;
    const nameOk = fn.length > 0 && ln.length > 0;
    if (!emailOk && !phoneOk && !nameOk) {
      setDupCandidates([]);
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
          setDupCandidates(Array.isArray(rows) ? rows : []);
        } catch {
          if (!ac.signal.aborted) setDupCandidates([]);
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

  const submitToApi = async (resolvedEmail: string, skipEmailPrompt = false) => {
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
      const phoneSecondaryLabel = form.phone_secondary_label.trim() || "Secondary";
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
      const created = (await res.json()) as { id: string; customer_code?: string };
      if (created.customer_code) {
        toast(`Customer created — code ${created.customer_code}`, "success");
      }
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
        title="Add customer"
        subtitle="Create a new customer profile."
        panelMaxClassName="max-w-3xl"
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
          className="space-y-8"
          onSubmit={(e) => void handleSubmit(e)}
        >
          {err ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-600">
              {err}
            </p>
          ) : null}

          {(dupLoading || dupCandidates.length > 0) && (
            <div
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3"
              data-testid="crm-duplicate-candidates"
            >
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-900">
                Possible existing customers
              </p>
              {dupLoading ? (
                <p className="mt-2 text-xs text-amber-800">Checking…</p>
              ) : (
                <ul className="mt-2 space-y-2 text-xs text-amber-950">
                  {dupCandidates.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-lg border border-amber-200/80 bg-app-surface/90 px-2 py-1.5 dark:border-amber-800/50 dark:bg-app-surface-2/80"
                    >
                      <span className="font-mono font-bold">{c.customer_code}</span>
                      {" — "}
                      {[c.first_name, c.last_name].filter(Boolean).join(" ") ||
                        "(no name)"}
                      {c.email ? (
                        <span className="block text-[10px] text-amber-800">
                          {c.email}
                        </span>
                      ) : null}
                      <span className="block text-[10px] font-semibold uppercase tracking-tight text-amber-700">
                        {c.match_reason.replace(/_/g, " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!dupLoading && dupCandidates.length > 0 ? (
                <p className="mt-2 text-[10px] font-semibold text-amber-900">
                  Open an existing profile in Customers if this is the same person;
                  merge tools live under customer admin when you have access.
                </p>
              ) : null}
            </div>
          )}

          <section className="space-y-3" aria-labelledby="add-cust-identity">
            <h3
              id="add-cust-identity"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Identity
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Company (optional)
              <input
                value={form.company_name}
                onChange={(e) => set("company_name", e.target.value)}
                className="ui-input mt-1 w-full text-sm"
                placeholder="Business or organization"
              />
            </label>
          </section>

          <section className="space-y-3" aria-labelledby="add-cust-contact">
            <h3
              id="add-cust-contact"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Contact
            </h3>
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Phones (primary required when provided; optional secondary)
              </p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[150px_1fr]">
                <input
                  value={form.phone_primary_label}
                  onChange={(e) => set("phone_primary_label", e.target.value)}
                  className="ui-input text-sm"
                  placeholder="Primary label"
                />
                <div>
                  <input
                    type="tel"
                    value={form.phone}
                    onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
                    onChange={(e) => set("phone", formatPhoneInput(e.target.value))}
                    className="ui-input w-full text-sm"
                    placeholder="(555) 000-0000"
                  />
                  {touched.phone && errors.phone ? (
                    <span className="mt-1 block text-[11px] font-semibold text-red-600">
                      {errors.phone}
                    </span>
                  ) : null}
                </div>
                <input
                  value={form.phone_secondary_label}
                  onChange={(e) => set("phone_secondary_label", e.target.value)}
                  className="ui-input text-sm"
                  placeholder="Secondary label"
                />
                <input
                  type="tel"
                  value={form.phone_secondary}
                  onChange={(e) =>
                    set("phone_secondary", formatPhoneInput(e.target.value))
                  }
                  className="ui-input text-sm"
                  placeholder="(555) 000-0000"
                />
              </div>
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Email (optional)
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
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Notes
              <textarea
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                rows={4}
                className="ui-input mt-1 w-full resize-none text-sm"
                placeholder="Fitting notes, preferences…"
              />
            </label>
          </section>

          <section className="space-y-3" aria-labelledby="add-cust-address">
            <h3
              id="add-cust-address"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Address
            </h3>
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Optional mailing address
              </p>
              <div className="mt-2 space-y-3">
                <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Address line 1
                  <input
                    value={form.address_line1}
                    onChange={(e) => set("address_line1", e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                    placeholder="123 Main St"
                  />
                </label>
                <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Address line 2
                  <input
                    value={form.address_line2}
                    onChange={(e) => set("address_line2", e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                    placeholder="Suite, unit, floor"
                  />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                      onChange={(e) =>
                        set("state", e.target.value.toUpperCase())
                      }
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
                    Postal code
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
              </div>
            </div>
          </section>

          <details className="rounded-xl border border-app-border bg-app-surface-2 p-3 [&_summary::-webkit-details-marker]:hidden">
            <summary className="cursor-pointer select-none text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Advanced — dates and custom fields
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </div>
          </details>

          <section className="space-y-3" aria-labelledby="add-cust-prefs">
            <h3
              id="add-cust-prefs"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Preferences
            </h3>
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Marketing (optional)
              </p>
              <div className="mt-2 flex flex-wrap gap-3">
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
                    Email is optional, but recommended for receipts and reminders.
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
