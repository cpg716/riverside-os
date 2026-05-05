-- Riverside OS RBAC seeds
-- Idempotent seed data. Run after schema-contract migrations.

\set ON_ERROR_STOP on

--
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: staff_role_permission; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'staff.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'staff.edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'staff.manage_pins', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'staff.manage_commission', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'staff.view_audit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'staff.manage_access', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'qbo.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'qbo.mapping_edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'qbo.staging_approve', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'qbo.sync', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'insights.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'insights.commission_finalize', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'physical_inventory.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'physical_inventory.mutate', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.edit_attribution', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'loyalty.adjust_points', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'inventory.view_cost', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'staff.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'staff.edit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'staff.manage_pins', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'staff.manage_commission', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'staff.view_audit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'staff.manage_access', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'qbo.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'qbo.mapping_edit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'qbo.staging_approve', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'qbo.sync', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'insights.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'insights.commission_finalize', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'physical_inventory.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'physical_inventory.mutate', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.edit_attribution', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'loyalty.adjust_points', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'inventory.view_cost', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'staff.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'staff.edit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'staff.manage_pins', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'staff.manage_commission', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'staff.view_audit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'staff.manage_access', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'qbo.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'qbo.mapping_edit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'qbo.staging_approve', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'qbo.sync', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'insights.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'insights.commission_finalize', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'physical_inventory.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'physical_inventory.mutate', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.edit_attribution', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'loyalty.adjust_points', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'inventory.view_cost', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.cancel', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.refund_process', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.modify', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.cancel', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.refund_process', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.modify', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.cancel', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.refund_process', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.modify', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'catalog.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'catalog.edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'procurement.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'procurement.mutate', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'settings.admin', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'gift_cards.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'loyalty.program_settings', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'weddings.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'weddings.mutate', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'register.reports', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'catalog.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'catalog.edit', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'procurement.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'procurement.mutate', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'settings.admin', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'gift_cards.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'loyalty.program_settings', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'weddings.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'weddings.mutate', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'register.reports', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'catalog.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'catalog.edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'procurement.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'procurement.mutate', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'settings.admin', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'gift_cards.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'loyalty.program_settings', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'weddings.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'weddings.mutate', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'register.reports', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.merge', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'alterations.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customer_groups.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'store_credit.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'alterations.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customer_groups.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.void_sale', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.void_sale', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.void_sale', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'orders.suit_component_swap', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'orders.suit_component_swap', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'orders.suit_component_swap', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'register.open_drawer', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'register.open_drawer', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'register.open_drawer', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'notifications.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'notifications.broadcast', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'notifications.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'notifications.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'register.shift_handoff', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'register.shift_handoff', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'register.shift_handoff', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'tasks.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'tasks.view_team', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'tasks.complete', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'tasks.view_team', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'tasks.complete', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'tasks.complete', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers_duplicate_review', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.hub_view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.hub_edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.timeline', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.measurements', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers.hub_view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers.hub_edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers.timeline', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers.measurements', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.hub_view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.hub_edit', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.timeline', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.measurements', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers_duplicate_review', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers.merge', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers_duplicate_review', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.merge', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'register.session_attach', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'register.session_attach', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'register.session_attach', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.rms_charge', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'online_store.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'online_store.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'online_store.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'shipments.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'shipments.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'shipments.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'shipments.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'shipments.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'shipments.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'help.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'help.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'help.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'reviews.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'reviews.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'reviews.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'reviews.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'reviews.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'reviews.manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.couple_manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'customers.couple_manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.couple_manage', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'wedding_manager.open', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'wedding_manager.open', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'wedding_manager.open', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'ops.dev_center.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'ops.dev_center.actions', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'ops.dev_center.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'ops.dev_center.actions', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'ops.dev_center.view', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'ops.dev_center.actions', false) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'pos.rms_charge.use', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'pos.rms_charge.lookup', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'pos.rms_charge.history_basic', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge.manage_links', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'pos.rms_charge.use', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'pos.rms_charge.lookup', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'pos.rms_charge.history_basic', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.rms_charge.view', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.rms_charge.manage_links', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('salesperson', 'pos.rms_charge.use', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'pos.rms_charge.payment_collect', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge.resolve_exceptions', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge.reconcile', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge.reverse', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('admin', 'customers.rms_charge.reporting', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'pos.rms_charge.payment_collect', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.rms_charge.resolve_exceptions', true) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_permission (role, permission_key, allowed) VALUES ('sales_support', 'customers.rms_charge.reporting', true) ON CONFLICT DO NOTHING;


--
-- Data for Name: staff_role_pricing_limits; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.staff_role_pricing_limits (role, max_discount_percent) VALUES ('admin', 100.00) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_pricing_limits (role, max_discount_percent) VALUES ('salesperson', 30.00) ON CONFLICT DO NOTHING;
INSERT INTO public.staff_role_pricing_limits (role, max_discount_percent) VALUES ('sales_support', 30.00) ON CONFLICT DO NOTHING;


--
--
