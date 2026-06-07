import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { printTextReport } from "../../lib/printerBridge";
import VariantSearchInput, {
  VariantSearchResult,
} from "../ui/VariantSearchInput";
import ConfirmationModal from "../ui/ConfirmationModal";
import {
  ArrowRight,
  BadgeDollarSign,
  Barcode,
  Calendar,
  CheckCircle2,
  Clock3,
  PauseCircle,
  Plus,
  Search,
  Printer,
  SlidersHorizontal,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";

const baseUrl = getBaseUrl();

interface EventRow {
  id: string;
  name: string;
  receipt_label: string;
  starts_at: string;
  ends_at: string;
  percent_off: string;
  is_active: boolean;
  scope_type: string;
  scope_category_id: string | null;
  scope_vendor_id: string | null;
}

interface VarRow {
  variant_id: string;
  sku: string;
  product_name: string;
}

interface UsageSummaryRow {
  event_id: string;
  event_name: string;
  line_count: number;
  units_sold: number;
  subtotal_sum: string;
}

interface UsageItemRow {
  variant_id: string;
  sku: string;
  product_name: string;
  line_count: number;
  units_sold: number;
  subtotal_sum: string;
}

interface UsageTransactionRow {
  transaction_id: string;
  transaction_display_id: string | null;
  created_at: string;
  sku: string;
  product_name: string;
  quantity: number;
  line_subtotal: string;
}

interface UsageDetailResponse {
  summary: UsageSummaryRow;
  items: UsageItemRow[];
  transactions: UsageTransactionRow[];
}

type PromoScope = "variants" | "category" | "vendor" | "all";
type PromoAction = "end" | "cancel";
type PanelMode = "manage" | "create";

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

function ymdLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function money(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      })
    : "$0.00";
}

