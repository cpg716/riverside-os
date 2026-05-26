import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Scissors,
  CheckCircle2,
  Clock,
  Package,
  Calendar as CalendarIcon,
  AlertTriangle,
  ClipboardList,
  Search,
  Printer,
  Plus,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import AlterationSchedulingDrawer from "../alterations/scheduler/AlterationSchedulingDrawer";

const baseUrl = getBaseUrl();

type AlterationRow = {
  id: string;
  customer_id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_code: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_address_line1: string | null;
  customer_city: string | null;
  customer_state: string | null;
  customer_postal_code: string | null;
  wedding_member_id: string | null;
  status: string;
  due_at: string | null;
  fitting_at: string | null;
  appointment_id: string | null;
  total_units_jacket: number;
  total_units_pant: number;
  notes: string | null;
  linked_transaction_id: string | null;
  linked_transaction_display_id: string | null;
  source_type: string | null;
  item_description: string | null;
  work_requested: string | null;
  source_transaction_id: string | null;
  source_transaction_line_id: string | null;
  source_sku: string | null;
  charge_amount: string | number | null;
  intake_channel: string;
  source_snapshot: Record<string, unknown> | null;
  picked_up_at: string | null;
  picked_up_by_staff_id: string | null;
  created_at: string;
};

type AlterationCapacityDay = {
  date: string;
  jacket_units_used: number;
  pant_units_used: number;
  jacket_units_available: number;
  pant_units_available: number;
  is_manual_only: boolean;
  is_closed: boolean;
  closed_label: string | null;
  has_staff: boolean;
};


const STATUS_FILTERS = ["all", "intake", "in_work", "ready", "picked_up"] as const;
const SOURCE_FILTERS = [
  { value: "all", label: "All sources" },
  { value: "current_cart_item", label: "Current sale" },
  { value: "catalog_item", label: "Stock/catalog item" },
  { value: "existing_order", label: "Existing order" },
  { value: "past_transaction_line", label: "Past purchase" },
  { value: "custom_item", label: "Custom/manual item" },
] as const;
const DUE_FILTERS = [
  { value: "all", label: "All due dates" },
  { value: "due_today", label: "Due today" },
  { value: "overdue", label: "Overdue" },
  { value: "ready", label: "Ready" },
] as const;

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dateInputValue = (date: Date) => {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};
const localDateKey = (value: string | null) => value ? dateInputValue(new Date(value)) : null;
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
const isOpenWorkStatus = (status: string) => status !== "ready" && status !== "picked_up";
const fulfillmentLooksLikeOrder = (snapshot: Record<string, unknown> | null | undefined) => {
  const fulfillment = String(snapshot?.fulfillment ?? "").toLowerCase();
  return ["special_order", "wedding_order", "custom", "layaway", "order"].includes(fulfillment);
};
const isExistingOrderSource = (row: AlterationRow) =>
  row.source_type === "past_transaction_line" && fulfillmentLooksLikeOrder(row.source_snapshot);
const isDueToday = (row: AlterationRow, now = new Date()) => {
  if (!row.due_at || !isOpenWorkStatus(row.status)) return false;
  return startOfLocalDay(new Date(row.due_at)).getTime() === startOfLocalDay(now).getTime();
};
const isOverdue = (row: AlterationRow, now = new Date()) => {
  if (!row.due_at || !isOpenWorkStatus(row.status)) return false;
  return startOfLocalDay(new Date(row.due_at)).getTime() < startOfLocalDay(now).getTime();
};

const alterationSourceLabel = (row: Pick<AlterationRow, "source_type" | "source_snapshot">) => {
  if (row.source_type === "past_transaction_line" && fulfillmentLooksLikeOrder(row.source_snapshot)) {
    return "Existing order";
  }
  switch (row.source_type) {
    case "current_cart_item":
      return "Current sale";
    case "past_transaction_line":
      return "Past purchase";
    case "catalog_item":
      return "Stock/catalog item";
    case "custom_item":
      return "Custom/manual item";
    default:
      return "Custom/manual item";
  }
};

