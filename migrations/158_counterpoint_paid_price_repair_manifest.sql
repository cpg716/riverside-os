-- Reviewed, non-executing recovery manifest for the July 21 Counterpoint
-- lifecycle-price incident. This migration stages evidence only. Financial
-- values are changed later by the staff-gated service after a fresh manifest
-- preview, exact-value recheck, and explicit confirmation.

CREATE TABLE IF NOT EXISTS public.counterpoint_paid_price_repair_manifest (
    manifest_key TEXT PRIMARY KEY,
    transaction_id UUID NOT NULL,
    display_id TEXT NOT NULL,
    source_doc_id TEXT NOT NULL,
    expected_total NUMERIC(14,2) NOT NULL,
    expected_amount_paid NUMERIC(14,2) NOT NULL,
    expected_balance NUMERIC(14,2) NOT NULL,
    corrected_total NUMERIC(14,2) NOT NULL,
    corrected_balance NUMERIC(14,2) NOT NULL,
    line_repairs JSONB NOT NULL,
    source_manifest_digest TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT counterpoint_paid_price_repair_lines_array_chk
        CHECK (jsonb_typeof(line_repairs) = 'array'),
    CONSTRAINT counterpoint_paid_price_repair_source_digest_chk
        CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS counterpoint_paid_price_repair_transaction_uidx
    ON public.counterpoint_paid_price_repair_manifest (transaction_id);

CREATE TABLE IF NOT EXISTS public.counterpoint_paid_price_repair_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manifest_key TEXT NOT NULL UNIQUE,
    transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    repaired_by_staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    review_manifest_digest TEXT NOT NULL,
    review_manifest_candidate_count INTEGER NOT NULL
        CHECK (review_manifest_candidate_count >= 0),
    source_snapshot JSONB NOT NULL,
    result_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT counterpoint_paid_price_repair_audit_reason_chk
        CHECK (length(btrim(reason)) >= 12),
    CONSTRAINT counterpoint_paid_price_repair_review_digest_chk
        CHECK (review_manifest_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS counterpoint_paid_price_repair_audit_transaction_idx
    ON public.counterpoint_paid_price_repair_audit (transaction_id, created_at DESC);

WITH reviewed(value) AS (
    VALUES ($json$
[
  {"transaction_id":"128f04a5-f12b-4dfd-b208-cb3be97eaf78","display_id":"TXN-565982","source_doc_id":"101193590405","expected_total":"282.75","expected_amount_paid":"337.22","expected_balance":"0.00","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"179c6c8e-3fed-41af-9913-6dd23c36769d","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"3A1129F5-3EC8-4392-A680-3417A205F530","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}},{"line_id":"e506de1a-aef4-4e42-aea3-bf9ce12093eb","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"87C9E99B-3685-4340-AFFE-ECB22902A187","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101399622926","completed_ticket_no":"O-117268-01","completed_header_total":"54.47"}}]},
  {"transaction_id":"b71a3c98-ef9c-41ba-9928-5863f44246d2","display_id":"TXN-566097","source_doc_id":"101126537312","expected_total":"282.75","expected_amount_paid":"337.22","expected_balance":"0.00","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"4a975e61-2e52-431d-a6fa-090cab4c100b","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"CD75D849-BE23-40B8-B30E-A3841F446D02","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}},{"line_id":"6c8fb71a-94f0-4600-be11-34d47f4195d3","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"E10E8751-4FCE-4918-AC92-C26E2FEE3353","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101396459285","completed_ticket_no":"O-117566-01","completed_header_total":"54.47"}}]},
  {"transaction_id":"91bbf41c-5e8f-4a25-b31d-2af2fe12c6bf","display_id":"TXN-566111","source_doc_id":"101127643340","expected_total":"347.75","expected_amount_paid":"282.75","expected_balance":"65.00","corrected_total":"337.22","corrected_balance":"54.47","line_repairs":[{"line_id":"18fa3d5c-e56b-4be2-a0a7-3841d5f7583e","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"7F7AB9EE-6396-4E19-B80E-4551AF438412","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}},{"line_id":"eb8817e1-8203-451f-a335-aacc373247dd","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"D5A66226-DE93-4546-A660-B77BBD4B03DF","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101397681271","completed_ticket_no":"O-117576-01","completed_header_total":"54.47"}}]},
  {"transaction_id":"a1e58662-8d15-4464-b365-7f1b20cef474","display_id":"TXN-566169","source_doc_id":"101129672032","expected_total":"565.50","expected_amount_paid":"619.97","expected_balance":"0.00","corrected_total":"619.97","corrected_balance":"0.00","line_repairs":[{"line_id":"3a4909bc-cc1f-4552-91b3-f1499e81b51e","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"9.82","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"6639AC63-04E6-4FD3-975E-4C2E0E527526","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}},{"line_id":"706b1b96-7ffc-460d-9d71-583dcb6db9f5","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"2.46","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"30F1B9F5-EEDF-4A0B-9434-AAB5174F616C","open_line_sequence":3,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101396579894","completed_ticket_no":"O-117610-01","completed_header_total":"54.47"}},{"line_id":"71ef44f4-3511-492e-b35a-256f43c73e36","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"9.82","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"01CE7668-F735-48B0-852C-5D7FA61B7680","open_line_sequence":2,"open_quantity":1,"shipped_quantity":0}}]},
  {"transaction_id":"e89be6f8-8bf8-40a7-a7f3-b3a7d593a45a","display_id":"TXN-566195","source_doc_id":"101133408625","expected_total":"282.75","expected_amount_paid":"337.22","expected_balance":"0.00","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"34468c6c-4d7a-4598-a67a-7dcecd9d59b0","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"FA92B6CA-6959-4F3A-B92D-17E6798F0AE4","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101397651332","completed_ticket_no":"O-117628-01","completed_header_total":"54.47"}},{"line_id":"e1d71f2b-c1bc-4040-91af-e2d7be0528a8","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"A0992E0A-04AF-45BC-8C97-158A78CC8D18","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}}]},
  {"transaction_id":"63d9d24a-5c68-407e-bde6-ddfb8a1cf0d5","display_id":"TXN-566240","source_doc_id":"101134691308","expected_total":"347.75","expected_amount_paid":"337.22","expected_balance":"10.53","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"4ed4737d-4570-4ebc-90c4-b790bb8024c8","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"F5824596-3796-430C-8B60-EE0105880D4A","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}},{"line_id":"da136244-0f96-459e-97f6-95f6d2f7d4c2","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"92D034AF-3249-4A5E-8D8C-9F24E0A52A72","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101397652021","completed_ticket_no":"O-117652-01","completed_header_total":"54.47"}}]},
  {"transaction_id":"7930312c-3bb4-4c98-96ef-b3c8a4e64027","display_id":"TXN-566249","source_doc_id":"101135423782","expected_total":"282.75","expected_amount_paid":"337.22","expected_balance":"0.00","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"13d7f391-46b6-4743-a86d-bf2c7dd49ad6","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"0A647C19-23AC-41CC-8EDD-99FA06F4C1C2","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101301746150","completed_ticket_no":"O-117657-01","completed_header_total":"54.47"}},{"line_id":"eac405a8-f804-404a-aea6-825e28b82f85","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"D7B3C7A4-5449-4C65-B9FF-CA12F8AE4A47","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}}]},
  {"transaction_id":"7a7166d4-8ea0-4fb9-82a2-1140d0504680","display_id":"TXN-566339","source_doc_id":"101140464282","expected_total":"282.75","expected_amount_paid":"337.22","expected_balance":"0.00","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"b6d7b713-6a3a-4f4f-bea7-1476d7f6f775","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"011555EE-7144-43D6-A443-7BF97D619821","open_line_sequence":2,"open_quantity":1,"shipped_quantity":0}},{"line_id":"fa7c8747-7256-4704-9992-ba7b2ee7525f","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"7BCF610D-1598-40B6-906D-9AE68C87AC13","open_line_sequence":3,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101301725795","completed_ticket_no":"O-117709-01","completed_header_total":"54.47"}}]},
  {"transaction_id":"8b93572b-df7b-4259-be6b-131d0de7677b","display_id":"TXN-566474","source_doc_id":"101148642848","expected_total":"282.75","expected_amount_paid":"349.79","expected_balance":"0.00","corrected_total":"349.79","corrected_balance":"0.00","line_repairs":[{"line_id":"00d0bbea-8fed-4424-9ed0-96104cde3dde","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.00","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"602AC8CB-B7EA-48BC-ADA0-3B7D914DAC13","open_line_sequence":2,"open_quantity":1,"shipped_quantity":0}},{"line_id":"37860b91-b424-4c6e-b702-48a52b2e52cb","expected_quantity":1,"expected_unit_price":"80.00","expected_discount_amount":"0.00","expected_state_tax":"3.20","expected_local_tax":"2.15","corrected_unit_price":"64.00","corrected_discount_amount":"16.00","corrected_state_tax":"2.56","corrected_local_tax":"0.48","source_evidence":{"open_line_guid":"33C6E820-5932-451E-86D5-E0150A848563","open_line_sequence":1,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101302696866","completed_ticket_no":"O-117787-01","completed_header_total":"67.04"}}]},
  {"transaction_id":"1ff49db9-32b4-4924-8da6-f4df7373de7f","display_id":"TXN-566478","source_doc_id":"101148665096","expected_total":"282.75","expected_amount_paid":"337.22","expected_balance":"0.00","corrected_total":"337.22","corrected_balance":"0.00","line_repairs":[{"line_id":"57b219da-d696-46cf-a8b8-241f793de5e3","expected_quantity":1,"expected_unit_price":"65.00","expected_discount_amount":"0.00","expected_state_tax":"2.60","expected_local_tax":"1.95","corrected_unit_price":"52.00","corrected_discount_amount":"13.00","corrected_state_tax":"2.08","corrected_local_tax":"0.39","source_evidence":{"open_line_guid":"6A01EA7D-94CE-4C11-9B40-9A1CD6EFBEFE","open_line_sequence":2,"open_quantity":0,"shipped_quantity":1,"completed_doc_id":"101301536029","completed_ticket_no":"O-117789-01","completed_header_total":"54.47"}},{"line_id":"c780f403-d9f0-4c7e-97cc-2ccff18f6e40","expected_quantity":1,"expected_unit_price":"260.00","expected_discount_amount":"115.00","expected_state_tax":"10.40","expected_local_tax":"7.80","corrected_unit_price":"260.00","corrected_discount_amount":"115.00","corrected_state_tax":"10.40","corrected_local_tax":"12.35","source_evidence":{"open_line_guid":"699E000C-04CC-4C8A-9E1C-3E7607AC4107","open_line_sequence":1,"open_quantity":1,"shipped_quantity":0}}]}
]
$json$::jsonb)
)
INSERT INTO public.counterpoint_paid_price_repair_manifest (
    manifest_key,
    transaction_id,
    display_id,
    source_doc_id,
    expected_total,
    expected_amount_paid,
    expected_balance,
    corrected_total,
    corrected_balance,
    line_repairs,
    source_manifest_digest
)
SELECT
    '2026-07-23-lifecycle-price:' || row->>'transaction_id',
    (row->>'transaction_id')::uuid,
    row->>'display_id',
    row->>'source_doc_id',
    (row->>'expected_total')::numeric,
    (row->>'expected_amount_paid')::numeric,
    (row->>'expected_balance')::numeric,
    (row->>'corrected_total')::numeric,
    (row->>'corrected_balance')::numeric,
    row->'line_repairs',
    '2eeb299e710d94bc74ebbc8b7475d153034c1c94e81a697c70fd2ecdb2ce81a9'
FROM reviewed
CROSS JOIN LATERAL jsonb_array_elements(reviewed.value) row
ON CONFLICT (manifest_key) DO NOTHING;

COMMENT ON TABLE public.counterpoint_paid_price_repair_manifest IS
    'Reviewed external Counterpoint evidence for current imported rows affected by the July 21 lifecycle-price repair. Staging this manifest does not change any transaction, line, payment, or fulfillment value.';

COMMENT ON TABLE public.counterpoint_paid_price_repair_audit IS
    'Append-only before/after evidence for staff-confirmed Counterpoint paid-price repairs. Payments, allocations, quantities, statuses, and fulfillment values are immutable in this workflow.';
