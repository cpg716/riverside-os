import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useState, useCallback } from "react";
import { AlertCircle, Package, Building2, TrendingUp, Truck, ArrowUpRight } from "lucide-react";
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
    title: "Inventory Control",
    subtitle: "High-density catalog discovery and multi-variant stock control.",
  },
  purchase_orders: {
    title: "Purchase Orders",
    subtitle: "Manage supplier procurement, draft orders, and tracking.",
  },
  receiving: {
    title: "Receiving Bay",
    subtitle: "Verify inbound shipments, scan verify invoices, and update WAC.",
  },
  vendors: {
    title: "Vendor Manager",
    subtitle: "Consolidate suppliers, manage brands, and merge duplicates.",
  },
  add: {
    title: "Add Inventory",
    subtitle: "Onboard new product templates and generate base SKUs.",
  },
  categories: {
    title: "Categories",
    subtitle: "Organize taxonomy, tax rules, and web-branch mapping.",
  },
  discount_events: {
    title: "Promotions",
    subtitle: "Schedule time-boxed markdowns by SKU, category, or vendor.",
  },
  import: {
    title: "Catalog Import",
    subtitle: "Batch ingestion from Lightspeed X-Series or Generic CSV.",
  },
  physical: {
    title: "Physical Inventory",
    subtitle: "Cycle counting and full-store reconciliation workflows.",
  },
  damaged: {
    title: "Damaged / Loss",
    subtitle: "Attribute shrinkage and damage to staff maintenance ledger.",
  },
  rtv: {
    title: "Return to Vendor",
    subtitle: "Track inventory egress for credits and supplier claims.",
  },
  intelligence: {
    title: "Inventory Brain v2",
    subtitle: "AI-driven stock-out predictions and replenishment guidance.",
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
                  icon={Package}
                />
                <DashboardStatsCard
                  title="Suppliers"
                  value={globalStats.active_vendors.toString()}
                  icon={Building2}
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
            <div className="flex flex-col items-center justify-center p-12 py-24 animate-in zoom-in-95 duration-1000">
              <div className="relative group max-w-2xl w-full p-16 rounded-[40px] border-2 border-app-border bg-app-surface shadow-2xl text-center space-y-10 overflow-hidden">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 h-32 w-32 rounded-3xl bg-app-bg border-4 border-app-border shadow-3xl text-app-accent flex items-center justify-center group-hover:scale-110 group-hover:rotate-6 transition-all duration-700">
                  <Truck size={48} strokeWidth={2.5} />
                  <div className="absolute inset-0 bg-app-accent/20 rounded-[32px] blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                </div>
                
                <div className="space-y-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 italic">Logistics Protocols</p>
                  <h3 className="text-4xl font-black italic tracking-tighter text-app-text uppercase leading-none">Standalone Ingress Offline</h3>
                  <div className="h-1.5 w-20 bg-app-accent mx-auto rounded-full" />
                  <p className="text-sm font-semibold text-app-text-muted leading-relaxed uppercase tracking-[0.15em] opacity-60 px-6">
                    Registry integrity requires a procurement baseline. Please enter the Procurement Hub to authorize an inbound shipment.
                  </p>
                </div>

                <button 
                  onClick={() => setSection("purchase_orders")}
                  className="group relative flex h-20 w-full items-center justify-center gap-6 bg-app-accent border-b-4 border-app-accent/60 rounded-[30px] px-12 text-[12px] font-black uppercase tracking-[0.3em] text-white shadow-xl hover:brightness-110 active:translate-y-1 active:border-b-0 transition-all italic"
                >
                  Enter Procurement Hub <ArrowUpRight size={24} strokeWidth={3} className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                </button>
              </div>
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
