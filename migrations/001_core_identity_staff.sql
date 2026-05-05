-- Riverside OS schema contract baseline.
-- Generated from the final pre-launch schema after legacy migrations through 188.
-- Do not place seed/test data in migrations.

\set ON_ERROR_STOP on
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- 001 Core Identity Staff

--
-- Name: reporting; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA reporting;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

--
-- Name: alteration_bucket; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alteration_bucket AS ENUM (
    'jacket',
    'pant',
    'other'
);

--
-- Name: alteration_intake_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alteration_intake_channel AS ENUM (
    'standalone',
    'pos_register'
);

--
-- Name: alteration_source_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alteration_source_type AS ENUM (
    'current_cart_item',
    'past_transaction_line',
    'catalog_item',
    'custom_item'
);

--
-- Name: alteration_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alteration_status AS ENUM (
    'intake',
    'in_work',
    'ready',
    'picked_up'
);

--
-- Name: bug_report_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bug_report_status AS ENUM (
    'pending',
    'complete',
    'dismissed'
);

--
-- Name: fulfillment_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.fulfillment_type AS ENUM (
    'takeaway',
    'special_order',
    'custom',
    'wedding_order',
    'layaway'
);

--
-- Name: gift_card_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.gift_card_kind AS ENUM (
    'purchased',
    'loyalty_reward',
    'donated_giveaway'
);

--
-- Name: gift_card_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.gift_card_status AS ENUM (
    'active',
    'depleted',
    'void'
);

--
-- Name: inventory_tx_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.inventory_tx_type AS ENUM (
    'po_receipt',
    'sale',
    'adjustment',
    'return_in',
    'return_out',
    'damaged',
    'return_to_vendor',
    'physical_inventory'
);

--
-- Name: order_fulfillment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_fulfillment_method AS ENUM (
    'pickup',
    'ship'
);

--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'open',
    'fulfilled',
    'cancelled',
    'pending_measurement'
);

--
-- Name: pos_parked_sale_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pos_parked_sale_status AS ENUM (
    'parked',
    'recalled',
    'deleted'
);

--
-- Name: purchase_order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.purchase_order_status AS ENUM (
    'draft',
    'submitted',
    'partially_received',
    'closed',
    'cancelled'
);

--
-- Name: sale_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sale_channel AS ENUM (
    'register',
    'web'
);

--
-- Name: shipment_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.shipment_source AS ENUM (
    'pos_order',
    'web_order',
    'manual_hub'
);

--
-- Name: shipment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.shipment_status AS ENUM (
    'draft',
    'quoted',
    'label_purchased',
    'in_transit',
    'delivered',
    'cancelled',
    'exception'
);

--
-- Name: staff_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.staff_role AS ENUM (
    'admin',
    'salesperson',
    'sales_support',
    'staff_support',
    'alterations'
);

--
-- Name: staff_schedule_exception_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.staff_schedule_exception_kind AS ENUM (
    'sick',
    'pto',
    'missed_shift',
    'extra_shift',
    'vacation',
    'doctors_appt',
    'other',
    'meeting',
    'store_event'
);

--
-- Name: staff_weekly_schedule_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.staff_weekly_schedule_status AS ENUM (
    'draft',
    'published',
    'archived'
);

--
-- Name: store_coupon_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.store_coupon_kind AS ENUM (
    'percent',
    'fixed_amount',
    'free_shipping'
);

--
-- Name: task_assignee_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_assignee_kind AS ENUM (
    'staff',
    'role'
);

--
-- Name: task_instance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_instance_status AS ENUM (
    'open',
    'completed',
    'cancelled'
);

--
-- Name: task_recurrence; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_recurrence AS ENUM (
    'daily',
    'weekly',
    'monthly',
    'yearly'
);

--
-- Name: tax_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tax_category AS ENUM (
    'clothing',
    'footwear',
    'accessory',
    'service'
);

--
-- Name: transaction_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transaction_category AS ENUM (
    'retail_sale',
    'rms_account_payment'
);

--
-- Name: generate_ord_display_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_ord_display_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.display_id IS NULL THEN
        NEW.display_id := 'ORD-' || nextval('fulfillment_order_display_id_seq')::text;
    END IF;
    RETURN NEW;
END;
$$;

--
-- Name: generate_txn_display_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_txn_display_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.display_id IS NULL THEN
        NEW.display_id := 'TXN-' || nextval('transaction_display_id_seq')::text;
    END IF;
    RETURN NEW;
