import { useEffect, useState, useCallback } from "react";
import { TrendingUp } from "lucide-react";
import CategoryManager from "./CategoryManager";
import InventoryControlBoard from "./InventoryControlBoard";
import PurchaseOrderPanel from "./PurchaseOrderPanel";
import UniversalImporter from "./UniversalImporter";
import VendorHub from "./VendorHub";
import PhysicalInventoryWorkspace from "./PhysicalInventoryWorkspace";
import DiscountEventsPanel from "./DiscountEventsPanel";
import { MaintenanceLedgerPanel } from "./MaintenanceLedgerPanel";
import InventoryOverviewPanel from "./InventoryOverviewPanel";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { apiUrl } from "../../lib/apiUrl";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

import ReceivingWizard from "./ReceivingWizard";
import { StoreMapModule } from "./StoreMapModule";

type InventorySection =
  | "home"
  | "products"
  | "orders"
  | "receiving"
  | "inventory_count"
  | "damaged"
  | "rtv"
  | "map"
  | "vendors"
  | "promotions"
  | "reports"
  | "settings";

interface InventoryWorkspaceProps {
  activeSection?: string;
  procurementDeepLinkPoId?: string | null;
  onProcurementDeepLinkConsumed?: () => void;
  openProductHubProductId?: string | null;
  onProductHubDeepLinkConsumed?: () => void;
}

