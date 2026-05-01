import { GRAPESJS_STUDIO_LICENSE_KEY } from "../../lib/grapesjsStudioLicense";

interface OnlineStoreConfigPanelProps {
  onOpenOnlineStore?: () => void;
}

const configRows = [
  {
    label: "Public storefront",
    value: "/shop",
    detail: "Guest storefront stays on the ROS-native catalog, cart, and account routes.",
  },
  {
    label: "GrapesJS Studio",
    value:
      GRAPESJS_STUDIO_LICENSE_KEY === "DEV_LICENSE_KEY"
        ? "Local dev key"
        : "License configured",
    detail: "Studio is for CMS and marketing pages, not catalog or checkout.",
  },
  {
    label: "Checkout",
    value: "Not enabled",
    detail: "Phase 1 keeps paid web checkout out of scope.",
  },
  {
    label: "Shipping and tax",
    value: "Estimate path",
    detail: "Public cart uses existing Shippo rate and web tax preview endpoints.",
  },
];

export default function OnlineStoreConfigPanel({
  onOpenOnlineStore,
}: OnlineStoreConfigPanelProps) {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-3xl font-black italic uppercase tracking-tighter text-app-text">
          Online Store Settings
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium text-app-text-muted">
          Low-frequency setup for the public storefront. Day-to-day page,
          coupon, product, and web operations now live in the Online Store
          workspace.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {configRows.map((row) => (
          <section key={row.label} className="ui-card p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              {row.label}
            </p>
            <p className="mt-2 text-lg font-black text-app-text">{row.value}</p>
            <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
              {row.detail}
            </p>
          </section>
        ))}
      </div>

      <section className="ui-card flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="text-sm font-black text-app-text">
            Manage the online business from the main workspace.
          </p>
          <p className="mt-1 text-xs text-app-text-muted">
            Open Online Store for storefront pages, promotions, products, web
            order routing, and launch readiness.
          </p>
        </div>
        {onOpenOnlineStore ? (
          <button
            type="button"
            onClick={onOpenOnlineStore}
            className="ui-btn-primary text-[10px] font-black uppercase tracking-widest"
          >
            Open Online Store
          </button>
        ) : null}
      </section>
    </div>
  );
}