END;
$$;

--
-- Name: staff_effective_working_day(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_effective_working_day(p_staff_id uuid, p_d date) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    r staff_role;
    wd int;
    ex staff_schedule_exception_kind;
    ws_works boolean;
    ws_week_start date;
BEGIN
    SELECT s.role INTO r FROM staff s WHERE s.id = p_staff_id;
    
    -- If no staff or non-floor staff, treat as "always available" for system logic.
    IF r IS NULL THEN
        RETURN TRUE;
    END IF;
    
    IF r NOT IN ('salesperson', 'sales_support', 'staff_support', 'alterations') THEN
        RETURN TRUE;
    END IF;

    wd := EXTRACT(DOW FROM p_d)::int;
    ws_week_start := (p_d::date - (EXTRACT(DOW FROM p_d)::int * INTERVAL '1 day'))::date;

    -- 1. Check for specific day exceptions (PTO, Sick, Extra Shift)
    -- Exceptions are considered "Finalized" events.
    SELECT e.kind INTO ex
    FROM staff_day_exception e
    WHERE e.staff_id = p_staff_id AND e.exception_date = p_d;

    IF FOUND THEN
        RETURN ex = 'extra_shift';
    END IF;

    -- 2. Check for PUBLISHED week-level schedule overrides for this date.
    SELECT swd.works INTO ws_works
    FROM staff_weekly_schedule sws
    JOIN staff_weekly_schedule_day swd
      ON swd.staff_id = sws.staff_id
     AND swd.week_start = sws.week_start
     AND swd.weekday = wd
    WHERE sws.staff_id = p_staff_id
      AND sws.week_start = ws_week_start
      AND sws.status = 'published'
    LIMIT 1;

    IF FOUND THEN
        RETURN ws_works;
    END IF;

    -- 3. REMOVED: Fallback to template availability.
    -- The user explicitly requested that unpublished drafts or missing schedules 
    -- should NOT show as working days.
    
    RETURN FALSE;
END;
$$;

--
-- Name: update_modified_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_modified_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

--
-- Name: effective_store_timezone(); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.effective_store_timezone() RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    tz text;
BEGIN
    SELECT COALESCE(
            NULLIF(TRIM(ss.receipt_config->>'timezone'), ''),
            'America/New_York'
        )
    INTO tz
    FROM store_settings ss
    WHERE ss.id = 1
    LIMIT 1;

    IF tz IS NULL OR length(tz) = 0 THEN
        RETURN 'America/New_York';
    END IF;
    RETURN tz;
END;
$$;

--
-- Name: order_recognition_at(uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.order_recognition_at(p_order_id uuid, p_fulfillment_method text, p_status text, p_fulfilled_at timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    SELECT CASE
        WHEN p_status = 'cancelled' THEN NULL::timestamptz
        WHEN COALESCE(NULLIF(BTRIM(p_fulfillment_method), ''), 'pickup') = 'pickup' THEN p_fulfilled_at
        ELSE (
            SELECT MIN(se.at)
            FROM shipment s
            INNER JOIN shipment_event se ON se.shipment_id = s.id
            WHERE s.transaction_id = p_order_id -- Renamed in Mig 142
              AND COALESCE(s.status::text, '') <> 'cancelled'
              AND (
                  se.kind = 'label_purchased'
                  OR (se.kind = 'updated' AND (
                      se.message LIKE '%status set to in_transit%'
                      OR se.message LIKE '%status set to delivered%'
                  ))
              )
        )
    END;
$$;

--
-- Name: transaction_line_recognition_at(uuid); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.transaction_line_recognition_at(p_line_id uuid) RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
    SELECT tl.fulfilled_at
    FROM transaction_lines tl
    WHERE tl.id = p_line_id;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: counterpoint_category_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_category_map_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_gift_reason_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_gift_reason_map_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_payment_method_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_payment_method_map_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_staff_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_staff_map_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_staging_batch_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_staging_batch_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_sync_issue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_sync_issue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_sync_request_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_sync_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: counterpoint_sync_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterpoint_sync_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: customer_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: fulfillment_order_display_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_order_display_id_seq
    START WITH 10001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: notification_delivery_suppression_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_delivery_suppression_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: register_sessions_session_ordinal_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.register_sessions_session_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: ros_schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ros_schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    full_name character varying(255) NOT NULL,
    cashier_code character varying(10) NOT NULL,
    base_commission_rate numeric(5,4) DEFAULT 0.0200,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    role public.staff_role DEFAULT 'sales_support'::public.staff_role NOT NULL,
    pin_hash text,
    phone text,
    email text,
    avatar_key text DEFAULT 'ros_default'::text NOT NULL,
    data_source text,
    counterpoint_user_id text,
    counterpoint_sls_rep text,
    max_discount_percent numeric(5,2) DEFAULT 30 NOT NULL,
    employment_start_date date,
    employment_end_date date,
    employee_customer_id uuid,
    pin text,
    notification_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT staff_max_discount_pct_chk CHECK (((max_discount_percent >= (0)::numeric) AND (max_discount_percent <= (100)::numeric)))
);

--
-- Name: staff_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_access_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id uuid NOT NULL,
    event_kind text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: staff_auth_failure_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_auth_failure_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: staff_commission_rate_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_commission_rate_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id uuid NOT NULL,
    effective_start_date date NOT NULL,
    base_commission_rate numeric(5,4) NOT NULL,
    changed_by_staff_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: staff_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_permission (
    staff_id uuid NOT NULL,
    permission_key text NOT NULL,
    allowed boolean DEFAULT true NOT NULL,
    CONSTRAINT staff_permission_non_empty_key CHECK ((length(TRIM(BOTH FROM permission_key)) > 0))
);

--
-- Name: staff_permission_override; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_permission_override (
    staff_id uuid NOT NULL,
    permission_key text NOT NULL,
    effect text NOT NULL,
    CONSTRAINT staff_permission_override_effect_check CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text])))
);

