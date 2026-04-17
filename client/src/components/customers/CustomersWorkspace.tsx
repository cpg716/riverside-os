import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { CustomerRelationshipHubDrawer } from "./CustomerRelationshipHubDrawer";
import type { HubTab } from "./CustomerRelationshipHubDrawer";
import DuplicateReviewQueueSection from "./DuplicateReviewQueueSection";
import CustomerPipelineStats from "./CustomerPipelineStats";
import CustomerFilterBar from "./CustomerFilterBar";
import CustomerTable from "./CustomerTable";
import AddCustomerDrawer from "./AddCustomerDrawer";
import MergeCustomersModal from "./MergeCustomersModal";
import BulkWeddingPrompt from "./BulkWeddingPrompt";
import { Customer } from "../pos/CustomerSelector";
import {
  CustomerBrowseRow,
  CustomerPipelineStats as StatsType,
  CustomerGroup,
} from "./CustomerWorkspaceTypes";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface CustomersWorkspaceProps {
  activeSection?: string;
  onNavigateSubSection?: (id: string) => void;
  onOpenWeddingParty?: (id: string) => void;
  onStartSaleInPos?: (c: Customer) => void;
  onNavigateRegister?: () => void;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenTransactionInBackoffice?: (id: string) => void;
  messagingFocusCustomerId?: string | null;
  messagingFocusHubTab?: HubTab;
  onMessagingFocusConsumed?: () => void;
}

