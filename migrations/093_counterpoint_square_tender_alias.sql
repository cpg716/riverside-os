-- Add Counterpoint Square tender alias observed during live import repair.
INSERT INTO public.counterpoint_payment_method_map (cp_pmt_typ, ros_method)
VALUES ('SQUARE', 'credit_card')
ON CONFLICT (cp_pmt_typ) DO UPDATE
SET ros_method = EXCLUDED.ros_method;
