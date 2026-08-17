import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useState, useCallback } from "react";
import { AlertCircle, TrendingUp, ArrowUpRight } from "lucide-react";
import CategoryManager from "./CategoryManager";
import InventoryControlBoard from "./InventoryControlBoard";
import ProductMasterForm from "./ProductMasterForm";
import PurchaseOrderPanel from "./PurchaseOrderPanel";
import UniversalImporter from "./UniversalImporter";
import VendorHub from "./VendorHub";
import ProcurementImportWorkspace from "../procurement/ProcurementImportWorkspace";
import PhysicalInventoryWorkspace from "./PhysicalInventoryWorkspace";
import DiscountEventsPanel from "./DiscountEventsPanel";
import { MaintenanceLedgerPanel } from "./MaintenanceLedgerPanel";
import IntelligencePanel from "./IntelligencePanel";
import InventoryReportsPanel from "./InventoryReportsPanel";
import DashboardStatsCard from "../ui/DashboardStatsCard";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { apiUrl } from "../../lib/apiUrl";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { getAppIcon } from "../../lib/icons";

const INVENTORY_ICON = getAppIcon("inventory");
const SHIPPING_ICON = getAppIcon("shipping");
const VENDOR_ICON = getAppIcon("vendor");

type InventorySection =
  | "hub"
  | "list"
  | "purchase_orders"
  | "po_invoice_import"
  | "receiving"
  | "batch_scan"
  | "vendors"
  | "add"
  | "categories"
  | "discount_events"
  | "import"
  | "physical"
  | "damaged"
  | "rtv"
  | "reports"
  | "intelligence";

interface InventoryWorkspaceProps {
  activeSection?: string;
  procurementDeepLinkPoId?: string | null;
  onProcurementDeepLinkConsumed?: () => void;
  openProductHubProductId?: string | null;
  onProductHubDeepLinkConsumed?: () => void;
  surface?: "backoffice" | "pos";
}

const SECTION_META: Record<InventorySection, { title: string; subtitle: string; toolLabel: string }> = {
  hub: {
    title: "Inventory Hub",
    subtitle: "Choose the inventory job you need.",
    toolLabel: "Inventory Hub",
  },
  list: {
    title: "Find Item",
    subtitle: "Look up items, review stock, and open product details.",
    toolLabel: "Inventory List",
  },
  purchase_orders: {
    title: "Order Stock",
    subtitle: "Build vendor orders, add invoice lines, and send items to receiving.",
    toolLabel: "Purchase Orders",
  },
  receiving: {
    title: "Receive Stock",
    subtitle: "Post received items from submitted purchase orders or direct vendor invoices.",
    toolLabel: "Receive Stock",
  },
  batch_scan: {
    title: "Batch Scan",
    subtitle: "Resolve a group of scanned SKUs or barcodes without changing stock.",
    toolLabel: "Batch Scan",
  },
  po_invoice_import: {
    title: "Import PO / Invoice",
    subtitle: "Use ROSIE plus deterministic parsers to turn vendor paperwork into PO or direct invoice drafts.",
    toolLabel: "Import PO / Invoice",
  },
  vendors: {
    title: "Add/Edit Catalog",
    subtitle: "Create, update, and clean up vendor records used for ordering and receiving.",
    toolLabel: "Vendors",
  },
  add: {
    title: "Add/Edit Catalog",
    subtitle: "Create a new item and its sellable SKUs.",
    toolLabel: "Add Item",
  },
  categories: {
    title: "Add/Edit Catalog",
    subtitle: "Organize item groups, tax rules, and default size or color options.",
    toolLabel: "Categories",
  },
  discount_events: {
    title: "Promotions",
    subtitle: "Schedule time-boxed markdowns by SKU, category, or vendor.",
    toolLabel: "Promotions",
  },
  import: {
    title: "Add/Edit Catalog",
    subtitle: "Catalog-only CSV mapping for vendor manifests; Counterpoint sync owns pre-launch inventory quantities.",
    toolLabel: "Catalog Import",
  },
  physical: {
    title: "Physical Inventory",
    subtitle: "Cycle counts and full-store stock review.",
    toolLabel: "Physical Inventory",
  },
  damaged: {
    title: "Correct Stock",
    subtitle: "Review damage/loss history. Start count corrections from Find Item.",
    toolLabel: "Damage/Loss History",
  },
  rtv: {
    title: "Correct Stock",
    subtitle: "Review stock sent back for vendor credits and claims.",
    toolLabel: "Vendor Return History",
  },
  reports: {
    title: "Inventory Reports",
    subtitle: "Search historical PO, invoice, and receiving reports.",
    toolLabel: "Reports",
  },
  intelligence: {
    title: "Order Stock",
    subtitle: "Review reorder and markdown suggestions with plain-language reasons.",
    toolLabel: "Stock Guidance",
  },
};

