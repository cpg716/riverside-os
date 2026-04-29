import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useState, useCallback } from "react";
import { AlertCircle, TrendingUp, ArrowUpRight } from "lucide-react";
import CategoryManager from "./CategoryManager";
import InventoryControlBoard from "./InventoryControlBoard";
import ProductMasterForm from "./ProductMasterForm";
import PurchaseOrderPanel from "./PurchaseOrderPanel";
import UniversalImporter from "./UniversalImporter";
import VendorHub from "./VendorHub";
import PhysicalInventoryWorkspace from "./PhysicalInventoryWorkspace";
import DiscountEventsPanel from "./DiscountEventsPanel";
import { MaintenanceLedgerPanel } from "./MaintenanceLedgerPanel";
import IntelligencePanel from "./IntelligencePanel";
import DashboardStatsCard from "../ui/DashboardStatsCard";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { apiUrl } from "../../lib/apiUrl";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { getAppIcon } from "../../lib/icons";

const INVENTORY_ICON = getAppIcon("inventory");
const SHIPPING_ICON = getAppIcon("shipping");
const VENDOR_ICON = getAppIcon("vendor");

type InventorySection =
  | "list"
  | "purchase_orders"
  | "receiving"
  | "vendors"
  | "add"
  | "categories"
  | "discount_events"
  | "import"
  | "physical"
  | "damaged"
  | "rtv"
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
    title: "Add/Edit Catalog",
    subtitle: "Schedule time-boxed markdowns by SKU, category, or vendor.",
    toolLabel: "Promotions",
  },
  import: {
    title: "Add/Edit Catalog",
    subtitle: "Catalog-only CSV mapping for vendor manifests; Counterpoint sync owns pre-launch inventory quantities.",
    toolLabel: "Catalog Import",
  },
  physical: {
    title: "Count/Reconcile",
    subtitle: "Cycle counting and full-store reconciliation workflows.",
    toolLabel: "Physical Inventory",
  },
  damaged: {
    title: "Correct Stock",
    subtitle: "Review damaged or missing stock movements and audit correction history.",
    toolLabel: "Damaged / Loss",
  },
  rtv: {
    title: "Correct Stock",
    subtitle: "Review stock sent back for vendor credits and claims.",
    toolLabel: "Return to Vendor",
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
    description: "Search items, inspect stock, print tags, and open product details.",
    primarySection: "list",
    sections: ["list"],
  },
  {
    label: "Add/Edit Catalog",
    description: "Maintain products, categories, vendors, imports, and promotions.",
    primarySection: "add",
    sections: ["add", "categories", "vendors", "import", "discount_events"],
  },
  {
    label: "Order Stock",
    description: "Create purchase orders and review buying guidance.",
    primarySection: "purchase_orders",
    sections: ["purchase_orders", "intelligence"],
  },
  {
    label: "Receive Stock",
    description: "Post arrived vendor paperwork into live inventory.",
    primarySection: "receiving",
    sections: ["receiving"],
  },
  {
    label: "Correct Stock",
    description: "Review damage, loss, and return-to-vendor movements.",
    primarySection: "damaged",
    sections: ["damaged", "rtv"],
  },
  {
    label: "Count/Reconcile",
    description: "Run physical counts and publish reviewed variances.",
    primarySection: "physical",
    sections: ["physical"],
  },
];

