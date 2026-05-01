# Online store (public `/shop` + Back Office CMS)

**Audience:** Developers and staff configuring the **first-party storefront** (catalog, marketing pages, coupons).

**Related:** **[`docs/PLAN_ONLINE_STORE_MODULE.md`](PLAN_ONLINE_STORE_MODULE.md)** (roadmap: Stripe checkout, Insights channel pivot, asset pipeline, etc.), **[`docs/SHIPPING_AND_SHIPMENTS_HUB.md`](SHIPPING_AND_SHIPMENTS_HUB.md)** (**`POST /api/store/shipping/rates`**), **[`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`](PODIUM_STOREFRONT_CSP_AND_PRIVACY.md)** (widget on public builds), **[`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md)** (**`online_store.manage`**), **[`docs/SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md)** (PLP **`search`**, optional Meilisearch **`ros_store_products`**).

**Future (goals only, not scheduled):** Unified **customer identity** on the web (match/link to existing **`customers`**) and **receipt-grade purchase history** spanning in-store and web — separate staff vs customer surfaces, one database — **[`docs/PLAN_ONLINE_STORE_UNIFIED_CUSTOMER.md`](PLAN_ONLINE_STORE_UNIFIED_CUSTOMER.md)**.

---

## What ships today

| Layer | Behavior |
|-------|----------|
| **Schema** | Migration **`73_online_store_module.sql`**: **`orders.sale_channel`**, **`product_variants.web_*`**, **`store_pages`** (**`project_json`**, **`published_html`**), **`store_coupons`**, **`store_tax_state_rate`**, RBAC **`online_store.manage`**. Migration **`76_store_guest_cart_and_media_assets.sql`**: **`store_guest_cart`**, **`store_guest_cart_line`**, **`store_media_asset`**. Migration **`77_customer_online_account.sql`**: **`customers.customer_created_source`**, **`customer_online_credential`** (Argon2 password for **`/api/store/account/*`**). |
| **Public app** | **`client/src/main.tsx`** mounts **`PublicStorefront`** when the path is **`/shop`** or **`/shop/*`** (no staff auth). |
| **Guest theme** | **`/shop`** uses the same **`ros.theme.mode`** + **`<html data-theme>`** bootstrap as the staff app (`syncDocumentThemeFromStorage` in **`main.tsx`**). **`[data-storefront="true"]`** supplies light **`--sf-*`** HSL channels; **`[data-theme="dark"][data-storefront="true"]`** in **`client/src/index.css`** supplies the dark guest palette so Tailwind **`storefront.*`** and shadcn primitives track system/user dark mode. |
| **Public API** | **`/api/store/*`** — catalog, published pages (HTML sanitized server-side with **ammonia**), coupon preview, tax preview, guest **cart line pricing**, Shippo rates — **`server/src/api/store.rs`**. |
| **Admin API** | **`/api/admin/store/*`** — pages and coupons — same module; requires **`online_store.manage`** or **`settings.admin`**. |
| **Inventory** | Web publish flags and bulk actions — see plan §1 and **`InventoryControlBoard`**. |
| **Back Office** | **Online Store** main workspace: dashboard, storefront pages (raw HTML + **GrapesJS Studio SDK** visual editor), web product merchandising, promotions/coupons, and operational links. **Settings → Online Store** is configuration/status only. |

---

## Staff: Online Store workspace

- **Storefront pages:** Create slug + title; **Edit page** loads **`published_html`** and **`project_json`**.
  - **Raw HTML:** edit textarea → **Save draft HTML** → **Publish** when ready (public site reads sanitized HTML for **`published = true`** rows).
  - **Visual (Studio):** lazy-loaded **`@grapesjs/studio-sdk`** (**`StorePageStudioEditor.tsx`**). Project data autosaves to **`project_json`** via **`PATCH`**. Image uploads use **`POST /api/admin/store/assets`** (base64 JSON) and resolve to **`GET /api/store/media/{id}`** URLs embedded in the page. Use **Export Studio HTML to raw draft** to generate HTML into the raw editor, then **Save draft HTML** if you want that snapshot in **`published_html`**.