type InventoryJob = {
  label: string;
  description: string;
  primarySection: InventorySection;
  sections: InventorySection[];
};

const INVENTORY_JOBS: InventoryJob[] = [
  {
    label: "Find Item",
    description: "Find, open, and manage existing items from Product Hub.",
    primarySection: "list",
    sections: ["list"],
  },
  {
    label: "Add/Edit Catalog",
    description: "Create items and manage catalog structure, vendors, and import.",
    primarySection: "add",
    sections: ["add", "categories", "vendors", "import"],
  },
  {
    label: "Promotions",
    description: "Create and review time-boxed discounts by SKU, category, or vendor.",
    primarySection: "discount_events",
    sections: ["discount_events"],
  },
  {
    label: "Order Stock",
    description: "Create purchase orders and review buying guidance.",
    primarySection: "purchase_orders",
    sections: ["purchase_orders", "intelligence"],
  },
  {
    label: "Receive Stock",
    description: "Import vendor paperwork, review drafts, and post received stock.",
    primarySection: "receiving",
    sections: ["po_invoice_import", "receiving", "batch_scan"],
  },
  {
    label: "Correct Stock",
    description: "Review correction history; start one-off count fixes from Find Item.",
    primarySection: "damaged",
    sections: ["damaged", "rtv"],
  },
  {
    label: "Reports",
    description: "Search and reprint historical PO, invoice, and receiving reports.",
    primarySection: "reports",
    sections: ["reports"],
  },
  {
    label: "Physical Inventory",
    description: "Run physical counts and publish reviewed variances.",
    primarySection: "physical",
    sections: ["physical"],
  },
];

const JOB_BY_SECTION = INVENTORY_JOBS.reduce<Partial<Record<InventorySection, InventoryJob>>>(
  (acc, job) => {
    job.sections.forEach((jobSection) => {
      acc[jobSection] = job;
    });
    return acc;
  },
  {} as Record<InventorySection, InventoryJob>,
);

interface BoardStats {
  total_asset_value: string;
  skus_out_of_stock: number;
  active_vendors: number;
  need_label_skus: number;
  oos_replenishment_skus?: number;
}

interface BatchScanResult {
  code: string;
  status: string;
  variant_id: string | null;
  sku: string | null;
  new_stock: number | null;
}

