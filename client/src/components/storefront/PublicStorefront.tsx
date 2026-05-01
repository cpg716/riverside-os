import { getBaseUrl } from "../../lib/apiConfig";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { apiUrl } from "../../lib/apiUrl";
import { Badge } from "@/components/ui-shadcn/badge";
import { Button } from "@/components/ui-shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui-shadcn/card";
import { Input } from "@/components/ui-shadcn/input";
import { Label } from "@/components/ui-shadcn/label";
import { Separator } from "@/components/ui-shadcn/separator";
import { Skeleton } from "@/components/ui-shadcn/skeleton";

const API_BASE = getBaseUrl();

const storefrontQueryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

const STORE_ACCOUNT_ORDER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoreAccountView = "home" | "login" | "register" | "link" | "order";

type Route =
  | { kind: "landing" }
  | { kind: "cms"; slug: string }
  | { kind: "plp" }
  | { kind: "pdp"; slug: string }
  | { kind: "cart" }
  | { kind: "checkout" }
  | { kind: "checkout-complete"; sessionId?: string }
  | { kind: "account"; view: StoreAccountView; orderId?: string };

function parseRoute(pathname: string): Route {
  const norm = pathname.replace(/\/+$/, "") || "/";
  if (!norm.startsWith("/shop")) return { kind: "landing" };
  const tail = norm.slice("/shop".length).replace(/^\//, "");
  if (!tail) return { kind: "landing" };
  if (tail === "cart") return { kind: "cart" };
  if (tail === "checkout") return { kind: "checkout" };
  if (tail === "checkout/complete") {
    const sp = new URLSearchParams(window.location.search);
    return {
      kind: "checkout-complete",
      sessionId: sp.get("session") ?? undefined,
    };
  }
  if (tail === "products") return { kind: "plp" };
  if (tail.startsWith("account")) {
    const sub = tail === "account" ? "" : tail.slice("account".length).replace(/^\//, "");
    if (sub === "login") return { kind: "account", view: "login" };
    if (sub === "register") return { kind: "account", view: "register" };
    if (sub === "link") return { kind: "account", view: "link" };
    if (sub.startsWith("orders/")) {
      const oid = sub.slice("orders/".length).trim();
      if (STORE_ACCOUNT_ORDER_ID_RE.test(oid)) {
        return { kind: "account", view: "order", orderId: oid };
      }
    }
    return { kind: "account", view: "home" };
  }
  if (tail.startsWith("products/")) {
    const slug = tail.slice("products/".length).trim();
    if (slug) return { kind: "pdp", slug };
  }
  return { kind: "cms", slug: tail };
}

interface StoreProduct {
  product_id: string;
  slug: string;
  name: string;
  brand: string | null;
  primary_image: string | null;
}

interface StoreVariant {
  variant_id: string;
  sku: string;
  variation_label: string | null;
  variation_values?: Record<string, unknown>;
  available_stock: number;
  unit_price: string;
}

interface StoreProductDetail {
  slug: string;
  name: string;
  brand: string | null;
  description: string | null;
  variation_axes?: string[];
  product_images?: string[];
  variants: StoreVariant[];
}

interface PublishedPageSummary {
  slug: string;
  title: string;
  seo_title: string | null;
  updated_at: string;
}

interface CartLineLocal {
  variant_id: string;
  qty: number;
}

interface CartResolvedLine {
  variant_id: string;
  qty: number;
  product_slug: string;
  product_name: string;
  sku: string;
  variation_label: string | null;
  unit_price: string;
  line_total: string;
  available_stock: number;
  primary_image: string | null;
}

interface StoreShipToForm {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface StoreShippingRateRow {
  rate_quote_id: string;
  amount_usd: string | number;
  carrier: string;
  service_name: string;
  estimated_days?: string | null;
}

interface CheckoutProviderReadiness {
  provider: "stripe" | "helcim";
  enabled: boolean;
  label: string;
  detail: string;
  missing_config: string[];
}

interface CheckoutConfigResponse {
  web_checkout_enabled: boolean;
  default_provider: "stripe" | "helcim";
  providers: CheckoutProviderReadiness[];
  stripe_public_key?: string | null;
}

interface CheckoutSessionResponse {
  id: string;
  status: string;
  selected_provider: "stripe" | "helcim";
  subtotal_usd: string;
  discount_usd: string;
  tax_usd: string;
  shipping_usd: string;
  total_usd: string;
  finalized_transaction_id?: string | null;
  lines?: unknown;
  coupon_code?: string | null;
}

interface CheckoutPaymentResponse {
  checkout_session_id: string;
  provider: "stripe" | "helcim";
  status: string;
  amount_cents: number;
  provider_payment_id?: string | null;
  client_secret?: string | null;
  checkout_token?: string | null;
  hosted_payment_url?: string | null;
  message?: string | null;
}

interface CheckoutConfirmResponse {
  checkout_session_id: string;
  provider: "stripe" | "helcim";
  status: string;
  transaction_id?: string | null;
  transaction_display_id?: string | null;
}

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string, allowExit?: boolean) => void;
  }
}

const SHIP_TO_STORAGE_KEY = "ros.store.shipTo.v1";
const CART_SESSION_STORAGE_KEY = "ros.store.cartSessionId.v1";
const FULFILLMENT_STORAGE_KEY = "ros.store.fulfillment.v1";
const STORE_ACCOUNT_JWT_KEY = "ros.store.customerJwt.v1";
const SHIPPING_QUOTE_STORAGE_KEY = "ros.store.shippingQuoteId.v1";
const CHECKOUT_COUPON_STORAGE_KEY = "ros.store.checkoutCoupon.v1";

function readStoreAccountJwt(): string | null {
  try {
    return window.localStorage.getItem(STORE_ACCOUNT_JWT_KEY);
  } catch {
    return null;
  }
}

function writeStoreAccountJwt(token: string | null) {
  try {
    if (token) window.localStorage.setItem(STORE_ACCOUNT_JWT_KEY, token);
    else window.localStorage.removeItem(STORE_ACCOUNT_JWT_KEY);
  } catch {
    /* ignore */
  }
}

type StoreFulfillmentMode = "ship" | "store_pickup";

function readStoredFulfillment(): StoreFulfillmentMode {
  try {
    const r = window.localStorage.getItem(FULFILLMENT_STORAGE_KEY);
    if (r === "store_pickup") return "store_pickup";
  } catch {
    /* ignore */
  }
  return "ship";
}

