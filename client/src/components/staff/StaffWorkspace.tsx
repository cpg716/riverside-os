import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  LayoutGrid,
  ListChecks,
  Percent,
  Search,
  UserPlus,
} from "lucide-react";
import CommissionPayoutsPanel from "./CommissionPayoutsPanel";
import StaffTasksPanel from "./StaffTasksPanel";
import StaffSchedulePanel from "./StaffSchedulePanel";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import StaffEditDrawer, { type HubRow } from "./StaffEditDrawer";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type StaffRole = "admin" | "salesperson" | "sales_support";
type StaffStatusFilter = "all" | "active" | "inactive";

// HubRow is imported from StaffEditDrawer

interface CategoryCommissionRow {
  category_id: string;
  category_name: string;
  commission_rate: string | number;
}

/** USD display — `parseFloat` here is only a finite-string guard before `parseMoneyToCents`. */
function money(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const s = String(n).trim();
  if (!s) return "—";
  if (!Number.isFinite(Number.parseFloat(s))) return "—";
  return formatUsdFromCents(parseMoneyToCents(n));
}

/** Commission rate stored as 0–1 decimal → percent label for the grid (not currency). */
function pctFromDecimal(d: string | number): string {
  const v = typeof d === "number" ? d : Number.parseFloat(String(d));
  if (!Number.isFinite(v)) return "0";
  return (v * 100).toFixed(2);
}

/** Cashier-entered percent string → 0–1 decimal for PATCH payloads (not currency). */
function decimalFromPctInput(s: string): number | null {
  const t = s.trim().replace(/%/g, "");
  const v = Number.parseFloat(t);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v / 100;
}

interface StaffWorkspaceProps {
  activeSection?: string;
  tasksFocusInstanceId?: string | null;
  onTasksFocusConsumed?: () => void;
}

type StaffTab = "team" | "tasks" | "schedule" | "commission" | "commission-payouts" | "audit";