function InventoryBatchScanPanel({
  baseUrl,
  headers,
  toast,
}: {
  baseUrl: string;
  headers: () => Record<string, string>;
  toast: (message: string, type?: "success" | "error" | "info") => void;
}) {
  const [rawCodes, setRawCodes] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchScanResult[]>([]);
  const [summary, setSummary] = useState<{ processed: number; matched: number; not_found: number } | null>(null);

  const parsedCodes = rawCodes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200);

  const runBatchScan = async () => {
    if (parsedCodes.length === 0) {
      toast("Enter at least one SKU or barcode.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/inventory/batch-scan"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers(),
        },
        body: JSON.stringify(parsedCodes.map((code) => ({ code, quantity: 1, source: "inventory_batch_scan" }))),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Batch scan failed.");
      }
      const body = (await res.json()) as {
        processed: number;
        matched: number;
        not_found: number;
        results: BatchScanResult[];
      };
      setSummary({
        processed: body.processed,
        matched: body.matched,
        not_found: body.not_found,
      });
      setResults(body.results);
      toast(`Batch scan complete: ${body.matched} matched, ${body.not_found} not found.`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Batch scan failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5 rounded-[28px] border border-app-border bg-app-surface p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            Inventory Resolution
          </p>
          <h3 className="mt-1 text-xl font-black tracking-tight text-app-text">
            Batch Scan
          </h3>
          <p className="mt-2 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
            Paste or scan up to 200 SKUs/barcodes, one per line. This resolves items only; stock changes still go through receiving, stock adjustment, or physical inventory.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runBatchScan()}
          disabled={busy}
          className="ui-btn-primary min-h-11 gap-2 px-5 disabled:opacity-50"
        >
          {busy ? "Scanning..." : "Resolve Batch"}
        </button>
      </div>

      <textarea
        value={rawCodes}
        onChange={(event) => setRawCodes(event.target.value)}
        className="ui-input min-h-48 w-full resize-y font-mono text-sm"
        placeholder={"Scan or paste one code per line:\nSKU-001\n123456789012\nVendor UPC"}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-app-text-muted">
        <span>{parsedCodes.length} code{parsedCodes.length === 1 ? "" : "s"} ready</span>
        <span>Limit 200 · no stock mutation</span>
      </div>

      {summary ? (
        <div className="grid gap-3 text-xs md:grid-cols-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <p className="font-black uppercase tracking-widest text-app-text-muted">Processed</p>
            <p className="mt-1 text-2xl font-black text-app-text">{summary.processed}</p>
          </div>
          <div className="rounded-xl border border-app-success/25 bg-app-success/10 p-3">
            <p className="font-black uppercase tracking-widest text-app-success">Matched</p>
            <p className="mt-1 text-2xl font-black text-app-success">{summary.matched}</p>
          </div>
          <div className="rounded-xl border border-app-warning/25 bg-app-warning/10 p-3">
            <p className="font-black uppercase tracking-widest text-app-warning">Not Found</p>
            <p className="mt-1 text-2xl font-black text-app-warning">{summary.not_found}</p>
          </div>
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-app-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-app-surface-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-4 py-2">Scanned</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Resolved SKU</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {results.map((row, index) => (
                <tr key={`${row.code}-${index}`}>
                  <td className="px-4 py-3 font-mono text-xs font-bold text-app-text">{row.code}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-widest ${
                      row.status === "matched"
                        ? "bg-app-success/10 text-app-success"
                        : "bg-app-warning/10 text-app-warning"
                    }`}>
                      {row.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-bold text-app-text-muted">
                    {row.sku ?? "No match"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export default function InventoryWorkspace({
  activeSection,
  procurementDeepLinkPoId,
  onProcurementDeepLinkConsumed,
  openProductHubProductId,
  onProductHubDeepLinkConsumed,
  surface = "backoffice",
}: InventoryWorkspaceProps) {
  const [section, setSection] = useState<InventorySection>("hub");
  const [localProcurementPoId, setLocalProcurementPoId] = useState<string | null>(null);
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const baseUrl = getBaseUrl();
  const [globalStats, setGlobalStats] = useState<BoardStats | null>(null);
  const [globalStatsError, setGlobalStatsError] = useState<string | null>(null);

  const refreshGlobalStats = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/inventory/control-board?limit=1"), {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (!res.ok) throw new Error(`Inventory summary failed with status ${res.status}`);
      const data = await res.json();
      setGlobalStats(data.stats);
      setGlobalStatsError(null);
    } catch (e) {
      console.error("Failed to fetch global inventory stats", e);
      setGlobalStatsError("Inventory totals are temporarily unavailable. Operational tools remain available.");
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void refreshGlobalStats();
  }, [refreshGlobalStats]);

  useEffect(() => {
    const valid: InventorySection[] = [
      "hub",
      "list",
      "purchase_orders",
      "po_invoice_import",
      "receiving",
      "batch_scan",
      "vendors",
      "add",
      "categories",
      "discount_events",
      "import",
      "physical",
      "damaged",
      "rtv",
      "reports",
      "intelligence",
    ];
    if (activeSection && valid.includes(activeSection as InventorySection)) {
      setSection(activeSection as InventorySection);
    }
  }, [activeSection]);

  const meta = SECTION_META[section];
  const isPosSurface = surface === "pos";
  const activeJob = JOB_BY_SECTION[section];
  const activeProcurementPoId = procurementDeepLinkPoId ?? localProcurementPoId;
  const consumeProcurementPoId = () => {
    if (localProcurementPoId) setLocalProcurementPoId(null);
    onProcurementDeepLinkConsumed?.();
  };
  const renderSubtoolChips = (job: InventoryJob) =>
    job.sections.length > 1 ? (
      <div className="mt-4 flex flex-wrap gap-2">
        {job.sections.map((jobSection) => {
          const isActiveSection = section === jobSection;
          return (
            <button
              key={jobSection}
              type="button"
              onClick={() => setSection(jobSection)}
              className={`rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 ${
                isActiveSection
                  ? "bg-app-accent text-white"
                  : "border border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-text"
              }`}
            >
              {SECTION_META[jobSection].toolLabel}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="flex flex-1 flex-col bg-transparent animate-in fade-in duration-700">
      <div className="flex-1 p-4 sm:p-6">
        
        {/* Harmonized Dashboard Header */}
        {!isPosSurface && (
	        <div className="mb-5">
            {section === "hub" ? (
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap items-center justify-between gap-6">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-4 rounded-full bg-app-accent shadow-[0_0_8px_rgba(var(--app-accent-rgb),0.5)]" />
                      <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
                        Inventory
                      </p>
                    </div>
                    <h2 className="text-3xl font-bold tracking-tight text-app-text">
                      Inventory Hub
                    </h2>
                    <p className="max-w-2xl text-sm font-medium text-app-text-muted leading-relaxed">
                      Pick the job that matches what you need to do.
                    </p>
                  </div>

                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <DashboardStatsCard
                      title="Asset Value"
                      value={globalStats ? formatUsdFromCents(parseMoneyToCents(globalStats.total_asset_value)) : "—"}
                      icon={TrendingUp}
                    />
                    <DashboardStatsCard
                      title="At / Below Zero"
                      value={globalStats ? new Intl.NumberFormat().format(globalStats.skus_out_of_stock) : "—"}
                      icon={AlertCircle}
                      color="orange"
                    />
                    <DashboardStatsCard
                      title="Replenishments"
                      value={globalStats ? new Intl.NumberFormat().format(globalStats.oos_replenishment_skus || 0) : "—"}
                      icon={INVENTORY_ICON}
                    />
                    <DashboardStatsCard
                      title="Vendors"
                      value={globalStats ? new Intl.NumberFormat().format(globalStats.active_vendors) : "—"}
                      icon={VENDOR_ICON}
                      color="purple"
                    />
                  </div>
                </div>

                {globalStatsError ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-app-warning/30 bg-app-warning/10 px-4 py-3 text-sm text-app-warning" role="status">
                    <AlertCircle className="mt-0.5 shrink-0" size={18} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-black">Summary unavailable</p>
                      <p className="mt-0.5 text-xs font-semibold opacity-90">{globalStatsError}</p>
                    </div>
                    <button type="button" onClick={() => void refreshGlobalStats()} className="ui-btn-secondary shrink-0">
                      Retry
                    </button>
                  </div>
                ) : null}

                <div className="ui-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">Priority work</p>
                      <p className="mt-1 text-sm font-semibold text-app-text">Open a queue from current inventory evidence.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setSection("list")} className="ui-btn-primary px-4 py-2 text-xs font-black">Find item</button>
                      <button type="button" onClick={() => setSection("receiving")} className="ui-btn-secondary px-4 py-2 text-xs font-black">Receive stock</button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <button type="button" onClick={() => setSection("list")} className="rounded-2xl border border-app-warning/25 bg-app-warning/10 p-4 text-left transition hover:border-app-warning">
                      <AlertCircle className="h-6 w-6 text-app-warning" aria-hidden />
                      <p className="mt-3 text-2xl font-black tabular-nums text-app-text">{globalStats ? globalStats.skus_out_of_stock.toLocaleString() : "—"}</p>
                      <p className="text-xs font-black uppercase tracking-wider text-app-warning">At or below zero</p>
                      <p className="mt-1 text-xs font-semibold text-app-text-muted">Find affected SKUs and review stock evidence.</p>
                    </button>
                    <button type="button" onClick={() => setSection("intelligence")} className="rounded-2xl border border-app-accent/25 bg-app-accent/10 p-4 text-left transition hover:border-app-accent">
                      <INVENTORY_ICON className="h-6 w-6 text-app-accent" aria-hidden />
                      <p className="mt-3 text-2xl font-black tabular-nums text-app-text">{globalStats ? (globalStats.oos_replenishment_skus ?? 0).toLocaleString() : "—"}</p>
                      <p className="text-xs font-black uppercase tracking-wider text-app-accent">Replenishment candidates</p>
                      <p className="mt-1 text-xs font-semibold text-app-text-muted">Review explained buying guidance before ordering.</p>
                    </button>
                    <button type="button" onClick={() => setSection("list")} className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-left transition hover:border-app-accent">
                      <VENDOR_ICON className="h-6 w-6 text-app-text-muted" aria-hidden />
                      <p className="mt-3 text-2xl font-black tabular-nums text-app-text">{globalStats ? globalStats.need_label_skus.toLocaleString() : "—"}</p>
                      <p className="text-xs font-black uppercase tracking-wider text-app-text-muted">Labels needed</p>
                      <p className="mt-1 text-xs font-semibold text-app-text-muted">Open item search and work the label queue.</p>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ui-workspace-page-header">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-accent/20 bg-app-surface text-app-accent shadow-sm">
                  <INVENTORY_ICON size={26} strokeWidth={2.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-accent">
                    {activeJob?.label ?? "Inventory"}
                  </p>
                  <h2 className="mt-1 text-2xl font-black tracking-tight text-app-text sm:text-3xl">
                    {meta.title}
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-relaxed text-app-text-muted">
                    {meta.subtitle}
                  </p>
                </div>
                {activeJob ? (
                  <div className="w-full [&>div]:mt-0 xl:w-auto">
                    {renderSubtoolChips(activeJob)}
                  </div>
                ) : null}
              </div>
            )}
	        </div>
	        )}

        {/* Section Delivery Plane */}
        <div className="min-h-0">
          {section === "list" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <InventoryControlBoard
                openProductHubProductId={openProductHubProductId ?? null}
                onProductHubDeepLinkConsumed={onProductHubDeepLinkConsumed}
                surface={surface}
              />
            </div>
          )}
          {!isPosSurface && section === "purchase_orders" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <PurchaseOrderPanel
                initialPoId={activeProcurementPoId}
                onInitialPoConsumed={consumeProcurementPoId}
                onOpenReceiving={() => setSection("receiving")}
                onOpenAddItem={() => setSection("add")}
              />
            </div>
          )}
          {!isPosSurface && section === "receiving" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
              <div className="rounded-[28px] border border-app-border bg-app-surface p-6 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
                      <SHIPPING_ICON size={24} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                        Receive Stock
                      </p>
                      <h3 className="mt-1 text-xl font-black tracking-tight text-app-text">
                        Start with the vendor paperwork in hand.
                      </h3>
                      <p className="mt-2 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
                        Pick an existing purchase order, or create a direct invoice when
                        merchandise arrived without a pre-built order. Standard purchase
                        orders still need to be submitted before stock can be posted.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSection("purchase_orders")}
                    className="inline-flex h-11 items-center gap-2 rounded-2xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
                  >
	                    Order Stock <ArrowUpRight size={14} strokeWidth={3} />
                  </button>
                </div>
              </div>
              <PurchaseOrderPanel
                initialPoId={activeProcurementPoId}
                onInitialPoConsumed={consumeProcurementPoId}
                mode="receive"
                onOpenOrderStock={() => setSection("purchase_orders")}
                onOpenAddItem={() => setSection("add")}
              />
            </div>
          )}
          {!isPosSurface && section === "po_invoice_import" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <ProcurementImportWorkspace
                onOpenReceiving={(poId) => {
                  if (poId) setLocalProcurementPoId(poId);
                  setSection("receiving");
                }}
                onOpenPurchaseOrder={(poId) => {
                  setLocalProcurementPoId(poId);
                  setSection("purchase_orders");
                }}
              />
            </div>
          )}
          {!isPosSurface && section === "batch_scan" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <InventoryBatchScanPanel
                baseUrl={baseUrl}
                headers={() => mergedPosStaffHeaders(backofficeHeaders)}
                toast={toast}
              />
            </div>
          )}
          
          <div className="space-y-20">
             {!isPosSurface && section === "vendors" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><VendorHub /></div>}
             {!isPosSurface && section === "add" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><ProductMasterForm /></div>}
             {!isPosSurface && section === "categories" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><CategoryManager /></div>}
             {!isPosSurface && section === "discount_events" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><DiscountEventsPanel /></div>}
             {!isPosSurface && section === "import" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><UniversalImporter onOpenReceiving={() => setSection("receiving")} onOpenPoInvoiceImport={() => setSection("po_invoice_import")} /></div>}
             {!isPosSurface && section === "physical" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><PhysicalInventoryWorkspace /></div>}
             {!isPosSurface && section === "damaged" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><MaintenanceLedgerPanel type="damaged" /></div>}
             {!isPosSurface && section === "rtv" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><MaintenanceLedgerPanel type="return_to_vendor" /></div>}
             {!isPosSurface && section === "reports" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><InventoryReportsPanel /></div>}
             {!isPosSurface && section === "intelligence" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><IntelligencePanel /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
