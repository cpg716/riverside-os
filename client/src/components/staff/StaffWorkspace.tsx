import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ClipboardList,
  LayoutGrid,
  ListChecks,
  Search,
  UserPlus,
} from "lucide-react";
import CommissionManagerWorkspace from "./CommissionManagerWorkspace";
import StaffTasksPanel from "./StaffTasksPanel";
import StaffSchedulePanel from "./StaffSchedulePanel";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import StaffEditDrawer, { type HubRow } from "./StaffEditDrawer";
import { useToast } from "../ui/ToastProviderLogic";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const baseUrl = getBaseUrl();

type StaffRole = "admin" | "salesperson" | "sales_support" | "staff_support" | "alterations";
type StaffStatusFilter = "all" | "active" | "inactive";

// HubRow is imported from StaffEditDrawer

/** USD display — `parseFloat` here is only a finite-string guard before `parseMoneyToCents`. */
function money(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const s = String(n).trim();
  if (!s) return "—";
  if (!Number.isFinite(Number.parseFloat(s))) return "—";
  return formatUsdFromCents(parseMoneyToCents(n));
}

/** Commission rate stored as 0–1 decimal → percent label for roster display. */
function pctFromDecimal(d: string | number): string {
  const v = typeof d === "number" ? d : Number.parseFloat(String(d));
  if (!Number.isFinite(v)) return "0";
  return (v * 100).toFixed(2);
}

function titleCaseAuditText(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatAuditWhen(created_at: string): string {
  const date = new Date(created_at);
  if (Number.isNaN(date.getTime())) return "Time not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatAuditAction(event_kind: string): string {
  const actionLabels: Record<string, string> = {
    checkout: "Checkout completed",
    checkout_auth: "Checkout access verified",
    checkout_operator_verified: "Checkout access verified",
    manager_override: "Manager override approved",
    notification_broadcast: "Notification sent",
    register_adjustment: "Register adjustment recorded",
    register_close: "Register closed",
    register_open: "Register opened",
    sale_checkout: "Sale completed",
    staff_apply_role_defaults: "Role defaults applied",
    staff_permission_save: "Staff access changed",
    staff_pin_reset: "Access PIN changed",
    staff_profile_update: "Staff profile updated",
    staff_role_update: "Staff role changed",
    transaction_attribution_update: "Sale attribution updated",
  };
  const normalized = event_kind.trim().toLowerCase();
  return actionLabels[normalized] ?? titleCaseAuditText(event_kind || "Recorded activity");
}

function formatPermissionLabel(value: string): string {
  return titleCaseAuditText(value.replace(/^staff\./, "staff "));
}

function isSystemIdKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "id" || normalized.endsWith("_id") || normalized.endsWith("uuid");
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatAuditValue(key: string, value: unknown): string | null {
  if (value == null || isSystemIdKey(key)) return null;
  const normalizedKey = key.toLowerCase();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || isUuidLike(trimmed)) return null;
    if (normalizedKey.includes("permission") || normalizedKey.includes("key")) {
      return formatPermissionLabel(trimmed);
    }
    if (
      normalizedKey.endsWith("_at") ||
      normalizedKey.includes("time") ||
      normalizedKey.includes("date")
    ) {
      return formatAuditWhen(trimmed);
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    const formatted = value
      .map((item) => {
        if (typeof item !== "string") return null;
        const trimmed = item.trim();
        if (!trimmed || isUuidLike(trimmed)) return null;
        return normalizedKey.includes("permission") || normalizedKey.includes("key")
          ? formatPermissionLabel(trimmed)
          : trimmed;
      })
      .filter((item): item is string => Boolean(item))
      .slice(0, 4);
    if (formatted.length === 0) return null;
    const suffix = value.length > formatted.length ? ` +${value.length - formatted.length} more` : "";
    return `${formatted.join(", ")}${suffix}`;
  }
  return null;
}

