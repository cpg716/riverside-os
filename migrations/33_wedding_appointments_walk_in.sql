-- Allow appointments for ROS customers who are not (yet) on an active wedding party row.
ALTER TABLE wedding_appointments
  ALTER COLUMN wedding_party_id DROP NOT NULL,
  ALTER COLUMN wedding_member_id DROP NOT NULL;

ALTER TABLE wedding_appointments
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wedding_appts_customer ON wedding_appointments (customer_id)
  WHERE customer_id IS NOT NULL;
