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