function dateShort(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusFor(row: EventRow) {
  const now = Date.now();
  const starts = new Date(row.starts_at).getTime();
  const ends = new Date(row.ends_at).getTime();
  if (!row.is_active) return { label: "Cancelled", tone: "bg-rose-500/10 text-rose-500" };
  if (starts > now) return { label: "Scheduled", tone: "bg-sky-500/10 text-sky-500" };
  if (ends < now) return { label: "Ended", tone: "bg-app-surface-2 text-app-text-muted" };
  return { label: "Active", tone: "bg-emerald-500/10 text-emerald-500" };
}

function scopeLabel(row: EventRow) {
  if (row.scope_type === "all") return "Full Inventory";
  if (row.scope_type === "category") return "Whole category";
  if (row.scope_type === "vendor") return "Primary vendor";
  return "Selected SKUs";
}

function dateTimeShort(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildPerformancePrintText(
  row: EventRow,
  detail: UsageDetailResponse,
  from: string,
  to: string,
) {
  const lines = [
    "Promotion Performance",
    "=====================",
    `Promotion: ${row.name}`,
    `Receipt label: ${row.receipt_label}`,
    `Scope: ${scopeLabel(row)}`,
    `Window: ${from || "Start"} - ${to || "Today"}`,
    `Sales: ${money(detail.summary.subtotal_sum)}`,
    `Units: ${detail.summary.units_sold}`,
    `Lines: ${detail.summary.line_count}`,
    "",
    "Transactions",
    "------------",
  ];
  if (detail.transactions.length === 0) {
    lines.push("No transactions used this promotion in the selected window.");
  } else {
    detail.transactions.forEach((tx) => {
      lines.push(
        `${dateTimeShort(tx.created_at)} | ${tx.transaction_display_id ?? tx.transaction_id.slice(0, 8)} | ${tx.sku} | Qty ${tx.quantity} | ${money(tx.line_subtotal)} | ${tx.product_name}`,
      );
    });
  }
  return lines.join("\n");
}

export default function DiscountEventsPanel() {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const canView = hasPermission("catalog.view");
  const canEdit = hasPermission("catalog.edit");
  const scanInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<EventRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [vars, setVars] = useState<VarRow[]>([]);

  const [name, setName] = useState("");
  const [receiptLabel, setReceiptLabel] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [pct, setPct] = useState("25");
  const [scopeType, setScopeType] = useState<PromoScope>("variants");
  const [scopeCategoryId, setScopeCategoryId] = useState("");
  const [scopeVendorId, setScopeVendorId] = useState("");

  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [promoVendors, setPromoVendors] = useState<{ id: string; name: string }[]>([]);
  const [editScopeType, setEditScopeType] = useState<PromoScope>("variants");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editVendorId, setEditVendorId] = useState("");

  const [scanSku, setScanSku] = useState("");
  const [busyScan, setBusyScan] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [confirmAction, setConfirmAction] = useState<PromoAction | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("manage");

  const [usageFrom, setUsageFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return ymdLocal(d);
  });
  const [usageTo, setUsageTo] = useState(() => ymdLocal(new Date()));
  const [usageRows, setUsageRows] = useState<UsageSummaryRow[]>([]);
  const [usageDetail, setUsageDetail] = useState<UsageDetailResponse | null>(null);
  const [performanceEventId, setPerformanceEventId] = useState<string | null>(null);
  const [performanceDetail, setPerformanceDetail] = useState<UsageDetailResponse | null>(null);
  const [performanceBusy, setPerformanceBusy] = useState(false);

  const selected = useMemo(() => rows.find((row) => row.id === sel) ?? null, [rows, sel]);
  const performanceEvent = useMemo(
    () => rows.find((row) => row.id === performanceEventId) ?? null,
    [rows, performanceEventId],
  );
  const usageByEvent = useMemo(() => {
    const map = new Map<string, UsageSummaryRow>();
    usageRows.forEach((row) => map.set(row.event_id, row));
    return map;
  }, [usageRows]);

  const counts = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        const status = statusFor(row).label;
        if (status === "Active") acc.active += 1;
        else if (status === "Scheduled") acc.scheduled += 1;
        else acc.closed += 1;
        return acc;
      },
      { active: 0, scheduled: 0, closed: 0 },
    );
  }, [rows]);

  const load = useCallback(async () => {
    if (!canView) return;
    const res = await fetch(`${baseUrl}/api/discount-events`, {
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      setRows([]);
      return;
    }
    const nextRows = (await res.json()) as EventRow[];
    setRows(nextRows);
    setSel((current) => current ?? nextRows[0]?.id ?? null);
  }, [backofficeHeaders, canView]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canView) return;
    void (async () => {
      const [cRes, vRes] = await Promise.all([
        fetch(`${baseUrl}/api/categories`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/vendors`, { headers: backofficeHeaders() }),
      ]);
      if (cRes.ok) {
        const j = (await cRes.json()) as { id: string; name: string }[];
        setCategories(Array.isArray(j) ? j : []);
      }
      if (vRes.ok) {
        const j = (await vRes.json()) as { id: string; name: string }[];
        setPromoVendors(Array.isArray(j) ? j : []);
      }
    })();
  }, [canView, backofficeHeaders]);

  useEffect(() => {
    if (!selected) return;
    const st = (selected.scope_type ?? "variants") as PromoScope;
    setEditScopeType(st);
    setEditCategoryId(selected.scope_category_id ?? "");
    setEditVendorId(selected.scope_vendor_id ?? "");
  }, [selected]);

  const loadUsageReport = useCallback(async () => {
    if (!canView) return;
    const p = new URLSearchParams();
    if (usageFrom.trim()) p.set("from", usageFrom.trim());
    if (usageTo.trim()) p.set("to", usageTo.trim());
    const res = await fetch(
      `${baseUrl}/api/discount-events/usage-report?${p.toString()}`,
      { headers: backofficeHeaders() },
    );
    if (!res.ok) {
      setUsageRows([]);
      toast("We couldn't load promotion results right now. Please try again.", "error");
      return;
    }
    setUsageRows((await res.json()) as UsageSummaryRow[]);
  }, [backofficeHeaders, canView, usageFrom, usageTo, toast]);

  const loadUsageDetail = useCallback(async () => {
    if (!canView || !sel) {
      setUsageDetail(null);
      return;
    }
    const p = new URLSearchParams();
    if (usageFrom.trim()) p.set("from", usageFrom.trim());
    if (usageTo.trim()) p.set("to", usageTo.trim());
    const res = await fetch(
      `${baseUrl}/api/discount-events/${sel}/usage-report?${p.toString()}`,
      { headers: backofficeHeaders() },
    );
    if (!res.ok) {
      setUsageDetail(null);
      return;
    }
    setUsageDetail((await res.json()) as UsageDetailResponse);
  }, [backofficeHeaders, canView, sel, usageFrom, usageTo]);

  const loadPerformanceDetail = useCallback(
    async (eventId: string) => {
      if (!canView) return;
      setPerformanceBusy(true);
      const p = new URLSearchParams();
      if (usageFrom.trim()) p.set("from", usageFrom.trim());
      if (usageTo.trim()) p.set("to", usageTo.trim());
      try {
        const res = await fetch(
          `${baseUrl}/api/discount-events/${eventId}/usage-report?${p.toString()}`,
          { headers: backofficeHeaders() },
        );
        if (!res.ok) {
          setPerformanceDetail(null);
          toast("We couldn't load promotion performance right now.", "error");
          return;
        }
        setPerformanceDetail((await res.json()) as UsageDetailResponse);
      } finally {
        setPerformanceBusy(false);
      }
    },
    [backofficeHeaders, canView, toast, usageFrom, usageTo],
  );

  useEffect(() => {
    void loadUsageReport();
  }, [loadUsageReport]);

  useEffect(() => {
    void loadUsageDetail();
  }, [loadUsageDetail]);

  useEffect(() => {
    if (!performanceEventId) return;
    void loadPerformanceDetail(performanceEventId);
  }, [loadPerformanceDetail, performanceEventId]);

  const loadVars = useCallback(
    async (id: string) => {
      const res = await fetch(`${baseUrl}/api/discount-events/${id}/variants`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        setVars([]);
        return;
      }
      setVars((await res.json()) as VarRow[]);
    },
    [backofficeHeaders],
  );

  useEffect(() => {
    if (!sel) {
      setVars([]);
      return;
    }
    void loadVars(sel);
  }, [sel, loadVars]);

  useEffect(() => {
    if (selected?.scope_type === "variants") {
      scanInputRef.current?.focus();
    }
  }, [selected?.id, selected?.scope_type]);

  const createEvent = async () => {
    if (!canEdit) return;
    if (!name.trim() || !receiptLabel.trim() || !starts || !ends) {
      toast("Enter the event name, receipt label, start date, and end date first.", "info");
      return;
    }
    const p = Number.parseFloat(pct);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      toast("Enter a discount percentage between 0 and 100.", "error");
      return;
    }
    if (scopeType === "category" && !scopeCategoryId) {
      toast("Select a category for this promotion.", "error");
      return;
    }
    if (scopeType === "vendor" && !scopeVendorId) {
      toast("Select a vendor for this promotion.", "error");
      return;
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      receipt_label: receiptLabel.trim(),
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(ends).toISOString(),
      percent_off: p.toFixed(2),
      scope_type: scopeType,
    };
    if (scopeType === "category") body.scope_category_id = scopeCategoryId;
    if (scopeType === "vendor") body.scope_vendor_id = scopeVendorId;

    const res = await fetch(`${baseUrl}/api/discount-events`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "We couldn't save this promotion. Please review the details and try again.", "error");
      return;
    }
    const created = (await res.json()) as EventRow;
    toast("Promotion saved and turned on.", "success");
    setName("");
    setReceiptLabel("");
    setSel(created.id);
    setPanelMode("manage");
    await load();
  };

  const patchSelectedScope = async () => {
    if (!canEdit || !sel) return;
    if (editScopeType === "category" && !editCategoryId) {
      toast("Select a category for this promotion.", "error");
      return;
    }
    if (editScopeType === "vendor" && !editVendorId) {
      toast("Select a vendor for this promotion.", "error");
      return;
    }
    const body: Record<string, unknown> = { scope_type: editScopeType };
    if (editScopeType === "category") body.scope_category_id = editCategoryId;
    if (editScopeType === "vendor") body.scope_vendor_id = editVendorId;

    const res = await fetch(`${baseUrl}/api/discount-events/${sel}`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast("We couldn't update where this promotion applies. Please try again.", "error");
      return;
    }
    toast("Promotion scope updated.", "success");
    await load();
    await loadVars(sel);
  };

  const addVariant = async (v: VariantSearchResult) => {
    if (!canEdit || !sel) return;
    const res = await fetch(`${baseUrl}/api/discount-events/${sel}/variants`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ variant_id: v.variant_id }),
    });
    if (!res.ok) {
      toast("We couldn't add that SKU to this promotion. Please try again.", "error");
      return;
    }
    toast(`${v.sku} added to promotion.`, "success");
    await loadVars(sel);
  };

  const removeVariant = async (variantId: string) => {
    if (!canEdit || !sel) return;
    const res = await fetch(`${baseUrl}/api/discount-events/${sel}/variants/${variantId}`, {
      method: "DELETE",
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      toast("We couldn't remove that SKU from this promotion.", "error");
      return;
    }
    await loadVars(sel);
  };

  const lookupVariantByCode = useCallback(
    async (code: string): Promise<VariantSearchResult | null> => {
      const trimmed = code.trim();
      if (trimmed.length < 2) return null;
      try {
        const res = await fetch(
          `${baseUrl}/api/products/control-board?search=${encodeURIComponent(trimmed)}&limit=8`,
          { headers: backofficeHeaders() },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { rows?: VariantSearchResult[] };
        const rows = Array.isArray(data.rows) ? data.rows : [];
        return (
          rows.find((row) => row.sku.toLowerCase() === trimmed.toLowerCase()) ??
          rows[0] ??
          null
        );
      } catch {
        return null;
      }
    },
    [backofficeHeaders],
  );

  const addScannedSku = async () => {
    if (!canEdit || !sel || busyScan) return;
    const code = scanSku.trim();
    if (!code) return;
    setBusyScan(true);
    try {
      const variant = await lookupVariantByCode(code);
      if (!variant) {
        toast(`SKU ${code} was not found.`, "error");
        return;
      }
      await addVariant(variant);
      setScanSku("");
    } finally {
      setBusyScan(false);
      scanInputRef.current?.focus();
    }
  };

  const applyPromoAction = async () => {
    if (!canEdit || !sel || !confirmAction) return;
    setBusyAction(true);
    try {
      const endpoint = confirmAction === "end" ? "end-now" : "cancel";
      const res = await fetch(`${baseUrl}/api/discount-events/${sel}/${endpoint}`, {
        method: "POST",
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        toast("We couldn't update this promotion status.", "error");
        return;
      }
      toast(confirmAction === "end" ? "Promotion ended now." : "Promotion cancelled.", "success");
      setConfirmAction(null);
      await load();
    } finally {
      setBusyAction(false);
    }
  };

  const openPerformance = (eventId: string) => {
    setPerformanceEventId(eventId);
    setPerformanceDetail(null);
  };

  const printPerformance = async () => {
    if (!performanceEvent || !performanceDetail) return;
    try {
      await printTextReport(
        buildPerformancePrintText(performanceEvent, performanceDetail, usageFrom, usageTo),
      );
      toast("Promotion performance sent to the Reports printer.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to print performance report.";
      toast(message, "error");
    }
  };

  if (!canView) {
    return <p className="p-8 text-app-text-muted">Security clearance insufficient.</p>;
  }

  return (
    <div className="flex h-full flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex flex-wrap items-end justify-between gap-4 px-2">
        <div>
          <h3 className="mb-1 text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-60">
            Promotions
          </h3>
          <h2 className="text-2xl font-black tracking-tight text-app-text">Promotion Management</h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setPanelMode("create")}
            className="ui-btn-primary min-h-12 px-5"
          >
            <Plus size={16} />
            New Promotion
          </button>
          <div className="grid grid-cols-3 gap-2 text-right">
            <div className="rounded-xl border border-app-border bg-app-surface px-4 py-2">
              <div className="text-lg font-black text-emerald-500">{counts.active}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Active</div>
            </div>
            <div className="rounded-xl border border-app-border bg-app-surface px-4 py-2">
              <div className="text-lg font-black text-sky-500">{counts.scheduled}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Scheduled</div>
            </div>
            <div className="rounded-xl border border-app-border bg-app-surface px-4 py-2">
              <div className="text-lg font-black text-app-text-muted">{counts.closed}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Closed</div>
            </div>
          </div>
        </div>
      </div>

      <main className="grid min-h-0 flex-1 gap-6 xl:grid-cols-[minmax(0,1fr)_520px]">
        <div className="min-h-0 overflow-y-auto no-scrollbar px-2 pb-20">
          <section className="rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border px-5 py-4">
              <div className="flex items-center gap-3">
                <Clock3 size={18} className="text-app-accent" />
                <div>
                  <h4 className="text-sm font-black text-app-text">Promotion Registry</h4>
                  <p className="text-xs font-semibold text-app-text-muted">
                    Select a promotion to manage scope, status, and performance.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-bg/40 p-2">
                <input
                  type="date"
                  value={usageFrom}
                  onChange={(e) => setUsageFrom(e.target.value)}
                  className="h-9 rounded-lg border border-app-border bg-app-surface px-3 text-xs font-bold text-app-text"
                />
                <ArrowRight size={14} className="text-app-text-muted" />
                <input
                  type="date"
                  value={usageTo}
                  onChange={(e) => setUsageTo(e.target.value)}
                  className="h-9 rounded-lg border border-app-border bg-app-surface px-3 text-xs font-bold text-app-text"
                />
              </div>
            </div>

            <div className="space-y-3 p-4">
              {rows.map((row) => {
                const status = statusFor(row);
                const usage = usageByEvent.get(row.id);
                const isSelected = row.id === sel && panelMode === "manage";
                return (
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSel(row.id);
                      setPanelMode("manage");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSel(row.id);
                        setPanelMode("manage");
                      }
                    }}
                    className={`w-full rounded-2xl border p-4 text-left transition-all hover:border-app-accent/50 hover:bg-app-accent/5 ${
                      isSelected
                        ? "border-app-accent bg-app-accent/10 shadow-lg shadow-app-accent/10"
                        : "border-app-border bg-app-bg/30"
                    }`}
                  >
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${status.tone}`}>
                            {status.label}
                          </span>
                          {isSelected && (
                            <span className="rounded-full bg-app-accent/15 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent">
                              Open
                            </span>
                          )}
                          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            -{Number(row.percent_off)}%
                          </span>
                          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            {scopeLabel(row)}
                          </span>
                        </div>
                        <div className="truncate text-lg font-black text-app-text">{row.name}</div>
                        <div className="truncate text-xs font-bold uppercase tracking-widest text-app-text-muted">
                          {row.receipt_label}
                        </div>
                        <div className="mt-3 flex items-center gap-2 text-xs font-bold text-app-text-muted">
                          <Calendar size={14} />
                          {dateShort(row.starts_at)} - {dateShort(row.ends_at)}
                        </div>
                      </div>
                      <div className="grid gap-3 xl:min-w-[360px]">
                        <div className="grid grid-cols-3 gap-3 rounded-xl border border-app-border bg-app-surface px-4 py-3">
                        <div>
                          <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Sales</div>
                          <div className="mt-1 font-mono text-sm font-black text-app-text">{money(usage?.subtotal_sum ?? 0)}</div>
                        </div>
                        <div>
                          <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Units</div>
                          <div className="mt-1 font-mono text-sm font-black text-app-text">{usage?.units_sold ?? 0}</div>
                        </div>
                        <div>
                          <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Lines</div>
                          <div className="mt-1 font-mono text-sm font-black text-app-text">{usage?.line_count ?? 0}</div>
                        </div>
                      </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPerformance(row.id);
                          }}
                          className="ui-btn-secondary min-h-10 w-full text-[10px]"
                        >
                          <Search size={15} />
                          Performance
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {rows.length === 0 && (
                <div className="rounded-2xl border border-dashed border-app-border p-10 text-center">
                  <p className="text-sm font-bold text-app-text-muted">No promotions have been created yet.</p>
                  <button
                    type="button"
                    onClick={() => setPanelMode("create")}
                    className="ui-btn-primary mt-4"
                  >
                    <Plus size={16} />
                    Create First Promotion
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="min-h-0 overflow-y-auto no-scrollbar px-2 pb-20">
          <section className="mb-4 rounded-2xl border border-app-border bg-app-surface p-2 shadow-sm">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPanelMode("create")}
                className={`flex min-h-12 items-center justify-center gap-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                  panelMode === "create"
                    ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                    : "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                }`}
              >
                <Plus size={16} />
                New Promotion
              </button>
              <button
                type="button"
                onClick={() => setPanelMode("manage")}
                disabled={!selected}
                className={`flex min-h-12 items-center justify-center gap-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-40 ${
                  panelMode === "manage"
                    ? "bg-app-surface-2 text-app-text"
                    : "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                }`}
              >
                <SlidersHorizontal size={16} />
                Selected Promo
              </button>
            </div>
          </section>

          {panelMode === "create" ? (
            <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
              <div className="mb-5">
                <div className="mb-1 flex items-center gap-3 text-app-accent">
                  <Plus size={18} />
                  <h4 className="text-sm font-black text-app-text">Create Promotion</h4>
                </div>
                <p className="text-xs font-semibold text-app-text-muted">
                  Define the promo, then add SKUs after it is created.
                </p>
              </div>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <input className="ui-input h-12 text-sm font-bold" value={name} onChange={(e) => setName(e.target.value)} placeholder="Promotion name" />
                  <input className="ui-input h-12 text-sm font-bold" value={receiptLabel} onChange={(e) => setReceiptLabel(e.target.value)} placeholder="Receipt label" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      <Calendar size={12} />
                      Starts
                    </label>
                    <input className="ui-input h-11 text-xs font-bold" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">Ends</label>
                    <input className="ui-input h-11 text-xs font-bold" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
                  </div>
                </div>
                <div className="grid grid-cols-[120px_1fr] gap-3">
                  <input className="ui-input h-12 text-sm font-black" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="25" />
                  <select className="ui-input h-12 text-sm font-bold" value={scopeType} onChange={(e) => setScopeType(e.target.value as PromoScope)}>
                    <option value="variants">Selected SKUs</option>
                    <option value="all">Full Inventory</option>
                    <option value="category">Whole Category</option>
                    <option value="vendor">Primary Vendor</option>
                  </select>
                </div>
                {scopeType === "category" && (
                  <select className="ui-input h-12 text-sm font-bold" value={scopeCategoryId} onChange={(e) => setScopeCategoryId(e.target.value)}>
                    <option value="">Select category...</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
                {scopeType === "vendor" && (
                  <select className="ui-input h-12 text-sm font-bold" value={scopeVendorId} onChange={(e) => setScopeVendorId(e.target.value)}>
                    <option value="">Select vendor...</option>
                    {promoVendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                )}
                <button type="button" onClick={createEvent} disabled={!canEdit} className="ui-btn-primary w-full disabled:opacity-50">
                  <Plus size={16} />
                  Create Promotion
                </button>
              </div>
            </section>
          ) : selected ? (
            <div className="space-y-4">
              <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${statusFor(selected).tone}`}>
                        {statusFor(selected).label}
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        -{Number(selected.percent_off)}%
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {scopeLabel(selected)}
                      </span>
                    </div>
                    <h3 className="truncate text-xl font-black text-app-text">{selected.name}</h3>
                    <p className="truncate text-xs font-bold uppercase tracking-widest text-app-text-muted">{selected.receipt_label}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={!canEdit || statusFor(selected).label === "Ended" || statusFor(selected).label === "Cancelled"}
                      onClick={() => setConfirmAction("end")}
                      className="ui-btn-secondary min-h-10 px-3 text-[10px] disabled:opacity-40"
                    >
                      <PauseCircle size={16} />
                      End
                    </button>
                    <button
                      type="button"
                      disabled={!canEdit || !selected.is_active}
                      onClick={() => setConfirmAction("cancel")}
                      className="ui-btn-danger min-h-10 px-3 text-[10px] disabled:opacity-40"
                    >
                      <XCircle size={16} />
                      Cancel
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-app-border bg-app-bg/40 p-3">
                    <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      <BadgeDollarSign size={14} />
                      Sales
                    </div>
                    <div className="mt-2 text-lg font-black text-app-text">
                      {money(usageDetail?.summary.subtotal_sum ?? 0)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg/40 p-3">
                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Units</div>
                    <div className="mt-2 text-lg font-black text-app-text">{usageDetail?.summary.units_sold ?? 0}</div>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg/40 p-3">
                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Lines</div>
                    <div className="mt-2 text-lg font-black text-app-text">{usageDetail?.summary.line_count ?? 0}</div>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-3">
                  <Settings2 size={18} className="text-app-accent" />
                  <h4 className="text-sm font-black text-app-text">Promotion Scope</h4>
                </div>
                <div className="space-y-3">
                  <select
                    className="ui-input h-11 text-sm font-bold"
                    value={editScopeType}
                    onChange={(e) => setEditScopeType(e.target.value as PromoScope)}
                  >
                    <option value="variants">Selected SKUs</option>
                    <option value="all">Full Inventory</option>
                    <option value="category">Whole Category</option>
                    <option value="vendor">Primary Vendor</option>
                  </select>

                  {editScopeType === "category" && (
                    <select
                      className="ui-input h-11 text-sm font-bold"
                      value={editCategoryId}
                      onChange={(e) => setEditCategoryId(e.target.value)}
                    >
                      <option value="">Select category...</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  )}

                  {editScopeType === "vendor" && (
                    <select
                      className="ui-input h-11 text-sm font-bold"
                      value={editVendorId}
                      onChange={(e) => setEditVendorId(e.target.value)}
                    >
                      <option value="">Select vendor...</option>
                      {promoVendors.map((v) => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  )}

                  {editScopeType === "variants" && (
                    <div className="space-y-3 rounded-xl border border-app-border bg-app-bg/30 p-3">
                      <div className="relative w-full">
                        <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted" size={18} />
                        <input
                          ref={scanInputRef}
                          aria-label="Scan SKU"
                          autoComplete="off"
                          value={scanSku}
                          onChange={(e) => setScanSku(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void addScannedSku();
                            }
                          }}
                          placeholder="Scan SKU"
                          className="ui-input h-12 w-full pl-10 pr-3 text-sm font-black"
                        />
                      </div>
                      <VariantSearchInput
                        onSelect={addVariant}
                        className="w-full"
                        placeholder="Search item name or SKU..."
                      />
                      <div className="max-h-56 space-y-2 overflow-y-auto no-scrollbar">
                        {vars.map((v) => (
                          <div key={v.variant_id} className="flex items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface px-3 py-2">
                            <div>
                              <div className="text-xs font-black text-app-text">{v.product_name}</div>
                              <div className="font-mono text-[10px] font-bold text-app-text-muted">{v.sku}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void removeVariant(v.variant_id)}
                              className="ui-touch-target rounded-lg text-app-text-muted hover:bg-rose-500/10 hover:text-rose-500"
                              aria-label={`Remove ${v.sku} from promotion`}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        ))}
                        {vars.length === 0 && (
                          <div className="rounded-xl border border-dashed border-app-border p-4 text-center text-xs font-bold text-app-text-muted">
                            Scan SKUs to build this promotion.
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={patchSelectedScope}
                    disabled={!canEdit}
                    className="ui-btn-primary w-full disabled:opacity-50"
                  >
                    <CheckCircle2 size={16} />
                    Save Scope
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <section className="rounded-2xl border border-app-border bg-app-surface p-5 text-sm font-bold text-app-text-muted">
              Select a promotion from the registry, or create a new one.
            </section>
          )}
        </aside>
      </main>

      {performanceEvent &&
        createPortal(
          <div className="ui-overlay-backdrop fixed inset-0 z-200 flex items-center justify-center bg-black/60 p-4">
            <section className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border px-6 py-5">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${statusFor(performanceEvent).tone}`}>
                      {statusFor(performanceEvent).label}
                    </span>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      -{Number(performanceEvent.percent_off)}%
                    </span>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {scopeLabel(performanceEvent)}
                    </span>
                  </div>
                  <h3 className="text-xl font-black text-app-text">Promotion Performance</h3>
                  <p className="mt-1 text-sm font-bold text-app-text-muted">
                    {performanceEvent.name} · {usageFrom || "Start"} - {usageTo || "Today"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void printPerformance()}
                    disabled={!performanceDetail || performanceBusy}
                    className="ui-btn-secondary min-h-10 text-[10px] disabled:opacity-50"
                  >
                    <Printer size={16} />
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPerformanceEventId(null);
                      setPerformanceDetail(null);
                    }}
                    className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                    aria-label="Close performance detail"
                  >
                    <XCircle size={20} />
                  </button>
                </div>
              </div>

              <div className="max-h-[calc(88vh-112px)] overflow-y-auto p-6">
                {performanceBusy && (
                  <div className="rounded-xl border border-app-border bg-app-bg/40 p-6 text-center text-sm font-bold text-app-text-muted">
                    Loading promotion performance...
                  </div>
                )}

                {!performanceBusy && performanceDetail && (
                  <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-xl border border-app-border bg-app-bg/40 p-4">
                        <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Sales</div>
                        <div className="mt-2 text-2xl font-black text-app-text">
                          {money(performanceDetail.summary.subtotal_sum)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-app-border bg-app-bg/40 p-4">
                        <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Units</div>
                        <div className="mt-2 text-2xl font-black text-app-text">
                          {performanceDetail.summary.units_sold}
                        </div>
                      </div>
                      <div className="rounded-xl border border-app-border bg-app-bg/40 p-4">
                        <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Lines</div>
                        <div className="mt-2 text-2xl font-black text-app-text">
                          {performanceDetail.summary.line_count}
                        </div>
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-app-border">
                      <div className="grid grid-cols-[150px_130px_100px_minmax(0,1fr)_80px_110px] gap-3 border-b border-app-border bg-app-bg/50 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <span>Date</span>
                        <span>Transaction</span>
                        <span>SKU</span>
                        <span>Item</span>
                        <span className="text-right">Qty</span>
                        <span className="text-right">Sales</span>
                      </div>
                      {performanceDetail.transactions.map((tx) => (
                        <div
                          key={`${tx.transaction_id}-${tx.sku}-${tx.created_at}`}
                          className="grid grid-cols-[150px_130px_100px_minmax(0,1fr)_80px_110px] gap-3 border-b border-app-border px-4 py-3 text-xs font-bold text-app-text last:border-b-0"
                        >
                          <span className="text-app-text-muted">{dateTimeShort(tx.created_at)}</span>
                          <span className="font-mono">{tx.transaction_display_id ?? tx.transaction_id.slice(0, 8)}</span>
                          <span className="font-mono text-app-text-muted">{tx.sku}</span>
                          <span className="min-w-0 truncate">{tx.product_name}</span>
                          <span className="text-right font-mono">{tx.quantity}</span>
                          <span className="text-right font-mono">{money(tx.line_subtotal)}</span>
                        </div>
                      ))}
                      {performanceDetail.transactions.length === 0 && (
                        <div className="p-8 text-center text-sm font-bold text-app-text-muted">
                          No transactions used this promotion in the selected window.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>,
          document.getElementById("drawer-root") ?? document.body,
        )}

      <ConfirmationModal
        isOpen={confirmAction !== null}
        onClose={() => !busyAction && setConfirmAction(null)}
        onConfirm={() => void applyPromoAction()}
        title={confirmAction === "end" ? "End Promotion" : "Cancel Promotion"}
        message={
          confirmAction === "end"
            ? "This stops the promotion immediately and keeps historical sales reporting attached to the promo."
            : "This disables the promotion so POS will no longer apply it. Historical sales reporting stays attached to the promo."
        }
        confirmLabel={confirmAction === "end" ? "End Now" : "Cancel Promo"}
        variant="danger"
        loading={busyAction}
      />
    </div>
  );
}