export default function StaffWorkspace({
  activeSection,
  tasksFocusInstanceId,
  onTasksFocusConsumed,
}: StaffWorkspaceProps) {
  const { toast } = useToast();
  const {
    backofficeHeaders,
    hasPermission,
  } = useBackofficeAuth();

  // Tab syncing effect moved here if needed
  const [tab, setTab] = useState<StaffTab>("team");

  // Sync sidebar sub-section to internal tab.
  useEffect(() => {
    if (
      activeSection === "team" ||
      activeSection === "tasks" ||
      activeSection === "schedule" ||
      activeSection === "commission" ||
      activeSection === "commission-payouts" ||
      activeSection === "audit"
    ) {
      setTab(activeSection as StaffTab);
    }
  }, [activeSection]);
  const [roster, setRoster] = useState<HubRow[]>([]);
  const [categories, setCategories] = useState<CategoryCommissionRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<StaffStatusFilter>("active");
  const [auditSearchInput, setAuditSearchInput] = useState("");
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRole, setBulkRole] = useState<StaffRole>("sales_support");

  const [editRow, setEditRow] = useState<HubRow | null>(null);

  interface AccessLogRow {
    id: string;
    staff_id: string;
    staff_name: string;
    staff_avatar_key: string;
    event_kind: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }
  const [accessLog, setAccessLog] = useState<AccessLogRow[]>([]);
  const [accessLogLoading, setAccessLogLoading] = useState(false);


  const refreshRoster = useCallback(async () => {
    setLoadErr(null);
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/roster`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load roster");
      const rows = (await res.json()) as HubRow[];
      setRoster(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Load failed");
    }
  }, [backofficeHeaders]);

  const refreshCategories = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/category-commissions`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load categories");
      const rows = (await res.json()) as CategoryCommissionRow[];
      setCategories(Array.isArray(rows) ? rows : []);
    } catch {
      setCategories([]);
    }
  }, [backofficeHeaders]);

  const refreshAccessLog = useCallback(async () => {
    setAccessLogLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/access-log?limit=400`,
        { headers: backofficeHeaders() },
      );
      if (!res.ok) throw new Error("Could not load audit log");
      const rows = (await res.json()) as AccessLogRow[];
      setAccessLog(Array.isArray(rows) ? rows : []);
    } catch {
      setAccessLog([]);
    } finally {
      setAccessLogLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void refreshRoster();
    void refreshCategories();
  }, [refreshRoster, refreshCategories]);

  useEffect(() => {
    if (tab !== "audit") return;
    void refreshAccessLog();
  }, [tab, refreshAccessLog]);

  const openEdit = (r: HubRow) => {
    setEditRow(r);
  };

  const filteredRoster = useMemo(
    () =>
      roster.filter((r) => {
        if (statusFilter === "active" && !r.is_active) return false;
        if (statusFilter === "inactive" && r.is_active) return false;
        if (!searchInput.trim()) return true;
        const q = searchInput.toLowerCase();
        return (
          r.full_name.toLowerCase().includes(q) ||
          r.cashier_code.toLowerCase().includes(q) ||
          r.role.toLowerCase().includes(q)
        );
      }),
    [roster, searchInput, statusFilter],
  );

  useEffect(() => {
    setSelectedStaffIds((prev) => prev.filter((id) => roster.some((r) => r.id === id)));
  }, [roster]);

  const visibleSelectedCount = useMemo(
    () => filteredRoster.filter((r) => selectedStaffIds.includes(r.id)).length,
    [filteredRoster, selectedStaffIds],
  );

  const allVisibleSelected =
    filteredRoster.length > 0 && filteredRoster.every((r) => selectedStaffIds.includes(r.id));

  const toggleStaffSelection = useCallback((staffId: string) => {
    setSelectedStaffIds((prev) =>
      prev.includes(staffId) ? prev.filter((id) => id !== staffId) : [...prev, staffId],
    );
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedStaffIds((prev) => {
      if (filteredRoster.length === 0) return prev;
      const visibleIds = filteredRoster.map((r) => r.id);
      const visibleSet = new Set(visibleIds);
      const allSelected = visibleIds.every((id) => prev.includes(id));
      if (allSelected) {
        return prev.filter((id) => !visibleSet.has(id));
      }
      const next = new Set(prev);
      visibleIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  }, [filteredRoster]);

  const bulkSetActive = useCallback(
    async (isActive: boolean) => {
      if (selectedStaffIds.length === 0) return;
      setBulkBusy(true);
      setLoadErr(null);
      try {
        const staffNameById = new Map(roster.map((row) => [row.id, row.full_name]));
        const succeeded: string[] = [];
        const failed: string[] = [];
        for (const staffId of selectedStaffIds) {
          const res = await fetch(`${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...backofficeHeaders() },
            body: JSON.stringify({ is_active: isActive }),
          });
          if (!res.ok) {
            const b = (await res.json().catch(() => ({}))) as { error?: string };
            const label = staffNameById.get(staffId) ?? "Unknown staff";
            failed.push(`${label}: ${b.error ?? "Bulk update failed"}`);
            continue;
          }
          succeeded.push(staffId);
        }
        await refreshRoster();
        setSelectedStaffIds((prev) => prev.filter((id) => !succeeded.includes(id)));
        if (succeeded.length > 0) {
          toast(
            `${isActive ? "Activated" : "Deactivated"} ${succeeded.length} staff account${succeeded.length === 1 ? "" : "s"}.`,
            "success",
          );
        }
        if (failed.length > 0) {
          setLoadErr(failed.join(" | "));
          toast(
            `${failed.length} staff account${failed.length === 1 ? "" : "s"} could not be ${isActive ? "activated" : "deactivated"}.`,
            "error",
          );
        } else {
          setLoadErr(null);
        }
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : "Bulk update failed");
        toast(e instanceof Error ? e.message : "Bulk update failed", "error");
      } finally {
        setBulkBusy(false);
      }
    },
    [backofficeHeaders, refreshRoster, roster, selectedStaffIds, toast],
  );

  const bulkSetRole = useCallback(async () => {
    if (selectedStaffIds.length === 0) return;
    setBulkBusy(true);
    setLoadErr(null);
    try {
      const staffNameById = new Map(roster.map((row) => [row.id, row.full_name]));
      const succeeded: string[] = [];
      const failed: string[] = [];
      for (const staffId of selectedStaffIds) {
        const roleRes = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...backofficeHeaders() },
            body: JSON.stringify({ role: bulkRole }),
          },
        );
        if (!roleRes.ok) {
          const body = (await roleRes.json().catch(() => ({}))) as { error?: string };
          const label = staffNameById.get(staffId) ?? "Unknown staff";
          failed.push(`${label}: ${body.error ?? "Role update failed"}`);
          continue;
        }

        if (bulkRole !== "admin" && hasPermission("staff.manage_access")) {
          const defaultsRes = await fetch(
            `${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}/apply-role-defaults`,
            {
              method: "POST",
              headers: backofficeHeaders(),
            },
          );
          if (!defaultsRes.ok) {
            const body = (await defaultsRes.json().catch(() => ({}))) as { error?: string };
            const label = staffNameById.get(staffId) ?? "Unknown staff";
            failed.push(`${label}: ${body.error ?? "Role defaults update failed"}`);
            continue;
          }
        }

        succeeded.push(staffId);
      }

      await refreshRoster();
      setSelectedStaffIds((prev) => prev.filter((id) => !succeeded.includes(id)));
      if (succeeded.length > 0) {
        toast(
          `Updated ${succeeded.length} staff account${succeeded.length === 1 ? "" : "s"} to ${roleLabel(bulkRole)}.`,
          "success",
        );
      }
      if (failed.length > 0) {
        setLoadErr(failed.join(" | "));
        toast(
          `${failed.length} staff account${failed.length === 1 ? "" : "s"} could not be updated.`,
          "error",
        );
      } else {
        setLoadErr(null);
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Bulk role update failed");
      toast(e instanceof Error ? e.message : "Bulk role update failed", "error");
    } finally {
      setBulkBusy(false);
    }
  }, [
    backofficeHeaders,
    bulkRole,
    hasPermission,
    refreshRoster,
    roster,
    selectedStaffIds,
    toast,
  ]);

  const saveCategoryRate = async (categoryId: string, pctStr: string) => {
    const rate = decimalFromPctInput(pctStr);
    if (rate === null) return;
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/category-commissions/${encodeURIComponent(categoryId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...backofficeHeaders() },
          body: JSON.stringify({ commission_rate: rate }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Update failed");
      }
      await refreshCategories();
      await refreshRoster();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (r: StaffRole) =>
    r === "admin"
      ? "Admin"
      : r === "salesperson"
        ? "Salesperson"
        : "Sales Support";

  const tabs = useMemo(() => {
    const all: {
      id: StaffTab;
      label: string;
      icon: typeof LayoutGrid;
      perm?: string;
      requireAll?: string[];
    }[] = [
      { id: "team", label: "Team", icon: LayoutGrid, perm: "staff.view" },
      { id: "tasks", label: "Tasks", icon: ListChecks, perm: "tasks.complete" },
      { id: "schedule", label: "Schedule", icon: CalendarDays, perm: "staff.view" },
      { id: "commission", label: "Commission", icon: Percent, perm: "staff.manage_commission" },
      {
        id: "commission-payouts",
        label: "Commission payouts",
        icon: CircleDollarSign,
        requireAll: ["insights.view", "insights.commission_finalize"],
      },
      { id: "audit", label: "Audit", icon: ClipboardList, perm: "staff.view_audit" },
    ];
    return all.filter((t) => {
      if (t.requireAll?.length) return t.requireAll.every((k) => hasPermission(k));
      if (t.perm) return hasPermission(t.perm);
      return false;
    });
  }, [hasPermission]);

  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === tab)) {
      setTab(tabs[0].id);
    }
  }, [tabs, tab]);




  const activeTabLabel = tabs.find((t) => t.id === tab)?.label ?? "Staff";

  return (
    <div className="flex flex-1 flex-col p-4 gap-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">Staff</p>
          <h2 className="text-2xl font-black tracking-tight text-app-text">{activeTabLabel}</h2>
        </div>
        {tab === "team" && hasPermission("staff.edit") && (
          <button
            type="button"
            onClick={() => {
              setEditRow({
                id: "NEW",
                full_name: "",
                cashier_code: "",
                role: "salesperson",
                is_active: true,
                base_commission_rate: 0,
                has_pin: false,
                sales_mtd: 0,
                avatar_key: "ros_default",
                max_discount_percent: 0,
              } as HubRow);
            }}
            className="ui-btn-primary px-4 py-2 flex items-center gap-2"
          >
            <UserPlus size={16} />
            Add Staff
          </button>
        )}
      </div>

      {loadErr ? (
        <p className="text-sm font-semibold text-red-600">{loadErr}</p>
      ) : null}

      {tab === "tasks" ? (
        <StaffTasksPanel
          focusInstanceId={tasksFocusInstanceId}
          onFocusConsumed={onTasksFocusConsumed}
        />
      ) : null}

      {tab === "schedule" ? <StaffSchedulePanel /> : null}

      {tab === "team" ? (
        <section className="ui-card flex flex-col p-4 gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex w-full max-w-2xl flex-wrap items-center gap-3">
              <div className="relative min-w-[18rem] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted" />
                <input
                  type="text"
                  placeholder="Search staff by name, PIN or role…"
                  className="ui-input w-full pl-10"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StaffStatusFilter)}
                className="ui-input min-w-[12rem] px-3 py-2"
              >
                <option value="active">Active Staff</option>
                <option value="inactive">Inactive Staff</option>
                <option value="all">All Staff</option>
              </select>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              {filteredRoster.length} Showing · {roster.length} Total · {roster.filter(r => r.is_active).length} Active
            </p>
          </div>

          {hasPermission("staff.edit") ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-[11px] font-bold text-app-text">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() => toggleSelectAllVisible()}
                    className="h-4 w-4 rounded border border-app-input-border bg-app-surface accent-[var(--app-accent)]"
                  />
                  Select visible
                </label>
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {selectedStaffIds.length} selected
                </span>
                {visibleSelectedCount > 0 ? (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                    {visibleSelectedCount} in current view
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={bulkRole}
                  onChange={(e) => setBulkRole(e.target.value as StaffRole)}
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  className="ui-input min-w-[11rem] px-3 py-2 disabled:opacity-50"
                >
                  <option value="sales_support">Sales Support</option>
                  <option value="salesperson">Salesperson</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="button"
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  onClick={() => void bulkSetRole()}
                  className="ui-btn-secondary px-3 py-2 disabled:opacity-50"
                >
                  Set Staff Type
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  onClick={() => void bulkSetActive(true)}
                  className="ui-btn-secondary px-3 py-2 disabled:opacity-50"
                >
                  Make Active
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  onClick={() => void bulkSetActive(false)}
                  className="ui-btn-secondary px-3 py-2 disabled:opacity-50"
                >
                  Deactivate
                </button>
              </div>
            </div>
          ) : null}

          <div className="pt-2">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredRoster.map((r) => (
                <div
                  key={r.id}
                  className="ui-card flex flex-col p-4 active:bg-app-surface-2 transition-colors cursor-pointer select-none"
                  onClick={() => openEdit(r)}
                >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-3">
                    {hasPermission("staff.edit") ? (
                      <input
                        type="checkbox"
                        checked={selectedStaffIds.includes(r.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleStaffSelection(r.id)}
                        className="mt-3 h-4 w-4 shrink-0 rounded border border-app-input-border bg-app-surface accent-[var(--app-accent)]"
                        aria-label={`Select ${r.full_name}`}
                      />
                    ) : null}
                    <img
                      src={staffAvatarUrl(r.avatar_key)}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-full border border-app-border object-cover"
                    />
                    <div className="min-w-0">
                    <p className="text-lg font-black text-app-text">
                      {r.full_name}
                    </p>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                      {roleLabel(r.role)}
                      {!r.is_active ? " · Inactive" : ""}
                    </p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                      r.has_pin
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {r.has_pin ? "PIN set" : "No PIN"}
                  </span>
                </div>
                <dl className="mt-3 grid gap-1 text-xs text-app-text-muted">
                  <div className="flex justify-between gap-2">
                    <dt>Sales MTD</dt>
                    <dd className="font-bold tabular-nums text-app-text">
                      {money(r.sales_mtd)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Base commission</dt>
                    <dd className="font-bold tabular-nums text-app-text">
                      {pctFromDecimal(r.base_commission_rate)}%
                    </dd>
                  </div>
                  {r.phone ? (
                    <div className="flex justify-between gap-2">
                      <dt>Phone</dt>
                      <dd className="font-bold text-app-text">{r.phone}</dd>
                    </div>
                  ) : null}
                  {r.email ? (
                    <div className="flex justify-between gap-2">
                      <dt>Email</dt>
                      <dd className="max-w-[10rem] truncate font-bold text-app-text" title={r.email}>
                        {r.email}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-2">
                    <dt>Max discount</dt>
                    <dd className="font-bold tabular-nums text-app-text">
                      {String(r.max_discount_percent ?? "—")}%
                    </dd>
                  </div>
                  {r.employee_customer_code ? (
                    <div className="flex justify-between gap-2">
                      <dt>Employee CRM</dt>
                      <dd className="truncate font-bold text-app-text" title={r.employee_customer_code}>
                        {r.employee_customer_code}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <div className="mt-auto pt-4">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditRow(r);
                    }}
                    className="ui-btn-secondary w-full py-2.5 flex items-center justify-center"
                  >
                    Edit profile
                  </button>
                </div>
              </div>
            ))}
          </div>
          </div>
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="ui-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-app-text-muted">
              Chronological PIN and high-authority events (checkout, overrides,
              register, payouts, attribution edits).
            </p>
            <div className="flex gap-4 items-center">
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-app-text-muted" />
                <input
                  className="ui-input w-full pl-8 py-1.5 text-xs"
                  placeholder="Search events or staff…"
                  value={auditSearchInput}
                  onChange={(e) => setAuditSearchInput(e.target.value)}
                />
              </div>
              <button
                type="button"
                disabled={accessLogLoading}
                onClick={() => void refreshAccessLog()}
                className="ui-btn-secondary px-3 py-1.5"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="ui-card">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-app-border bg-app-surface text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-3 py-2">When (UTC)</th>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border font-mono text-[11px]">
                {accessLogLoading && accessLog.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-app-text-muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {accessLog
                  .filter((row) => {
                    if (!auditSearchInput.trim()) return true;
                    const q = auditSearchInput.toLowerCase();
                    return (
                      row.staff_name.toLowerCase().includes(q) ||
                      row.event_kind.toLowerCase().includes(q) ||
                      JSON.stringify(row.metadata).toLowerCase().includes(q)
                    );
                  })
                  .map((row) => (
                    <tr key={row.id} className="align-top hover:bg-app-surface-2 transition-colors">
                      <td className="whitespace-nowrap px-3 py-2 text-app-text-muted">
                        {new Date(row.created_at).toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <img
                            src={staffAvatarUrl(row.staff_avatar_key)}
                            alt=""
                            className="h-7 w-7 shrink-0 rounded-full border border-app-border object-cover"
                          />
                          <span className="font-semibold text-app-text">{row.staff_name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[var(--app-accent)]">
                        {row.event_kind}
                      </td>
                      <td className="max-w-md break-all px-3 py-2 text-app-text-muted">
                        {JSON.stringify(row.metadata)}
                      </td>
                    </tr>
                  ))}
                {!accessLogLoading && accessLog.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-app-text-muted">
                      No events yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === "commission-payouts" ? <CommissionPayoutsPanel /> : null}

      {tab === "commission" ? (
        <section className="ui-card space-y-4 p-4">
          <p className="text-sm text-app-text-muted">
            Category overrides apply to commission-eligible staff when a line’s
            product maps to that category. Sales Support earns no commission.
          </p>
          <div className="ui-card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-app-border bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Override %</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <CategoryRateRow
                    key={c.category_id}
                    row={c}
                    disabled={busy}
                    onSave={(pct) => void saveCategoryRate(c.category_id, pct)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {editRow && (
        <StaffEditDrawer
          staff={editRow}
          open={!!editRow}
          onClose={() => setEditRow(null)}
          onUpdate={() => {
            setEditRow(null);
            void refreshRoster();
          }}
        />
      )}
    </div>
  );
}

function CategoryRateRow({
  row,
  disabled,
  onSave,
}: {
  row: CategoryCommissionRow;
  disabled: boolean;
  onSave: (pct: string) => void;
}) {
  const [local, setLocal] = useState(pctFromDecimal(row.commission_rate));
  useEffect(() => {
    setLocal(pctFromDecimal(row.commission_rate));
  }, [row.commission_rate]);

  return (
    <tr className="border-b border-app-border/50">
      <td className="px-4 py-3 font-semibold text-app-text">
        {row.category_name}
      </td>
      <td className="px-4 py-3">
        <input
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          disabled={disabled}
          className="ui-input w-24 py-1.5 font-mono text-sm"
        />
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSave(local)}
          className="ui-btn-primary px-3 py-1.5 disabled:opacity-50"
        >
          Apply
        </button>
      </td>
    </tr>
  );
}
