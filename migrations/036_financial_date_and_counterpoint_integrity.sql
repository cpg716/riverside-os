-- Financial date and Counterpoint lifecycle integrity hardening.
--
-- Keep governed business/effective dates as the reporting source of truth, and
-- repair imported Counterpoint rows so historical tickets and open documents do
-- not disagree across transaction status, line fulfillment state, and reports.

\set ON_ERROR_STOP on

UPDATE public.transactions
SET business_date = (booked_at AT TIME ZONE reporting.effective_store_timezone())::date
WHERE business_date IS NULL
  AND booked_at IS NOT NULL;

UPDATE public.payment_transactions
SET effective_date = (COALESCE(occurred_at, created_at) AT TIME ZONE reporting.effective_store_timezone())::date
WHERE effective_date IS NULL;

UPDATE public.transactions
SET
    status = 'open'::public.order_status,
    fulfilled_at = NULL
WHERE counterpoint_doc_ref IS NOT NULL
  AND status = 'fulfilled'::public.order_status;

UPDATE public.transactions
SET fulfilled_at = COALESCE(fulfilled_at, booked_at, created_at)
WHERE counterpoint_ticket_ref IS NOT NULL
  AND status = 'fulfilled'::public.order_status
  AND fulfilled_at IS NULL;

UPDATE public.transaction_lines tl
SET
    is_fulfilled = TRUE,
    fulfilled_at = COALESCE(tl.fulfilled_at, t.fulfilled_at, t.booked_at, t.created_at)
FROM public.transactions t
WHERE tl.transaction_id = t.id
  AND t.counterpoint_ticket_ref IS NOT NULL
  AND tl.fulfillment = 'takeaway'::public.fulfillment_type
  AND (
      tl.is_fulfilled = FALSE
      OR tl.fulfilled_at IS NULL
  );

DROP VIEW IF EXISTS reporting.transactions_core CASCADE;
CREATE OR REPLACE VIEW reporting.transactions_core AS
 SELECT t.id AS transaction_id,
    t.display_id AS transaction_display_id,
    t.booked_at,
    COALESCE(t.business_date, ((t.booked_at AT TIME ZONE reporting.effective_store_timezone()))::date) AS booked_business_date,
    rec.rec_at AS recognition_at,
    ((rec.rec_at AT TIME ZONE reporting.effective_store_timezone()))::date AS recognition_business_date,
    (t.status)::text AS status,
    t.total_price,
    t.amount_paid,
    t.balance_due,
    t.is_tax_exempt,
    t.tax_exempt_reason,
    t.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    c.email AS customer_email,
    c.phone AS customer_phone,
    op.full_name AS operator_name,
    sp.full_name AS primary_salesperson_name,
    t.created_at,
    t.fulfilled_at,
    (t.sale_channel)::text AS sale_channel,
    (t.fulfillment_method)::text AS fulfillment_method,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.company_name AS customer_company_name,
    op.full_name AS operator_display_name,
    sp.full_name AS primary_salesperson_display_name
   FROM ((((public.transactions t
     CROSS JOIN LATERAL ( SELECT reporting.order_recognition_at(t.id, (t.fulfillment_method)::text, (t.status)::text, t.fulfilled_at) AS rec_at) rec)
     LEFT JOIN public.customers c ON ((c.id = t.customer_id)))
     LEFT JOIN public.staff op ON ((op.id = t.operator_id)))
     LEFT JOIN public.staff sp ON ((sp.id = t.primary_salesperson_id)));

DROP VIEW IF EXISTS reporting.merchant_reconciliation CASCADE;
CREATE OR REPLACE VIEW reporting.merchant_reconciliation AS
 SELECT COALESCE(pt.effective_date, ((pt.created_at AT TIME ZONE reporting.effective_store_timezone()))::date) AS business_date,
    payment_provider,
    payment_method,
    count(id) AS transaction_count,
    sum(amount) AS gross_amount,
    sum(merchant_fee) AS total_merchant_fee,
    sum(net_amount) AS net_amount,
    (0)::numeric AS avg_basis_points
   FROM public.payment_transactions pt
  WHERE (payment_provider IS NOT NULL)
  GROUP BY COALESCE(pt.effective_date, ((pt.created_at AT TIME ZONE reporting.effective_store_timezone()))::date), payment_provider, payment_method
  ORDER BY COALESCE(pt.effective_date, ((pt.created_at AT TIME ZONE reporting.effective_store_timezone()))::date) DESC, payment_provider, payment_method;

