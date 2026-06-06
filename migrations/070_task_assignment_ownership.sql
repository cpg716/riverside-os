-- Track who assigned task work so overdue/unresolved reporting can route back
-- to the responsible manager/assigner.

ALTER TABLE public.task_assignment
  ADD COLUMN IF NOT EXISTS assigned_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL;

ALTER TABLE public.task_instance
  ADD COLUMN IF NOT EXISTS assigned_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_task_assignment_assigned_by
  ON public.task_assignment (assigned_by_staff_id)
  WHERE assigned_by_staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_instance_assigned_by_open_due
  ON public.task_instance (assigned_by_staff_id, due_date)
  WHERE status = 'open'::public.task_instance_status
    AND assigned_by_staff_id IS NOT NULL;

COMMENT ON COLUMN public.task_assignment.assigned_by_staff_id IS
  'Staff member who created the recurring task assignment.';

COMMENT ON COLUMN public.task_instance.assigned_by_staff_id IS
  'Staff member who should be notified when this materialized task is overdue and unfinished.';