function variationStringValues(
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

function variantsMatchingSelection(
  variants: StoreVariant[],
  sel: Record<string, string | undefined>,
): StoreVariant[] {
  return variants.filter((v) => {
    const vv = variationStringValues(
      v.variation_values as Record<string, unknown> | undefined,
    );
    for (const [axis, val] of Object.entries(sel)) {
      if (val === undefined || val === "") continue;
      if (vv[axis] !== val) return false;
    }
    return true;
  });
}

function optionsForAxis(
  axis: string,
  variants: StoreVariant[],
  sel: Record<string, string | undefined>,
): string[] {
  const partial = { ...sel };
  delete partial[axis];
  const compat = variantsMatchingSelection(variants, partial);
  const s = new Set<string>();
  for (const v of compat) {
    const vv = variationStringValues(
      v.variation_values as Record<string, unknown> | undefined,
    );
    const val = vv[axis];
    if (val) s.add(val);
  }
  return [...s].sort();
}

function axisValueInStock(
  axis: string,
  value: string,
  variants: StoreVariant[],
  sel: Record<string, string | undefined>,
): boolean {
  const test = { ...sel, [axis]: value };
  return variantsMatchingSelection(variants, test).some(
    (v) => v.available_stock > 0,
  );
}

async function syncStoreCartSession(lines: CartLineLocal[]): Promise<void> {
  try {
    const sessionId = window.localStorage.getItem(CART_SESSION_STORAGE_KEY);
    if (lines.length === 0) {
      if (sessionId) {
        await fetch(
          apiUrl(API_BASE, `/api/store/cart/session/${sessionId}`),
          { method: "DELETE" },
        );
        window.localStorage.removeItem(CART_SESSION_STORAGE_KEY);
      }
      return;
    }
    const body = {
      lines: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
    };
    if (!sessionId) {
      const res = await fetch(apiUrl(API_BASE, "/api/store/cart/session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const j = (await res.json()) as { cart_id?: string };
        if (j.cart_id) {
          window.localStorage.setItem(CART_SESSION_STORAGE_KEY, j.cart_id);
        }
      }
      return;
    }
    const res = await fetch(
      apiUrl(API_BASE, `/api/store/cart/session/${sessionId}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 404) {
      window.localStorage.removeItem(CART_SESSION_STORAGE_KEY);
      const res2 = await fetch(apiUrl(API_BASE, "/api/store/cart/session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res2.ok) {
        const j2 = (await res2.json()) as { cart_id?: string };
        if (j2.cart_id) {
          window.localStorage.setItem(CART_SESSION_STORAGE_KEY, j2.cart_id);
        }
      }
    }
  } catch {
    /* offline */
  }
}

async function hydrateCartFromSession(): Promise<CartLineLocal[] | null> {
  const sessionId = window.localStorage.getItem(CART_SESSION_STORAGE_KEY);
  if (!sessionId) return null;
  try {
    const res = await fetch(
      apiUrl(API_BASE, `/api/store/cart/session/${sessionId}`),
    );
    if (res.status === 404) {
      window.localStorage.removeItem(CART_SESSION_STORAGE_KEY);
      return null;
    }
    if (!res.ok) return null;
    const j = (await res.json()) as {
      lines?: Array<{ variant_id: string; qty: number }>;
    };
    if (!Array.isArray(j.lines)) return null;
    return j.lines.map((l) => ({
      variant_id: l.variant_id,
      qty: l.qty,
    }));
  } catch {
    return null;
  }
}

function parseMoney(s: string | number | undefined): number {
  if (s === undefined || s === null) return 0;
  const n = typeof s === "number" ? s : Number.parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function shipToKey(s: StoreShipToForm): string {
  return [
    s.name.trim(),
    s.street1.trim(),
    s.city.trim(),
    s.state.trim(),
    s.zip.trim(),
    s.country.trim().toUpperCase() || "US",
  ].join("|");
}

export default function PublicStorefront() {
  return (
    <QueryClientProvider client={storefrontQueryClient}>
      <PublicStorefrontShell />
    </QueryClientProvider>
  );
}

function PublicStorefrontShell() {
  const { toast } = useToast();
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname),
  );
  const [storeJwt, setStoreJwt] = useState<string | null>(() =>
    typeof window !== "undefined" ? readStoreAccountJwt() : null,
  );

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    const next = path.startsWith("/") ? path : `/shop/${path}`;
    window.history.pushState({}, "", next);
    setRoute(parseRoute(next));
  }, []);

  const onStoreAuthChange = useCallback(() => {
    setStoreJwt(readStoreAccountJwt());
  }, []);

  return (
    <div
      data-storefront="true"
      className="min-h-screen bg-storefront-background text-storefront-foreground"
    >
      <header className="border-b border-storefront-border bg-storefront-card px-4 py-4 shadow-sm">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            className="h-auto px-0 text-left text-lg font-black uppercase italic tracking-tight text-storefront-foreground hover:text-storefront-primary"
            type="button"
            onClick={() => navigate("/shop")}
          >
            Shop
          </Button>
          <nav className="flex flex-wrap items-center gap-1 text-[10px] font-black uppercase tracking-widest text-storefront-muted-foreground">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-storefront-muted-foreground"
              onClick={() => navigate("/shop/products")}
            >
              Products
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-storefront-muted-foreground"
              onClick={() => navigate("/shop/cart")}
            >
              Cart
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-storefront-muted-foreground"
              onClick={() => navigate("/shop/account")}
            >
              {storeJwt ? "Account" : "Sign in"}
            </Button>
            <Button variant="link" size="sm" className="text-[10px]" asChild>
              <a href="/">Staff app</a>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <StorefrontBody
          route={route}
          navigate={navigate}
          toast={toast}
          storeJwt={storeJwt}
          onStoreAuthChange={onStoreAuthChange}
        />
      </main>
    </div>
  );
}

interface StoreAccountMe {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  customer_created_source: string;
}

interface StoreAccountOrderDetail {
  order_id: string;
  booked_at: string;
  status: string;
  sale_channel: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  fulfillment_method: string;
  ship_to?: unknown;
  shipping_amount_usd?: string | null;
  tracking_number?: string | null;
  tracking_url_provider?: string | null;
  payment_methods_summary: string;
  primary_salesperson_name?: string | null;
  financial_summary: {
    total_allocated_payments: string;
    total_applied_deposit_amount: string;
  };
  items: Array<{
    product_name: string;
    sku: string;
    variation_label?: string | null;
    quantity: number;
    quantity_returned: number;
    unit_price: string;
    state_tax: string;
    local_tax: string;
    fulfillment: string;
    is_fulfilled: boolean;
    salesperson_name?: string | null;
  }>;
}

interface StoreAccountOrderRow {
  order_id: string;
  booked_at: string;
  status: string;
  sale_channel?: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  item_count: number;
  primary_salesperson_name: string | null;
}

function StoreAccountOrderDetailCard({
  detail,
  saleChannelLabel,
}: {
  detail: StoreAccountOrderDetail;
  saleChannelLabel: (ch: string | undefined) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm">
          Order {detail.order_id.slice(0, 8)}…
        </CardTitle>
        <CardDescription>
          {new Date(detail.booked_at).toLocaleString()} ·{" "}
          {saleChannelLabel(detail.sale_channel)} · {detail.fulfillment_method}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 font-mono text-xs sm:grid-cols-3">
          <div>Total ${parseMoney(detail.total_price).toFixed(2)}</div>
          <div>Paid ${parseMoney(detail.amount_paid).toFixed(2)}</div>
          <div>Balance ${parseMoney(detail.balance_due).toFixed(2)}</div>
        </div>
        {detail.primary_salesperson_name ? (
          <div className="text-xs text-storefront-muted-foreground">
            Salesperson: {detail.primary_salesperson_name}
          </div>
        ) : null}
        {detail.tracking_number ? (
          <div className="text-xs">
            <span className="text-storefront-muted-foreground">Tracking: </span>
            {detail.tracking_url_provider ? (
              <a
                href={detail.tracking_url_provider}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-storefront-primary underline"
              >
                {detail.tracking_number}
              </a>
            ) : (
              detail.tracking_number
            )}
          </div>
        ) : null}
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="border-b border-storefront-border text-[10px] font-black uppercase tracking-widest text-storefront-muted-foreground">
              <tr>
                <th className="py-2 pr-2">Item</th>
                <th className="py-2 pr-2">SKU</th>
                <th className="py-2 pr-2 text-right">Qty</th>
                <th className="py-2 text-right">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-storefront-border">
              {detail.items.map((it, idx) => (
                <tr key={`${detail.order_id}-${idx}-${it.sku}`}>
                  <td className="py-2 pr-2">
                    {it.product_name}
                    {it.variation_label ? (
                      <span className="block text-storefront-muted-foreground">
                        {it.variation_label}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 font-mono">{it.sku}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {it.quantity}
                    {it.quantity_returned > 0
                      ? ` (−${it.quantity_returned} ret.)`
                      : ""}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    ${parseMoney(it.unit_price).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-storefront-muted-foreground">
          Payments: {detail.payment_methods_summary}
        </p>
      </CardContent>
    </Card>
  );
}

function StoreAccountSection({
  view,
  orderId,
  navigate,
  toast,
  storeJwt,
  onStoreAuthChange,
}: {
  view: StoreAccountView;
  orderId?: string;
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
  storeJwt: string | null;
  onStoreAuthChange: () => void;
}) {
  const jwt = storeJwt ?? readStoreAccountJwt();
  const [me, setMe] = useState<StoreAccountMe | null>(null);
  const [meLoading, setMeLoading] = useState(false);
  const [orders, setOrders] = useState<StoreAccountOrderRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderDetail, setOrderDetail] = useState<StoreAccountOrderDetail | null>(null);
  const [orderDetailLoading, setOrderDetailLoading] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [profileDraft, setProfileDraft] = useState<Partial<StoreAccountMe> | null>(null);

  const loadMeAndOrders = useCallback(async () => {
    const t = readStoreAccountJwt();
    if (!t) {
      setMe(null);
      setOrders([]);
      return;
    }
    setMeLoading(true);
    setOrdersLoading(true);
    try {
      const [meRes, ordRes] = await Promise.all([
        fetch(apiUrl(API_BASE, "/api/store/account/me"), {
          headers: { Authorization: `Bearer ${t}` },
        }),
        fetch(apiUrl(API_BASE, "/api/store/account/orders?limit=50"), {
          headers: { Authorization: `Bearer ${t}` },
        }),
      ]);
      if (meRes.ok) {
        setMe((await meRes.json()) as StoreAccountMe);
      } else {
        setMe(null);
        if (meRes.status === 401) {
          writeStoreAccountJwt(null);
          onStoreAuthChange();
        }
      }
      if (ordRes.ok) {
        const data = (await ordRes.json()) as {
          items?: StoreAccountOrderRow[];
        };
        setOrders(Array.isArray(data.items) ? data.items : []);
      } else {
        setOrders([]);
      }
    } catch {
      setMe(null);
      setOrders([]);
    } finally {
      setMeLoading(false);
      setOrdersLoading(false);
    }
  }, [onStoreAuthChange]);

  useEffect(() => {
    if (view === "home" && jwt) void loadMeAndOrders();
  }, [view, jwt, loadMeAndOrders]);

  useEffect(() => {
    if (view !== "order" || !orderId || !jwt) {
      setOrderDetail(null);
      return;
    }
    let cancelled = false;
    setOrderDetailLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          apiUrl(API_BASE, `/api/store/account/orders/${orderId}`),
          { headers: { Authorization: `Bearer ${jwt}` } },
        );
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!res.ok) {
          if (!cancelled) {
            setOrderDetail(null);
            if (res.status === 401) {
              writeStoreAccountJwt(null);
              onStoreAuthChange();
              toast("Session expired. Sign in again.", "error");
              navigate("/shop/account");
            } else {
              toast(j.error ?? "Could not load order.", "error");
            }
          }
          return;
        }
        if (!cancelled) setOrderDetail(j as StoreAccountOrderDetail);
      } catch {
        if (!cancelled) {
          setOrderDetail(null);
          toast("Could not load order.", "error");
        }
      } finally {
        if (!cancelled) setOrderDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, orderId, jwt, navigate, onStoreAuthChange, toast]);

  useEffect(() => {
    if (me) {
      setProfileDraft({
        first_name: me.first_name,
        last_name: me.last_name,
        company_name: me.company_name,
        phone: me.phone,
        address_line1: me.address_line1,
        address_line2: me.address_line2,
        city: me.city,
        state: me.state,
        postal_code: me.postal_code,
      });
    }
  }, [me]);

  const saleChannelLabel = (ch: string | undefined) => {
    if (ch === "web") return "Web";
    if (ch === "register") return "Store";
    return ch ?? "—";
  };

  if (view === "login") {
    return (
      <StoreAccountLoginForm
        navigate={navigate}
        toast={toast}
        onStoreAuthChange={onStoreAuthChange}
      />
    );
  }
  if (view === "register") {
    return (
      <StoreAccountRegisterForm
        navigate={navigate}
        toast={toast}
        onStoreAuthChange={onStoreAuthChange}
      />
    );
  }
  if (view === "link") {
    return (
      <StoreAccountLinkForm
        navigate={navigate}
        toast={toast}
        onStoreAuthChange={onStoreAuthChange}
      />
    );
  }

  if (view === "order") {
    if (!jwt) {
      return (
        <div className="mx-auto max-w-md space-y-4">
          <p className="text-sm text-storefront-muted-foreground">
            Sign in to view order details.
          </p>
          <Button type="button" onClick={() => navigate("/shop/account/login")}>
            Sign in
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/shop/account")}
        >
          Back to account
        </Button>
        {orderDetailLoading ? (
          <p className="text-sm text-storefront-muted-foreground">Loading order…</p>
        ) : orderDetail ? (
          <StoreAccountOrderDetailCard
            detail={orderDetail}
            saleChannelLabel={saleChannelLabel}
          />
        ) : (
          <p className="text-sm text-storefront-muted-foreground">Order not found.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-black uppercase italic tracking-tight">
          Your account
        </h1>
        <p className="mt-2 text-sm text-storefront-muted-foreground">
          Same customer record as in-store. Link a password if we already have
          your email, or register to create a new profile.
        </p>
      </div>

      {!jwt ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Sign in</CardTitle>
              <CardDescription>Email and password</CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" onClick={() => navigate("/shop/account/login")}>
                Sign in
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">New customer</CardTitle>
              <CardDescription>Create an online profile</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate("/shop/account/register")}
              >
                Register
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Link password</CardTitle>
              <CardDescription>Email already on file at the store</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate("/shop/account/link")}
              >
                Set password
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Profile</CardTitle>
                <CardDescription>
                  {meLoading ? "Loading…" : me ? me.email ?? "—" : "—"}
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  writeStoreAccountJwt(null);
                  onStoreAuthChange();
                  setMe(null);
                  setOrders([]);
                  toast("Signed out.", "info");
                }}
              >
                Sign out
              </Button>
            </CardHeader>
            {me && profileDraft ? (
              <CardContent className="space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  {me.customer_created_source === "online_store" ? (
                    <Badge variant="secondary" className="text-[10px]">
                      Online signup
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      Store / import
                    </Badge>
                  )}
                </div>
                <div>
                  <span className="text-storefront-muted-foreground">Customer code: </span>
                  <span className="font-mono">{me.customer_code}</span>
                </div>
                <div>
                  <span className="text-storefront-muted-foreground">Email (sign-in): </span>
                  {me.email ?? "—"}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="sa-fn">First name</Label>
                    <Input
                      id="sa-fn"
                      value={profileDraft.first_name ?? ""}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, first_name: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sa-ln">Last name</Label>
                    <Input
                      id="sa-ln"
                      value={profileDraft.last_name ?? ""}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, last_name: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sa-co">Company (optional)</Label>
                  <Input
                    id="sa-co"
                    value={profileDraft.company_name ?? ""}
                    onChange={(e) =>
                      setProfileDraft((d) => ({ ...d, company_name: e.target.value || null }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sa-ph">Phone</Label>
                  <Input
                    id="sa-ph"
                    type="tel"
                    value={profileDraft.phone ?? ""}
                    onChange={(e) =>
                      setProfileDraft((d) => ({ ...d, phone: e.target.value || null }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sa-a1">Address line 1</Label>
                  <Input
                    id="sa-a1"
                    value={profileDraft.address_line1 ?? ""}
                    onChange={(e) =>
                      setProfileDraft((d) => ({ ...d, address_line1: e.target.value || null }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sa-a2">Address line 2</Label>
                  <Input
                    id="sa-a2"
                    value={profileDraft.address_line2 ?? ""}
                    onChange={(e) =>
                      setProfileDraft((d) => ({ ...d, address_line2: e.target.value || null }))
                    }
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="sa-city">City</Label>
                    <Input
                      id="sa-city"
                      value={profileDraft.city ?? ""}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, city: e.target.value || null }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sa-st">State</Label>
                    <Input
                      id="sa-st"
                      value={profileDraft.state ?? ""}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, state: e.target.value || null }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sa-zip">Postal code</Label>
                    <Input
                      id="sa-zip"
                      value={profileDraft.postal_code ?? ""}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, postal_code: e.target.value || null }))
                      }
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  disabled={profileBusy}
                  onClick={() => {
                    void (async () => {
                      const t = readStoreAccountJwt();
                      if (!t || !profileDraft) return;
                      setProfileBusy(true);
                      try {
                        const res = await fetch(apiUrl(API_BASE, "/api/store/account/me"), {
                          method: "PATCH",
                          headers: {
                            Authorization: `Bearer ${t}`,
                            "Content-Type": "application/json",
                          },
                          body: JSON.stringify({
                            first_name: profileDraft.first_name ?? undefined,
                            last_name: profileDraft.last_name ?? undefined,
                            company_name: profileDraft.company_name ?? undefined,
                            phone: profileDraft.phone ?? undefined,
                            address_line1: profileDraft.address_line1 ?? undefined,
                            address_line2: profileDraft.address_line2 ?? undefined,
                            city: profileDraft.city ?? undefined,
                            state: profileDraft.state ?? undefined,
                            postal_code: profileDraft.postal_code ?? undefined,
                          }),
                        });
                        const j = (await res.json().catch(() => ({}))) as {
                          error?: string;
                        };
                        if (res.status === 429) {
                          toast(j.error ?? "Too many requests.", "error");
                          return;
                        }
                        if (!res.ok) {
                          toast(j.error ?? "Could not save profile.", "error");
                          return;
                        }
                        setMe(j as StoreAccountMe);
                        toast("Profile saved.", "success");
                      } finally {
                        setProfileBusy(false);
                      }
                    })();
                  }}
                >
                  {profileBusy ? "Saving…" : "Save profile"}
                </Button>

                <Separator className="my-2" />
                <p className="text-[11px] font-black uppercase tracking-widest text-storefront-muted-foreground">
                  Change password
                </p>
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    void (async () => {
                      const t = readStoreAccountJwt();
                      if (!t) return;
                      setPwBusy(true);
                      try {
                        const res = await fetch(
                          apiUrl(API_BASE, "/api/store/account/password"),
                          {
                            method: "POST",
                            headers: {
                              Authorization: `Bearer ${t}`,
                              "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                              current_password: pwCurrent,
                              new_password: pwNew,
                            }),
                          },
                        );
                        const j = (await res.json().catch(() => ({}))) as {
                          error?: string;
                        };
                        if (res.status === 429) {
                          toast(j.error ?? "Too many requests.", "error");
                          return;
                        }
                        if (!res.ok) {
                          toast(j.error ?? "Could not update password.", "error");
                          return;
                        }
                        setPwCurrent("");
                        setPwNew("");
                        toast("Password updated.", "success");
                      } finally {
                        setPwBusy(false);
                      }
                    })();
                  }}
                  className="space-y-4"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="sa-pw-cur">Current password</Label>
                      <Input
                        id="sa-pw-cur"
                        type="password"
                        autoComplete="current-password"
                        value={pwCurrent}
                        onChange={(e) => setPwCurrent(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sa-pw-new">New password (min 8)</Label>
                      <Input
                        id="sa-pw-new"
                        type="password"
                        autoComplete="new-password"
                        value={pwNew}
                        onChange={(e) => setPwNew(e.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={pwBusy}
                  >
                    {pwBusy ? "Updating…" : "Update password"}
                  </Button>
                </form>
              </CardContent>
            ) : null}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order history</CardTitle>
              <CardDescription>
                In-store and web purchases on your customer record
              </CardDescription>
            </CardHeader>
            <CardContent>
              {ordersLoading ? (
                <p className="text-sm text-storefront-muted-foreground">Loading orders…</p>
              ) : orders.length === 0 ? (
                <p className="text-sm text-storefront-muted-foreground">No orders yet.</p>
              ) : (
                <div className="w-full overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="border-b border-storefront-border text-[10px] font-black uppercase tracking-widest text-storefront-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Date</th>
                        <th className="py-2 pr-3">Channel</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3 text-right">Total</th>
                        <th className="py-2 pl-2 text-right" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-storefront-border">
                      {orders.map((row) => (
                        <tr key={row.order_id}>
                          <td className="py-2 pr-3 text-xs text-storefront-muted-foreground">
                            {new Date(row.booked_at).toLocaleString()}
                          </td>
                          <td className="py-2 pr-3 text-xs">
                            {saleChannelLabel(row.sale_channel)}
                          </td>
                          <td className="py-2 pr-3 text-xs font-semibold">{row.status}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">
                            ${parseMoney(row.total_price).toFixed(2)}
                          </td>
                          <td className="py-2 pl-2 text-right">
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-[10px] font-black uppercase"
                              onClick={() =>
                                navigate(`/shop/account/orders/${row.order_id}`)
                              }
                            >
                              Details
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function StoreAccountLoginForm({
  navigate,
  toast,
  onStoreAuthChange,
}: {
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
  onStoreAuthChange: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/shop/account")}>
        Back
      </Button>
      <h1 className="text-2xl font-black uppercase italic tracking-tight">Sign in</h1>
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            setBusy(true);
            try {
              const res = await fetch(apiUrl(API_BASE, "/api/store/account/login"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
              });
              const j = (await res.json().catch(() => ({}))) as {
                error?: string;
                code?: string;
                token?: string;
              };
              if (!res.ok) {
                if (res.status === 429) {
                  toast(j.error ?? "Too many requests.", "error");
                  return;
                }
                if (j.code === "needs_activate") {
                  toast(
                    "Use Link password if we already have your email on file.",
                    "info",
                  );
                } else {
                  toast(j.error ?? "Sign-in failed.", "error");
                }
                return;
              }
              if (j.token) {
                writeStoreAccountJwt(j.token);
                onStoreAuthChange();
                toast("Signed in.", "success");
                navigate("/shop/account");
              }
            } finally {
              setBusy(false);
            }
          })();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="sa-login-email">Email</Label>
          <Input
            id="sa-login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sa-login-password">Password</Label>
          <Input
            id="sa-login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={busy}
          className="w-full"
        >
          {busy ? "…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function StoreAccountRegisterForm({
  navigate,
  toast,
  onStoreAuthChange,
}: {
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
  onStoreAuthChange: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/shop/account")}>
        Back
      </Button>
      <h1 className="text-2xl font-black uppercase italic tracking-tight">Register</h1>
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            setBusy(true);
            try {
              const res = await fetch(apiUrl(API_BASE, "/api/store/account/register"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email,
                  password,
                  first_name: firstName,
                  last_name: lastName,
                  phone: phone.trim() ? phone : null,
                }),
              });
              const j = (await res.json().catch(() => ({}))) as {
                error?: string;
                code?: string;
                token?: string;
              };
              if (!res.ok) {
                if (res.status === 429) {
                  toast(j.error ?? "Too many requests.", "error");
                  return;
                }
                toast(j.error ?? "Registration failed.", "error");
                if (j.code === "use_activate") navigate("/shop/account/link");
                return;
              }
              if (j.token) {
                writeStoreAccountJwt(j.token);
                onStoreAuthChange();
                toast("Account created.", "success");
                navigate("/shop/account");
              }
            } finally {
              setBusy(false);
            }
          })();
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sa-reg-fn">First name</Label>
            <Input
              id="sa-reg-fn"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sa-reg-ln">Last name</Label>
            <Input
              id="sa-reg-ln"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sa-reg-email">Email</Label>
          <Input
            id="sa-reg-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sa-reg-phone">Phone (optional)</Label>
          <Input
            id="sa-reg-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sa-reg-pw">Password (min 8 characters)</Label>
          <Input
            id="sa-reg-pw"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={busy}
          className="w-full"
        >
          {busy ? "…" : "Create account"}
        </Button>
      </form>
    </div>
  );
}

function StoreAccountLinkForm({
  navigate,
  toast,
  onStoreAuthChange,
}: {
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
  onStoreAuthChange: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/shop/account")}>
        Back
      </Button>
      <h1 className="text-2xl font-black uppercase italic tracking-tight">Link password</h1>
      <p className="text-sm text-storefront-muted-foreground">
        Use the same email we have on your in-store customer profile. This creates online sign-in
        without duplicating your record.
      </p>
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            setBusy(true);
            try {
              const res = await fetch(apiUrl(API_BASE, "/api/store/account/activate"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
              });
              const j = (await res.json().catch(() => ({}))) as {
                error?: string;
                code?: string;
                token?: string;
              };
              if (!res.ok) {
                if (res.status === 429) {
                  toast(j.error ?? "Too many requests.", "error");
                  return;
                }
                toast(j.error ?? "Could not link password.", "error");
                if (j.code === "use_login") navigate("/shop/account/login");
                return;
              }
              if (j.token) {
                writeStoreAccountJwt(j.token);
                onStoreAuthChange();
                toast("Online access enabled.", "success");
                navigate("/shop/account");
              }
            } finally {
              setBusy(false);
            }
          })();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="sa-link-email">Email</Label>
          <Input
            id="sa-link-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sa-link-pw">New password (min 8 characters)</Label>
          <Input
            id="sa-link-pw"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={busy}
          className="w-full"
        >
          {busy ? "…" : "Save password"}
        </Button>
      </form>
    </div>
  );
}

function StorefrontBody({
  route,
  navigate,
  toast,
  storeJwt,
  onStoreAuthChange,
}: {
  route: Route;
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
  storeJwt: string | null;
  onStoreAuthChange: () => void;
}) {
  if (route.kind === "account") {
    return (
      <StoreAccountSection
        view={route.view}
        orderId={route.orderId}
        navigate={navigate}
        toast={toast}
        storeJwt={storeJwt}
        onStoreAuthChange={onStoreAuthChange}
      />
    );
  }
  if (route.kind === "landing") {
    return <LandingPage navigate={navigate} />;
  }
  if (route.kind === "cms") {
    return <CmsPage slug={route.slug} />;
  }
  if (route.kind === "plp") {
    return <ProductList navigate={navigate} toast={toast} />;
  }
  if (route.kind === "pdp") {
    return (
      <ProductDetail slug={route.slug} navigate={navigate} toast={toast} />
    );
  }
  if (route.kind === "checkout") {
    return <CheckoutPane navigate={navigate} toast={toast} />;
  }
  if (route.kind === "checkout-complete") {
    return (
      <CheckoutCompletePane
        sessionId={route.sessionId}
        navigate={navigate}
        toast={toast}
      />
    );
  }
  return <CartPane navigate={navigate} toast={toast} />;
}

function LandingPage({ navigate }: { navigate: (p: string) => void }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["store-published-pages"],
    queryFn: async () => {
      const res = await fetch(apiUrl(API_BASE, "/api/store/pages"));
      if (!res.ok) throw new Error("pages");
      return res.json() as Promise<{ pages?: PublishedPageSummary[] }>;
    },
  });
  const pages = data?.pages ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-black uppercase italic tracking-tight">
          Riverside storefront
        </h1>
        <p className="mt-2 max-w-xl text-sm text-storefront-muted-foreground">
          Browse published styles with live inventory, explore marketing pages,
          or open the product catalog.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => navigate("/shop/products")}>
            View products
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/shop/cart")}
          >
            Cart
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-black uppercase tracking-widest text-storefront-muted-foreground">
            Marketing pages
          </h2>
          {isPending ? <Skeleton className="h-4 w-24" /> : null}
        </div>
        {isError ? (
          <p className="text-sm text-storefront-muted-foreground">
            Could not load page list.
          </p>
        ) : isPending ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : pages.length === 0 ? (
          <p className="text-sm text-storefront-muted-foreground">
            No published pages yet. Create them in Settings → Online store.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {pages.map((p) => (
              <li key={p.slug}>
                <Card className="h-full transition hover:border-storefront-primary/40">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{p.title}</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      /shop/{p.slug}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        navigate(`/shop/${encodeURIComponent(p.slug)}`)
                      }
                    >
                      Open page
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CmsPage({ slug }: { slug: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["store-published-page", slug],
    queryFn: async () => {
      const res = await fetch(
        apiUrl(API_BASE, `/api/store/pages/${encodeURIComponent(slug)}`),
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("page");
      return res.json() as Promise<{ html?: string; title?: string }>;
    },
  });

  if (isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3 max-w-md" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-storefront-muted-foreground">
        Could not load this page.
      </p>
    );
  }
  if (!data || (typeof data.html === "string" && data.html === "")) {
    return (
      <p className="text-sm text-storefront-muted-foreground">
        Page not found.
      </p>
    );
  }

  const title =
    typeof data.title === "string" && data.title ? data.title : slug;
  const html = typeof data.html === "string" ? data.html : "";

  return (
    <article className="prose prose-sm max-w-none text-storefront-foreground">
      <h1 className="text-xl font-black uppercase tracking-tight">{title}</h1>
      <Separator className="my-4" />
      <div
        className="ros-store-cms mt-4 text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}

function ProductList({
  navigate,
  toast,
}: {
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const [searchDraft, setSearchDraft] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchDraft.trim()), 250);
    return () => window.clearTimeout(t);
  }, [searchDraft]);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["store-products", 60, debouncedSearch],
    queryFn: async () => {
      const sp = new URLSearchParams({ limit: "60" });
      if (debouncedSearch.length > 0) {
        sp.set("search", debouncedSearch);
      }
      const res = await fetch(
        apiUrl(API_BASE, `/api/store/products?${sp.toString()}`),
      );
      if (!res.ok) throw new Error("products");
      return res.json() as Promise<{ products?: StoreProduct[] }>;
    },
  });

  useEffect(() => {
    if (isError) toast("Could not load catalog", "error");
  }, [isError, toast]);

  const items = data?.products ?? [];

  return (
    <div>
      <h1 className="mb-2 text-xl font-black uppercase italic tracking-tight">
        Products
      </h1>
      <p className="mb-6 text-xs text-storefront-muted-foreground">
        Shown when variants are marked <strong>Web store</strong> in Inventory
        and the template has a catalog handle (URL slug).
      </p>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="search"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder="Search by name, brand, or URL slug"
          className="max-w-md bg-storefront-card"
          autoComplete="off"
        />
        {searchDraft.trim().length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSearchDraft("")}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {isError ? (
        <Button type="button" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      ) : null}
      <ul className="grid gap-4 sm:grid-cols-2">
        {isPending
          ? Array.from({ length: 6 }).map((_, i) => (
              <li key={i}>
                <Skeleton className="h-56 w-full rounded-xl" />
              </li>
            ))
          : items.map((p) => (
              <li key={p.product_id}>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/shop/products/${encodeURIComponent(p.slug)}`,
                    )
                  }
                  className="flex w-full flex-col overflow-hidden rounded-xl border border-storefront-border bg-storefront-card text-left shadow-sm transition hover:border-storefront-primary/40"
                >
                  {p.primary_image ? (
                    <img
                      src={p.primary_image}
                      alt=""
                      className="h-40 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-storefront-muted text-[10px] font-bold uppercase text-storefront-muted-foreground">
                      No image
                    </div>
                  )}
                  <div className="p-3">
                    <div className="text-[10px] font-black uppercase tracking-widest text-storefront-muted-foreground">
                      {p.brand ?? "Brand"}
                    </div>
                    <div className="font-bold">{p.name}</div>
                  </div>
                </button>
              </li>
            ))}
      </ul>
      {!isPending && items.length === 0 ? (
        <p className="text-sm text-storefront-muted-foreground">
          {debouncedSearch.length > 0
            ? "No products match that search."
            : "No products published yet."}
        </p>
      ) : null}
    </div>
  );
}

