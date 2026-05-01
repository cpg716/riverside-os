import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  ExternalLink,
  Package,
  Settings,
  ShoppingBag,
  Truck,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { GRAPESJS_STUDIO_LICENSE_KEY } from "../../lib/grapesjsStudioLicense";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { SidebarTabId } from "../layout/sidebarSections";
import OnlineStoreSettingsPanel from "../settings/OnlineStoreSettingsPanel";

type OnlineStoreSection =
  | "dashboard"
  | "storefront"
  | "products"
  | "orders"
  | "customers"
  | "promotions"
  | "shipping"
  | "analytics";

interface OnlineStoreWorkspaceProps {
  activeSection?: string;
  onNavigateToTab: (tab: SidebarTabId, section?: string) => void;
}

interface StorePageRow {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  updated_at: string;
}

interface StoreCouponRow {
  id: string;
  code: string;
  kind: string;
  value: string;
  is_active: boolean;
  uses_count: number;
  max_uses: number | null;
}

const sections: {
  id: OnlineStoreSection;
  label: string;
  desc: string;
}[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    desc: "Launch readiness and web business health.",
  },
  {
    id: "storefront",
    label: "Storefront",
    desc: "CMS pages, Studio editing, and publishing.",
  },
  {
    id: "products",
    label: "Products",
    desc: "Web-published inventory and merchandising paths.",
  },
  {
    id: "orders",
    label: "Orders",
    desc: "Web order operating surface as checkout comes online.",
  },
  {
    id: "customers",
    label: "Customers",
    desc: "Online accounts and linked in-store customers.",
  },
  {
    id: "promotions",
    label: "Promotions",
    desc: "Coupons and campaign controls.",
  },
  {
    id: "shipping",
    label: "Shipping",
    desc: "Pickup, ship-to, rates, and fulfillment routing.",
  },
  {
    id: "analytics",
    label: "Analytics",
    desc: "Channel reporting and performance signals.",
  },
];

const sectionIds = new Set(sections.map((section) => section.id));

function resolveSection(value: string | undefined): OnlineStoreSection {
  return value && sectionIds.has(value as OnlineStoreSection)
    ? (value as OnlineStoreSection)
    : "dashboard";
}

function StatusCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <section className="ui-card p-4">
      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-tight text-app-text">
        {value}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
        {detail}
      </p>
    </section>
  );
}

function RoutePanel({
  icon: Icon,
  title,
  body,
  buttonLabel,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  buttonLabel: string;
  onClick: () => void;
}) {
  return (
    <section className="ui-card flex flex-wrap items-center justify-between gap-4 p-5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
          <Icon size={18} />
        </div>
        <div>
          <h3 className="text-base font-black text-app-text">{title}</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-app-text-muted">
            {body}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onClick}
        className="ui-btn-secondary inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest"
      >
        {buttonLabel}
        <ExternalLink size={14} />
      </button>
    </section>
  );
}