- **Products:** **Online Store → Products** is the web merchandising surface over Inventory truth. Staff can review live/draft/blocked products, edit storefront slugs, toggle web publish status, set web-only price overrides, set gallery sort order, open public PDP links, and jump to the full Product Hub. Catalog/PDP/cart remain ROS-native; GrapesJS is not used for product or catalog pages.
- **Coupons:** create, list, activate/deactivate (**`PATCH`**).
- **Production Studio:** set **`VITE_GRAPESJS_STUDIO_LICENSE_KEY`** in the client env for non-localhost deployments (SDK license rules: [GrapesJS Studio licenses](https://app.grapesjs.com/docs-sdk/overview/licenses)). Local dev may use the SDK’s documented dev key pattern.

**Permission:** **`online_store.manage`** (or **`settings.admin`** for the same admin routes).

---

## Public `/shop` UX (guest)

| Route | Purpose |
|-------|---------|
| **`/shop`** | Landing: links to products, cart, and **published marketing pages** (from **`GET /api/store/pages`**). |
| **`/shop/products`** | Product list (**web-published** variants only; slug = **`products.catalog_handle`**). Search box debounces **`GET /api/store/products?search=`**; with Meilisearch configured, catalog text search uses **`ros_store_products`** + SQL hydration (see **`docs/SEARCH_AND_PAGINATION.md`**). |
| **`/shop/products/{slug}`** | PDP: **faceted** options when **`variation_axes`** / **`variation_values`** exist (else flat variant chips); **Add to cart** → **`localStorage`** **`ros.store.cart.v1`** and sync to **`/api/store/cart/session`** when possible. |
| **`/shop/cart`** | Line items priced via **`POST /api/store/cart/lines`**; **`ros.store.cartSessionId.v1`** + server session **GET/PUT**; **Fulfillment:** **In-store pickup** (NY tax estimate, no shipping) or **Ship to address** (address in **`localStorage`**, Shippo rates, tax per **Web tax policy** above); coupon + estimate; **`?promo=CODE`** pre-fills coupon when empty. |
| **`/shop/account`**, **`/shop/account/login`**, **`/shop/account/register`**, **`/shop/account/link`**, **`/shop/account/orders/{order_id}`** | Customer **JWT** in **`localStorage`** **`ros.store.customerJwt.v1`**: sign-in, new web signup (**`customer_created_source = online_store`**), or **link password** when email already matches **`customers`**. **Profile / address** via **`PATCH /api/store/account/me`**; **change password** via **`POST /api/store/account/password`**. Order list + **Details** → read-only order payload (**no** unit cost or internal Shippo object ids). |
| **`/shop/{page_slug}`** | CMS page: **`GET /api/store/pages/{slug}`** returns sanitized HTML (must be **published**). Reserved slugs include **`cart`**, **`products`**, **`account`**, etc. — see **`RESERVED_PAGE_SLUGS`** in **`store.rs`**. |

**Data fetching:** **TanStack Query** in **`PublicStorefront.tsx`**.

**UI stack:** **`client/src/components/ui-shadcn/`** (Radix + **CVA** + **`cn()`**) with **scoped** Tailwind tokens under **`[data-storefront="true"]`** (see **`client/src/index.css`** and **`tailwind.config.js`** **`storefront.*`**). This is the project’s **shadcn-style** storefront layer ( **`components.json`** at **`client/components.json`** for tooling); Back Office continues to use **`ui-*`** primitives where unchanged.

---

## Web tax policy (Riverside operating assumption)

**Not legal advice.** Final determinations belong to your **CPA** and counsel. ROS encodes the following **store policy** for **public `/shop` tax estimates** and future web checkout:

1. **In-store pickup (possession in New York)**  
   If the customer picks up at the **New York** store, the sale is treated as **NY**-sourced for sales tax purposes: **New York sales tax applies** (including when the customer’s home address is out of state).

2. **Ship to an address outside New York**  
   The shipment is treated as **not** subject to **New York** sales tax collection for this store’s web channel (**no NY tax** on the estimate).

3. **Tax in other states**  
   The business **does not** assert **sales tax nexus** in other states for this policy path; **no tax is collected** for ship-to states other than **NY** in the preview (rate **0** with an explanatory disclaimer).

**Implementation:** **`GET /api/store/tax/preview`** accepts **`fulfillment=ship`** (default) or **`fulfillment=store_pickup`**. Pickup uses the configured **NY** combined rate from **`store_tax_state_rate`**. Ship + **NY** ship-to uses that same **NY** row; ship + non-**NY** returns **0** rate and a policy disclaimer. **`PublicStorefront`** cart: **In-store pickup** vs **Ship to address** toggles this parameter and **$0** shipping for pickup.

---

## API reference (condensed)

### Public (`/api/store`)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/products` | Query: **`limit`**, **`offset`**, **`search`**. **`search`** uses Meilisearch when **`RIVERSIDE_MEILISEARCH_URL`** is set; otherwise **ILIKE** on name / brand / slug. |
| GET | `/products/{slug}` | Detail + variants (**`unit_price`**, **`available_stock`**). |
| GET | `/pages` | Published page metadata list. |
| GET | `/pages/{slug}` | **`title`**, **`html`** (sanitized). |
| POST | `/cart/coupon` | Body: **`code`**, **`subtotal`** — preview only (**`uses_count`** not incremented). |
| POST | `/cart/lines` | Body: **`lines: [{ variant_id, qty }]`** — priced rows + **`subtotal`**; unknown / delisted variants in **`missing_variant_ids`**. |
| POST | `/cart/session` | Optional **`lines`** — creates **`store_guest_cart`**; response includes **`cart_id`** + same priced fields as **`/cart/lines`**. |
| GET | `/cart/session/{id}` | Priced cart; refreshes expiry (**90d**); **404** if expired / missing. |
| PUT | `/cart/session/{id}` | Body: **`lines`** — replace server lines. |
| DELETE | `/cart/session/{id}` | Remove guest cart row (cascade lines). |
| GET | `/media/{id}` | Public image bytes (**JPEG**, **PNG**, **WebP**, **GIF**). |
| GET | `/tax/preview` | Query: **`subtotal`** (required), **`state`** (two-letter; for **`fulfillment=ship`**), **`fulfillment`**: **`ship`** (default) or **`store_pickup`**. Response includes **`fulfillment`**, **`disclaimer`**, **`tax_estimated`**, **`combined_rate`**. |
| POST | `/shipping/rates` | Shippo quote path — **`docs/SHIPPING_AND_SHIPMENTS_HUB.md`**. |
| POST | `/account/login` | Body: **`email`**, **`password`**. Returns **`token`** (HS256 JWT, ~30d) + **`customer_id`**. **401** with **`code: needs_activate`** when the email exists but **`customer_online_credential`** is missing (use **`/account/activate`**). |
| POST | `/account/register` | Body: **`email`**, **`password`**, **`first_name`**, **`last_name`**, optional **`phone`**. Creates **`customers`** row + credential. **409** **`use_login`** / **`use_activate`** when email already exists. |
| POST | `/account/activate` | Body: **`email`**, **`password`** — insert credential for an existing **`customers`** row (normalized email match). **409** **`use_login`** if credential already exists. |
| GET | `/account/me` | Header **`Authorization: Bearer {token}`** — profile including address fields + **`customer_created_source`**. |
| PATCH | `/account/me` | **`Bearer`** — JSON body: optional **`first_name`**, **`last_name`**, **`company_name`**, **`phone`**, **`address_line1`**, **`address_line2`**, **`city`**, **`state`**, **`postal_code`** (email is **not** editable here). |
| POST | `/account/password` | **`Bearer`** — body **`current_password`**, **`new_password`** (Argon2, min **8**). |
| GET | `/account/orders` | Same **`Bearer`** — paged order history (**`sale_channel`** included). |
| GET | `/account/orders/{order_id}` | **`Bearer`** — read-only detail for that order **only if** **`orders.customer_id`** matches the token; strips **unit cost** and internal Shippo ids; includes **tracking** link when present. |
| GET | `/navigation` | Public header/footer navigation menus controlled from Online Store. |
| GET | `/home-layout` | Public ROS-native homepage layout block config. |

**Rate limits (rolling 60s):** per client key from **`ConnectInfo`** (socket IP) or first hop of **`X-Forwarded-For`** when behind a reverse proxy — **`RIVERSIDE_STORE_ACCOUNT_UNAUTH_POST_PER_MINUTE_IP`** (default **20**) for **`login`**, **`register`**, **`activate`** combined; per **`customer_id`** — **`RIVERSIDE_STORE_ACCOUNT_AUTH_PER_MINUTE`** (default **120**) for authenticated **`me`**, **`password`**, **`orders`**, **`orders/{id}`**. Set to **0** to disable that limit. **429** + JSON error when exceeded.

**Production:** set **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`** (long random string). If unset, the server logs a warning and uses an **insecure dev default** (JWTs would be forgeable if the port is exposed). **`main.rs`** uses **`into_make_service_with_connect_info::<SocketAddr>()`** so **`ConnectInfo`** is populated for rate keys.

### Admin (`/api/admin/store`)

Staff headers + **`online_store.manage`** or **`settings.admin`**.

| Method | Path | Notes |
|--------|------|--------|
| GET | `/dashboard` | Online Store operating counts: web sales, checkout sessions, campaigns, media. |
| GET | `/orders` | Web transactions with **`sale_channel = web`**. |
| GET | `/carts` | Checkout sessions and abandoned/failed checkout signals. |
| GET/POST | `/campaigns` | Campaigns with landing-page/coupon attribution. |
| PATCH | `/campaigns/{id}` | Update campaign config. |
| GET | `/seo` | Storefront SEO/catalog/page health issue list. |
| GET/PUT | `/navigation` | Header/footer menu management. |
| GET/PATCH | `/home-layout` | ROS-native homepage layout blocks. |
| GET | `/media` | Media library list with alt text and usage metadata. |
| PATCH | `/media/{id}` | Update asset alt text / usage note. |
| GET | `/publish-history` | Published page snapshots. |
| GET/POST | `/pages` | List / create. |
| GET/PATCH | `/pages/{slug}` | Includes **`project_json`**, **`published_html`**. |
| POST | `/pages/{slug}/publish` | Sets **`published = true`** and captures a publish revision. |
| GET/POST | `/coupons` | List / create. |
| PATCH | `/coupons/{id}` | **`is_active`**, **`max_uses`**, **`ends_at`**. |
| POST | `/assets` | JSON: **`file_base64`**, **`mime_type`**, optional **`filename`** — insert **`store_media_asset`** (max **3 MiB** decoded). |

---

## Server modules

- **`server/src/api/store.rs`** — public + admin routers, ammonia sanitization for public HTML; nests **`/account/*`** from **`store_account.rs`**.
- **`server/src/api/store_account.rs`** — public customer JWT login / register / activate / me (GET+PATCH) / password / orders + order detail.
- **`server/src/api/store_account_rate.rs`** — in-memory sliding-window limits for account routes.
- **`server/src/auth/store_customer_password.rs`**, **`store_customer_jwt.rs`** — Argon2 + HS256 for storefront accounts (not staff PIN rules).
- **`server/src/logic/store_customer_account.rs`** — normalized email lookup + credential insert helpers.
- **`server/src/logic/store_catalog.rs`** — list/detail + **`map_web_variants_by_id`** (cart resolution).
- **`server/src/logic/store_cart_resolve.rs`**, **`store_guest_cart.rs`**, **`store_checkout.rs`**, **`store_media_asset.rs`** — merge/pricing helper, guest cart persistence, provider-neutral web checkout sessions, uploaded image blobs.
- **`server/src/logic/store_promotions.rs`**, **`store_tax.rs`** — coupons and web tax preview (**`web_tax_preview`**: pickup vs ship-to NY vs out-of-state).

---

## Money and security

- Server totals use **`rust_decimal::Decimal`** (cart lines, tax preview, coupons).
- Paid web checkout uses **`store_checkout_session`** + **`store_checkout_payment_attempt`** before finalization. Stripe uses PaymentIntent + Stripe Elements; Helcim uses HelcimPay.js initialization and validates the returned response hash server-side before ROS creates a **`sale_channel = web`** transaction.
- Storefront **account** passwords are **Argon2** (min **8** characters); protect **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`** like any session signing key. **Trust `X-Forwarded-For` only** from your own edge/proxy; otherwise clients can spoof IPs and shift rate-limit buckets.
- Treat **published HTML** and **embed snippets** (Podium, Constant Contact) as **untrusted** until sanitized / CSP allowlisted — see **`PLAN_ONLINE_STORE_MODULE.md`** §5 and **`PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`**.

---

## Still planned (see **`PLAN_ONLINE_STORE_MODULE.md`**)

- Deeper **cart** features (merge rules across devices, abandoned-cart analytics).
- **Insights** / Orders UI pivots on **`sale_channel`**.

**Last reviewed:** 2026-05-01