export default function CustomersWorkspace({
  onOpenWeddingParty,
  onStartSaleInPos,
  onNavigateRegister,
  onAddToWedding,
  onBookAppointment,
  onOpenTransactionInBackoffice,
  messagingFocusCustomerId,
  messagingFocusHubTab,
  onMessagingFocusConsumed,
}: CustomersWorkspaceProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  // Stats
  const [stats, setStats] = useState<StatsType | null>(null);

  // Filters
  const [q, setQ] = useState("");
  const [weddingPartyQuery, setWeddingPartyQuery] = useState("");
  const [vipOnly, setVipOnly] = useState(false);
  const [balanceDueOnly, setBalanceDueOnly] = useState(false);
  const [weddingSoonOnly, setWeddingSoonOnly] = useState(false);
  const [groupFilterCode, setGroupFilterCode] = useState("");
  const [customerGroups, setCustomerGroups] = useState<CustomerGroup[]>([]);

  // List State
  const [rows, setRows] = useState<CustomerBrowseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedId = useRef<string | null>(null);

  // Selection UI
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const [activeHubCustomerId, setActiveHubCustomerId] = useState<string | null>(
    null,
  );
  const [mergePrimary, setMergePrimary] = useState<CustomerBrowseRow | null>(
    null,
  );
  const [mergeSecondary, setMergeSecondary] = useState<CustomerBrowseRow | null>(
    null,
  );
  const [merging, setMerging] = useState(false);
  const [showBulkWeddingPrompt, setShowBulkWeddingPrompt] = useState(false);

  const importFileRef = useRef<HTMLInputElement>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/pipeline-stats`, {
        headers: apiAuth(),
      });
      if (res.ok) setStats((await res.json()) as StatsType);
    } catch (e) {
      console.error("Failed to fetch CRM stats", e);
    }
  }, [apiAuth]);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/groups`, {
        headers: apiAuth(),
      });
      if (res.ok) setCustomerGroups((await res.json()) as CustomerGroup[]);
    } catch (e) {
      console.error("Failed to fetch customer groups", e);
    }
  }, [apiAuth]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (weddingPartyQuery) p.set("wedding_party", weddingPartyQuery);
      if (vipOnly) p.set("is_vip", "true");
      if (balanceDueOnly) p.set("has_balance", "true");
      if (weddingSoonOnly) p.set("wedding_soon", "true");
      if (groupFilterCode) p.set("group_code", groupFilterCode);

      const res = await fetch(`${baseUrl}/api/customers/browse?${p.toString()}`, {
        headers: apiAuth(),
      });
      if (res.ok) {
        const data = (await res.json()) as CustomerBrowseRow[];
        setRows(data);
      }
    } catch {
      toast("Failed to load customers", "error");
    } finally {
      setLoading(false);
    }
  }, [
    q,
    weddingPartyQuery,
    vipOnly,
    balanceDueOnly,
    weddingSoonOnly,
    groupFilterCode,
    apiAuth,
    toast,
  ]);

  useEffect(() => {
    if (messagingFocusCustomerId) {
      setActiveHubCustomerId(messagingFocusCustomerId);
    }
  }, [messagingFocusCustomerId]);

  const handleOpenCustomerHub = useCallback(
    (customerId: string) => {
      setActiveHubCustomerId(customerId);
      if (
        messagingFocusCustomerId &&
        messagingFocusCustomerId !== customerId
      ) {
        onMessagingFocusConsumed?.();
      }
    },
    [messagingFocusCustomerId, onMessagingFocusConsumed],
  );

  const effectiveInitialHubTab =
    activeHubCustomerId != null &&
    activeHubCustomerId === messagingFocusCustomerId
      ? messagingFocusHubTab
      : undefined;

  useEffect(() => {
    void fetchStats();
    void fetchGroups();
  }, [fetchStats, fetchGroups]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refresh();
    }, 350);
    return () => clearTimeout(t);
  }, [refresh]);

  const handleToggleSelect = (id: string, shift: boolean) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
      lastSelectedId.current = null;
    } else {
      if (shift && lastSelectedId.current) {
        const start = rows.findIndex((r) => r.id === lastSelectedId.current);
        const end = rows.findIndex((r) => r.id === id);
        if (start !== -1 && end !== -1) {
          const [min, max] = start < end ? [start, end] : [end, start];
          for (let i = min; i <= max; i++) {
            next.add(rows[i].id);
          }
        }
      } else {
        next.add(id);
      }
      lastSelectedId.current = id;
    }
    setSelectedIds(next);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === rows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  };

  const handleMerge = async () => {
    if (!mergePrimary || !mergeSecondary) return;
    setMerging(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${mergeSecondary.id}/merge-into/${mergePrimary.id}`,
        { method: "POST", headers: apiAuth() },
      );
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        throw new Error(b.error ?? "Merge failed");
      }
      toast("Customers merged successfully", "success");
      setMergePrimary(null);
      setMergeSecondary(null);
      setSelectedIds(new Set());
      void refresh();
      void fetchStats();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Merge failed", "error");
    } finally {
      setMerging(false);
    }
  };

  const handleBulkWeddingPartyAssign = async () => {
    if (selectedIds.size === 0 || !weddingPartyQuery) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/bulk-wedding-assign?party_name=${encodeURIComponent(weddingPartyQuery)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify(Array.from(selectedIds)),
        },
      );
      if (res.ok) {
        toast(`Added ${selectedIds.size} customers to registry`, "success");
        setShowBulkWeddingPrompt(false);
        setSelectedIds(new Set());
        void refresh();
      } else {
        const b = (await res.json()) as { error?: string };
        toast(b.error ?? "Bulk assign failed", "error");
      }
    } catch {
      toast("Bulk assign failed", "error");
    }
  };

  const handleImportFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${baseUrl}/api/customers/import`, {
        method: "POST",
        headers: apiAuth(),
        body: formData,
      });
      if (res.ok) {
        toast("Import successful", "success");
        void refresh();
        void fetchStats();
      } else {
        toast("Import failed", "error");
      }
    } catch {
      toast("Import failed", "error");
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  };

  const handleOpenTransaction = (id: string) => {
    setActiveHubCustomerId(id);
  };

  const handleOpenShipment = () => {
    toast("Opening shipment tracking...", "success");
  };

  const activeHubCustomer: Customer | null = useMemo(() => {
    if (!activeHubCustomerId) return null;
    const r = rows.find((r) => r.id === activeHubCustomerId);
    if (!r) return null;
    return {
      id: r.id,
      customer_code: r.customer_code,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      phone: r.phone,
      company_name: r.company_name,
    };
  }, [activeHubCustomerId, rows]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-app-bg">
      {/* Top Stats Overview */}
      <CustomerPipelineStats stats={stats} />

      <div className="mt-4 flex-1 flex flex-col overflow-hidden border-t border-app-border bg-app-surface/60 backdrop-blur-2xl rounded-t-[40px] shadow-glow-sm">
        <CustomerFilterBar
          q={q}
          setQ={setQ}
          weddingPartyQuery={weddingPartyQuery}
          setWeddingPartyQuery={setWeddingPartyQuery}
          vipOnly={vipOnly}
          setVipOnly={setVipOnly}
          balanceDueOnly={balanceDueOnly}
          setBalanceDueOnly={setBalanceDueOnly}
          weddingSoonOnly={weddingSoonOnly}
          setWeddingSoonOnly={setWeddingSoonOnly}
          groupFilterCode={groupFilterCode}
          setGroupFilterCode={setGroupFilterCode}
          customerGroups={customerGroups}
          loading={loading}
          refresh={refresh}
          onPickImportFile={() => importFileRef.current?.click()}
          onShowAddDrawer={() => setShowAddDrawer(true)}
          onImportFileChange={handleImportFileChange}
          importFileRef={importFileRef}
          totalCount={rows.length}
        />

        {/* Global Bulk Actions Bar */}
        {selectedIds.size > 0 && (
          <div className="flex shrink-0 items-center justify-between border-b border-app-accent/20 bg-app-accent/5 px-6 py-3 animate-in slide-in-from-top duration-300">
            <div className="flex items-center gap-4">
              <span className="text-xs font-black italic text-app-accent">
                {selectedIds.size} customers selected
              </span>
              <div className="h-4 w-[1px] bg-app-accent/20" />
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-colors"
              >
                Clear Selection
              </button>
            </div>
            <div className="flex items-center gap-3">
              {selectedIds.size === 2 && (
                <button
                  onClick={() => {
                    const [idA, idB] = Array.from(selectedIds);
                    const rowA = rows.find((r) => r.id === idA);
                    const rowB = rows.find((r) => r.id === idB);
                    if (rowA && rowB) {
                      setMergePrimary(rowA);
                      setMergeSecondary(rowB);
                    }
                  }}
                  className="ui-btn-secondary px-4 py-2 text-[10px]"
                >
                  Merge Records
                </button>
              )}
              {weddingPartyQuery && (
                <button
                  onClick={() => setShowBulkWeddingPrompt(true)}
                  className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-indigo-600/20"
                >
                  Add to Registry
                </button>
              )}
            </div>
          </div>
        )}

        {/* Main Grid */}
        <CustomerTable
          rows={rows}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onSelectAll={handleSelectAll}
          onOpenCustomer={handleOpenCustomerHub}
          onOpenTransaction={handleOpenTransaction}
          onOpenShipment={handleOpenShipment}
        />
      </div>

      {/* Duplicate Review Queue (Collapsible Bottom Section) */}
      <DuplicateReviewQueueSection
        onNavigateAllCustomers={() => {}}
        onOpenWeddingParty={onOpenWeddingParty ?? (() => {})}
        onStartSale={onStartSaleInPos ?? (() => {})}
        onNavigateRegister={onNavigateRegister}
        onAddToWedding={onAddToWedding}
        onBookAppointment={onBookAppointment}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      />

      {/* Drawers & Modals */}
      <AddCustomerDrawer
        isOpen={showAddDrawer}
        onClose={() => setShowAddDrawer(false)}
        onSaved={() => {
          setShowAddDrawer(false);
          void refresh();
          void fetchStats();
        }}
      />

      {activeHubCustomer && (
        <CustomerRelationshipHubDrawer
          customer={activeHubCustomer}
          open={!!activeHubCustomerId}
          initialHubTab={effectiveInitialHubTab}
          onClose={() => {
            setActiveHubCustomerId(null);
            onMessagingFocusConsumed?.();
          }}
          onOpenWeddingParty={onOpenWeddingParty ?? (() => {})}
          onStartSale={onStartSaleInPos ?? (() => {})}
          onNavigateRegister={onNavigateRegister}
          onAddToWedding={onAddToWedding}
          onBookAppointment={onBookAppointment}
          onOpenOrderInBackoffice={onOpenTransactionInBackoffice}
          onRefresh={refresh}
        />
      )}

      {mergePrimary && mergeSecondary && (
        <MergeCustomersModal
          primary={mergePrimary}
          secondary={mergeSecondary}
          busy={merging}
          onClose={() => {
            setMergePrimary(null);
            setMergeSecondary(null);
          }}
          onConfirm={handleMerge}
        />
      )}

      {showBulkWeddingPrompt && (
        <BulkWeddingPrompt
          count={selectedIds.size}
          weddingPartyQuery={weddingPartyQuery}
          onClose={() => setShowBulkWeddingPrompt(false)}
          onConfirm={handleBulkWeddingPartyAssign}
        />
      )}
    </div>
  );
}
