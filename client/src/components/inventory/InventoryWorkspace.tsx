import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import CategoryManager from "./CategoryManager";
import InventoryControlBoard from "./InventoryControlBoard";
import ProductMasterForm from "./ProductMasterForm";
import PurchaseOrderPanel from "./PurchaseOrderPanel";
import UniversalImporter from "./UniversalImporter";
import VendorHub from "./VendorHub";
import PhysicalInventoryWorkspace from "./PhysicalInventoryWorkspace";
import DiscountEventsPanel from "./DiscountEventsPanel";
import { MaintenanceLedgerPanel } from "./MaintenanceLedgerPanel";

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
  | "rtv";

interface InventoryWorkspaceProps {
  activeSection?: string;
  procurementDeepLinkPoId?: string | null;
  onProcurementDeepLinkConsumed?: () => void;
  openProductHubProductId?: string | null;
  onProductHubDeepLinkConsumed?: () => void;
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
};

export default function InventoryWorkspace({
  activeSection,
  procurementDeepLinkPoId,
  onProcurementDeepLinkConsumed,
  openProductHubProductId,
  onProductHubDeepLinkConsumed,
}: InventoryWorkspaceProps) {
  const [section, setSection] = useState<InventorySection>("list");

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
  const isListSection = section === "list";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 gap-4">
      {/* Section header — list view keeps title only; detail lives inside the control board */}
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
          Inventory
        </p>
        <h2 className="text-2xl font-black tracking-tight text-app-text">{meta.title}</h2>
        {!isListSection ? (
          <p className="mt-0.5 text-sm text-app-text-muted">{meta.subtitle}</p>
        ) : null}
      </div>

      {/* Active section panel — fills remaining height, scrolls internally */}
      <div className="ui-card min-h-0 flex-1 overflow-y-auto p-5">
        {section === "list" && (
          <InventoryControlBoard
            openProductHubProductId={openProductHubProductId ?? null}
            onProductHubDeepLinkConsumed={onProductHubDeepLinkConsumed}
          />
        )}
        {section === "purchase_orders" && (
          <PurchaseOrderPanel
            initialPoId={procurementDeepLinkPoId ?? null}
            onInitialPoConsumed={onProcurementDeepLinkConsumed}
          />
        )}
        {section === "receiving" && (
          <div className="flex flex-col items-center justify-center py-20 bg-app-surface-2/30 rounded-3xl border-2 border-dashed border-app-border">
            <Truck className="h-12 w-12 text-app-text-muted mb-4 opacity-20" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text mb-2">Standalone Receiving Bay</h3>
            <p className="text-[10px] font-bold text-app-text-muted max-w-xs text-center mb-6">Open the Receiving Bay from a submitted Purchase Order to begin scan verification.</p>
            <button 
              onClick={() => setSection("purchase_orders")}
              className="px-6 py-2.5 bg-app-accent text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-app-accent/20"
            >
              Go to Purchase Orders
            </button>
          </div>
        )}
        {section === "vendors" && <VendorHub />}
        {section === "add" && <ProductMasterForm />}
        {section === "categories" && <CategoryManager />}
        {section === "discount_events" && <DiscountEventsPanel />}
        {section === "import" && <UniversalImporter />}
        {section === "physical" && <PhysicalInventoryWorkspace />}
        {section === "damaged" && <MaintenanceLedgerPanel type="damaged" />}
        {section === "rtv" && <MaintenanceLedgerPanel type="return_to_vendor" />}
      </div>
    </div>
  );
}