const JOB_BY_SECTION = INVENTORY_JOBS.reduce<Record<InventorySection, InventoryJob>>(
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

export default function InventoryWorkspace({
  activeSection,
  procurementDeepLinkPoId,
  onProcurementDeepLinkConsumed,
  openProductHubProductId,
  onProductHubDeepLinkConsumed,
  surface = "backoffice",
}: InventoryWorkspaceProps) {
  const [section, setSection] = useState<InventorySection>("list");
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  const [globalStats, setGlobalStats] = useState<BoardStats>({
    total_asset_value: "0.00",
    skus_out_of_stock: 0,
    active_vendors: 0,
    need_label_skus: 0,
    oos_replenishment_skus: 0,
  });

  const refreshGlobalStats = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/inventory/control-board?limit=1"), {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (res.ok) {
        const data = await res.json();
        setGlobalStats(data.stats);
      }
    } catch (e) {
      console.error("Failed to fetch global inventory stats", e);
    } finally {
      // stats loading handled implicitly by data presence
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void refreshGlobalStats();
  }, [refreshGlobalStats]);

  useEffect(() => {
    const valid: InventorySection[] = [
      "list",
      "purchase_orders",
      "receiving",
      "vendors",
      "add",
      "categories",
      "discount_events",
      "import",
      "physical",
      "damaged",
      "rtv",
      "intelligence",
    ];
    if (activeSection && valid.includes(activeSection as InventorySection)) {
      if (activeSection === "products") {
        setSection("add");
      } else {
        setSection(activeSection as InventorySection);
      }
    }
  }, [activeSection]);

  const meta = SECTION_META[section];
  const isPosSurface = surface === "pos";
  const activeJob = JOB_BY_SECTION[section];

  return (
    <div className="flex flex-1 flex-col bg-transparent animate-in fade-in duration-700">
      <div className={isPosSurface ? "flex-1 p-4 sm:p-6" : "flex-1 p-6 sm:p-10"}>
        
        {/* Harmonized Dashboard Header */}
        {!isPosSurface && (
	        <div className="flex flex-col gap-6 mb-10">
	          <div className="flex flex-wrap items-center justify-between gap-6">
	            <div className="space-y-3">
	              <div className="flex items-center gap-2">
	                <div className="h-1 w-4 rounded-full bg-app-accent shadow-[0_0_8px_rgba(var(--app-accent-rgb),0.5)]" />
	                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
	                  Inventory Hub · {activeJob.label}
	                </p>
	              </div>
	              <h2 className="text-3xl font-bold tracking-tight text-app-text">
	                {meta.title}
	              </h2>
	              <p className="max-w-2xl text-sm font-medium text-app-text-muted leading-relaxed">
	                {meta.subtitle}
	              </p>
	              {meta.toolLabel !== meta.title ? (
	                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
	                  Current tool: <span className="text-app-text">{meta.toolLabel}</span>
	                </p>
	              ) : null}
	            </div>

	            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 w-full">
                <DashboardStatsCard
                  title="Asset Value"
                  value={formatUsdFromCents(parseMoneyToCents(globalStats.total_asset_value))}
                  icon={TrendingUp}
                  trend={{ value: "+2.4%", isUp: true }}
                />
                <DashboardStatsCard
                  title="Stock Alerts"
                  value={globalStats.skus_out_of_stock.toString()}
                  icon={AlertCircle}
                  color="orange"
                />
                <DashboardStatsCard
                  title="Replenishments"
                  value={(globalStats.oos_replenishment_skus || 0).toString()}
                  icon={INVENTORY_ICON}
                />
                <DashboardStatsCard
                  title="Vendors"
                  value={globalStats.active_vendors.toString()}
                  icon={VENDOR_ICON}
                  color="purple"
                />
	            </div>
	          </div>
	          <div className="rounded-[28px] border border-app-border bg-app-surface p-4 shadow-sm">
	            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
	              {INVENTORY_JOBS.map((job) => {
	                const isActive = job.label === activeJob.label;
	                return (
	                  <button
	                    key={job.label}
	                    type="button"
	                    onClick={() => setSection(job.primarySection)}
	                    className={`rounded-2xl border px-4 py-3 text-left transition-all active:scale-95 ${
	                      isActive
	                        ? "border-app-accent bg-app-accent/10 text-app-text"
	                        : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-text"
	                    }`}
	                  >
	                    <span className="block text-[10px] font-black uppercase tracking-[0.18em]">
	                      {job.label}
	                    </span>
	                    <span className="mt-2 block text-[11px] font-semibold leading-relaxed">
	                      {job.description}
	                    </span>
	                  </button>
	                );
	              })}
	            </div>
	            {activeJob.sections.length > 1 ? (
	              <div className="mt-4 flex flex-wrap gap-2 border-t border-app-border pt-4">
	                {activeJob.sections.map((jobSection) => {
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
	            ) : null}
	          </div>
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
                initialPoId={procurementDeepLinkPoId ?? null}
                onInitialPoConsumed={onProcurementDeepLinkConsumed}
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
                initialPoId={procurementDeepLinkPoId ?? null}
                onInitialPoConsumed={onProcurementDeepLinkConsumed}
                mode="receive"
              />
            </div>
          )}
          
          <div className="space-y-20">
             {!isPosSurface && section === "vendors" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><VendorHub /></div>}
             {!isPosSurface && section === "add" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><ProductMasterForm /></div>}
             {!isPosSurface && section === "categories" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><CategoryManager /></div>}
             {!isPosSurface && section === "discount_events" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><DiscountEventsPanel /></div>}
             {!isPosSurface && section === "import" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><UniversalImporter /></div>}
             {!isPosSurface && section === "physical" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><PhysicalInventoryWorkspace /></div>}
             {!isPosSurface && section === "damaged" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><MaintenanceLedgerPanel type="damaged" /></div>}
             {!isPosSurface && section === "rtv" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><MaintenanceLedgerPanel type="return_to_vendor" /></div>}
             {!isPosSurface && section === "intelligence" && <div className="animate-in fade-in slide-in-from-bottom-8 duration-700"><IntelligencePanel /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
