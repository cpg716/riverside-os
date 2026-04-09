-- Extended RBAC: catalog, procurement, settings, gift cards, loyalty program, weddings, register reports.
-- Admin role bypasses in app code; seeds define defaults for salesperson / sales_support.

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'catalog.view', true),
    ('admin', 'catalog.edit', true),
    ('admin', 'procurement.view', true),
    ('admin', 'procurement.mutate', true),
    ('admin', 'settings.admin', true),
    ('admin', 'gift_cards.manage', true),
    ('admin', 'loyalty.program_settings', true),
    ('admin', 'weddings.view', true),
    ('admin', 'weddings.mutate', true),
    ('admin', 'register.reports', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('salesperson', 'catalog.view', true),
    ('salesperson', 'catalog.edit', false),
    ('salesperson', 'procurement.view', true),
    ('salesperson', 'procurement.mutate', false),
    ('salesperson', 'settings.admin', false),
    ('salesperson', 'gift_cards.manage', false),
    ('salesperson', 'loyalty.program_settings', false),
    ('salesperson', 'weddings.view', true),
    ('salesperson', 'weddings.mutate', false),
    ('salesperson', 'register.reports', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('sales_support', 'catalog.view', true),
    ('sales_support', 'catalog.edit', true),
    ('sales_support', 'procurement.view', true),
    ('sales_support', 'procurement.mutate', true),
    ('sales_support', 'settings.admin', true),
    ('sales_support', 'gift_cards.manage', true),
    ('sales_support', 'loyalty.program_settings', true),
    ('sales_support', 'weddings.view', true),
    ('sales_support', 'weddings.mutate', true),
    ('sales_support', 'register.reports', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
