import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  BarChart3,
  ExternalLink,
  FileClock,
  Image as ImageIcon,
  Megaphone,
  Navigation,
  Search,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { apiUrl } from "../../lib/apiUrl";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { SidebarTabId } from "../layout/sidebarSections";
import OnlineStoreSettingsPanel from "../settings/OnlineStoreSettingsPanel";
import OnlineStoreProductsPanel from "./OnlineStoreProductsPanel";

type OnlineStoreSection =
  | "dashboard"
  | "storefront"
  | "layout"
  | "products"
  | "orders"
  | "carts"
  | "customers"
  | "promotions"
  | "campaigns"
  | "seo"
  | "navigation"
  | "media"
  | "shipping"
  | "analytics";

interface OnlineStoreWorkspaceProps {
  activeSection?: string;
  onNavigateToTab: (tab: SidebarTabId, section?: string) => void;
  onOpenInventoryProduct: (productId: string) => void;
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

interface StoreMerchRow {
  product_id: string;
  catalog_handle?: string | null;
  stock_on_hand: number;
  available_stock?: number;
  web_published?: boolean;
  web_price_override?: string | null;
}

interface StoreMerchResponse {
  rows?: StoreMerchRow[];
}

interface StoreCheckoutConfigResponse {
  web_checkout_enabled: boolean;
  default_provider: string;
  providers: Array<{
    provider: string;
    enabled: boolean;
    label: string;
  }>;
}

interface StoreDashboardResponse {
  web_transactions: number;
  web_sales_usd: string;
  pending_checkouts: number;
  abandoned_checkouts: number;
  active_campaigns: number;
  media_assets: number;
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
    id: "layout",
    label: "Layout",
    desc: "ROS-native homepage sections and safe storefront blocks.",
  },
  {
    id: "products",
    label: "Products",
    desc: "Web-published inventory and merchandising paths.",
  },
  {
    id: "orders",
    label: "Orders",
    desc: "Paid web transactions and fulfillment routing.",
  },
  {
    id: "carts",
    label: "Carts",
    desc: "Checkout sessions, failures, and abandoned cart signals.",
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
    id: "campaigns",
    label: "Campaigns",
    desc: "Landing pages, coupon attribution, and performance.",
  },
  {
    id: "seo",
    label: "SEO",
    desc: "Storefront health issues and fix paths.",
  },
  {
    id: "navigation",
    label: "Navigation",
    desc: "Header and footer storefront menus.",
  },
  {
    id: "media",
    label: "Media",
    desc: "Uploaded assets, alt text, and usage notes.",
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

function money(value: string | number | null | undefined) {
  const n =
    typeof value === "number"
      ? value
      : Number.parseFloat(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "$0.00";
}

function shortDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function DataPanel({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
          <Icon size={18} />
        </div>
        <div>
          <h2 className="text-2xl font-black italic uppercase tracking-tight text-app-text">
            {title}
          </h2>
          <p className="mt-1 text-sm text-app-text-muted">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="ui-card p-6 text-sm font-medium text-app-text-muted">
      {label}
    </div>
  );
}

type HeaderFactory = () => Record<string, string>;

function OrdersPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/orders"), {
      headers: headers(),
    });
    const json = (await res.json()) as {
      orders?: Array<Record<string, unknown>>;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error ?? "Could not load web orders.");
    setOrders(json.orders ?? []);
  }, [baseUrl, headers]);
  useEffect(() => {
    void load().catch((err: Error) => setError(err.message));
  }, [load]);
  const updateOrder = async (id: string, action: string) => {
    setError(null);
    const res = await fetch(apiUrl(baseUrl, `/api/admin/store/orders/${id}`), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        action,
        tracking_number: tracking[id] || null,
        tracking_url_provider: tracking[id] ? "carrier" : null,
      }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not update web transaction.");
      return;
    }
    await load();
  };
  return (
    <DataPanel
      title="Web orders"
      subtitle="Paid web transactions created by ROS checkout."
      icon={ShoppingBag}
    >
      {error ? <EmptyState label={error} /> : null}
      {orders.length === 0 && !error ? (
        <EmptyState label="No web orders yet." />
      ) : null}
      <div className="grid gap-3">
        {orders.map((order) => {
          const transactionId = String(order.transaction_id);
          return (
            <section key={transactionId} className="ui-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-app-text">
                    {String(order.display_id ?? "Web transaction")}
                  </p>
                  <p className="text-xs text-app-text-muted">
                    {shortDate(String(order.booked_at ?? ""))} ·{" "}
                    {String(order.fulfillment_method ?? "pickup")}
                  </p>
                </div>
                <div className="text-right font-mono text-sm font-black text-app-text">
                  {money(order.total_price as string)}
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-app-text-muted sm:grid-cols-4">
                <span>Status: {String(order.status ?? "—")}</span>
                <span>Web: {String(order.web_order_status ?? "new")}</span>
                <span>Paid: {money(order.amount_paid as string)}</span>
                <span>Balance: {money(order.balance_due as string)}</span>
                <span>Provider: {String(order.payment_provider ?? "—")}</span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
                  onClick={() =>
                    void updateOrder(transactionId, "ready_for_pickup")
                  }
                >
                  Ready for pickup
                </button>
                <input
                  className="ui-input max-w-56 text-xs"
                  value={
                    tracking[transactionId] ??
                    String(order.tracking_number ?? "")
                  }
                  onChange={(e) =>
                    setTracking((current) => ({
                      ...current,
                      [transactionId]: e.target.value,
                    }))
                  }
                  placeholder="Tracking number"
                />
                <button
                  type="button"
                  className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
                  onClick={() =>
                    void updateOrder(transactionId, "mark_shipped")
                  }
                >
                  Mark shipped
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
                  onClick={() =>
                    void updateOrder(transactionId, "cancel_requested")
                  }
                >
                  Cancel review
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
                  onClick={() =>
                    void updateOrder(transactionId, "refund_needed")
                  }
                >
                  Refund needed
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </DataPanel>
  );
}

function CartsPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [sessions, setSessions] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(apiUrl(baseUrl, "/api/admin/store/carts"), {
          headers: headers(),
        });
        const json = (await res.json()) as {
          sessions?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (!res.ok) {
          setError(json.error ?? "Could not load checkout sessions.");
          return;
        }
        setSessions(json.sessions ?? []);
      } catch {
        setError("Could not load checkout sessions.");
      }
    })();
  }, [baseUrl, headers]);
  return (
    <DataPanel
      title="Carts"
      subtitle="Checkout sessions, pending payments, failures, and abandoned signals."
      icon={ShoppingCart}
    >
      {error ? <EmptyState label={error} /> : null}
      {sessions.length === 0 && !error ? (
        <EmptyState label="No checkout sessions yet." />
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {sessions.map((session) => {
          const contact = session.contact as
            | { email?: string; name?: string }
            | undefined;
          return (
            <section key={String(session.id)} className="ui-card p-4">
              <div className="flex justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-app-text">
                    {String(
                      contact?.email ?? contact?.name ?? "Guest checkout",
                    )}
                  </p>
                  <p className="text-xs text-app-text-muted">
                    {shortDate(String(session.created_at ?? ""))}
                  </p>
                </div>
                <span className="text-xs font-black uppercase text-app-accent">
                  {String(session.status ?? "draft")}
                </span>
              </div>
              <div className="mt-3 grid gap-1 font-mono text-xs text-app-text-muted">
                <span>Total {money(session.total_usd as string)}</span>
                <span>Provider {String(session.selected_provider ?? "—")}</span>
                <span>Coupon {String(session.coupon_code ?? "—")}</span>
              </div>
            </section>
          );
        })}
      </div>
    </DataPanel>
  );
}

function CampaignsPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [campaigns, setCampaigns] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [draft, setDraft] = useState({
    slug: "",
    name: "",
    landing_page_slug: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/campaigns"), {
      headers: headers(),
    });
    const json = (await res.json()) as {
      campaigns?: Array<Record<string, unknown>>;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error ?? "Could not load campaigns.");
    setCampaigns(json.campaigns ?? []);
  }, [baseUrl, headers]);
  useEffect(() => {
    void load().catch((err: Error) => setError(err.message));
  }, [load]);
  const create = async () => {
    setError(null);
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/campaigns"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        slug: draft.slug,
        name: draft.name,
        landing_page_slug: draft.landing_page_slug || null,
        notes: draft.notes || null,
      }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not create campaign.");
      return;
    }
    setDraft({ slug: "", name: "", landing_page_slug: "", notes: "" });
    await load();
  };
  return (
    <DataPanel
      title="Campaigns"
      subtitle="Landing pages, coupon attribution, source tags, and web revenue."
      icon={Megaphone}
    >
      <section className="ui-card grid gap-3 p-4 lg:grid-cols-4">
        <input
          className="ui-input"
          value={draft.slug}
          onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
          placeholder="campaign-slug"
        />
        <input
          className="ui-input"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Campaign name"
        />
        <input
          className="ui-input"
          value={draft.landing_page_slug}
          onChange={(e) =>
            setDraft((d) => ({ ...d, landing_page_slug: e.target.value }))
          }
          placeholder="Landing page slug"
        />
        <button
          type="button"
          className="ui-btn-primary"
          onClick={() => void create()}
        >
          Create campaign
        </button>
      </section>
      {error ? <EmptyState label={error} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {campaigns.map((campaign) => (
          <section key={String(campaign.id)} className="ui-card p-4">
            <p className="text-sm font-black text-app-text">
              {String(campaign.name)}
            </p>
            <p className="text-xs font-mono text-app-text-muted">
              /shop/{String(campaign.landing_page_slug ?? campaign.slug)}
            </p>
            <div className="mt-3 grid gap-1 text-xs text-app-text-muted">
              <span>Coupon: {String(campaign.coupon_code ?? "—")}</span>
              <span>
                Paid checkouts: {String(campaign.paid_checkouts ?? 0)}
              </span>
              <span>Revenue: {money(campaign.revenue_usd as string)}</span>
            </div>
          </section>
        ))}
      </div>
    </DataPanel>
  );
}

function SeoPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [issues, setIssues] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(apiUrl(baseUrl, "/api/admin/store/seo"), {
          headers: headers(),
        });
        const json = (await res.json()) as {
          issues?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (!res.ok) {
          setError(json.error ?? "Could not load SEO health.");
          return;
        }
        setIssues(json.issues ?? []);
      } catch {
        setError("Could not load SEO health.");
      }
    })();
  }, [baseUrl, headers]);
  return (
    <DataPanel
      title="SEO health"
      subtitle="Actionable storefront publishing and catalog issues."
      icon={Search}
    >
      {error ? <EmptyState label={error} /> : null}
      {issues.length === 0 && !error ? (
        <EmptyState label="No SEO issues found." />
      ) : null}
      <div className="grid gap-2">
        {issues.map((issue, idx) => (
          <section
            key={`${String(issue.kind)}-${String(issue.entity_id)}-${idx}`}
            className="ui-card flex flex-wrap items-center justify-between gap-3 p-4"
          >
            <div>
              <p className="text-sm font-black text-app-text">
                {String(issue.label)}
              </p>
              <p className="text-xs text-app-text-muted">
                {String(issue.kind)} · {String(issue.entity_id)}
              </p>
            </div>
          </section>
        ))}
      </div>
    </DataPanel>
  );
}

function NavigationPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [menus, setMenus] = useState<Array<Record<string, unknown>>>([]);
  const [selectedHandle, setSelectedHandle] = useState("header");
  const [draftTitle, setDraftTitle] = useState("Header");
  const [draftItems, setDraftItems] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/navigation"), {
      headers: headers(),
    });
    const json = (await res.json()) as {
      menus?: Array<Record<string, unknown>>;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error ?? "Could not load navigation.");
    setMenus(json.menus ?? []);
  }, [baseUrl, headers]);
  useEffect(() => {
    void load().catch((err: Error) => setError(err.message));
  }, [load]);
  useEffect(() => {
    const selected = menus.find(
      (menu) => String(menu.handle) === selectedHandle,
    );
    setDraftTitle(
      String(
        selected?.title ?? (selectedHandle === "footer" ? "Footer" : "Header"),
      ),
    );
    setDraftItems([
      ...(
        (selected?.items as Array<Record<string, unknown>> | undefined) ?? []
      ).map((item, idx) => ({
        label: String(item.label ?? ""),
        url: String(item.url ?? ""),
        item_kind: String(item.item_kind ?? "custom"),
        sort_order: Number(item.sort_order ?? idx * 10),
        is_active: item.is_active !== false,
      })),
    ]);
  }, [menus, selectedHandle]);
  const updateItem = (index: number, patch: Record<string, unknown>) => {
    setDraftItems((items) =>
      items.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
    );
  };
  const moveItem = (index: number, delta: number) => {
    setDraftItems((items) => {
      const next = [...items];
      const to = index + delta;
      if (to < 0 || to >= next.length) return items;
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item);
      return next.map((row, idx) => ({ ...row, sort_order: idx * 10 }));
    });
  };
  const save = async () => {
    setError(null);
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/navigation"), {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        handle: selectedHandle,
        title: draftTitle,
        items: draftItems.map((item, idx) => ({
          ...item,
          sort_order: idx * 10,
        })),
      }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not save navigation.");
      return;
    }
    await load();
  };
  return (
    <DataPanel
      title="Navigation"
      subtitle="Header and footer menus rendered by the public storefront."
      icon={Navigation}
    >
      {error ? <EmptyState label={error} /> : null}
      <section className="ui-card space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs font-black uppercase tracking-widest text-app-text-muted">
            Menu
            <select
              className="ui-input min-w-40"
              value={selectedHandle}
              onChange={(e) => setSelectedHandle(e.target.value)}
            >
              <option value="header">Header</option>
              <option value="footer">Footer</option>
            </select>
          </label>
          <label className="grid min-w-64 flex-1 gap-1 text-xs font-black uppercase tracking-widest text-app-text-muted">
            Title
            <input
              className="ui-input"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="ui-btn-primary text-[10px] font-black uppercase tracking-widest"
            onClick={() => void save()}
          >
            Save menu
          </button>
          <button
            type="button"
            className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
            onClick={() =>
              setDraftItems((items) => [
                ...items,
                {
                  label: "New link",
                  url: "/shop",
                  item_kind: "custom",
                  sort_order: items.length * 10,
                  is_active: true,
                },
              ])
            }
          >
            Add link
          </button>
        </div>
        <div className="grid gap-2">
          {draftItems.map((item, index) => (
            <div
              key={`${index}-${String(item.label)}`}
              className="grid gap-2 rounded-xl border border-app-border p-3 lg:grid-cols-[1fr_1fr_auto]"
            >
              <input
                className="ui-input"
                value={String(item.label ?? "")}
                onChange={(e) => updateItem(index, { label: e.target.value })}
                placeholder="Label"
              />
              <input
                className="ui-input"
                value={String(item.url ?? "")}
                onChange={(e) => updateItem(index, { url: e.target.value })}
                placeholder="/shop/products"
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs font-bold text-app-text-muted">
                  <input
                    type="checkbox"
                    checked={item.is_active !== false}
                    onChange={(e) =>
                      updateItem(index, { is_active: e.target.checked })
                    }
                  />
                  Active
                </label>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-2 text-xs"
                  onClick={() => moveItem(index, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-2 text-xs"
                  onClick={() => moveItem(index, 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-2 text-xs"
                  onClick={() =>
                    setDraftItems((items) =>
                      items.filter((_, idx) => idx !== index),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {draftItems.length === 0 ? (
            <EmptyState label="No menu items yet." />
          ) : null}
        </div>
      </section>
    </DataPanel>
  );
}

function MediaPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [assets, setAssets] = useState<Array<Record<string, unknown>>>([]);
  const [drafts, setDrafts] = useState<
    Record<string, { alt_text: string; usage_note: string }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/media"), {
      headers: headers(),
    });
    const json = (await res.json()) as {
      assets?: Array<Record<string, unknown>>;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error ?? "Could not load media.");
    const nextAssets = json.assets ?? [];
    setAssets(nextAssets);
    setDrafts(
      Object.fromEntries(
        nextAssets.map((asset) => [
          String(asset.id),
          {
            alt_text: String(asset.alt_text ?? ""),
            usage_note: String(asset.usage_note ?? ""),
          },
        ]),
      ),
    );
  }, [baseUrl, headers]);
  useEffect(() => {
    void load().catch((err: Error) => setError(err.message));
  }, [load]);
  const patchAsset = async (id: string) => {
    setError(null);
    const draft = drafts[id] ?? { alt_text: "", usage_note: "" };
    const res = await fetch(apiUrl(baseUrl, `/api/admin/store/media/${id}`), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        alt_text: draft.alt_text || null,
        usage_note: draft.usage_note || null,
      }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not save media.");
      return;
    }
    await load();
  };
  const archiveAsset = async (id: string) => {
    setError(null);
    const res = await fetch(
      apiUrl(baseUrl, `/api/admin/store/media/${id}/archive`),
      {
        method: "POST",
        headers: headers(),
      },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not archive media.");
      return;
    }
    await load();
  };
  return (
    <DataPanel
      title="Media library"
      subtitle="Uploaded Studio/CMS assets with alt text and usage context."
      icon={ImageIcon}
    >
      {error ? <EmptyState label={error} /> : null}
      {assets.length === 0 && !error ? (
        <EmptyState label="No uploaded media yet." />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {assets.map((asset) => {
          const id = String(asset.id);
          const draft = drafts[id] ?? { alt_text: "", usage_note: "" };
          return (
            <section key={id} className="ui-card overflow-hidden">
              <img
                src={apiUrl(baseUrl, `/api/store/media/${id}`)}
                alt={draft.alt_text}
                className="h-36 w-full object-cover"
              />
              <div className="space-y-1 p-3 text-xs text-app-text-muted">
                <p className="font-black text-app-text">
                  {String(asset.original_filename ?? "Uploaded image")}
                </p>
                <p>
                  {String(asset.mime_type)} · {String(asset.byte_size)} bytes
                </p>
                <input
                  className="ui-input text-xs"
                  value={draft.alt_text}
                  onChange={(e) =>
                    setDrafts((current) => ({
                      ...current,
                      [id]: { ...draft, alt_text: e.target.value },
                    }))
                  }
                  placeholder="Alt text"
                />
                <input
                  className="ui-input text-xs"
                  value={draft.usage_note}
                  onChange={(e) =>
                    setDrafts((current) => ({
                      ...current,
                      [id]: { ...draft, usage_note: e.target.value },
                    }))
                  }
                  placeholder="Usage note"
                />
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    onClick={() => void patchAsset(id)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    onClick={() => void archiveAsset(id)}
                  >
                    Archive
                  </button>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </DataPanel>
  );
}

function PublishHistoryPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [revisions, setRevisions] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(
      apiUrl(baseUrl, "/api/admin/store/publish-history"),
      {
        headers: headers(),
      },
    );
    const json = (await res.json()) as {
      revisions?: Array<Record<string, unknown>>;
      error?: string;
    };
    if (!res.ok)
      throw new Error(json.error ?? "Could not load publish history.");
    setRevisions(json.revisions ?? []);
  }, [baseUrl, headers]);
  useEffect(() => {
    void load().catch((err: Error) => setError(err.message));
  }, [load]);
  const restore = async (id: string) => {
    setError(null);
    const res = await fetch(
      apiUrl(baseUrl, `/api/admin/store/publish-history/${id}/restore`),
      {
        method: "POST",
        headers: headers(),
      },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not restore publish snapshot.");
      return;
    }
    await load();
  };
  return (
    <DataPanel
      title="Publish history"
      subtitle="Published page snapshots captured when staff publish."
      icon={FileClock}
    >
      {error ? <EmptyState label={error} /> : null}
      {revisions.length === 0 && !error ? (
        <EmptyState label="No publish snapshots yet." />
      ) : null}
      <div className="grid gap-2">
        {revisions.map((revision) => (
          <section
            key={String(revision.id)}
            className="ui-card flex flex-wrap justify-between gap-3 p-4"
          >
            <div>
              <p className="text-sm font-black text-app-text">
                {String(revision.title)}
              </p>
              <p className="text-xs font-mono text-app-text-muted">
                /shop/{String(revision.slug)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-app-text-muted">
                {shortDate(String(revision.published_at ?? ""))}
              </p>
              <button
                type="button"
                className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                onClick={() => void restore(String(revision.id))}
              >
                Restore
              </button>
              <button
                type="button"
                className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                onClick={() =>
                  window.open(
                    `/shop/${String(revision.slug)}`,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                Preview
              </button>
            </div>
          </section>
        ))}
      </div>
    </DataPanel>
  );
}

function HomeLayoutPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const sample = `[
  {
    "type": "hero",
    "title": "Formalwear made simple",
    "body": "Shop live Riverside inventory online.",
    "cta_label": "View products",
    "cta_url": "/shop/products"
  },
  {
    "type": "featured_products",
    "title": "Featured styles"
  }
]`;
  const [draft, setDraft] = useState(sample);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          apiUrl(baseUrl, "/api/admin/store/home-layout"),
          {
            headers: headers(),
          },
        );
        const json = (await res.json()) as { blocks?: unknown; error?: string };
        if (!res.ok) {
          setError(json.error ?? "Could not load homepage layout.");
          return;
        }
        setDraft(
          JSON.stringify(
            Array.isArray(json.blocks) ? json.blocks : [],
            null,
            2,
          ),
        );
      } catch {
        setError("Could not load homepage layout.");
      }
    })();
  }, [baseUrl, headers]);
  const save = async () => {
    setError(null);
    setSaved(false);
    let blocks: unknown;
    try {
      blocks = JSON.parse(draft);
    } catch {
      setError("Layout must be valid JSON.");
      return;
    }
    if (!Array.isArray(blocks)) {
      setError("Layout must be a JSON array.");
      return;
    }
    const res = await fetch(apiUrl(baseUrl, "/api/admin/store/home-layout"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ blocks }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Could not save homepage layout.");
      return;
    }
    setSaved(true);
  };
  return (
    <DataPanel
      title="Homepage layout"
      subtitle="ROS-native sections rendered by the public storefront without replacing product/catalog truth."
      icon={Navigation}
    >
      {error ? <EmptyState label={error} /> : null}
      {saved ? <EmptyState label="Homepage layout saved." /> : null}
      <section className="ui-card space-y-3 p-4">
        <textarea
          className="ui-input min-h-[360px] font-mono text-xs"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="ui-btn-primary text-[10px] font-black uppercase tracking-widest"
            onClick={() => void save()}
          >
            Save layout
          </button>
          <button
            type="button"
            className="ui-btn-secondary text-[10px] font-black uppercase tracking-widest"
            onClick={() => setDraft(sample)}
          >
            Use starter layout
          </button>
        </div>
      </section>
    </DataPanel>
  );
}

function AnalyticsPanel({
  baseUrl,
  headers,
}: {
  baseUrl: string;
  headers: HeaderFactory;
}) {
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [campaigns, setCampaigns] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(apiUrl(baseUrl, "/api/admin/store/analytics"), {
          headers: headers(),
        });
        const json = (await res.json()) as {
          summary?: Record<string, unknown>;
          campaigns?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (!res.ok) {
          setError(json.error ?? "Could not load analytics.");
          return;
        }
        setSummary(json.summary ?? null);
        setCampaigns(json.campaigns ?? []);
      } catch {
        setError("Could not load analytics.");
      }
    })();
  }, [baseUrl, headers]);
  const paid = Number(summary?.paid_sessions ?? 0);
  const started = Number(summary?.checkout_started ?? 0);
  const paymentStarted = Number(summary?.payment_started ?? 0);
  const pct = (num: number, den: number) =>
    den > 0 ? `${Math.round((num / den) * 100)}%` : "0%";
  return (
    <DataPanel
      title="Analytics"
      subtitle="Storefront checkout funnel and campaign revenue."
      icon={BarChart3}
    >
      {error ? <EmptyState label={error} /> : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusCard
          label="Checkout starts"
          value={String(summary?.checkout_started ?? 0)}
          detail={`${summary?.checkout_sessions ?? 0} total saved sessions.`}
        />
        <StatusCard
          label="Payment starts"
          value={String(summary?.payment_started ?? 0)}
          detail={`${pct(paymentStarted, started)} of started checkouts.`}
        />
        <StatusCard
          label="Paid sessions"
          value={String(summary?.paid_sessions ?? 0)}
          detail={`${pct(paid, started)} conversion from checkout start.`}
        />
        <StatusCard
          label="Paid revenue"
          value={money(summary?.paid_revenue_usd as string)}
          detail={`${summary?.web_transactions ?? 0} web transactions in ROS.`}
        />
      </div>
      <section className="ui-card p-4">
        <p className="text-sm font-black text-app-text">Campaign performance</p>
        <div className="mt-3 grid gap-2">
          {campaigns.map((campaign, idx) => (
            <div
              key={`${String(campaign.campaign_slug ?? "direct")}-${idx}`}
              className="grid gap-2 rounded-lg border border-app-border p-3 text-xs text-app-text-muted sm:grid-cols-4"
            >
              <span className="font-black text-app-text">
                {String(campaign.campaign_slug ?? "direct")}
              </span>
              <span>Sessions {String(campaign.sessions ?? 0)}</span>
              <span>Paid {String(campaign.paid_sessions ?? 0)}</span>
              <span>Revenue {money(campaign.revenue_usd as string)}</span>
            </div>
          ))}
          {campaigns.length === 0 ? (
            <EmptyState label="No campaign sessions yet." />
          ) : null}
        </div>
      </section>
    </DataPanel>
  );
}