const SECTION_META: Record<InventorySection, { title: string; subtitle: string }> = {
  home: {
    title: "Inventory Overview",
    subtitle: "Daily stock alerts and replenishment suggestions.",
  },
  products: {
    title: "Product List",
    subtitle: "View products, update stock, and manage sizes.",
  },
  orders: {
    title: "Purchase Orders",
    subtitle: "Manage orders and track incoming shipments from suppliers.",
  },
  receiving: {
    title: "Receive Items",
    subtitle: "Scan incoming items and add them to your stock counts.",
  },
  inventory_count: {
    title: "Count Inventory",
    subtitle: "Perform cycle counts and reconcile shelf stock.",
  },
  damaged: {
    title: "Damaged Items",
    subtitle: "Log broken or damaged goods for adjustment records.",
  },
  rtv: {
    title: "Return to Vendor",
    subtitle: "Manage defective goods or seasonal returns to suppliers.",
  },
  map: {
    title: "Store Map",
    subtitle: "Map products to physical racks and floor locations.",
  },
  vendors: {
    title: "Suppliers",
    subtitle: "Manage vendor contacts, brands, and price lists.",
  },
  promotions: {
    title: "Sales & Markdowns",
    subtitle: "Schedule price drops and promotional events.",
  },
  reports: {
    title: "Inventory Reports",
    subtitle: "View stock levels, sales velocity, and low-stock alerts.",
  },
  settings: {
    title: "System Settings",
    subtitle: "Manage categories and batch import new products.",
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
}: InventoryWorkspaceProps) {
  const [section, setSection] = useState<InventorySection>("home");
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
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
        headers: backofficeHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setGlobalStats(data.stats);
      }
    } catch (e) {
      console.error("Failed to fetch global inventory stats", e);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void refreshGlobalStats();
  }, [refreshGlobalStats]);

  useEffect(() => {
    const valid: InventorySection[] = [
      "home",
      "products",
      "orders",
      "receiving",
      "inventory_count",
      "damaged",
      "rtv",
      "map",
      "vendors",
      "promotions",
      "reports",
      "settings",
    ];

    if (activeSection) {
      const legacyMap: Record<string, InventorySection> = {
        list: "products",
        purchase_orders: "orders",
        physical: "inventory_count",
        discount_events: "promotions",
        intelligence: "home",
        categories: "settings",
        add: "products",
        import: "settings",
        damaged: "damaged",
        rtv: "rtv",
      };

      const target = legacyMap[activeSection] || (valid.includes(activeSection as InventorySection) ? activeSection as InventorySection : null);
      if (target) {
        setSection(target);
      }
    }
  }, [activeSection]);

  const meta = SECTION_META[section];

  return (
    <div className="flex flex-1 flex-col bg-gray-50/50 min-h-screen animate-in fade-in duration-500">
      <div className="flex-1 p-6 lg:p-10 space-y-8">
        
        {/* Simplified Data-Driven Header */}
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex flex-col">
            <h2 className="text-xl font-black tracking-tight text-app-text">Inventory Hub</h2>
            <div className="flex items-center gap-1 mt-1">
              <div className="h-1 w-3 rounded-full bg-app-accent opacity-50" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                {meta.title}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
             {[
              { label: 'Value', value: formatUsdFromCents(parseMoneyToCents(globalStats.total_asset_value)), color: 'blue' as const },
              { label: 'OOS', value: globalStats.skus_out_of_stock, color: 'orange' as const },
              { label: 'Replenish', value: globalStats.oos_replenishment_skus || 0, color: 'purple' as const },
              { label: 'Vendors', value: globalStats.active_vendors, color: 'blue' as const },
            ].map((stat, i) => (
              <div key={i} className="bg-app-surface/60 backdrop-blur-md border border-app-border rounded-xl px-4 py-2 flex flex-col min-w-[100px]">
                <span className="text-[8px] font-black uppercase tracking-widest text-app-text-muted opacity-40">{stat.label}</span>
                <span className="text-sm font-bold text-app-text">{stat.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Improved Subsection Navigation (Tabs) */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
          {(Object.keys(SECTION_META) as InventorySection[]).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`
                shrink-0 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all
                ${section === s 
                  ? "bg-app-accent text-white shadow-lg shadow-app-accent/20" 
                  : "bg-app-surface/40 text-app-text-muted hover:bg-app-surface/60 hover:text-app-text"
                }
              `}
            >
              {s === "inventory_count" ? "Count Stock" 
               : s === "rtv" ? "Returns"
               : s === "vendors" ? "Suppliers"
               : s === "promotions" ? "Sales"
               : s.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="min-h-0">
          {section === "home" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <InventoryOverviewPanel />
            </div>
          )}
          {section === "products" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <InventoryControlBoard
                openProductHubProductId={openProductHubProductId ?? null}
                onProductHubDeepLinkConsumed={onProductHubDeepLinkConsumed}
              />
            </div>
          )}
          {section === "orders" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <PurchaseOrderPanel
                initialPoId={procurementDeepLinkPoId ?? null}
                onInitialPoConsumed={onProcurementDeepLinkConsumed}
              />
            </div>
          )}
          {section === "receiving" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
               <ReceivingWizard />
            </div>
          )}
          {section === "inventory_count" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <PhysicalInventoryWorkspace />
            </div>
          )}
          {section === "damaged" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <MaintenanceLedgerPanel type="damaged" />
            </div>
          )}
          {section === "rtv" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
              <MaintenanceLedgerPanel type="return_to_vendor" />
            </div>
          )}
          {section === "map" && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
               <StoreMapModule />
            </div>
          )}
          {section === "vendors" && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <VendorHub />
            </div>
          )}
          {section === "promotions" && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <DiscountEventsPanel />
            </div>
          )}
          {section === "reports" && (
            <div className="flex flex-col items-center justify-center p-12 py-24 animate-in zoom-in-95 duration-1000">
               <div className="text-center space-y-4">
                  <TrendingUp size={64} className="mx-auto text-app-accent opacity-20" />
                  <h3 className="text-2xl font-black uppercase tracking-widest text-app-text-muted opacity-40">Reports Coming Soon</h3>
                  <p className="text-sm font-medium text-app-text-muted max-w-md mx-auto">Detailed sales and stock level reporting for managers.</p>
               </div>
            </div>
          )}
          {section === "settings" && (
            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
              <div className="rounded-[32px] border border-app-border bg-app-surface/40 p-10">
                <h3 className="text-xl font-bold text-app-text mb-8">Category Taxonomy</h3>
                <CategoryManager />
              </div>
              <div className="rounded-[32px] border border-app-border bg-app-surface/40 p-10">
                <h3 className="text-xl font-bold text-app-text mb-8">Batch Product Import</h3>
                <UniversalImporter />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
