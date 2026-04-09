-- Server-backed guest cart for public storefront + binary media for Studio/CMS images.

CREATE TABLE store_guest_cart (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE TABLE store_guest_cart_line (
    cart_id UUID NOT NULL REFERENCES store_guest_cart(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL,
    PRIMARY KEY (cart_id, variant_id),
    CONSTRAINT store_guest_cart_line_qty_chk CHECK (qty >= 1 AND qty <= 9999)
);

CREATE INDEX idx_store_guest_cart_expires ON store_guest_cart (expires_at);
CREATE INDEX idx_store_guest_cart_line_variant ON store_guest_cart_line (variant_id);

COMMENT ON TABLE store_guest_cart IS 'Anonymous storefront cart session; lines in store_guest_cart_line.';
COMMENT ON TABLE store_guest_cart_line IS 'Guest cart lines; priced via public store catalog rules.';

CREATE TABLE store_media_asset (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mime_type TEXT NOT NULL,
    original_filename TEXT,
    byte_size INTEGER NOT NULL,
    bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    CONSTRAINT store_media_asset_size_chk CHECK (byte_size > 0 AND byte_size <= 3145728),
    CONSTRAINT store_media_asset_mime_chk CHECK (
        mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
    )
);

CREATE INDEX idx_store_media_asset_created ON store_media_asset (created_at DESC);

COMMENT ON TABLE store_media_asset IS 'Staff-uploaded images for GrapesJS Studio; public GET /api/store/media/{id}.';
