-- Riverside OS - Relational Inventory Engine baseline
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core enums (wrapped in idempotency blocks)
DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE fulfillment_type AS ENUM ('takeaway', 'special_order', 'custom'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE transaction_category AS ENUM ('retail_sale', 'rms_account_payment'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE order_status AS ENUM ('open', 'fulfilled', 'cancelled', 'pending_measurement'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE purchase_order_status AS ENUM ('draft', 'submitted', 'partially_received', 'closed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE inventory_tx_type AS ENUM ('po_receipt', 'sale', 'adjustment', 'return_in', 'return_out'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Staff
CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    cashier_code VARCHAR(10) UNIQUE NOT NULL,
    base_commission_rate DECIMAL(5, 4) DEFAULT 0.0200,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Category engine (drives inherited tax classification)
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    is_clothing_footwear BOOLEAN DEFAULT false,
    parent_id UUID REFERENCES categories(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS category_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    changed_field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by UUID REFERENCES staff(id),
    change_note TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Product template + variant matrix
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID REFERENCES categories(id),
    catalog_handle TEXT UNIQUE,
    name TEXT NOT NULL,
    brand TEXT,
    description TEXT,
    base_retail_price NUMERIC(12,2) NOT NULL,
    base_cost NUMERIC(12,2) NOT NULL,
    spiff_amount NUMERIC(12,2) DEFAULT 0.00,
    variation_axes TEXT[] DEFAULT '{}'::text[],
    images TEXT[] DEFAULT '{}'::text[],
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku TEXT UNIQUE NOT NULL,
    variation_values JSONB NOT NULL,
    variation_label TEXT,
    stock_on_hand INTEGER DEFAULT 0,
    reorder_point INTEGER DEFAULT 2,
    images TEXT[] DEFAULT '{}'::text[],
    retail_price_override NUMERIC(12,2),
    cost_override NUMERIC(12,2),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Customers and tailoring context
CREATE TABLE IF NOT EXISTS wedding_parties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    groom_name VARCHAR(255) NOT NULL,
    event_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20),
    loyalty_points INTEGER DEFAULT 0,
    wedding_id UUID REFERENCES wedding_parties(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS measurements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    neck DECIMAL(5, 2),
    sleeve DECIMAL(5, 2),
    chest DECIMAL(5, 2),
    waist DECIMAL(5, 2),
    seat DECIMAL(5, 2),
    inseam DECIMAL(5, 2),
    outseam DECIMAL(5, 2),
    shoulder DECIMAL(5, 2),
    measured_by UUID REFERENCES staff(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Register and order ledgers
CREATE TABLE IF NOT EXISTS register_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opened_by UUID REFERENCES staff(id),
    closed_by UUID REFERENCES staff(id),
    opening_float DECIMAL(12, 2) NOT NULL,
    expected_cash DECIMAL(12, 2),
    actual_cash DECIMAL(12, 2),
    cash_over_short DECIMAL(12, 2),
    discrepancy DECIMAL(12, 2),
    closing_notes TEXT,
    is_open BOOLEAN DEFAULT TRUE,
    opened_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id),
    wedding_id UUID REFERENCES wedding_parties(id),
    operator_id UUID REFERENCES staff(id),
    primary_salesperson_id UUID REFERENCES staff(id),
    is_employee_purchase BOOLEAN DEFAULT FALSE,
    status order_status DEFAULT 'open',
    booked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    fulfilled_at TIMESTAMPTZ,
    total_price DECIMAL(12, 2) NOT NULL,
    amount_paid DECIMAL(12, 2) DEFAULT 0,
    balance_due DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    variant_id UUID REFERENCES product_variants(id),
    salesperson_id UUID REFERENCES staff(id),
    fulfillment fulfillment_type NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price DECIMAL(12, 2) NOT NULL,
    unit_cost DECIMAL(12, 2) NOT NULL,
    state_tax DECIMAL(12, 2) DEFAULT 0,
    local_tax DECIMAL(12, 2) DEFAULT 0,
    applied_spiff DECIMAL(12, 2) DEFAULT 0,
    calculated_commission DECIMAL(12, 2) DEFAULT 0,
    size_specs JSONB,
    is_fulfilled BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES register_sessions(id),
    payer_id UUID REFERENCES customers(id),
    category transaction_category DEFAULT 'retail_sale',
    payment_method VARCHAR(50) NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    stripe_intent_id VARCHAR(255),
    is_posted_to_rms_portal BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID REFERENCES payment_transactions(id) ON DELETE CASCADE,
    target_order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    amount_allocated DECIMAL(12, 2) NOT NULL
);

-- PO and receiving workflow
CREATE TABLE IF NOT EXISTS vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    email TEXT,
    phone TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_number TEXT UNIQUE NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    status purchase_order_status NOT NULL DEFAULT 'draft',
    ordered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expected_at TIMESTAMPTZ,
    invoice_number TEXT,
    freight_total NUMERIC(12,2) DEFAULT 0,
    notes TEXT,
    created_by UUID REFERENCES staff(id)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
    quantity_received INTEGER NOT NULL DEFAULT 0,
    unit_cost NUMERIC(12,2) NOT NULL,
    landed_cost_per_unit NUMERIC(12,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS receiving_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    received_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    invoice_number TEXT,
    freight_total NUMERIC(12,2) DEFAULT 0,
    received_by UUID REFERENCES staff(id),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    tx_type inventory_tx_type NOT NULL,
    quantity_delta INTEGER NOT NULL,
    unit_cost NUMERIC(12,4),
    landed_cost_component NUMERIC(12,4) DEFAULT 0,
    reference_table TEXT,
    reference_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- QuickBooks integration mapping layer
CREATE TABLE IF NOT EXISTS qbo_integration (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    last_sync_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS qbo_accounts_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_type TEXT,
    account_number TEXT,
    is_active BOOLEAN DEFAULT true,
    refreshed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    internal_key TEXT UNIQUE NOT NULL,
    internal_description TEXT,
    qbo_account_id TEXT REFERENCES qbo_accounts_cache(id),
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Gift cards and settings
CREATE TABLE IF NOT EXISTS gift_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    current_balance DECIMAL(12, 2) NOT NULL,
    is_liability BOOLEAN NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS store_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    employee_markup_percent DECIMAL(5, 2) DEFAULT 15.0,
    loyalty_point_threshold INTEGER DEFAULT 1000,
    loyalty_reward_amount DECIMAL(12, 2) DEFAULT 25.0,
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO store_settings (id, employee_markup_percent) VALUES (1, 15.0) ON CONFLICT (id) DO NOTHING;