export default function OnlineStoreWorkspace({
  activeSection,
  onNavigateToTab,
  onOpenInventoryProduct,
}: OnlineStoreWorkspaceProps) {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const canManage =
    hasPermission("online_store.manage") || hasPermission("settings.admin");
  const canOpenSettings = hasPermission("settings.admin");
  const section = resolveSection(activeSection);
  const [pages, setPages] = useState<StorePageRow[]>([]);
  const [coupons, setCoupons] = useState<StoreCouponRow[]>([]);
  const [merchRows, setMerchRows] = useState<StoreMerchRow[]>([]);
  const [dashboard, setDashboard] = useState<StoreDashboardResponse | null>(
    null,
  );
  const [checkoutConfig, setCheckoutConfig] =
    useState<StoreCheckoutConfigResponse | null>(null);
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
      const [pagesRes, couponsRes, merchRes, checkoutRes, dashboardRes] =
        await Promise.all([
          fetch(`${baseUrl}/api/admin/store/pages`, { headers: headers() }),
          fetch(`${baseUrl}/api/admin/store/coupons`, { headers: headers() }),
          fetch(apiUrl(baseUrl, "/api/inventory/control-board?limit=5000"), {
            headers: headers(),
          }),
          fetch(apiUrl(baseUrl, "/api/store/checkout/config")),
          fetch(apiUrl(baseUrl, "/api/admin/store/dashboard"), {
            headers: headers(),
          }),
        ]);
      if (
        !pagesRes.ok ||
        !couponsRes.ok ||
        !merchRes.ok ||
        !checkoutRes.ok ||
        !dashboardRes.ok
      ) {
        setLoadError("Could not load online store status.");
        return;
      }
      const pagesJson = (await pagesRes.json()) as { pages?: StorePageRow[] };
      const couponsJson = (await couponsRes.json()) as {
        coupons?: StoreCouponRow[];
      };
      const merchJson = (await merchRes.json()) as StoreMerchResponse;
      const checkoutJson =
        (await checkoutRes.json()) as StoreCheckoutConfigResponse;
      const dashboardJson =
        (await dashboardRes.json()) as StoreDashboardResponse;
      setPages(Array.isArray(pagesJson.pages) ? pagesJson.pages : []);
      setCoupons(Array.isArray(couponsJson.coupons) ? couponsJson.coupons : []);
      setMerchRows(Array.isArray(merchJson.rows) ? merchJson.rows : []);
      setCheckoutConfig(checkoutJson);
      setDashboard(dashboardJson);
    } catch {
      setLoadError("Could not load online store status.");
    }
  }, [baseUrl, canManage, headers]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const publishedPages = pages.filter((page) => page.published).length;
  const activeCoupons = coupons.filter((coupon) => coupon.is_active).length;
  const merchProductIds = new Set(merchRows.map((row) => row.product_id));
  const onWebProductIds = new Set(
    merchRows.filter((row) => row.web_published).map((row) => row.product_id),
  );
  const needsSlugProductIds = new Set(
    merchRows
      .filter((row) => row.web_published && !(row.catalog_handle ?? "").trim())
      .map((row) => row.product_id),
  );
  const zeroStockProductIds = new Set(
    merchRows
      .filter(
        (row) =>
          row.web_published &&
          (typeof row.available_stock === "number"
            ? row.available_stock
            : row.stock_on_hand) <= 0,
      )
      .map((row) => row.product_id),
  );
  const webPriceOverrideCount = merchRows.filter((row) =>
    (row.web_price_override ?? "").trim(),
  ).length;
  const enabledPaymentProviders = useMemo(
    () =>
      checkoutConfig?.providers.filter((provider) => provider.enabled) ?? [],
    [checkoutConfig?.providers],
  );

  const dashboardCards = useMemo(
    () => [
      {
        label: "Web sales",
        value: money(dashboard?.web_sales_usd ?? "0"),
        detail: `${dashboard?.web_transactions ?? 0} paid web transactions.`,
      },
      {
        label: "Open checkouts",
        value: `${dashboard?.pending_checkouts ?? 0}`,
        detail: "Draft or payment-pending storefront checkouts.",
      },
      {
        label: "Abandoned",
        value: `${dashboard?.abandoned_checkouts ?? 0}`,
        detail: "Failed, expired, or cancelled checkout sessions.",
      },
      {
        label: "Campaigns",
        value: `${dashboard?.active_campaigns ?? 0}`,
        detail: "Active Online Store campaigns.",
      },
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
        label: "Products on web",
        value: `${onWebProductIds.size}/${merchProductIds.size}`,
        detail: "Product merchandising reads from inventory truth.",
      },
      {
        label: "Needs web setup",
        value: `${needsSlugProductIds.size}`,
        detail: "Published products missing a storefront slug.",
      },
      {
        label: "Zero-stock web",
        value: `${zeroStockProductIds.size}`,
        detail: "Published products with no available stock.",
      },
      {
        label: "Web price overrides",
        value: `${webPriceOverrideCount}`,
        detail: "Variants using web-only pricing.",
      },
      {
        label: "Paid checkout",
        value: checkoutConfig?.web_checkout_enabled
          ? enabledPaymentProviders.length > 0
            ? "Ready"
            : "Needs provider"
          : "Disabled",
        detail:
          enabledPaymentProviders.length > 0
            ? `Default ${checkoutConfig?.default_provider ?? "stripe"}; enabled: ${enabledPaymentProviders
                .map((provider) => provider.label)
                .join(", ")}.`
            : "Configure Stripe or Helcim before public checkout is available.",
      },
    ],
    [
      activeCoupons,
      coupons.length,
      dashboard?.abandoned_checkouts,
      dashboard?.active_campaigns,
      dashboard?.pending_checkouts,
      dashboard?.web_sales_usd,
      dashboard?.web_transactions,
      merchProductIds.size,
      needsSlugProductIds.size,
      onWebProductIds.size,
      pages.length,
      publishedPages,
      checkoutConfig?.default_provider,
      checkoutConfig?.web_checkout_enabled,
      enabledPaymentProviders,
      webPriceOverrideCount,
      zeroStockProductIds.size,
    ],
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
        <section className="space-y-6">
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
          <PublishHistoryPanel baseUrl={baseUrl} headers={headers} />
        </section>
      ) : null}

      {section === "layout" ? (
        <HomeLayoutPanel baseUrl={baseUrl} headers={headers} />
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
        <OnlineStoreProductsPanel
          baseUrl={baseUrl}
          onOpenInventoryProduct={onOpenInventoryProduct}
          onRefreshSummary={loadOverview}
        />
      ) : null}

      {section === "orders" ? (
        <OrdersPanel baseUrl={baseUrl} headers={headers} />
      ) : null}

      {section === "carts" ? (
        <CartsPanel baseUrl={baseUrl} headers={headers} />
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

      {section === "campaigns" ? (
        <CampaignsPanel baseUrl={baseUrl} headers={headers} />
      ) : null}

      {section === "seo" ? (
        <SeoPanel baseUrl={baseUrl} headers={headers} />
      ) : null}

      {section === "navigation" ? (
        <NavigationPanel baseUrl={baseUrl} headers={headers} />
      ) : null}

      {section === "media" ? (
        <MediaPanel baseUrl={baseUrl} headers={headers} />
      ) : null}

      {section === "analytics" ? (
        <AnalyticsPanel baseUrl={baseUrl} headers={headers} />
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