function ProductDetail({
  slug,
  navigate,
  toast,
}: {
  slug: string;
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const { data, isPending, isError, refetch } = useQuery<
    StoreProductDetail | null
  >({
    queryKey: ["store-product", slug],
    queryFn: async () => {
      const res = await fetch(
        apiUrl(API_BASE, `/api/store/products/${encodeURIComponent(slug)}`),
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("detail");
      return res.json() as Promise<StoreProductDetail>;
    },
  });

  const [pick, setPick] = useState<string | null>(null);
  const [facetSel, setFacetSel] = useState<Record<string, string | undefined>>(
    {},
  );

  const axes = useMemo(() => {
    if (!data) return [] as string[];
    const from = (data.variation_axes ?? []).filter(
      (a) => typeof a === "string" && a.trim() !== "",
    );
    if (from.length) return from;
    const v0 = data.variants[0];
    if (!v0?.variation_values) return [];
    return Object.keys(
      variationStringValues(
        v0.variation_values as Record<string, unknown>,
      ),
    ).sort();
  }, [data]);

  useEffect(() => {
    if (!data) return;
    if (data.variants.length === 1) {
      setPick(data.variants[0]!.variant_id);
      setFacetSel({});
      return;
    }
    setPick(null);
    setFacetSel({});
  }, [data]);

  useEffect(() => {
    if (!data || data.variants.length <= 1) return;
    if (axes.length === 0) return;
    const allPicked = axes.every((a) => Boolean(facetSel[a]));
    if (!allPicked) {
      setPick(null);
      return;
    }
    const matches = variantsMatchingSelection(data.variants, facetSel);
    if (matches.length >= 1) setPick(matches[0]!.variant_id);
    else setPick(null);
  }, [data, facetSel, axes]);

  useEffect(() => {
    if (isError) toast("Could not load product", "error");
  }, [isError, toast]);

  if (isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-3/4 max-w-lg" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (isError) {
    return (
      <Button type="button" variant="outline" onClick={() => void refetch()}>
        Retry
      </Button>
    );
  }
  if (data === null) {
    return (
      <p className="text-sm text-storefront-muted-foreground">
        Product not found.{" "}
        <Button
          variant="link"
          className="h-auto p-0"
          type="button"
          onClick={() => navigate("/shop/products")}
        >
          Back to list
        </Button>
      </p>
    );
  }

  const selected = data.variants.find((v) => v.variant_id === pick);
  const useFacets = axes.length > 0 && data.variants.length > 1;

  return (
    <div>
      <Button
        variant="link"
        className="mb-4 h-auto p-0 text-[10px] font-black uppercase tracking-widest"
        type="button"
        onClick={() => navigate("/shop/products")}
      >
        ← Products
      </Button>
      <h1 className="text-2xl font-black uppercase italic tracking-tight">
        {data.name}
      </h1>
      {data.brand ? (
        <p className="text-xs font-bold uppercase text-storefront-muted-foreground">
          {data.brand}
        </p>
      ) : null}
      {data.description ? (
        <p className="mt-2 text-sm text-storefront-muted-foreground">
          {data.description}
        </p>
      ) : null}

      <div className="mt-6">
        <p className="text-[10px] font-black uppercase tracking-widest text-storefront-muted-foreground">
          {useFacets ? "Choose options" : "Choose size / option"}
        </p>
        {useFacets ? (
          <div className="mt-3 space-y-4">
            {axes.map((axis) => (
              <div key={axis}>
                <p className="text-[9px] font-bold uppercase text-storefront-muted-foreground">
                  {axis}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {optionsForAxis(axis, data.variants, facetSel).map((opt) => {
                    const active = facetSel[axis] === opt;
                    const inStock = axisValueInStock(
                      axis,
                      opt,
                      data.variants,
                      facetSel,
                    );
                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={!inStock}
                        onClick={() =>
                          setFacetSel((s) => ({ ...s, [axis]: opt }))
                        }
                        className={`rounded-lg border px-3 py-2 text-left text-xs font-bold transition ${
                          active
                            ? "border-storefront-primary bg-storefront-primary/10"
                            : "border-storefront-border bg-storefront-card text-storefront-muted-foreground"
                        } ${!inStock ? "opacity-40" : ""}`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {data.variants.map((v) => (
              <button
                key={v.variant_id}
                type="button"
                onClick={() => setPick(v.variant_id)}
                className={`rounded-lg border px-3 py-2 text-left text-xs font-bold transition ${
                  pick === v.variant_id
                    ? "border-storefront-primary bg-storefront-primary/10"
                    : "border-storefront-border bg-storefront-card text-storefront-muted-foreground"
                }`}
              >
                <div>{v.variation_label ?? v.sku}</div>
                <div className="font-mono text-[10px] text-storefront-muted-foreground">
                  Avail {v.available_stock} · ${v.unit_price}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Button
        type="button"
        disabled={!selected || (selected?.available_stock ?? 0) <= 0}
        onClick={() => {
          if (!selected) return;
          const raw = window.localStorage.getItem("ros.store.cart.v1");
          const cart: CartLineLocal[] = raw
            ? (JSON.parse(raw) as CartLineLocal[])
            : [];
          const i = cart.findIndex((l) => l.variant_id === selected.variant_id);
          if (i >= 0) cart[i]!.qty += 1;
          else cart.push({ variant_id: selected.variant_id, qty: 1 });
          window.localStorage.setItem("ros.store.cart.v1", JSON.stringify(cart));
          void syncStoreCartSession(cart);
          toast("Added to cart", "success");
        }}
        className="mt-8 w-full border-b-8 border-emerald-800 bg-emerald-600 py-6 text-sm font-black uppercase tracking-widest text-white shadow-lg hover:bg-emerald-600 disabled:opacity-40"
      >
        Add to cart
      </Button>
    </div>
  );
}

function CartPane({
  navigate,
  toast,
}: {
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<CartLineLocal[]>([]);
  const [coupon, setCoupon] = useState("");
  const [shipTo, setShipTo] = useState<StoreShipToForm>(() => {
    try {
      const raw = window.localStorage.getItem(SHIP_TO_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw) as Partial<StoreShipToForm>;
        return {
          name: String(o.name ?? ""),
          street1: String(o.street1 ?? ""),
          city: String(o.city ?? ""),
          state: String(o.state ?? "NY").toUpperCase().slice(0, 2),
          zip: String(o.zip ?? ""),
          country: String(o.country ?? "US").toUpperCase().slice(0, 2) || "US",
        };
      }
    } catch {
      /* ignore */
    }
    return {
      name: "",
      street1: "",
      city: "",
      state: "NY",
      zip: "",
      country: "US",
    };
  });
  const [preview, setPreview] = useState<{
    sub: string;
    disc: string;
    tax: string;
  } | null>(null);
  const [shipRates, setShipRates] = useState<StoreShippingRateRow[]>([]);
  const [shipRatesStub, setShipRatesStub] = useState(false);
  const [shipRatesLoading, setShipRatesLoading] = useState(false);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [rateAddressKey, setRateAddressKey] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<StoreFulfillmentMode>(() =>
    readStoredFulfillment(),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(SHIP_TO_STORAGE_KEY, JSON.stringify(shipTo));
    } catch {
      /* ignore */
    }
  }, [shipTo]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FULFILLMENT_STORAGE_KEY, fulfillment);
    } catch {
      /* ignore */
    }
    if (fulfillment === "store_pickup") {
      setShipRates([]);
      setSelectedQuoteId(null);
      setRateAddressKey(null);
    }
  }, [fulfillment]);

  useEffect(() => {
    try {
      if (selectedQuoteId) {
        window.localStorage.setItem(SHIPPING_QUOTE_STORAGE_KEY, selectedQuoteId);
      } else {
        window.localStorage.removeItem(SHIPPING_QUOTE_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [selectedQuoteId]);

  useEffect(() => {
    try {
      if (coupon.trim()) {
        window.localStorage.setItem(CHECKOUT_COUPON_STORAGE_KEY, coupon.trim());
      } else {
        window.localStorage.removeItem(CHECKOUT_COUPON_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [coupon]);

  const refreshCart = useCallback(() => {
    const raw = window.localStorage.getItem("ros.store.cart.v1");
    setLines(
      raw ? (JSON.parse(raw) as CartLineLocal[]) : [],
    );
  }, []);

  useEffect(() => {
    void (async () => {
      const serverLines = await hydrateCartFromSession();
      if (serverLines !== null) {
        window.localStorage.setItem(
          "ros.store.cart.v1",
          JSON.stringify(serverLines),
        );
        setLines(serverLines);
        return;
      }
      refreshCart();
    })();
  }, [refreshCart]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void syncStoreCartSession(lines);
    }, 500);
    return () => window.clearTimeout(t);
  }, [lines]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const pr = sp.get("promo");
    if (pr) setCoupon((c) => (c.trim() ? c : pr));
  }, []);

  const linesKey = useMemo(() => JSON.stringify(lines), [lines]);

  const { data: priced, isFetching: pricedLoading } = useQuery({
    queryKey: ["store-cart-lines", linesKey],
    queryFn: async () => {
      const res = await fetch(apiUrl(API_BASE, "/api/store/cart/lines"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      if (!res.ok) throw new Error("resolve");
      return res.json() as Promise<{
        lines?: CartResolvedLine[];
        subtotal?: string;
        missing_variant_ids?: string[];
      }>;
    },
    enabled: lines.length > 0,
  });

  const resolvedLines = priced?.lines ?? [];
  const subtotalStr = priced?.subtotal ?? "0";
  const missing = priced?.missing_variant_ids ?? [];

  const addressKeyLive = shipToKey(shipTo);
  const ratesStale =
    rateAddressKey != null && rateAddressKey !== addressKeyLive;

  const runEstimate = async () => {
    const subUsd =
      lines.length > 0 ? subtotalStr : Math.max(1, lines.length * 25).toFixed(2);
    const ff =
      fulfillment === "store_pickup" ? "store_pickup" : "ship";
    const st =
      fulfillment === "store_pickup"
        ? "NY"
        : shipTo.state.trim().toUpperCase() || "NY";
    const taxRes = await fetch(
      apiUrl(
        API_BASE,
        `/api/store/tax/preview?state=${encodeURIComponent(st)}&subtotal=${encodeURIComponent(subUsd)}&fulfillment=${encodeURIComponent(ff)}`,
      ),
    );
    let taxStr = "0";
    if (taxRes.ok) {
      const tj = (await taxRes.json()) as { tax_estimated?: string };
      taxStr = tj.tax_estimated ?? "0";
    }
    let disc = "0";
    if (coupon.trim()) {
      const cRes = await fetch(apiUrl(API_BASE, "/api/store/cart/coupon"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: coupon.trim(),
          subtotal: subUsd,
        }),
      });
      if (cRes.ok) {
        const cj = (await cRes.json()) as { discount_amount?: string };
        disc = cj.discount_amount ?? "0";
      }
    }
    setPreview({ sub: subUsd, disc, tax: taxStr });
    toast("Estimate updated", "info");
  };

  const fetchShipRates = async () => {
    if (lines.length === 0) {
      toast("Add items to the cart first.", "error");
      return;
    }
    setShipRatesLoading(true);
    setShipRates([]);
    setSelectedQuoteId(null);
    try {
      const res = await fetch(apiUrl(API_BASE, "/api/store/shipping/rates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_address: {
            name: shipTo.name.trim() || "Customer",
            street1: shipTo.street1.trim(),
            city: shipTo.city.trim(),
            state: shipTo.state.trim().toUpperCase(),
            zip: shipTo.zip.trim(),
            country:
              shipTo.country.trim().toUpperCase().slice(0, 2) || "US",
          },
          force_stub: false,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        rates?: StoreShippingRateRow[];
        stub?: boolean;
      };
      if (!res.ok) {
        toast(j.error ?? "Could not get shipping rates", "error");
        return;
      }
      const list = j.rates ?? [];
      setShipRates(list);
      setShipRatesStub(Boolean(j.stub));
      setRateAddressKey(addressKeyLive);
      if (j.stub) {
        toast(
          "Showing demo rates — enable Shippo in staff Settings and set SHIPPO_API_TOKEN for live pricing.",
          "info",
        );
      } else {
        toast(
          list.length
            ? "Shipping rates updated (quotes expire in about 15 minutes)."
            : "No carrier rates returned.",
          list.length ? "success" : "info",
        );
      }
    } catch {
      toast("Network error loading shipping rates", "error");
    } finally {
      setShipRatesLoading(false);
    }
  };

  const removeLine = (variantId: string) => {
    const next = lines.filter((l) => l.variant_id !== variantId);
    window.localStorage.setItem("ros.store.cart.v1", JSON.stringify(next));
    setLines(next);
    void queryClient.invalidateQueries({ queryKey: ["store-cart-lines"] });
  };

  const setQty = (variantId: string, qty: number) => {
    const q = Math.max(1, Math.min(999, qty));
    const next = lines.map((l) =>
      l.variant_id === variantId ? { ...l, qty: q } : l,
    );
    window.localStorage.setItem("ros.store.cart.v1", JSON.stringify(next));
    setLines(next);
    void queryClient.invalidateQueries({ queryKey: ["store-cart-lines"] });
  };

  const selectedRate = shipRates.find((r) => r.rate_quote_id === selectedQuoteId);
  const shipCharge =
    fulfillment === "store_pickup"
      ? 0
      : selectedRate && !ratesStale
        ? parseMoney(selectedRate.amount_usd)
        : 0;
  const estGrand =
    preview != null
      ? Math.max(
          0,
          parseMoney(preview.sub) -
            parseMoney(preview.disc) +
            parseMoney(preview.tax) +
            shipCharge,
        )
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-black uppercase italic tracking-tight">
          Cart
        </h1>
        <p className="mt-1 text-sm text-storefront-muted-foreground">
          {lines.length === 0
            ? "Your cart is empty."
            : `${resolvedLines.length || lines.length} line(s) · server subtotal $${subtotalStr}`}
        </p>
        {missing.length > 0 ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Some items are no longer available online and were skipped in the
            priced total.
          </p>
        ) : null}
      </div>

      {lines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Line items</CardTitle>
            <CardDescription>
              Priced from the live catalog. Payment checkout will use your
              selected shipping quote when that phase ships.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pricedLoading ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : (
              <ul className="space-y-3">
                {resolvedLines.map((row) => (
                  <li
                    key={row.variant_id}
                    className="flex flex-wrap items-start gap-3 rounded-lg border border-storefront-border p-3"
                  >
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-storefront-muted">
                      {row.primary_image ? (
                        <img
                          src={row.primary_image}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold leading-tight">
                        {row.product_name}
                      </div>
                      <div className="text-xs text-storefront-muted-foreground">
                        {row.variation_label ?? row.sku} · ${row.unit_price} ea
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Label className="sr-only" htmlFor={`qty-${row.variant_id}`}>
                          Qty
                        </Label>
                        <Input
                          id={`qty-${row.variant_id}`}
                          type="number"
                          min={1}
                          max={999}
                          className="w-20 font-mono text-xs"
                          value={String(
                            lines.find((l) => l.variant_id === row.variant_id)
                              ?.qty ?? row.qty,
                          )}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isFinite(n)) return;
                            setQty(row.variant_id, n);
                          }}
                        />
                        <Badge variant="outline">${row.line_total}</Badge>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-storefront-destructive"
                          onClick={() => removeLine(row.variant_id)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {lines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fulfillment</CardTitle>
            <CardDescription>
              Choose <strong>In-store pickup</strong> at our New York location or{" "}
              <strong>Ship to address</strong>. Sales tax estimates follow the
              store&apos;s published web tax rules (NY pickup and ship-to NY vs
              out-of-state shipment).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={
                  fulfillment === "store_pickup" ? "default" : "secondary"
                }
                className={
                  fulfillment === "store_pickup"
                    ? "bg-storefront-primary text-storefront-primary-foreground"
                    : ""
                }
                onClick={() => setFulfillment("store_pickup")}
              >
                In-store pickup
              </Button>
              <Button
                type="button"
                variant={fulfillment === "ship" ? "default" : "secondary"}
                className={
                  fulfillment === "ship"
                    ? "bg-storefront-primary text-storefront-primary-foreground"
                    : ""
                }
                onClick={() => setFulfillment("ship")}
              >
                Ship to address
              </Button>
            </div>
            {fulfillment === "store_pickup" ? (
              <p className="rounded-lg border border-storefront-border bg-storefront-muted/40 p-3 text-sm text-storefront-muted-foreground">
                Pick up your order at the store. No shipping charge. New York
                sales tax applies on pickup (possession in NY). Bring your order
                confirmation when you arrive.
              </p>
            ) : null}
            {fulfillment === "ship" ? (
              <>
                <p className="text-xs text-storefront-muted-foreground">
                  Shipping rates use Shippo when configured (staff Settings →
                  Shippo + server{" "}
                  <span className="font-mono">SHIPPO_API_TOKEN</span>
                  ); otherwise demo rates. Quotes expire in about 15 minutes.
                </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="sf-ship-name">Full name</Label>
                <Input
                  id="sf-ship-name"
                  value={shipTo.name}
                  onChange={(e) =>
                    setShipTo((s) => ({ ...s, name: e.target.value }))
                  }
                  autoComplete="name"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="sf-ship-street">Street address</Label>
                <Input
                  id="sf-ship-street"
                  value={shipTo.street1}
                  onChange={(e) =>
                    setShipTo((s) => ({ ...s, street1: e.target.value }))
                  }
                  autoComplete="street-address"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sf-ship-city">City</Label>
                <Input
                  id="sf-ship-city"
                  value={shipTo.city}
                  onChange={(e) =>
                    setShipTo((s) => ({ ...s, city: e.target.value }))
                  }
                  autoComplete="address-level2"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sf-ship-state">State</Label>
                <Input
                  id="sf-ship-state"
                  value={shipTo.state}
                  onChange={(e) =>
                    setShipTo((s) => ({
                      ...s,
                      state: e.target.value.toUpperCase().slice(0, 2),
                    }))
                  }
                  maxLength={2}
                  className="font-mono uppercase"
                  autoComplete="address-level1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sf-ship-zip">ZIP</Label>
                <Input
                  id="sf-ship-zip"
                  value={shipTo.zip}
                  onChange={(e) =>
                    setShipTo((s) => ({ ...s, zip: e.target.value }))
                  }
                  autoComplete="postal-code"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sf-ship-country">Country</Label>
                <Input
                  id="sf-ship-country"
                  value={shipTo.country}
                  onChange={(e) =>
                    setShipTo((s) => ({
                      ...s,
                      country: e.target.value.toUpperCase().slice(0, 2),
                    }))
                  }
                  maxLength={2}
                  className="font-mono uppercase"
                  placeholder="US"
                />
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={shipRatesLoading}
              onClick={() => void fetchShipRates()}
            >
              {shipRatesLoading ? "Fetching rates…" : "Get shipping rates"}
            </Button>
            {ratesStale && shipRates.length > 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Address changed since the last rate request — click &quot;Get
                shipping rates&quot; again before checkout.
              </p>
            ) : null}
            {shipRates.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-storefront-muted-foreground">
                  Choose a service
                  {shipRatesStub ? " (demo)" : ""}
                </p>
                <ul className="space-y-2">
                  {shipRates.map((r) => {
                    const id = r.rate_quote_id;
                    const amt = parseMoney(r.amount_usd);
                    return (
                      <li key={id}>
                        <label
                          className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${
                            selectedQuoteId === id
                              ? "border-storefront-primary bg-storefront-primary/10"
                              : "border-storefront-border bg-storefront-card"
                          } ${ratesStale ? "opacity-50" : ""}`}
                        >
                          <input
                            type="radio"
                            name="ros-store-ship-rate"
                            className="mt-1"
                            checked={selectedQuoteId === id}
                            disabled={ratesStale}
                            onChange={() => setSelectedQuoteId(id)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold">
                              {r.carrier} · {r.service_name}
                            </div>
                            <div className="text-xs text-storefront-muted-foreground">
                              ${amt.toFixed(2)}
                              {r.estimated_days
                                ? ` · est. ${r.estimated_days} day(s)`
                                : null}
                            </div>
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coupon & order estimate</CardTitle>
          <CardDescription>
            Tax follows <strong>fulfillment</strong> (pickup = NY; ship = NY only
            if ship-to state is NY; otherwise no tax collected per store
            policy). Append <span className="font-mono">?promo=CODE</span> to
            the cart URL to pre-fill a coupon.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sf-coupon">Coupon code</Label>
            <Input
              id="sf-coupon"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              placeholder="WELCOME10"
            />
          </div>
          <Button type="button" variant="secondary" onClick={() => void runEstimate()}>
            Update tax & coupon estimate
          </Button>
          {preview ? (
            <div className="mt-2 space-y-1 rounded-lg bg-storefront-muted p-3 font-mono text-[11px] text-storefront-muted-foreground">
              <div>Subtotal: ${parseMoney(preview.sub).toFixed(2)}</div>
              <div>Discount: −${parseMoney(preview.disc).toFixed(2)}</div>
              <div>Est. tax: ${parseMoney(preview.tax).toFixed(2)}</div>
              <div>
                Shipping:{" "}
                {fulfillment === "store_pickup"
                  ? "$0.00 (in-store pickup)"
                  : selectedRate && !ratesStale
                    ? `$${shipCharge.toFixed(2)} (${selectedRate.carrier})`
                    : ratesStale && selectedQuoteId
                      ? "— (refresh rates)"
                      : "— (select a rate above)"}
              </div>
              <div className="border-t border-storefront-border pt-2 font-black text-storefront-foreground">
                Estimated total: $
                {estGrand != null ? estGrand.toFixed(2) : "—"}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Button
        type="button"
        disabled={
          lines.length === 0 ||
          resolvedLines.length === 0 ||
          pricedLoading ||
          (fulfillment === "ship" && (!selectedQuoteId || ratesStale))
        }
        className="w-full border-b-8 border-emerald-800 bg-emerald-600 py-6 text-sm font-black uppercase tracking-widest text-white shadow-lg hover:bg-emerald-600 disabled:opacity-40"
        onClick={() => {
          if (coupon.trim()) {
            window.localStorage.setItem(CHECKOUT_COUPON_STORAGE_KEY, coupon.trim());
          }
          if (selectedQuoteId) {
            window.localStorage.setItem(SHIPPING_QUOTE_STORAGE_KEY, selectedQuoteId);
          }
          navigate("/shop/checkout");
        }}
      >
        Checkout
      </Button>

      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-[10px] font-black uppercase tracking-widest"
        onClick={() => navigate("/shop/products")}
      >
        Continue shopping
      </Button>
    </div>
  );
}

function CheckoutPane({
  navigate,
  toast,
}: {
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const [lines, setLines] = useState<CartLineLocal[]>([]);
  const [contact, setContact] = useState({
    name: "",
    email: "",
    phone: "",
  });
  const [coupon] = useState(() => {
    try {
      return window.localStorage.getItem(CHECKOUT_COUPON_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [fulfillment] = useState<StoreFulfillmentMode>(() =>
    readStoredFulfillment(),
  );
  const [shipTo] = useState<StoreShipToForm>(() => {
    try {
      const raw = window.localStorage.getItem(SHIP_TO_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw) as Partial<StoreShipToForm>;
        return {
          name: String(o.name ?? ""),
          street1: String(o.street1 ?? ""),
          city: String(o.city ?? ""),
          state: String(o.state ?? "NY").toUpperCase().slice(0, 2),
          zip: String(o.zip ?? ""),
          country: String(o.country ?? "US").toUpperCase().slice(0, 2) || "US",
        };
      }
    } catch {
      /* ignore */
    }
    return {
      name: "",
      street1: "",
      city: "",
      state: "NY",
      zip: "",
      country: "US",
    };
  });
  const [selectedQuoteId] = useState(() => {
    try {
      return window.localStorage.getItem(SHIPPING_QUOTE_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [config, setConfig] = useState<CheckoutConfigResponse | null>(null);
  const [provider, setProvider] = useState<"stripe" | "helcim">("stripe");
  const [session, setSession] = useState<CheckoutSessionResponse | null>(null);
  const [payment, setPayment] = useState<CheckoutPaymentResponse | null>(null);
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const serverLines = await hydrateCartFromSession();
      if (serverLines !== null) {
        setLines(serverLines);
        return;
      }
      try {
        const raw = window.localStorage.getItem("ros.store.cart.v1");
        setLines(raw ? (JSON.parse(raw) as CartLineLocal[]) : []);
      } catch {
        setLines([]);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(apiUrl(API_BASE, "/api/store/checkout/config"));
        const json = (await res.json().catch(() => ({}))) as
          | CheckoutConfigResponse
          | { error?: string };
        if (!res.ok) {
          setError("Checkout configuration is unavailable.");
          return;
        }
        const cfg = json as CheckoutConfigResponse;
        setConfig(cfg);
        const defaultProvider =
          cfg.providers.find((p) => p.provider === cfg.default_provider && p.enabled)
            ?.provider ??
          cfg.providers.find((p) => p.enabled)?.provider ??
          cfg.default_provider ??
          "stripe";
        setProvider(defaultProvider);
        if (cfg.stripe_public_key) {
          setStripePromise(loadStripe(cfg.stripe_public_key));
        }
      } catch {
        setError("Checkout configuration is unavailable.");
      }
    })();
  }, []);

  const enabledProviders = config?.providers ?? [];
  const selectedProvider = enabledProviders.find((p) => p.provider === provider);
  const canStart =
    lines.length > 0 &&
    contact.name.trim().length >= 2 &&
    contact.email.includes("@") &&
    Boolean(selectedProvider?.enabled) &&
    (fulfillment === "store_pickup" || Boolean(selectedQuoteId));

  const startCheckout = async () => {
    setBusy(true);
    setError(null);
    setPayment(null);
    try {
      const cartId = window.localStorage.getItem(CART_SESSION_STORAGE_KEY);
      const sessionRes = await fetch(
        apiUrl(API_BASE, "/api/store/checkout/session"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cart_id: cartId || null,
            contact: {
              name: contact.name.trim(),
              email: contact.email.trim(),
              phone: contact.phone.trim() || null,
            },
            lines,
            coupon_code: coupon.trim() || null,
            fulfillment_method:
              fulfillment === "store_pickup" ? "pickup" : "ship",
            ship_to:
              fulfillment === "ship"
                ? {
                    name: shipTo.name || contact.name,
                    street1: shipTo.street1,
                    city: shipTo.city,
                    state: shipTo.state,
                    zip: shipTo.zip,
                    country: shipTo.country || "US",
                  }
                : null,
            shipping_rate_quote_id:
              fulfillment === "ship" ? selectedQuoteId : null,
            selected_provider: provider,
            idempotency_key: `store-checkout-${cartId || ""}-${provider}-${Date.now()}`,
          }),
        },
      );
      const sessionJson = (await sessionRes.json().catch(() => ({}))) as
        | CheckoutSessionResponse
        | { error?: string };
      if (!sessionRes.ok) {
        setError(
          "error" in sessionJson
            ? sessionJson.error ?? "Could not create checkout."
            : "Could not create checkout.",
        );
        return;
      }
      const nextSession = sessionJson as CheckoutSessionResponse;
      setSession(nextSession);

      const paymentRes = await fetch(
        apiUrl(
          API_BASE,
          `/api/store/checkout/session/${nextSession.id}/payment`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        },
      );
      const paymentJson = (await paymentRes.json().catch(() => ({}))) as
        | CheckoutPaymentResponse
        | { error?: string };
      if (!paymentRes.ok) {
        setError(
          "error" in paymentJson
            ? paymentJson.error ?? "Could not start payment."
            : "Could not start payment.",
        );
        return;
      }
      setPayment(paymentJson as CheckoutPaymentResponse);
    } catch {
      setError("Checkout could not be started.");
    } finally {
      setBusy(false);
    }
  };

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-black uppercase italic tracking-tight">
          Checkout
        </h1>
        <p className="text-sm text-storefront-muted-foreground">
          Your cart is empty.
        </p>
        <Button type="button" onClick={() => navigate("/shop/products")}>
          View products
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/shop/cart")}
      >
        Back to cart
      </Button>
      <div>
        <h1 className="text-2xl font-black uppercase italic tracking-tight">
          Checkout
        </h1>
        <p className="mt-1 text-sm text-storefront-muted-foreground">
          ROS recalculates cart, coupon, tax, shipping, and payment provider
          status before payment.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contact</CardTitle>
          <CardDescription>Used for order confirmation and pickup or shipping.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="checkout-name">Full name</Label>
            <Input
              id="checkout-name"
              value={contact.name}
              onChange={(event) =>
                setContact((draft) => ({ ...draft, name: event.target.value }))
              }
              autoComplete="name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="checkout-email">Email</Label>
            <Input
              id="checkout-email"
              type="email"
              value={contact.email}
              onChange={(event) =>
                setContact((draft) => ({ ...draft, email: event.target.value }))
              }
              autoComplete="email"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="checkout-phone">Phone</Label>
            <Input
              id="checkout-phone"
              type="tel"
              value={contact.phone}
              onChange={(event) =>
                setContact((draft) => ({ ...draft, phone: event.target.value }))
              }
              autoComplete="tel"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment provider</CardTitle>
          <CardDescription>
            Stripe and Helcim use the same ROS checkout contract.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {enabledProviders.map((item) => (
              <button
                key={item.provider}
                type="button"
                disabled={!item.enabled || payment != null}
                onClick={() => setProvider(item.provider)}
                className={`rounded-lg border p-3 text-left text-sm ${
                  provider === item.provider
                    ? "border-storefront-primary bg-storefront-primary/10"
                    : "border-storefront-border bg-storefront-card"
                } ${!item.enabled ? "opacity-50" : ""}`}
              >
                <div className="font-black">{item.label}</div>
                <div className="mt-1 text-xs text-storefront-muted-foreground">
                  {item.detail}
                </div>
              </button>
            ))}
          </div>
          {fulfillment === "ship" && !selectedQuoteId ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Select a shipping rate in the cart before checkout.
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-storefront-destructive/30 bg-storefront-destructive/10 p-3 text-sm text-storefront-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={!canStart || busy || payment != null}
            onClick={() => void startCheckout()}
            className="w-full"
          >
            {busy ? "Preparing payment..." : "Review total & start payment"}
          </Button>
        </CardContent>
      </Card>

      {session ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ROS total</CardTitle>
            <CardDescription>
              Server-priced checkout session {session.id.slice(0, 8)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 font-mono text-xs">
            <div>Subtotal: ${parseMoney(session.subtotal_usd).toFixed(2)}</div>
            <div>Discount: -${parseMoney(session.discount_usd).toFixed(2)}</div>
            <div>Tax: ${parseMoney(session.tax_usd).toFixed(2)}</div>
            <div>Shipping: ${parseMoney(session.shipping_usd).toFixed(2)}</div>
            <div className="border-t border-storefront-border pt-2 text-sm font-black">
              Total: ${parseMoney(session.total_usd).toFixed(2)}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {payment?.provider === "stripe" &&
      payment.client_secret &&
      stripePromise ? (
        <Elements
          stripe={stripePromise}
          options={{ clientSecret: payment.client_secret }}
        >
          <CheckoutStripePaymentForm
            payment={payment}
            onComplete={(result) => {
              toast("Payment accepted.", "success");
              window.localStorage.removeItem("ros.store.cart.v1");
              window.localStorage.removeItem(CART_SESSION_STORAGE_KEY);
              window.localStorage.removeItem(SHIPPING_QUOTE_STORAGE_KEY);
              window.localStorage.removeItem(CHECKOUT_COUPON_STORAGE_KEY);
              navigate(
                `/shop/checkout/complete?session=${encodeURIComponent(
                  result.checkout_session_id,
                )}`,
              );
            }}
            onError={(message) => setError(message)}
          />
        </Elements>
      ) : null}

      {payment?.provider === "helcim" && payment.checkout_token ? (
        <CheckoutHelcimPaymentForm
          payment={payment}
          onComplete={(result) => {
            toast("Payment accepted.", "success");
            window.localStorage.removeItem("ros.store.cart.v1");
            window.localStorage.removeItem(CART_SESSION_STORAGE_KEY);
            window.localStorage.removeItem(SHIPPING_QUOTE_STORAGE_KEY);
            window.localStorage.removeItem(CHECKOUT_COUPON_STORAGE_KEY);
            navigate(
              `/shop/checkout/complete?session=${encodeURIComponent(
                result.checkout_session_id,
              )}`,
            );
          }}
          onError={(message) => setError(message)}
        />
      ) : null}
    </div>
  );
}

function CheckoutStripePaymentForm({
  payment,
  onComplete,
  onError,
}: {
  payment: CheckoutPaymentResponse;
  onComplete: (result: CheckoutConfirmResponse) => void;
  onError: (message: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Card payment</CardTitle>
        <CardDescription>Secure Stripe payment for this ROS checkout.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PaymentElement />
        <Button
          type="button"
          disabled={!stripe || !elements || submitting}
          className="w-full"
          onClick={() => {
            void (async () => {
              if (!stripe || !elements || !payment.provider_payment_id) return;
              setSubmitting(true);
              try {
                const result = await stripe.confirmPayment({
                  elements,
                  redirect: "if_required",
                });
                if (result.error) {
                  onError(result.error.message ?? "Payment was not accepted.");
                  return;
                }
                const confirmRes = await fetch(
                  apiUrl(
                    API_BASE,
                    `/api/store/checkout/session/${payment.checkout_session_id}/confirm`,
                  ),
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      provider: "stripe",
                      provider_payment_id: payment.provider_payment_id,
                    }),
                  },
                );
                const confirmJson = (await confirmRes.json().catch(() => ({}))) as
                  | CheckoutConfirmResponse
                  | { error?: string };
                if (!confirmRes.ok) {
                  onError(
                    "error" in confirmJson
                      ? confirmJson.error ?? "Payment confirmed, but ROS could not finalize the order."
                      : "Payment confirmed, but ROS could not finalize the order.",
                  );
                  return;
                }
                const confirmed = confirmJson as CheckoutConfirmResponse;
                if (confirmed.status !== "paid") {
                  onError(`Payment status is ${confirmed.status}.`);
                  return;
                }
                onComplete(confirmed);
              } finally {
                setSubmitting(false);
              }
            })();
          }}
        >
          {submitting ? "Finalizing..." : "Pay now"}
        </Button>
      </CardContent>
    </Card>
  );
}

function loadHelcimPayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.appendHelcimPayIframe) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-ros-helcim-pay="true"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("helcim")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://secure.helcim.app/helcim-pay/services/start.js";
    script.async = true;
    script.dataset.rosHelcimPay = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("helcim"));
    document.head.appendChild(script);
  });
}

function CheckoutHelcimPaymentForm({
  payment,
  onComplete,
  onError,
}: {
  payment: CheckoutPaymentResponse;
  onComplete: (result: CheckoutConfirmResponse) => void;
  onError: (message: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!payment.checkout_token) return;
    const eventName = `helcim-pay-js-${payment.checkout_token}`;
    const handler = (event: MessageEvent) => {
      const data = event.data as
        | {
            eventName?: string;
            eventStatus?: string;
            eventMessage?: unknown;
          }
        | undefined;
      if (!data || data.eventName !== eventName) return;
      if (data.eventStatus === "ABORTED") {
        onError("Helcim payment was not accepted.");
        setSubmitting(false);
        return;
      }
      if (data.eventStatus !== "SUCCESS") return;
      void (async () => {
        try {
          const eventMessage =
            typeof data.eventMessage === "string"
              ? (JSON.parse(data.eventMessage) as unknown)
              : data.eventMessage;
          const payload = eventMessage as {
            data?: unknown;
            hash?: string;
          };
          const confirmRes = await fetch(
            apiUrl(
              API_BASE,
              `/api/store/checkout/session/${payment.checkout_session_id}/confirm`,
            ),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: "helcim",
                provider_payment_id: payment.checkout_token,
                raw_data_response: payload.data,
                helcim_hash: payload.hash,
              }),
            },
          );
          const confirmJson = (await confirmRes.json().catch(() => ({}))) as
            | CheckoutConfirmResponse
            | { error?: string };
          if (!confirmRes.ok) {
            onError(
              "error" in confirmJson
                ? confirmJson.error ?? "Helcim payment could not be finalized."
                : "Helcim payment could not be finalized.",
            );
            return;
          }
          const confirmed = confirmJson as CheckoutConfirmResponse;
          if (confirmed.status !== "paid") {
            onError(`Payment status is ${confirmed.status}.`);
            return;
          }
          onComplete(confirmed);
        } catch {
          onError("Helcim payment response could not be read.");
        } finally {
          setSubmitting(false);
        }
      })();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onComplete, onError, payment.checkout_session_id, payment.checkout_token]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Helcim payment</CardTitle>
        <CardDescription>
          Secure HelcimPay.js checkout for this ROS order.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          disabled={submitting}
          className="w-full"
          onClick={() => {
            void (async () => {
              if (!payment.checkout_token) return;
              setSubmitting(true);
              try {
                await loadHelcimPayScript();
                if (!window.appendHelcimPayIframe) {
                  onError("HelcimPay.js could not be loaded.");
                  setSubmitting(false);
                  return;
                }
                window.appendHelcimPayIframe(payment.checkout_token, true);
              } catch {
                onError("HelcimPay.js could not be loaded.");
                setSubmitting(false);
              }
            })();
          }}
        >
          {submitting ? "Waiting for Helcim..." : "Pay with Helcim"}
        </Button>
      </CardContent>
    </Card>
  );
}

function CheckoutCompletePane({
  sessionId,
  navigate,
  toast,
}: {
  sessionId?: string;
  navigate: (p: string) => void;
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["store-checkout-complete", sessionId],
    queryFn: async () => {
      if (!sessionId) return null;
      const res = await fetch(
        apiUrl(API_BASE, `/api/store/checkout/session/${sessionId}`),
      );
      if (!res.ok) throw new Error("checkout");
      return res.json() as Promise<CheckoutSessionResponse>;
    },
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    if (isError) toast("Could not load checkout confirmation.", "error");
  }, [isError, toast]);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-black uppercase italic tracking-tight">
        Order received
      </h1>
      {isPending ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : data?.status === "paid" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment accepted</CardTitle>
            <CardDescription>
              ROS transaction {data.finalized_transaction_id?.slice(0, 8) ?? "created"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Total paid: ${parseMoney(data.total_usd).toFixed(2)}</p>
            <p className="text-storefront-muted-foreground">
              We will contact you with pickup or shipping updates.
            </p>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-storefront-muted-foreground">
          Checkout status: {data?.status ?? "unknown"}
        </p>
      )}
      <Button type="button" onClick={() => navigate("/shop/products")}>
        Continue shopping
      </Button>
    </div>
  );
}