function formatAuditDetails(metadata: Record<string, unknown>): string {
  const priorityKeys = [
    "staff_name",
    "target_staff_name",
    "cashier_name",
    "manager_name",
    "role",
    "previous_role",
    "new_role",
    "permission_key",
    "permission_keys",
    "permissions",
    "action",
    "reason",
    "register_number",
    "register",
    "amount",
    "status",
  ];
  const keys = [
    ...priorityKeys.filter((key) => Object.prototype.hasOwnProperty.call(metadata, key)),
    ...Object.keys(metadata).filter((key) => !priorityKeys.includes(key)),
  ];
  const details = keys
    .map((key) => {
      const value = formatAuditValue(key, metadata[key]);
      if (!value) return null;
      return `${titleCaseAuditText(key)}: ${value}`;
    })
    .filter((detail): detail is string => Boolean(detail))
    .slice(0, 3);
  return details.length > 0 ? details.join(" • ") : "Details recorded";
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
  const isCompactLayout = useMediaQuery("(max-width: 1023px)");
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
      setTab(activeSection === "commission-payouts" ? "commission" : (activeSection as StaffTab));
    }
  }, [activeSection]);
  const [roster, setRoster] = useState<HubRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
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
  }, [refreshRoster]);

  useEffect(() => {
    if (tab !== "audit") return;
    void refreshAccessLog();
  }, [tab, refreshAccessLog]);

  const filteredAccessLog = useMemo(() => {
    const query = auditSearchInput.trim().toLowerCase();
    if (!query) {
      return accessLog;
    }
    return accessLog.filter((row) => {
      const action = formatAuditAction(row.event_kind);
      const details = formatAuditDetails(row.metadata);
      return (
        row.staff_name.toLowerCase().includes(query) ||
        action.toLowerCase().includes(query) ||
        details.toLowerCase().includes(query) ||
        titleCaseAuditText(row.event_kind).toLowerCase().includes(query)
      );
    });
  }, [accessLog, auditSearchInput]);

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

  const roleLabel = (r: StaffRole) =>
    r === "admin"
      ? "Admin"
      : r === "salesperson"
        ? "Salesperson"
        : r === "sales_support"
          ? "Sales Support"
          : r === "staff_support"
            ? "Staff Support"
            : "Alterations";

  const tabs = useMemo(() => {
    const all: {
      id: StaffTab;
      label: string;
      icon: typeof LayoutGrid;
      perm?: string;
      requireAll?: string[];
      requireAny?: string[];
    }[] = [
      { id: "team", label: "Team", icon: LayoutGrid, perm: "staff.view" },
      { id: "tasks", label: "Tasks", icon: ListChecks, perm: "tasks.complete" },
      { id: "schedule", label: "Schedule", icon: CalendarDays, perm: "staff.view" },
      {
        id: "commission",
        label: "Commissions",
        icon: LayoutGrid,
        requireAny: ["staff.manage_commission", "insights.view"],
      },
      { id: "audit", label: "Audit", icon: ClipboardList, perm: "staff.view_audit" },
    ];
    return all.filter((t) => {
      if (t.requireAny?.length) return t.requireAny.some((k) => hasPermission(k));
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
              <div className="relative min-w-0 flex-1 sm:min-w-[18rem]">
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
                className="ui-input w-full min-w-[10rem] px-3 py-2 sm:w-auto sm:min-w-[12rem]"
              >
                <option value="active">Active Staff</option>
                <option value="inactive">Inactive Staff</option>
                <option value="all">All Staff</option>
              </select>
            </div>
            <p className="w-full text-[10px] font-bold uppercase tracking-widest text-app-text-muted lg:w-auto">
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
              <div
                data-testid="staff-team-bulk-controls"
                className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center"
              >
                <select
                  value={bulkRole}
                  onChange={(e) => setBulkRole(e.target.value as StaffRole)}
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  className="ui-input w-full min-w-[9.5rem] px-3 py-2 disabled:opacity-50 sm:w-auto sm:min-w-[11rem]"
                >
                  <option value="sales_support">Sales Support</option>
                  <option value="staff_support">Staff Support</option>
                  <option value="alterations">Alterations</option>
                  <option value="salesperson">Salesperson</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="button"
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  onClick={() => void bulkSetRole()}
                  className="ui-btn-secondary w-full px-3 py-2 disabled:opacity-50 sm:w-auto"
                >
                  Set Staff Type
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  onClick={() => void bulkSetActive(true)}
                  className="ui-btn-secondary w-full px-3 py-2 disabled:opacity-50 sm:w-auto"
                >
                  Make Active
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || selectedStaffIds.length === 0}
                  onClick={() => void bulkSetActive(false)}
                  className="ui-btn-secondary w-full px-3 py-2 disabled:opacity-50 sm:w-auto"
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
                  className="ui-card flex touch-manipulation cursor-pointer select-none flex-col p-4 transition-colors active:bg-app-surface-2"
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
            <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:justify-end">
              <div className="relative w-full sm:w-64">
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
                className="ui-btn-secondary w-full px-3 py-1.5 sm:w-auto"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="ui-card">
            {isCompactLayout ? (
              <div data-testid="staff-audit-cards" className="space-y-3 p-3">
                {accessLogLoading && accessLog.length === 0 ? (
                  <p className="rounded-xl border border-app-border bg-app-surface px-3 py-8 text-center text-sm text-app-text-muted">
                    Loading…
                  </p>
                ) : null}
                {filteredAccessLog.map((row) => (
                  <article
                    key={row.id}
                    className="rounded-2xl border border-app-border bg-app-surface px-3 py-3 text-xs shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold text-app-text-muted">
                        {formatAuditWhen(row.created_at)}
                      </p>
                      <p className="rounded-full border border-app-accent/20 bg-app-accent/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-[var(--app-accent)]">
                        {formatAuditAction(row.event_kind)}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <img
                        src={staffAvatarUrl(row.staff_avatar_key)}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-full border border-app-border object-cover"
                      />
                      <span className="font-semibold text-app-text">{row.staff_name}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-app-text-muted">
                      {formatAuditDetails(row.metadata)}
                    </p>
                  </article>
                ))}
                {!accessLogLoading && filteredAccessLog.length === 0 ? (
                  <p className="rounded-xl border border-app-border bg-app-surface px-3 py-8 text-center text-sm text-app-text-muted">
                    No events yet.
                  </p>
                ) : null}
              </div>
            ) : (
              <table data-testid="staff-audit-table" className="w-full text-left text-xs">
                <thead className="sticky top-0 border-b border-app-border bg-app-surface text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  <tr>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">Staff</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border text-[11px]">
                  {accessLogLoading && accessLog.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-app-text-muted">
                        Loading…
                      </td>
                    </tr>
                  ) : null}
                  {filteredAccessLog.map((row) => (
                    <tr key={row.id} className="align-top transition-colors hover:bg-app-surface-2">
                      <td className="whitespace-nowrap px-3 py-2 text-app-text-muted">
                        {formatAuditWhen(row.created_at)}
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
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-[var(--app-accent)]">
                        {formatAuditAction(row.event_kind)}
                      </td>
                      <td className="max-w-md px-3 py-2 leading-relaxed text-app-text-muted">
                        <span className="line-clamp-2">{formatAuditDetails(row.metadata)}</span>
                      </td>
                    </tr>
                  ))}
                  {!accessLogLoading && filteredAccessLog.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-app-text-muted">
                        No events yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}

      {tab === "commission" ? <CommissionManagerWorkspace /> : null}

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
