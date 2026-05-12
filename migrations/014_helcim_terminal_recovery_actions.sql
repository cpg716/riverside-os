-- Append-only review history for Helcim terminal/webhook recovery work.
-- These rows are audit notes only; they do not mutate attempts, webhook rows, or ledgers.

CREATE TABLE IF NOT EXISTS public.helcim_terminal_recovery_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_kind text NOT NULL,
    source_id uuid NOT NULL,
    action text NOT NULL,
    note text,
    actor_staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT helcim_terminal_recovery_actions_pkey PRIMARY KEY (id),
    CONSTRAINT helcim_terminal_recovery_actions_source_kind_chk CHECK (
        source_kind = ANY (ARRAY['payment_provider_attempt'::text, 'helcim_event'::text])
    ),
    CONSTRAINT helcim_terminal_recovery_actions_action_chk CHECK (
        action = ANY (
            ARRAY[
                'reviewed'::text,
                'noted'::text,
                'resolved_no_action'::text,
                'provider_charge_confirmed'::text,
                'duplicate_suspected'::text,
                'refund_required'::text,
                'replayed_webhook'::text
            ]
        )
    ),
    CONSTRAINT helcim_terminal_recovery_actions_note_chk CHECK (
        action = 'reviewed'::text OR NULLIF(btrim(COALESCE(note, ''::text)), ''::text) IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_helcim_terminal_recovery_actions_source
    ON public.helcim_terminal_recovery_actions (source_kind, source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_helcim_terminal_recovery_actions_actor
    ON public.helcim_terminal_recovery_actions (actor_staff_id, created_at DESC)
    WHERE actor_staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_helcim_terminal_recovery_actions_created
    ON public.helcim_terminal_recovery_actions (created_at DESC);

COMMENT ON TABLE public.helcim_terminal_recovery_actions IS
    'Append-only staff review actions for Helcim terminal/webhook recovery items. Review-only; no ledger, attempt, or webhook mutation.';
