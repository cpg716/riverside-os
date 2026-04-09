-- Per-manual Help Center overrides (body/title/summary), visibility, and RBAC gates.
-- Default gates are computed in app code from manual id; NULL columns inherit defaults.

CREATE TABLE help_manual_policy (
    manual_id TEXT PRIMARY KEY,
    hidden BOOLEAN NOT NULL DEFAULT false,
    title_override TEXT NULL,
    summary_override TEXT NULL,
    markdown_override TEXT NULL,
    order_override INT NULL,
    required_permissions TEXT[] NULL,
    allow_register_session BOOLEAN NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_staff_id UUID NULL REFERENCES staff (id) ON DELETE SET NULL
);

CREATE INDEX help_manual_policy_hidden_idx ON help_manual_policy (hidden) WHERE hidden = true;

COMMENT ON TABLE help_manual_policy IS 'Help Center manual policy: overrides and visibility. NULL permission array = use server default for manual id.';

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'help.manage', true),
    ('salesperson', 'help.manage', false),
    ('sales_support', 'help.manage', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
