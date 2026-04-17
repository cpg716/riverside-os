-- Staff task checklists: templates, recurring assignments, per-staff instances, checklist progress.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_recurrence') THEN
        CREATE TYPE task_recurrence AS ENUM ('daily', 'weekly', 'monthly', 'yearly');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_assignee_kind') THEN
        CREATE TYPE task_assignee_kind AS ENUM ('staff', 'role');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_instance_status') THEN
        CREATE TYPE task_instance_status AS ENUM ('open', 'completed', 'cancelled');
    END IF;
END $$;

CREATE TABLE task_checklist_template (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL
);

CREATE TABLE task_checklist_template_item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES task_checklist_template(id) ON DELETE CASCADE,
    sort_order INT NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX task_checklist_template_item_order_uidx
    ON task_checklist_template_item (template_id, sort_order);

CREATE TABLE task_assignment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES task_checklist_template(id) ON DELETE CASCADE,
    recurrence task_recurrence NOT NULL,
    recurrence_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    assignee_kind task_assignee_kind NOT NULL,
    assignee_staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,
    assignee_role staff_role,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    starts_on DATE,
    ends_on DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_assignment_assignee_chk CHECK (
        (assignee_kind = 'staff' AND assignee_staff_id IS NOT NULL AND assignee_role IS NULL)
        OR (assignee_kind = 'role' AND assignee_role IS NOT NULL AND assignee_staff_id IS NULL)
    )
);

CREATE INDEX idx_task_assignment_active ON task_assignment (active) WHERE active = TRUE;

CREATE TABLE task_instance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES task_assignment(id) ON DELETE CASCADE,
    assignee_staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    period_key TEXT NOT NULL,
    due_date DATE,
    status task_instance_status NOT NULL DEFAULT 'open',
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    title_snapshot TEXT NOT NULL DEFAULT '',
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    completed_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    UNIQUE (assignment_id, assignee_staff_id, period_key)
);

CREATE INDEX idx_task_instance_assignee_open ON task_instance (assignee_staff_id, status)
    WHERE status = 'open';

CREATE TABLE task_instance_item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_instance_id UUID NOT NULL REFERENCES task_instance(id) ON DELETE CASCADE,
    template_item_id UUID REFERENCES task_checklist_template_item(id) ON DELETE SET NULL,
    sort_order INT NOT NULL,
    label TEXT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    done_at TIMESTAMPTZ,
    done_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    UNIQUE (task_instance_id, sort_order)
);

CREATE INDEX idx_task_instance_item_instance ON task_instance_item (task_instance_id);

-- RBAC: admin manages templates/assignments; sales_support sees team; all roles may complete assigned work.
INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'tasks.manage', true),
    ('admin', 'tasks.view_team', true),
    ('admin', 'tasks.complete', true),
    ('sales_support', 'tasks.view_team', true),
    ('sales_support', 'tasks.complete', true),
    ('salesperson', 'tasks.complete', true)
ON CONFLICT (role, permission_key) DO NOTHING;
