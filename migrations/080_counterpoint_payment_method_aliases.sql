-- Seed Counterpoint payment method aliases observed in real Riverside data.

INSERT INTO public.counterpoint_payment_method_map (cp_pmt_typ, ros_method)
VALUES
  ('CREDITCARD', 'credit_card')
ON CONFLICT (cp_pmt_typ) DO NOTHING;
