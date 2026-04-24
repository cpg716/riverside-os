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

const SECTION_META: Record<InventorySection, { title: string; subtitle: string }> = {
  list: {
    title: "Inventory List",
    subtitle: "Look up items, review stock, and open product details.",
  },
  purchase_orders: {
    title: "Purchase Orders",
    subtitle: "Build vendor orders, add invoice lines, and send items to receiving.",
  },
  receiving: {
    title: "Receive Stock",
    subtitle: "Post received items from submitted purchase orders or direct vendor invoices.",
  },
  vendors: {
    title: "Vendors",
    subtitle: "Create, update, and clean up vendor records used for ordering and receiving.",
  },
  add: {
    title: "Add Item",
    subtitle: "Create a new item and its sellable SKUs.",
  },
  categories: {
    title: "Categories",
    subtitle: "Organize item groups, tax rules, and default size or color options.",
  },
  discount_events: {
    title: "Promotions",
    subtitle: "Schedule time-boxed markdowns by SKU, category, or vendor.",
  },
  import: {
    title: "Catalog Import",
    subtitle: "Catalog-only CSV mapping for vendor manifests; Counterpoint sync owns pre-launch inventory quantities.",
  },
  physical: {
    title: "Physical Inventory",
    subtitle: "Cycle counting and full-store reconciliation workflows.",
  },
  damaged: {
    title: "Damaged / Loss",
    subtitle: "Record damaged or missing stock with clear staff notes.",
  },
  rtv: {
    title: "Return to Vendor",
    subtitle: "Track stock sent back for vendor credits and claims.",
  },
  intelligence: {
    title: "Stock Guidance",
    subtitle: "Review reorder and markdown suggestions with plain-language reasons.",
  },
};

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
                  Inventory Hub · {section.replace("_", " ")}
                </p>
              </div>
              <h2 className="text-3xl font-bold tracking-tight text-app-text">
                {meta.title}
              </h2>
              <p className="max-w-2xl text-sm font-medium text-app-text-muted leading-relaxed">
                {meta.subtitle}
              </p>
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
                    Purchase Orders <ArrowUpRight size={14} strokeWidth={3} />
                  </button>
                </div>
              </div>
              <PurchaseOrderPanel
                initialPoId={procurementDeepLinkPoId ?? null}
                onInitialPoConsumed={onProcurementDeepLinkConsumed}
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