export default function OnlineStoreWorkspace({
  activeSection,
  onNavigateToTab,
}: OnlineStoreWorkspaceProps) {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const canManage =
    hasPermission("online_store.manage") || hasPermission("settings.admin");
  const canOpenSettings = hasPermission("settings.admin");
  const section = resolveSection(activeSection);
  const [pages, setPages] = useState<StorePageRow[]>([]);
  const [coupons, setCoupons] = useState<StoreCouponRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const headers = useCallback(
    () =>
      ({
        "Content-Type": "application/json",
        ...mergedPosStaffHeaders(backofficeHeaders),
      }) as Record<string, string>,
    [backofficeHeaders],
  );

  const loadOverview = useCallback(async () => {
    if (!canManage) return;
    setLoadError(null);
    try {
      const [pagesRes, couponsRes] = await Promise.all([
        fetch(`${baseUrl}/api/admin/store/pages`, { headers: headers() }),
        fetch(`${baseUrl}/api/admin/store/coupons`, { headers: headers() }),
      ]);
      if (!pagesRes.ok || !couponsRes.ok) {
        setLoadError("Could not load online store status.");
        return;
      }
      const pagesJson = (await pagesRes.json()) as { pages?: StorePageRow[] };
      const couponsJson = (await couponsRes.json()) as {
        coupons?: StoreCouponRow[];
      };
      setPages(Array.isArray(pagesJson.pages) ? pagesJson.pages : []);
      setCoupons(
        Array.isArray(couponsJson.coupons) ? couponsJson.coupons : [],
      );
    } catch {
      setLoadError("Could not load online store status.");
    }
  }, [baseUrl, canManage, headers]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const publishedPages = pages.filter((page) => page.published).length;
  const activeCoupons = coupons.filter((coupon) => coupon.is_active).length;

  const dashboardCards = useMemo(
    () => [
      {
        label: "Published pages",
        value: `${publishedPages}/${pages.length}`,
        detail: "CMS pages live under public /shop slugs.",
      },
      {
        label: "Active coupons",
        value: `${activeCoupons}/${coupons.length}`,
        detail: "Coupon controls moved from Settings into Promotions.",
      },
      {
        label: "Studio license",
        value:
          GRAPESJS_STUDIO_LICENSE_KEY === "DEV_LICENSE_KEY"
            ? "Dev key"
            : "Configured",
        detail: "Studio edits marketing pages only; catalog remains ROS-native.",
      },
      {
        label: "Paid checkout",
        value: "Not enabled",
        detail: "Phase 1 keeps checkout implementation out of scope.",
      },
    ],
    [activeCoupons, coupons.length, pages.length, publishedPages],
  );

  if (!canManage) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-app-text-muted">
        You need Online Store or Settings admin permission to manage this
        workspace.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-app-accent">
            First-party web business
          </p>
          <h1 className="mt-2 text-3xl font-black italic uppercase tracking-tighter text-app-text sm:text-4xl">
            Online Store
          </h1>
          <p className="mt-2 max-w-4xl text-sm font-medium leading-relaxed text-app-text-muted">
            Run the public storefront from ROS: pages, promotions, product
            exposure, web operations, and channel readiness. Catalog, cart,
            checkout, tax, and fulfillment stay ROS-native.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.open("/shop", "_blank", "noopener,noreferrer")}
          className="ui-btn-secondary inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest"
        >
          Open /shop
          <ExternalLink size={14} />
        </button>
      </header>

      <nav className="flex flex-wrap gap-2">
        {sections.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigateToTab("online-store", item.id)}
            className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-widest ${
              section === item.id
                ? "bg-app-accent text-white"
                : "border border-app-border bg-app-surface text-app-text-muted"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {loadError ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700">
          {loadError}
        </p>
      ) : null}

      {section === "dashboard" ? (
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {dashboardCards.map((card) => (
              <StatusCard key={card.label} {...card} />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {sections
              .filter((item) => item.id !== "dashboard")
              .map((item) => (
                <section key={item.id} className="ui-card p-4">
                  <p className="text-sm font-black text-app-text">
                    {item.label}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-app-text-muted">
                    {item.desc}
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigateToTab("online-store", item.id)}
                    className="mt-3 text-[10px] font-black uppercase tracking-widest text-app-accent"
                  >
                    Open {item.label}
                  </button>
                </section>
              ))}
          </div>
        </div>
      ) : null}

      {section === "storefront" ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-2xl font-black italic uppercase tracking-tight text-app-text">
              Storefront
            </h2>
            <p className="mt-1 text-sm text-app-text-muted">
              Manage CMS pages, Studio editing, raw HTML fallback, and publish
              state for public /shop pages.
            </p>
          </div>
          <OnlineStoreSettingsPanel
            baseUrl={baseUrl}
            mode="pages"
            showHeader={false}
          />
        </section>
      ) : null}

      {section === "promotions" ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-2xl font-black italic uppercase tracking-tight text-app-text">
              Promotions
            </h2>
            <p className="mt-1 text-sm text-app-text-muted">
              Create and activate web coupon codes for the public cart preview
              path.
            </p>
          </div>
          <OnlineStoreSettingsPanel
            baseUrl={baseUrl}
            mode="coupons"
            showHeader={false}
          />
        </section>
      ) : null}

      {section === "products" ? (
        <RoutePanel
          icon={Package}
          title="Products stay tied to inventory truth"
          body="Phase 1 does not duplicate catalog management. Use the Inventory workspace for web publish flags, web pricing, gallery order, and product data until Online Store gets a dedicated merchandising surface."
          buttonLabel="Open inventory"
          onClick={() => onNavigateToTab("inventory", "list")}
        />
      ) : null}

      {section === "orders" ? (
        <RoutePanel
          icon={ShoppingBag}
          title="Web order operations will attach to ROS orders"
          body="Paid web checkout is not enabled in Phase 1. When web orders are created, this section should focus on sale channel, fulfillment state, pickup or ship-to handling, and staff review."
          buttonLabel="Open orders"
          onClick={() => onNavigateToTab("orders", "open")}
        />
      ) : null}

      {section === "customers" ? (
        <RoutePanel
          icon={Users}
          title="Online accounts share the customer base"
          body="Public account records and linked in-store customers are already part of the storefront account path. Use Customers for the live customer record until this view gets account-specific queues."
          buttonLabel="Open customers"
          onClick={() => onNavigateToTab("customers", "all")}
        />
      ) : null}

      {section === "shipping" ? (
        <RoutePanel
          icon={Truck}
          title="Shipping remains a shared ROS operation"
          body="Shippo rates support the public cart estimate path and the existing shipments hub. Web shipping should stay aligned with POS and customer shipment workflows."
          buttonLabel="Open shipments hub"
          onClick={() => onNavigateToTab("customers", "ship")}
        />
      ) : null}

      {section === "analytics" ? (
        <RoutePanel
          icon={BarChart3}
          title="Channel analytics will use ROS reporting"
          body="The sale_channel field already exists for register vs web attribution. Phase 1 keeps analytics routed to existing reports until paid web checkout creates live web orders."
          buttonLabel="Open reports"
          onClick={() => onNavigateToTab("reports")}
        />
      ) : null}

      <section className="ui-card flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
            <Settings size={18} />
          </div>
          <div>
            <p className="text-sm font-black text-app-text">
              Store configuration moved to Settings.
            </p>
            <p className="mt-1 text-xs text-app-text-muted">
              Use Settings only for license, provider, checkout, tax, and
              storefront setup status.
            </p>
          </div>
        </div>
        {canOpenSettings ? (
          <button
            type="button"
            onClick={() => onNavigateToTab("settings", "online-store")}
            className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
          >
            Open Settings
          </button>
        ) : null}
      </section>
    </div>
  );
}
