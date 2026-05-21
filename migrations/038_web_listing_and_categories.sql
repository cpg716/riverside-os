-- 038: Web listing fields, web category taxonomy, and product web images
--
-- Adds web-specific listing data to products for online storefront merchandising,
-- a separate web category hierarchy (distinct from store POS categories), and
-- a dedicated product web images table with sort order, alt text, and hero flag.

-- ── Web listing fields on products ──────────────────────────────────────────

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS web_title text,
    ADD COLUMN IF NOT EXISTS web_description text,
    ADD COLUMN IF NOT EXISTS seo_meta_title text,
    ADD COLUMN IF NOT EXISTS seo_meta_description text,
    ADD COLUMN IF NOT EXISTS web_tags text[] DEFAULT '{}'::text[] NOT NULL;

COMMENT ON COLUMN public.products.web_title IS 'Storefront display name override (falls back to products.name when NULL)';
COMMENT ON COLUMN public.products.web_description IS 'Rich marketing copy for the online product detail page';
COMMENT ON COLUMN public.products.seo_meta_title IS 'HTML <title> override for the product page (falls back to web_title or name)';
COMMENT ON COLUMN public.products.seo_meta_description IS 'HTML meta description for SEO';
COMMENT ON COLUMN public.products.web_tags IS 'Search keywords and filter tags for the storefront';

-- ── Web categories (online shopping taxonomy) ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.web_categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
    parent_id uuid REFERENCES public.web_categories(id) ON DELETE SET NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT web_categories_slug_unique UNIQUE (slug)
);

COMMENT ON TABLE public.web_categories IS 'Online storefront category taxonomy, separate from POS store categories';
COMMENT ON COLUMN public.web_categories.parent_id IS 'Self-referencing parent for hierarchical browsing (e.g. Accessories > Ties)';
COMMENT ON COLUMN public.web_categories.slug IS 'URL-safe identifier used in storefront navigation paths';

-- ── Product ↔ Web Category junction (many-to-many) ─────────────────────────

CREATE TABLE IF NOT EXISTS public.product_web_categories (
    product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    web_category_id uuid NOT NULL REFERENCES public.web_categories(id) ON DELETE CASCADE,
    sort_order integer DEFAULT 0 NOT NULL,
    PRIMARY KEY (product_id, web_category_id)
);

COMMENT ON TABLE public.product_web_categories IS 'Maps products to web storefront categories (a product can appear in multiple online categories)';

-- ── Product web images ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_web_images (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
    product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    url text NOT NULL,
    alt_text text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_hero boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE public.product_web_images IS 'Dedicated web storefront images separate from the generic products.images array';
COMMENT ON COLUMN public.product_web_images.is_hero IS 'When true, this image is the primary hero/thumbnail for the web listing';

CREATE INDEX IF NOT EXISTS idx_product_web_images_product ON public.product_web_images(product_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_web_categories_product ON public.product_web_categories(product_id);
CREATE INDEX IF NOT EXISTS idx_product_web_categories_category ON public.product_web_categories(web_category_id);
CREATE INDEX IF NOT EXISTS idx_web_categories_parent ON public.web_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_web_categories_slug ON public.web_categories(slug);
CREATE INDEX IF NOT EXISTS idx_products_web_tags ON public.products USING gin(web_tags);
