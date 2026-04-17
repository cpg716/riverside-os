import { Customer } from "../pos/CustomerSelector";

export interface CustomerPipelineStats {
  total_customers: number;
  vip_customers: number;
  with_balance: number;
  upcoming_weddings: number;
}

export interface CustomerBrowseRow {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_vip: boolean;
  open_balance_due: string;
  lifetime_sales: string;
  open_orders_count: number;
  active_shipment_status: string | null;
  wedding_soon: boolean;
  wedding_active: boolean;
  wedding_party_name: string | null;
  wedding_party_id: string | null;
}

export function rowToCustomer(r: CustomerBrowseRow): Customer {
  return {
    id: r.id,
    customer_code: r.customer_code,
    first_name: r.first_name,
    last_name: r.last_name,
    company_name: r.company_name,
    email: r.email,
    phone: r.phone,
  };
}

export interface DuplicateCandidateRow {
  id: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  match_reason: string;
}

export interface CustomerGroup {
  id: string;
  code: string;
  label: string;
}
