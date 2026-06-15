import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileText, Printer, RefreshCw, Search } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import ReceivingReport from "./ReceivingReport";

const baseUrl = getBaseUrl();

interface Vendor {
  id: string;
  name: string;
}

interface ReceivingHistoryRow {
  id: string;
  purchase_order_id: string;
  po_number: string;
  vendor_name: string;
  invoice_number?: string | null;
  freight_total: string | number;
  received_at?: string | null;
  received_by_name?: string | null;
  total_units_received: number;
  total_line_cost: string | number;
}

interface ReconciliationFinding {
  issue_kind: string;
  severity: "high" | "medium" | "low" | string;
  product_id?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  product_name?: string | null;
  stock_on_hand?: number | null;
  reserved_stock?: number | null;
  on_layaway?: number | null;
  available_stock?: number | null;
  quantity_delta?: number | null;
  tx_type?: string | null;
  created_at?: string | null;
  detail: string;
}

interface ReconciliationResponse {
  generated_at: string;
  total_findings: number;
  findings: ReconciliationFinding[];
}

function money(value: string | number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

function dateTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

const ISSUE_LABELS: Record<string, string> = {
  negative_available_stock: "Negative available stock",
  inactive_product_with_inventory: "Inactive with inventory",
  manual_movement_missing_note: "Manual movement missing note",
  counterpoint_stock_without_ledger: "Counterpoint stock without ledger",
};

function issueLabel(kind: string): string {
  return ISSUE_LABELS[kind] ?? kind.replaceAll("_", " ");
}

function severityClass(severity: string): string {
  if (severity === "high") return "border-red-200 bg-red-50 text-red-700";
  if (severity === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-app-border bg-app-surface-2 text-app-text-muted";
}

export default function InventoryReportsPanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [rows, setRows] = useState<ReceivingHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationResponse | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (vendorId) params.set("vendor_id", vendorId);
      if (query.trim()) params.set("q", query.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const res = await fetch(apiUrl(baseUrl, `/api/purchase-orders/receiving-events?${params}`), {
        headers: backofficeHeaders() as Record<string, string>,
      });
      setRows(res.ok ? ((await res.json()) as ReceivingHistoryRow[]) : []);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, dateFrom, dateTo, query, vendorId]);

  const loadReconciliation = useCallback(async () => {
    setReconciliationLoading(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/products/reconciliation"), {
        headers: backofficeHeaders() as Record<string, string>,
      });
      setReconciliation(res.ok ? ((await res.json()) as ReconciliationResponse) : null);
    } finally {
      setReconciliationLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    fetch(apiUrl(baseUrl, "/api/vendors"), {
      headers: backofficeHeaders() as Record<string, string>,
    })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setVendors(Array.isArray(data) ? data : []))
      .catch(() => setVendors([]));
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadReports();
    void loadReconciliation();
  }, [loadReports, loadReconciliation]);

  const groupedFindings = useMemo(() => {
    const grouped = new Map<string, ReconciliationFinding[]>();
    for (const finding of reconciliation?.findings ?? []) {
      const current = grouped.get(finding.issue_kind) ?? [];
      current.push(finding);
      grouped.set(finding.issue_kind, current);
    }
    return Array.from(grouped.entries());
  }, [reconciliation?.findings]);

  return (
    <section className="space-y-5 rounded-[28px] border border-app-border bg-app-surface p-6 shadow-sm">
      <div className="rounded-[24px] border border-app-border bg-app-surface-2/40 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
              Inventory Reconciliation
            </p>
            <h3 className="mt-1 text-xl font-black tracking-tight text-app-text">
              Store-wide stock proof checks
            </h3>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
              Review cross-catalog inventory risks that Product Hub shows only one item at a time.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadReconciliation()}
            className="inline-flex h-11 items-center gap-2 rounded-2xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
          >
            <RefreshCw size={14} /> Refresh Checks
          </button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {["negative_available_stock", "inactive_product_with_inventory", "manual_movement_missing_note", "counterpoint_stock_without_ledger"].map((kind) => {
            const count = reconciliation?.findings.filter((finding) => finding.issue_kind === kind).length ?? 0;
            const severity = kind === "negative_available_stock" ? "high" : "medium";
            return (
              <div key={kind} className={`rounded-2xl border px-4 py-3 ${severityClass(severity)}`}>
                <p className="text-[9px] font-black uppercase tracking-widest opacity-70">
                  {issueLabel(kind)}
                </p>
                <p className="mt-2 text-3xl font-black tabular-nums">{count}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-app-border bg-app-surface">
          <table className="w-full text-left text-xs">
            <thead className="bg-app-surface-2/70 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-4 py-3">Finding</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3 text-right">On Hand</th>
                <th className="px-4 py-3 text-right">Reserved</th>
                <th className="px-4 py-3 text-right">Layaway</th>
                <th className="px-4 py-3 text-right">Available</th>
                <th className="px-4 py-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/40">
              {reconciliationLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-xs font-bold text-app-text-muted">
                    Running reconciliation checks...
                  </td>
                </tr>
              ) : (reconciliation?.findings.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-xs font-bold text-app-text-muted">
                    No store-wide reconciliation findings.
                  </td>
                </tr>
              ) : (
                groupedFindings.flatMap(([kind, findings]) =>
                  findings.map((finding, index) => (
                    <tr key={`${kind}-${finding.variant_id ?? finding.product_id ?? index}-${index}`} className="hover:bg-app-surface-2/40">
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${severityClass(finding.severity)}`}>
                          <AlertTriangle size={12} /> {issueLabel(finding.issue_kind)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-bold text-app-text">{finding.product_name ?? "Unknown product"}</p>
                        <p className="font-mono text-[10px] font-bold text-app-text-muted">{finding.sku ?? "All variants"}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-app-text">{finding.stock_on_hand ?? "-"}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-app-text">{finding.reserved_stock ?? "-"}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-app-text">{finding.on_layaway ?? "-"}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-app-text">{finding.available_stock ?? "-"}</td>
                      <td className="px-4 py-3 text-[11px] font-semibold text-app-text-muted">
                        {finding.detail}
                        {finding.tx_type ? ` Movement: ${finding.tx_type} ${finding.quantity_delta ?? ""}.` : ""}
                      </td>
                    </tr>
                  )),
                )
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-[10px] font-bold text-app-text-muted">
          Generated {dateTime(reconciliation?.generated_at)}. These checks are read-only and do not change inventory.
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            Inventory Reports
          </p>
          <h3 className="mt-1 text-xl font-black tracking-tight text-app-text">
            PO, Invoice & Receiving History
          </h3>
          <p className="mt-2 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
            Search saved inventory paperwork by vendor, invoice, PO, item, SKU, or received date.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadReports()}
          className="inline-flex h-11 items-center gap-2 rounded-2xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
        >
          <Search size={14} /> Search
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ui-input h-11 text-sm font-bold"
          placeholder="Invoice, PO, item, SKU..."
        />
        <select
          value={vendorId}
          onChange={(event) => setVendorId(event.target.value)}
          className="ui-input h-11 text-sm font-bold"
        >
          <option value="">All vendors</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(event) => setDateFrom(event.target.value)}
          className="ui-input h-11 text-sm font-bold"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(event) => setDateTo(event.target.value)}
          className="ui-input h-11 text-sm font-bold"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-app-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-app-surface-2/70 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            <tr>
              <th className="px-4 py-3">Received</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">PO / Invoice</th>
              <th className="px-4 py-3 text-center">Units</th>
              <th className="px-4 py-3 text-right">Merchandise</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/40">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-xs font-bold text-app-text-muted">
                  Loading inventory reports...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-xs font-bold text-app-text-muted">
                  No matching receiving reports.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="bg-app-surface transition-colors hover:bg-app-surface-2/40">
                  <td className="px-4 py-3 font-bold text-app-text">{dateTime(row.received_at)}</td>
                  <td className="px-4 py-3 font-bold text-app-text">{row.vendor_name}</td>
                  <td className="px-4 py-3">
                    <p className="font-mono font-bold text-app-accent">{row.po_number}</p>
                    <p className="text-[10px] font-bold text-app-text-muted">
                      Invoice {row.invoice_number?.trim() || "-"}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-center font-mono font-bold text-app-text">
                    {row.total_units_received}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-app-text">
                    {money(row.total_line_cost)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setActiveReportId(row.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
                    >
                      <Printer size={13} /> View / Print
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] font-bold text-app-text-muted">
        <FileText size={12} className="mr-1 inline" />
        Inventory reports are operational inventory records and stay separate from Insights/Metabase reporting.
      </p>

      {activeReportId ? (
        <ReceivingReport
          receivingEventId={activeReportId}
          onClose={() => setActiveReportId(null)}
        />
      ) : null}
    </section>
  );
}