const formatCharge = (amount: string | number | null | undefined) => {
  if (amount == null || amount === "") return "Free / included";
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return "Free / included";
  return `Charge noted: ${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(parsed)}`;
};

const customerName = (row: AlterationRow) =>
  `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim() ||
  "Unassigned customer";

const rowMatchesSearch = (row: AlterationRow, search: string) => {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.id,
    customerName(row),
    row.customer_code,
    row.customer_phone,
    row.customer_email,
    row.customer_address_line1,
    row.customer_city,
    row.customer_state,
    row.customer_postal_code,
    row.item_description,
    row.work_requested,
    row.notes,
    row.source_sku,
    row.linked_transaction_display_id,
    row.source_transaction_id,
    alterationSourceLabel(row),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
};

const nextAlterationStatus = (status: string): string | null => {
  if (status === "intake") return "in_work";
  if (status === "in_work") return "ready";
  if (status === "ready") return "picked_up";
  return null;
};

const alterationPressureState = (row: AlterationRow) => {
  if (isOverdue(row)) {
    return {
      label: "Needs attention",
      className: "border-app-danger/30 bg-app-danger/10 text-app-danger",
    };
  }
  if (isDueToday(row)) {
    return {
      label: "Due today",
      className: "border-app-warning/40 bg-app-warning/10 text-app-warning",
    };
  }
  if (row.status === "ready") {
    return {
      label: "Ready for pickup",
      className: "border-app-success/30 bg-app-success/10 text-app-success",
    };
  }
  return {
    label: row.status === "in_work" ? "In work" : "Needs tailor review",
    className: "border-app-border bg-app-surface-2 text-app-text-muted",
  };
};

const alterationNextSafeAction = (row: AlterationRow): string => {
  if (isOverdue(row)) return "Escalate or reassign before promising pickup.";
  if (isDueToday(row)) return "Advance status or reassign if it will miss today.";
  if (row.status === "intake") return "Start work or assign schedule.";
  if (row.status === "in_work") return "Mark ready when tailoring is complete.";
  if (row.status === "ready") return "Confirm pickup before marking picked up.";
  return "Review history if the customer asks for status.";
};

export default function CustomerAlterationsPanel({
  apiAuth,
  customerId,
  highlightAlterationId,
  onHighlightConsumed,
}: {
  apiAuth: () => Record<string, string>;
  customerId?: string | null;
  highlightAlterationId?: string | null;
  onHighlightConsumed?: () => void;
}) {
  const { toast } = useToast();
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [rows, setRows] = useState<AlterationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [dueFilter, setDueFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [schedulingAlt, setSchedulingAlt] = useState<AlterationRow | null>(null);
  const [compactQueue, setCompactQueue] = useState(false);
  const [selectedScheduleDate, setSelectedScheduleDate] = useState(() => dateInputValue(new Date()));
  const [scheduleDayCapacity, setScheduleDayCapacity] = useState<AlterationCapacityDay | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (customerId) params.set("customer_id", customerId);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`${baseUrl}/api/alterations${suffix}`, { headers: apiAuth() });
      if (!res.ok) throw new Error("load");
      setRows((await res.json()) as AlterationRow[]);
    } catch {
      toast("Could not load alterations.", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, customerId, debouncedSearch, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const loadCapacity = async () => {
      try {
        const params = new URLSearchParams({
          start: selectedScheduleDate,
          end: selectedScheduleDate,
        });
        const res = await fetch(`${baseUrl}/api/alterations/capacity?${params.toString()}`, {
          headers: apiAuth(),
        });
        if (!res.ok) throw new Error("capacity");
        const data = (await res.json()) as AlterationCapacityDay[];
        if (!cancelled) setScheduleDayCapacity(data[0] ?? null);
      } catch {
        if (!cancelled) setScheduleDayCapacity(null);
      }
    };
    void loadCapacity();
    return () => {
      cancelled = true;
    };
  }, [apiAuth, selectedScheduleDate]);

  useEffect(() => {
    const id = highlightAlterationId?.trim();
    if (!id || rows.length === 0) return;
    if (!rows.some((r) => r.id === id)) return;
    const el = rowRefs.current[id];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    onHighlightConsumed?.();
  }, [highlightAlterationId, rows, onHighlightConsumed]);

  const setStatus = async (id: string, status: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Update failed", "error");
        return;
      }
      toast(`Status updated to ${status.replace("_", " ")}`, "success");
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  const scheduleForSelectedDay = async (id: string) => {
    if (scheduleDayCapacity?.is_closed) {
      toast("That day is marked closed. Choose another work date.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ fitting_at: `${selectedScheduleDate}T10:00:00Z` }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Could not schedule alteration.", "error");
        return;
      }
      toast("Alteration added to the daily schedule.", "success");
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  const pickupAlteration = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${id}/pickup`, {
        method: "POST",
        headers: apiAuth(),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Pickup failed", "error");
        return;
      }
      toast("Alteration marked as picked up", "success");
      void load();
      await printPickupReceipt(id);
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  const printPickupReceipt = async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${id}/pickup-receipt`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        toast("Could not generate pickup receipt", "error");
        return;
      }
      const data = (await res.json()) as {
        escpos_base64?: string;
        receiptline_markdown?: string;
      };
      if (data.escpos_base64) {
        const { printRawEscPosBase64 } = await import("../../lib/printerBridge");
        await printRawEscPosBase64(data.escpos_base64);
        toast("Pickup receipt sent to printer", "success");
      } else if (data.receiptline_markdown) {
        const { transform } = await import("receiptline");
        const cmd = transform(data.receiptline_markdown, {
          cpl: 42,
          encoding: "cp437",
          command: "escpos",
          cutting: true,
        });
        const b64 = btoa(
          String(cmd)
            .split("")
            .map((c) => String.fromCharCode(c.charCodeAt(0) & 0xff))
            .join("")
        );
        const { printRawEscPosBase64 } = await import("../../lib/printerBridge");
        await printRawEscPosBase64(b64);
        toast("Pickup receipt sent to printer", "success");
      }
    } catch {
      toast("Pickup receipt print failed", "error");
    }
  };

  const printDailySchedule = () => {
    const capacityLine = scheduleDayCapacity
      ? `Jacket ${scheduleDayCapacity.jacket_units_used}/${scheduleDayCapacity.jacket_units_used + scheduleDayCapacity.jacket_units_available}u · Pant ${scheduleDayCapacity.pant_units_used}/${scheduleDayCapacity.pant_units_used + scheduleDayCapacity.pant_units_available}u`
      : "Capacity unavailable";
    const closedLine = scheduleDayCapacity?.is_closed
      ? `<p class="closed">Closed: ${escapeHtml(scheduleDayCapacity.closed_label ?? "Holiday")}</p>`
      : "";
    const rowsHtml = dailyScheduledRows.length > 0
      ? dailyScheduledRows.map((row) => `
          <tr>
            <td>${escapeHtml(customerName(row))}</td>
            <td>${escapeHtml(row.item_description ?? "")}</td>
            <td>${escapeHtml(row.work_requested ?? "")}</td>
            <td>${escapeHtml(row.status.replace("_", " "))}</td>
            <td>${row.total_units_jacket}u / ${row.total_units_pant}u</td>
            <td>${escapeHtml(row.notes ?? "")}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="6">No alterations scheduled for this day.</td></tr>`;
    const printWindow = window.open("", "_blank", "width=900,height=700");
    if (!printWindow) {
      toast("Could not open print window.", "error");
      return;
    }
    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>Daily Alteration Schedule ${escapeHtml(selectedScheduleDate)}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; padding: 24px; }
            h1 { font-size: 22px; margin: 0 0 4px; }
            p { margin: 0 0 12px; }
            .meta { color: #4b5563; font-size: 13px; }
            .closed { color: #991b1b; font-weight: 700; }
            table { border-collapse: collapse; width: 100%; margin-top: 18px; font-size: 12px; }
            th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
            th { background: #f3f4f6; text-transform: uppercase; font-size: 10px; letter-spacing: .08em; }
          </style>
        </head>
        <body>
          <h1>Daily Alteration Schedule</h1>
          <p class="meta">${escapeHtml(selectedScheduleDate)} · ${dailyScheduledRows.length} scheduled · ${escapeHtml(capacityLine)}</p>
          ${closedLine}
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Garment</th>
                <th>Work</th>
                <th>Status</th>
                <th>Jacket / Pant</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "intake": return "text-sky-600 bg-sky-500/10 border-sky-500/20";
      case "in_work": return "text-amber-600 bg-amber-500/10 border-amber-500/20";
      case "ready": return "text-emerald-600 bg-emerald-500/10 border-emerald-500/20";
      case "picked_up": return "text-app-text-muted bg-app-surface-3 border-app-border";
      default: return "text-app-text-muted bg-app-surface-3 border-app-border";
    }
  };

  const matchesSourceFilter = (row: AlterationRow) => {
    if (sourceFilter === "all") return true;
    if (sourceFilter === "existing_order") return isExistingOrderSource(row);
    if (sourceFilter === "past_transaction_line") {
      return row.source_type === "past_transaction_line" && !isExistingOrderSource(row);
    }
    return row.source_type === sourceFilter;
  };

  const matchesDueFilter = (row: AlterationRow) => {
    switch (dueFilter) {
      case "due_today":
        return isDueToday(row);
      case "overdue":
        return isOverdue(row);
      case "ready":
        return row.status === "ready";
      default:
        return true;
    }
  };

  const visibleRows = rows.filter((row) => {
    const statusMatches = filter === "all" || row.status === filter;
    return statusMatches && matchesSourceFilter(row) && matchesDueFilter(row) && rowMatchesSearch(row, search);
  });

  const dailyScheduledRows = rows.filter((row) => localDateKey(row.fitting_at) === selectedScheduleDate);
  const unscheduledOpenRows = rows.filter((row) => row.status !== "picked_up" && !row.fitting_at);

  const summaryCards = [
    {
      id: "overdue",
      label: "Overdue",
      value: rows.filter((row) => isOverdue(row)).length,
      icon: AlertTriangle,
      tint: "ui-tint-danger",
      color: "text-app-danger",
      bg: "bg-app-danger/8",
      border: "border-app-danger/16",
      onClick: () => {
        setDueFilter("overdue");
        setFilter("all");
      },
    },
    {
      id: "due_today",
      label: "Due Today",
      value: rows.filter((row) => isDueToday(row)).length,
      icon: CalendarIcon,
      tint: "ui-tint-warning",
      color: "text-app-warning",
      bg: "bg-app-warning/8",
      border: "border-app-warning/16",
      onClick: () => {
        setDueFilter("due_today");
        setFilter("all");
      },
    },
    {
      id: "ready",
      label: "Ready for Pickup",
      value: rows.filter((row) => row.status === "ready").length,
      icon: CheckCircle2,
      tint: "ui-tint-success",
      color: "text-app-success",
      bg: "bg-app-success/8",
      border: "border-app-success/16",
      onClick: () => {
        setDueFilter("ready");
        setFilter("all");
      },
    },
    {
      id: "open",
      label: "Total Open",
      value: rows.filter((row) => row.status !== "picked_up").length,
      icon: Scissors,
      tint: "ui-tint-accent",
      color: "text-app-accent",
      bg: "bg-app-accent/8",
      border: "border-app-accent/16",
      onClick: () => {
        setDueFilter("all");
        setFilter("all");
      },
    },
  ];

  const workbenchSections = [
    {
      id: "overdue",
      title: "Overdue",
      subtitle: "Open garment work past the promised due date.",
      icon: AlertTriangle,
      rows: visibleRows.filter((row) => isOverdue(row)),
      tone: "text-red-700 bg-red-500/10 border-red-500/20",
    },
    {
      id: "due_today",
      title: "Due Today",
      subtitle: "Open garment work due today.",
      icon: CalendarIcon,
      rows: visibleRows.filter((row) => isDueToday(row) && !isOverdue(row)),
      tone: "text-amber-700 bg-amber-500/10 border-amber-500/20",
    },
    {
      id: "ready",
      title: "Ready for Pickup",
      subtitle: "Completed alteration work waiting for the customer.",
      icon: CheckCircle2,
      rows: visibleRows.filter((row) => row.status === "ready"),
      tone: "text-emerald-700 bg-emerald-500/10 border-emerald-500/20",
    },
    {
      id: "in_work",
      title: "In Work",
      subtitle: "Garments currently being altered.",
      icon: Scissors,
      rows: visibleRows.filter(
        (row) => row.status === "in_work" && !isDueToday(row) && !isOverdue(row),
      ),
      tone: "text-violet-700 bg-violet-500/10 border-violet-500/20",
    },
    {
      id: "intake",
      title: "Intake / Not Started",
      subtitle: "New alteration work that still needs tailor attention.",
      icon: ClipboardList,
      rows: visibleRows.filter(
        (row) => row.status === "intake" && !isDueToday(row) && !isOverdue(row),
      ),
      tone: "text-sky-700 bg-sky-500/10 border-sky-500/20",
    },
  ];

  const sourceContextLabel = (row: AlterationRow) => {
    if (!row.source_transaction_id && !row.source_transaction_line_id) return null;
    const display = row.linked_transaction_display_id ?? row.source_transaction_id?.slice(0, 8).toUpperCase();
    return `Source ${display ?? "transaction"}${row.source_transaction_line_id ? " / garment line" : ""}`;
  };

  const renderAlterationCard = (r: AlterationRow) => (
    <div
      key={r.id}
      ref={(el) => { rowRefs.current[r.id] = el; }}
      data-testid="alteration-workbench-card"
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 ${
        compactQueue ? "gap-2 p-3" : "gap-3 p-4"
      } ${
        highlightAlterationId === r.id ? "ring-2 ring-app-accent shadow-2xl" : ""
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
           <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-sm font-black text-app-text shadow-inner">
              {r.customer_first_name?.[0]}{r.customer_last_name?.[0]}
           </div>
           <div className="min-w-0 flex-1">
              <p className="mb-0.5 truncate font-mono text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-60">#{r.customer_code ?? "NO-CODE"}</p>
              <h4 className="line-clamp-2 break-words text-base font-black leading-tight text-app-text">
                {customerName(r)}
              </h4>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                 <div className={`px-2 py-0.5 rounded-lg border text-[9px] font-black uppercase tracking-widest ${getStatusColor(r.status)}`}>
                    {r.status.replace("_", " ")}
                 </div>
                 <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                   {alterationSourceLabel(r)}
                 </span>
                 <span className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-700">
                   {formatCharge(r.charge_amount)}
                 </span>
                 {r.due_at && (
                   <div className="flex items-center gap-1.5 text-app-text-muted">
                     <Clock size={12} className={isOverdue(r) ? "text-red-500" : ""} />
                     <span className="text-[10px] font-bold tabular-nums">
                       Due {new Date(r.due_at).toLocaleDateString()}
                     </span>
                   </div>
                 )}
              </div>
           </div>
        </div>

        <div className="hidden shrink-0 flex-col items-end gap-1 font-mono text-[10px] text-app-text-muted opacity-50 sm:flex">
           <span>ALT-{r.id.slice(0, 8).toUpperCase()}</span>
        </div>
      </div>

      {compactQueue ? (
        <p className="truncate text-xs font-semibold text-app-text-muted">
          {[r.item_description, r.work_requested].filter(Boolean).join(" · ") || "Garment details not specified"}
        </p>
      ) : null}

      {!compactQueue && r.notes && (
        <div className="break-words rounded-xl border border-app-border/40 bg-app-surface-2/60 p-3 text-xs italic text-app-text/80 shadow-inner">
           {r.notes}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-app-border/40 bg-app-bg/60 px-3 py-2">
        <span
          className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${alterationPressureState(r).className}`}
        >
          {alterationPressureState(r).label}
        </span>
        {nextAlterationStatus(r.status) ? (
          <span className="rounded-full border border-app-accent/25 bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent">
            Next: {nextAlterationStatus(r.status)?.replace("_", " ")}
          </span>
        ) : null}
        <span className="min-w-0 rounded-full border border-app-border bg-app-surface px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
          {alterationNextSafeAction(r)}
        </span>
      </div>

      {!compactQueue ? (
      <div className="grid gap-3 rounded-xl border border-app-border/40 bg-app-surface-2/60 p-3 text-xs shadow-inner sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Garment
          </p>
          <p className="mt-1 break-words font-bold text-app-text">
            {r.item_description || "Garment not specified"}
          </p>
          {r.source_sku ? (
            <p className="mt-0.5 truncate font-mono text-[10px] text-app-text-muted">
              SKU {r.source_sku}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Work Requested
          </p>
          <p className="mt-1 break-words font-bold text-app-text">
            {r.work_requested || "Work details not specified"}
          </p>
        </div>
        {sourceContextLabel(r) ? (
          <div className="break-words text-[10px] font-bold uppercase tracking-widest text-app-text-muted sm:col-span-2">
            {sourceContextLabel(r)}
          </div>
        ) : null}
      </div>
      ) : null}

      <div className={`flex flex-wrap items-center justify-between gap-3 border-t border-app-border/40 ${compactQueue ? "pt-2" : "pt-3"}`}>
         <div className="flex flex-col gap-0.5">
           <p className="text-[9px] font-bold uppercase tracking-tighter text-app-text-muted">Created {new Date(r.created_at).toLocaleString()}</p>
           {r.status === "picked_up" && r.picked_up_at ? (
             <p className="text-[9px] font-bold uppercase tracking-tighter text-app-success">
               Picked up {new Date(r.picked_up_at).toLocaleString()}
             </p>
           ) : null}
         </div>

         <div className="flex flex-wrap items-center justify-end gap-2">
            {r.status === "ready" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void pickupAlteration(r.id)}
                className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-tight text-emerald-400 transition-all hover:bg-emerald-500 hover:text-white disabled:opacity-50"
              >
                Pick Up & Print
              </button>
            ) : null}
            {r.status === "picked_up" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void printPickupReceipt(r.id)}
                className="rounded-xl border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-tight text-app-accent transition-all hover:bg-app-accent hover:text-white disabled:opacity-50"
              >
                Reprint Receipt
              </button>
            ) : null}
            {nextAlterationStatus(r.status) && r.status !== "ready" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void setStatus(r.id, nextAlterationStatus(r.status) as string)}
                className="rounded-xl border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-tight text-app-accent transition-all hover:bg-app-accent hover:text-white disabled:opacity-50"
              >
                Advance to {nextAlterationStatus(r.status)?.replace("_", " ")}
              </button>
            ) : null}
            {["in_work", "ready", "picked_up"].map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy || r.status === s}
                onClick={() => void setStatus(r.id, s)}
                className={`rounded-xl border px-3 py-1.5 text-[9px] font-black uppercase tracking-tight transition-all ${
                  r.status === s
                    ? "bg-app-accent text-white border-transparent"
                    : "bg-app-surface-2 border-app-border text-app-text hover:bg-app-accent hover:text-white"
                }`}
              >
                {s.replace("_", " ")}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSchedulingAlt(r)}
              className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-tight text-blue-400 transition-all hover:bg-blue-500 hover:text-white"
            >
              Plan / Reassign
            </button>
         </div>
      </div>
    </div>
  );

  return (
    <div className="ui-page flex min-h-0 flex-1 flex-col bg-transparent p-0">
      <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              data-testid={`alterations-summary-${card.id}`}
              onClick={card.onClick}
              className={`ui-card flex min-w-[200px] flex-1 items-center gap-4 p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg ${card.tint}`}
            >
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${card.border} ${card.bg} shadow-sm`}
              >
                <Icon size={24} className={card.color} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
                  {card.label}
                </p>
                <p className="text-2xl font-black tabular-nums text-app-text">
                  {card.value}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="px-4 sm:px-6">
        <div className="ui-card ui-tint-accent px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                Alteration Workflow
              </p>
              <p className="mt-1 text-sm font-semibold text-app-text">
                {customerId
                  ? "Customer alteration history and open garment work, searchable by garment, due date, source, and contact details."
                  : "Garment-based workbench for alteration attention by due date, status, and source item."}
              </p>
            </div>
            <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              {visibleRows.length} visible / {rows.length} loaded
            </span>
          </div>
        </div>
      </div>

      <div className="px-4 pt-4 sm:px-6">
        <section className="ui-card border-app-border bg-app-surface px-4 py-4 print:shadow-none">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-app-border/50 pb-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                Daily Alteration Schedule
              </p>
              <p className="mt-1 text-sm font-semibold text-app-text">
                View, print, and assign alteration work by scheduled work date.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={selectedScheduleDate}
                onChange={(event) => {
                  if (event.target.value) setSelectedScheduleDate(event.target.value);
                }}
                className="ui-input h-9 rounded-xl py-1 text-[10px] font-black uppercase tracking-widest"
                aria-label="Daily alteration schedule date"
              />
              <button
                type="button"
                onClick={printDailySchedule}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface hover:text-app-text"
              >
                <Printer size={14} />
                Print
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest">
                <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-app-text">
                  {dailyScheduledRows.length} scheduled
                </span>
                {scheduleDayCapacity ? (
                  <>
                    <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-blue-700">
                      Jacket {scheduleDayCapacity.jacket_units_used}/{scheduleDayCapacity.jacket_units_used + scheduleDayCapacity.jacket_units_available}u
                    </span>
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-emerald-700">
                      Pant {scheduleDayCapacity.pant_units_used}/{scheduleDayCapacity.pant_units_used + scheduleDayCapacity.pant_units_available}u
                    </span>
                    {scheduleDayCapacity.is_closed ? (
                      <span className="rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-red-700">
                        Closed: {scheduleDayCapacity.closed_label ?? "Holiday"}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
              {dailyScheduledRows.length > 0 ? (
                <div className="grid gap-2">
                  {dailyScheduledRows.map(renderAlterationCard)}
                </div>
              ) : (
                <p className="rounded-2xl border border-dashed border-app-border bg-app-surface-2/70 px-4 py-5 text-sm font-semibold text-app-text-muted">
                  No alterations are scheduled for this day.
                </p>
              )}
            </div>

            <aside className="min-w-0 rounded-2xl border border-app-border bg-app-surface-2 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Add Open Work
                </p>
                <span className="rounded-full border border-app-border bg-app-surface px-2 py-0.5 text-[10px] font-black text-app-text">
                  {unscheduledOpenRows.length}
                </span>
              </div>
              <div className="space-y-2">
                {unscheduledOpenRows.slice(0, 6).map((row) => (
                  <div key={row.id} className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                    <p className="truncate text-xs font-black text-app-text">{customerName(row)}</p>
                    <p className="mt-0.5 truncate text-[10px] font-semibold text-app-text-muted">
                      {[row.item_description, row.work_requested].filter(Boolean).join(" · ") || "Garment work"}
                    </p>
                    <button
                      type="button"
                      disabled={busy || scheduleDayCapacity?.is_closed}
                      onClick={() => void scheduleForSelectedDay(row.id)}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-app-accent/30 bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent hover:bg-app-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus size={12} />
                      Add to Day
                    </button>
                  </div>
                ))}
                {unscheduledOpenRows.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-app-border bg-app-surface px-3 py-4 text-xs font-semibold text-app-text-muted">
                    No unscheduled open alterations loaded.
                  </p>
                ) : null}
              </div>
            </aside>
          </div>
        </section>
      </div>

      <div className="flex flex-1 flex-col p-3 sm:p-6 lg:min-h-0 lg:p-8 animate-workspace-snap">
        <section className="ui-card flex flex-1 flex-col overflow-hidden lg:min-h-0">
          <div className="flex shrink-0 flex-col gap-3 border-b border-app-border bg-app-surface-2 px-4 py-4 lg:flex-row lg:flex-wrap lg:items-center lg:px-5">
            <div className="relative min-w-0 flex-1">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-disabled"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                data-testid="alterations-search"
                placeholder="SEARCH NAME, PHONE, GARMENT..."
                className="ui-input h-10 w-full rounded-xl pl-10 text-[10px] font-black uppercase tracking-widest"
                aria-label="Search alterations"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {DUE_FILTERS.map(f => (
                <button
                  key={f.value}
                  type="button"
                  data-testid={`alterations-due-filter-${f.value}`}
                  onClick={() => setDueFilter(f.value)}
                  className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                    dueFilter === f.value
                      ? "border-app-accent/20 bg-app-accent/10 text-app-accent"
                      : "border-app-border bg-app-surface-3 text-app-text-muted hover:bg-app-surface hover:text-app-text"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-app-surface-3 px-4 py-4 lg:justify-end lg:px-5">
            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              data-testid="alterations-source-filter"
              className="ui-input h-9 rounded-xl py-1 text-[10px] font-black uppercase tracking-widest"
              aria-label="Alteration source filter"
            >
              {SOURCE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              data-testid="alterations-status-filter"
              className="ui-input h-9 rounded-xl py-1 text-[10px] font-black uppercase tracking-widest"
              aria-label="Alteration status filter"
            >
              {STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {status.replace("_", " ")}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setCompactQueue((value) => !value)}
              className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
                compactQueue
                  ? "border-app-accent bg-app-accent/10 text-app-accent"
                  : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-surface"
              }`}
            >
              {compactQueue ? "Comfort View" : "Compact View"}
            </button>
          </div>

          <div className="flex items-center justify-between border-b border-app-border/40 px-5 py-3">
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
              Garment Workbench
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              {visibleRows.length} visible
            </p>
          </div>

          <div className="flex-1 p-3 lg:min-h-0 lg:overflow-y-auto lg:p-4 custom-scrollbar">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 opacity-40">
                <Loader2 size={32} className="animate-spin text-app-accent" />
                <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Hydrating queue…</p>
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 grayscale opacity-30">
                <Package size={48} />
                <p className="text-sm font-black uppercase tracking-widest text-center">No garment work matched these filters.</p>
              </div>
            ) : (
              compactQueue ? (
                <div className="grid gap-2">
                  {visibleRows.map(renderAlterationCard)}
                </div>
              ) : (
              <>
              <div className="grid gap-3 lg:hidden">
                {visibleRows.map(renderAlterationCard)}
              </div>
              <div className="hidden items-start gap-4 lg:grid xl:grid-cols-2 2xl:grid-cols-3">
                {workbenchSections.map((section) => {
                const Icon = section.icon;
                const isIntakeSection = section.id === "intake";
                return (
                  <section
                    key={section.id}
                    data-testid={`alteration-workbench-section-${section.id}`}
                    className={`flex min-w-0 flex-col rounded-2xl border border-app-border/60 bg-app-surface/80 p-4 shadow-sm ${
                      isIntakeSection
                        ? "h-[min(63vh,780px)] min-h-[360px] xl:col-span-2 2xl:col-span-3"
                        : "h-[min(42vh,520px)] min-h-[240px]"
                    }`}
                  >
                    <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border ${section.tone}`}>
                          <Icon size={17} />
                        </div>
                        <div className="min-w-0">
                          <h4 className="truncate text-sm font-black uppercase tracking-widest text-app-text">
                            {section.title}
                          </h4>
                          <p className="line-clamp-2 text-[10px] font-semibold leading-snug text-app-text-muted">
                            {section.subtitle}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-black tabular-nums text-app-text">
                        {section.rows.length}
                      </span>
                    </div>
                    {section.rows.length > 0 ? (
                      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                        {section.rows.map(renderAlterationCard)}
                      </div>
                    ) : (
                      <p className="rounded-2xl border border-dashed border-app-border bg-app-surface-2/70 px-4 py-3 text-xs font-semibold text-app-text-muted">
                        No garments in this section.
                      </p>
                    )}
                  </section>
                );
                })}
              </div>
              </>
              )
            )}
          </div>
        </section>
      </div>
      {schedulingAlt && (
        <AlterationSchedulingDrawer
          alteration={schedulingAlt}
          apiAuth={apiAuth}
          onClose={() => setSchedulingAlt(null)}
          onUpdated={load}
        />
      )}
    </div>
  );
}
