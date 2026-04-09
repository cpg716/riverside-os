import { useEffect, useState } from "react";
import CategoryManager from "./CategoryManager";
import InventoryControlBoard from "./InventoryControlBoard";
import ProductMasterForm from "./ProductMasterForm";
import PurchaseOrderPanel from "./PurchaseOrderPanel";
import UniversalImporter from "./UniversalImporter";
import VendorHub from "./VendorHub";
import PhysicalInventoryWorkspace from "./PhysicalInventoryWorkspace";
import DiscountEventsPanel from "./DiscountEventsPanel";

type InventorySection =
  | "list"
  | "add"
  | "receiving"
  | "categories"
  | "discount_events"
  | "import"
  | "vendors"
  | "physical";

interface InventoryWorkspaceProps {
  activeSection?: string;
  procurementDeepLinkPoId?: string | null;
  onProcurementDeepLinkConsumed?: () => void;
  openProductHubProductId?: string | null;
  onProductHubDeepLinkConsumed?: () => void;
}

const SECTION_META: Record<InventorySection, { title: string; subtitle: string }> = {
  list: {
    title: "Inventory List",
    subtitle: "Browse live inventory, stock levels, and variant details.",
  },
  add: {
    title: "Add Inventory",
    subtitle: "Create and manage your product catalog and SKUs.",
  },
  receiving: {
    title: "Receiving & Purchase Orders",
    subtitle: "Log incoming stock and manage purchase orders.",
  },
  categories: { title: "Categories & Import", subtitle: "Organize categories, tax rules, and bulk import catalog data." },
  discount_events: {
    title: "Promotions & sales",
    subtitle:
      "Time-boxed percent-off retail: by selected SKUs, whole category, or primary vendor. POS applies as sale price.",
  },
  import: {
    title: "Catalog Import",
    subtitle:
      "Import products from Lightspeed X-Series presets or Generic CSV mapping.",
  },
  vendors: { title: "Vendor Hub", subtitle: "Manage supplier contacts, lead times, and cost tracking." },
  physical: {
    title: "Physical Inventory",
    subtitle: "Multi-day scanning sessions with review, adjustment, and publish workflow.",
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
      "add",
      "receiving",
      "categories",
      "discount_events",
      "import",
      "vendors",
      "physical",
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
        {section === "add" && <ProductMasterForm />}
        {section === "receiving" && (
          <div className="space-y-6">
            <PurchaseOrderPanel
              initialPoId={procurementDeepLinkPoId ?? null}
              onInitialPoConsumed={onProcurementDeepLinkConsumed}
            />
          </div>
        )}
        {section === "categories" && (
          <div className="space-y-6">
            <CategoryManager />
            <div className="border-t border-app-border pt-6">
              <p className="mb-4 text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
                Catalog Import
              </p>
              <UniversalImporter />
            </div>
          </div>
        )}
        {section === "discount_events" && <DiscountEventsPanel />}
        {section === "import" && <UniversalImporter />}
        {section === "vendors" && <VendorHub />}
        {section === "physical" && <PhysicalInventoryWorkspace />}
      </div>
    </div>
  );
}