DROP VIEW IF EXISTS reporting.payment_ledger CASCADE;
CREATE OR REPLACE VIEW reporting.payment_ledger AS
 WITH allocation_rollup AS (
         SELECT pa.transaction_id AS payment_transaction_id,
            count(DISTINCT pa.target_transaction_id) AS linked_transaction_count,
            min((pa.target_transaction_id)::text) FILTER (WHERE (pa.target_transaction_id IS NOT NULL)) AS primary_transaction_id_text,
            min(tc.transaction_display_id) FILTER (WHERE (tc.transaction_display_id IS NOT NULL)) AS primary_transaction_display_id,
            string_agg(DISTINCT tc.transaction_display_id, ', '::text ORDER BY tc.transaction_display_id) FILTER (WHERE (tc.transaction_display_id IS NOT NULL)) AS linked_transaction_display_ids,
            string_agg(DISTINCT COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'::text), ', '::text ORDER BY COALESCE(tc.customer_display_name, tc.customer_name, 'Walk-in / Unknown'::text)) FILTER (WHERE (tc.transaction_id IS NOT NULL)) AS linked_customer_names
           FROM (public.payment_allocations pa
             LEFT JOIN reporting.transactions_core tc ON ((tc.transaction_id = pa.target_transaction_id)))
          GROUP BY pa.transaction_id
        )
 SELECT pt.id,
    pt.id AS payment_transaction_id,
    pt.created_at,
    pt.occurred_at,
    COALESCE(pt.effective_date, ((pt.created_at AT TIME ZONE reporting.effective_store_timezone()))::date) AS business_date,
    (pt.category)::text AS category,
    pt.status,
    pt.payment_method,
    pt.check_number,
    pt.payment_provider,
    pt.provider_payment_id,
    pt.provider_status,
    pt.provider_terminal_id,
    pt.provider_transaction_id,
    pt.provider_auth_code,
    pt.provider_card_type,
    pt.amount AS gross_amount,
    pt.merchant_fee,
    pt.net_amount,
    pt.card_brand,
    pt.card_last4,
    pt.payer_id,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS payer_name,
    c.customer_code AS payer_code,
    c.phone AS payer_phone,
    c.email AS payer_email,
    (NULLIF(ar.primary_transaction_id_text, ''::text))::uuid AS linked_transaction_id,
    ar.linked_transaction_count,
    ar.primary_transaction_display_id,
    ar.linked_transaction_display_ids,
    ar.linked_customer_names
   FROM ((public.payment_transactions pt
     LEFT JOIN public.customers c ON ((c.id = pt.payer_id)))
     LEFT JOIN allocation_rollup ar ON ((ar.payment_transaction_id = pt.id)));

DROP VIEW IF EXISTS reporting.order_loyalty_accrual CASCADE;
CREATE OR REPLACE VIEW reporting.order_loyalty_accrual AS
 SELECT ola.transaction_id AS order_id,
    ola.transaction_id,
    t.display_id AS transaction_display_id,
    ola.points_earned,
    ola.product_subtotal,
    ola.created_at AS accrual_recorded_at,
    t.booked_at AS order_booked_at,
    COALESCE(t.business_date, ((t.booked_at AT TIME ZONE reporting.effective_store_timezone()))::date) AS order_business_date,
    (t.status)::text AS order_status,
    t.total_price,
    t.amount_paid,
    t.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state
   FROM ((public.transaction_loyalty_accrual ola
     JOIN public.transactions t ON ((t.id = ola.transaction_id)))
     LEFT JOIN public.customers c ON ((c.id = t.customer_id)));

COMMENT ON VIEW reporting.transactions_core IS
  'Transaction reporting core. booked_business_date uses transactions.business_date when governed corrections exist.';

COMMENT ON VIEW reporting.payment_ledger IS
  'Payment ledger with readable linkage fields. business_date uses payment_transactions.effective_date when governed corrections exist.';

COMMENT ON VIEW reporting.merchant_reconciliation IS
  'Merchant/provider payment rollup using payment_transactions.effective_date as the reconciliation business date.';
CREATE OR REPLACE VIEW reporting.daily_order_totals AS
 SELECT booked_business_date AS order_business_date,
    count(*) AS order_count,
    sum(total_price) AS gross_total,
    sum(amount_paid) AS amount_paid_total
   FROM reporting.transactions_core
  GROUP BY booked_business_date;

--
-- Name: daily_order_totals_fulfilled; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.daily_order_totals_fulfilled AS
 SELECT ((r.rec_at AT TIME ZONE reporting.effective_store_timezone()))::date AS business_date,
    count(*) AS fulfilled_order_count,
    sum(o.total_price) AS gross_total,
    sum(o.amount_paid) AS amount_paid_total
   FROM (public.transactions o
     CROSS JOIN LATERAL ( SELECT reporting.order_recognition_at(o.id, (o.fulfillment_method)::text, (o.status)::text, o.fulfilled_at) AS rec_at) r)
  WHERE (((o.status)::text <> 'cancelled'::text) AND (r.rec_at IS NOT NULL))
  GROUP BY (((r.rec_at AT TIME ZONE reporting.effective_store_timezone()))::date);

--
-- Name: daily_order_totals_recognized; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.daily_order_totals_recognized AS
 SELECT recognition_business_date AS order_recognition_business_date,
    count(*) AS completed_order_count,
    sum(total_price) AS gross_total,
    sum(amount_paid) AS amount_paid_total
   FROM reporting.transactions_core
  WHERE ((status <> 'cancelled'::text) AND (recognition_at IS NOT NULL))
  GROUP BY recognition_business_date;

--
-- Name: fulfillment_orders_core; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.fulfillment_orders_core AS
 SELECT fo.id AS fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    fo.created_at,
    fo.status AS fulfillment_status,
    fo.customer_id,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_name,
    wp.party_name AS wedding_party_name,
    fo.fulfilled_at,
    fo.notes,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email
   FROM ((public.fulfillment_orders fo
     LEFT JOIN public.customers c ON ((c.id = fo.customer_id)))
     LEFT JOIN public.wedding_parties wp ON ((wp.id = fo.wedding_id)));

--
-- Name: layaway_snapshot; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.layaway_snapshot AS
SELECT
    NULL::uuid AS order_id,
    NULL::text AS order_short_id,
    NULL::text AS customer_code,
    NULL::text AS customer_name,
    NULL::character varying(64) AS customer_phone,
    NULL::timestamp with time zone AS booked_at,
    NULL::numeric(12,2) AS total_price,
    NULL::numeric(12,2) AS amount_paid,
    NULL::numeric(12,2) AS balance_due,
    NULL::text AS order_status,
    NULL::text AS layaway_status,
    NULL::bigint AS layaway_item_count;

--
-- Name: loyalty_customer_snapshot; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.loyalty_customer_snapshot AS
 SELECT c.id AS customer_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone,
    c.email,
    c.loyalty_points AS current_balance,
    COALESCE(sum(lpl.delta_points) FILTER (WHERE ((lpl.delta_points > 0) AND (lpl.reason = 'order_earn'::text))), (0)::bigint) AS lifetime_earned_from_orders,
    (COALESCE(sum(lpl.delta_points) FILTER (WHERE ((lpl.delta_points < 0) AND (lpl.reason = 'reward_redemption'::text))), (0)::bigint) * '-1'::integer) AS lifetime_points_redeemed,
    COALESCE(sum(lpl.delta_points) FILTER (WHERE (lpl.reason = 'manual_adjust'::text)), (0)::bigint) AS net_manual_adjustments,
    COALESCE(count(lri.id), (0)::bigint) AS rewards_issued_count,
    COALESCE(sum(lri.reward_amount), (0)::numeric) AS total_reward_dollars_issued
   FROM ((public.customers c
     LEFT JOIN public.loyalty_point_ledger lpl ON ((c.id = lpl.customer_id)))
     LEFT JOIN public.loyalty_reward_issuances lri ON ((c.id = lri.customer_id)))
  GROUP BY c.id, c.customer_code, c.first_name, c.last_name, c.phone, c.email, c.loyalty_points;

--
-- Name: loyalty_daily_velocity; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.loyalty_daily_velocity AS
 WITH daily_earn AS (
         SELECT ((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date AS event_date,
            sum(loyalty_point_ledger.delta_points) AS points_earned
           FROM public.loyalty_point_ledger
          WHERE (loyalty_point_ledger.delta_points > 0)
          GROUP BY (((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date)
        ), daily_burn AS (
         SELECT ((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date AS event_date,
            (sum(loyalty_point_ledger.delta_points) * '-1'::integer) AS points_burned
           FROM public.loyalty_point_ledger
          WHERE (loyalty_point_ledger.delta_points < 0)
          GROUP BY (((loyalty_point_ledger.created_at AT TIME ZONE 'UTC'::text))::date)
        ), all_dates AS (
         SELECT daily_earn.event_date
           FROM daily_earn
        UNION
         SELECT daily_burn.event_date
           FROM daily_burn
        )
 SELECT ad.event_date,
    COALESCE(de.points_earned, (0)::bigint) AS points_earned,
    COALESCE(db.points_burned, (0)::bigint) AS points_burned,
    (COALESCE(de.points_earned, (0)::bigint) - COALESCE(db.points_burned, (0)::bigint)) AS net_velocity
   FROM ((all_dates ad
     LEFT JOIN daily_earn de ON ((ad.event_date = de.event_date)))
     LEFT JOIN daily_burn db ON ((ad.event_date = db.event_date)))
  ORDER BY ad.event_date DESC;

--
-- Name: loyalty_point_ledger; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.loyalty_point_ledger AS
 SELECT l.id,
    l.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    l.delta_points,
    l.balance_after,
    l.reason,
    l.transaction_id AS order_id,
    l.transaction_id,
    t.display_id AS transaction_display_id,
    l.created_by_staff_id,
    s.full_name AS created_by_staff_name,
    l.metadata,
    l.created_at
   FROM (((public.loyalty_point_ledger l
     JOIN public.customers c ON ((c.id = l.customer_id)))
     LEFT JOIN public.transactions t ON ((t.id = l.transaction_id)))
     LEFT JOIN public.staff s ON ((s.id = l.created_by_staff_id)));

--
-- Name: loyalty_reward_issuances; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.loyalty_reward_issuances AS
 SELECT lri.id,
    lri.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state,
    lri.points_deducted,
    lri.reward_amount,
    lri.applied_to_sale,
    lri.remainder_card_id,
    lri.transaction_id AS order_id,
    lri.transaction_id,
    t.display_id AS transaction_display_id,
    lri.issued_by_staff_id,
    s.full_name AS issued_by_staff_name,
    lri.created_at
   FROM (((public.loyalty_reward_issuances lri
     JOIN public.customers c ON ((c.id = lri.customer_id)))
     LEFT JOIN public.transactions t ON ((t.id = lri.transaction_id)))
     LEFT JOIN public.staff s ON ((s.id = lri.issued_by_staff_id)));

--
-- Name: merchant_reconciliation; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.merchant_reconciliation AS
 SELECT ((created_at AT TIME ZONE reporting.effective_store_timezone()))::date AS business_date,
    payment_provider,
    payment_method,
    count(id) AS transaction_count,
    sum(amount) AS gross_amount,
    sum(merchant_fee) AS total_merchant_fee,
    sum(net_amount) AS net_amount,
    (0)::numeric AS avg_basis_points
   FROM public.payment_transactions pt
  WHERE (payment_provider IS NOT NULL)
  GROUP BY (((created_at AT TIME ZONE reporting.effective_store_timezone()))::date), payment_provider, payment_method
  ORDER BY (((created_at AT TIME ZONE reporting.effective_store_timezone()))::date) DESC, payment_provider, payment_method;

--
-- Name: order_lines; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.order_lines AS
 SELECT tl.id AS line_id,
    tl.line_display_id,
    tl.transaction_id,
    t.transaction_display_id,
    tl.transaction_id AS order_id,
    t.transaction_display_id AS order_short_id,
    t.booked_at AS order_booked_at,
    t.booked_business_date AS order_business_date,
    t.recognition_at AS order_recognition_at,
    t.recognition_business_date AS order_recognition_business_date,
    t.status AS order_status,
    tl.quantity,
    tl.unit_price,
    (tl.unit_price * (tl.quantity)::numeric) AS line_extended_price,
    tl.unit_cost,
    (tl.unit_cost * (tl.quantity)::numeric) AS line_extended_cost,
    ((tl.unit_price * (tl.quantity)::numeric) - (tl.unit_cost * (tl.quantity)::numeric)) AS line_gross_margin_pre_tax,
    (tl.fulfillment)::text AS fulfillment,
    tl.is_fulfilled,
    tl.fulfillment_order_id,
    fo.display_id AS fulfillment_order_display_id,
    tl.product_id,
    tl.variant_id,
    p.name AS product_name,
    p.name AS product_display_name,
    pv.variation_label AS variant_display_name,
        CASE
            WHEN (NULLIF(btrim(pv.variation_label), ''::text) IS NULL) THEN p.name
            ELSE concat_ws(' - '::text, p.name, pv.variation_label)
        END AS item_display_name,
    pv.sku,
    pv.barcode,
    c.name AS category_name,
    v.name AS vendor_display_name,
    t.customer_id,
    t.customer_display_name,
    t.customer_phone,
    t.customer_email,
    tls.full_name AS line_salesperson_display_name,
    t.primary_salesperson_display_name,
    t.operator_display_name
   FROM (((((((public.transaction_lines tl
     JOIN reporting.transactions_core t ON ((t.transaction_id = tl.transaction_id)))
     LEFT JOIN public.fulfillment_orders fo ON ((fo.id = tl.fulfillment_order_id)))
     LEFT JOIN public.products p ON ((p.id = tl.product_id)))
     LEFT JOIN public.product_variants pv ON ((pv.id = tl.variant_id)))
     LEFT JOIN public.categories c ON ((c.id = p.category_id)))
     LEFT JOIN public.vendors v ON ((v.id = p.primary_vendor_id)))
     LEFT JOIN public.staff tls ON ((tls.id = tl.salesperson_id)));

--
-- Name: order_loyalty_accrual; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.order_loyalty_accrual AS
 SELECT ola.transaction_id AS order_id,
    ola.transaction_id,
    t.display_id AS transaction_display_id,
    ola.points_earned,
    ola.product_subtotal,
    ola.created_at AS accrual_recorded_at,
    t.booked_at AS order_booked_at,
    ((t.booked_at AT TIME ZONE reporting.effective_store_timezone()))::date AS order_business_date,
    (t.status)::text AS order_status,
    t.total_price,
    t.amount_paid,
    t.customer_id,
    c.customer_code,
    TRIM(BOTH FROM concat_ws(' '::text, c.first_name, c.last_name)) AS customer_display_name,
    c.phone AS customer_phone,
    c.email AS customer_email,
    c.postal_code AS customer_postal_code,
    c.city AS customer_city,
    c.state AS customer_state
   FROM ((public.transaction_loyalty_accrual ola
     JOIN public.transactions t ON ((t.id = ola.transaction_id)))
     LEFT JOIN public.customers c ON ((c.id = t.customer_id)));

--
-- Name: orders_core; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.orders_core AS
 SELECT transaction_id,
    transaction_display_id,
    booked_at,
    booked_business_date,
    recognition_at,
    recognition_business_date,
    status,
    total_price,
    amount_paid,
    balance_due,
    is_tax_exempt,
    tax_exempt_reason,
    customer_id,
    customer_code,
    customer_name,
    customer_email,
    customer_phone,
    operator_name,
    primary_salesperson_name,
    created_at,
    fulfilled_at,
    sale_channel,
    fulfillment_method,
    customer_display_name,
    customer_company_name,
    operator_display_name,
    primary_salesperson_display_name
   FROM reporting.transactions_core;

--
-- Name: orders_v1; Type: VIEW; Schema: reporting; Owner: -
--

CREATE OR REPLACE VIEW reporting.orders_v1 AS
 SELECT transaction_id,
    transaction_display_id,
    booked_at,
    booked_business_date,
    recognition_at,
    recognition_business_date,
    status,
    total_price,
    amount_paid,
    balance_due,
    is_tax_exempt,
    tax_exempt_reason,
    customer_id,
    customer_code,
    customer_name,
    customer_email,
    customer_phone,
    operator_name,
    primary_salesperson_name,
    created_at,
    fulfilled_at,
    sale_channel,
    fulfillment_method,
    customer_display_name,
    customer_company_name,
    operator_display_name,
    primary_salesperson_display_name
   FROM reporting.transactions_core;