--
-- Name: staff_role_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_role_permission (
    role public.staff_role NOT NULL,
    permission_key text NOT NULL,
    allowed boolean DEFAULT false NOT NULL
);

--
-- Name: staff_role_pricing_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_role_pricing_limits (
    role public.staff_role NOT NULL,
    max_discount_percent numeric(5,2) DEFAULT 30.00 NOT NULL,
    CONSTRAINT staff_role_pricing_limits_pct CHECK (((max_discount_percent >= (0)::numeric) AND (max_discount_percent <= (100)::numeric)))
);

--
-- Name: store_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_settings (
    id integer DEFAULT 1 NOT NULL,
    employee_markup_percent numeric(5,2) DEFAULT 15.0,
    loyalty_point_threshold integer DEFAULT 1000,
    loyalty_reward_amount numeric(12,2) DEFAULT 25.0,
    receipt_config jsonb DEFAULT '{"show_email": false, "show_phone": true, "store_name": "Riverside OS", "footer_lines": ["Thank you for shopping with us!", "Visit us again soon."], "header_lines": [], "show_address": true, "show_barcode": false, "show_loyalty_earned": true, "show_loyalty_balance": true}'::jsonb NOT NULL,
    backup_settings jsonb DEFAULT '{"cloud_region": "us-east-1", "schedule_cron": "0 2 * * *", "cloud_endpoint": "", "auto_cleanup_days": 30, "cloud_bucket_name": "", "cloud_storage_enabled": false}'::jsonb NOT NULL,
    weather_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    staff_sop_markdown text DEFAULT ''::text NOT NULL,
    podium_sms_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    shippo_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    insights_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    counterpoint_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    review_policy jsonb DEFAULT '{"review_invites_enabled": true, "send_review_invite_by_default": true}'::jsonb NOT NULL,
    nuorder_config jsonb DEFAULT '{}'::jsonb,
    loyalty_letter_template text DEFAULT 'Dear {{first_name}}, 

Congratulations! Your loyalty to Riverside has earned you a ${{reward_amount}} reward. 

We have loaded this reward onto a personalized gift card for you:
CODE: {{card_code}}

Thank you for being part of our community. We look ahead to seeing you again soon!

Best regards,
The Riverside Team'::text NOT NULL,
    rosie_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    environment_mode text DEFAULT 'development'::text NOT NULL,
    active_card_provider text DEFAULT 'helcim'::text NOT NULL,
    storefront_home_layout jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT environment_mode_check CHECK ((environment_mode = ANY (ARRAY['development'::text, 'production'::text, 'e2e'::text]))),
    CONSTRAINT single_row CHECK ((id = 1)),
    CONSTRAINT store_settings_active_card_provider_chk CHECK ((active_card_provider = 'helcim'::text))
);

--
-- Name: transaction_display_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transaction_display_id_seq
    START WITH 10001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: variant_sku_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.variant_sku_seq
    START WITH 10000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
