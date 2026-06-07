export function setWeddingManagerAuthHeadersProvider(
  fn: null | (() => HeadersInit),
): void;

export interface WmMember {
  id: string;
  partyId: string;
  name: string;
  firstName: string;
  lastName: string;
  customerId: string;
  customerEmail: string;
  role: string;
  phone: string;
  status: string;
  measured: boolean;
  ordered: boolean;
  received: boolean;
  fitting: boolean;
  pickup: 0 | 1 | "partial";
  suit: string;
  waist: string;
  vest: string;
  shirt: string;
  shoe: string;
  notes: string;
}

export interface WmParty {
  id: string;
  name: string;
  trackingLabel: string;
  groomFirstName: string;
  date: string;
  signUpDate: string;
  salesperson: string;
  styleInfo: string;
  priceInfo: string;
  brideName: string;
  bridePhone: string;
  brideEmail: string;
  groomPhone: string;
  groomEmail: string;
  notes: string;
  accessories: Record<string, unknown>;
  type: string;
  isDeleted: boolean;
  members: WmMember[];
}

export interface WmPaginationParams {
  page?: number;
  limit?: number;
  search?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface WmPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface WmHealthScore {
  wedding_id: string;
  overall_score: number;
  status: 'healthy' | 'concern' | 'critical';
  payment_progress: number;
  measurement_progress: number;
  days_until_event: number;
  member_count: number;
  measured_count: number;
  reason: string;
}

export type WmReadinessStatus = 'safe' | 'watch' | 'at_risk' | 'critical' | 'complete';

export interface WmReadinessBlocker {
  severity: 'blocking' | 'warning' | 'info';
  label: string;
  explanation: string;
  next_safe_action: string;
}

export interface WmReadinessSummary {
  wedding_party_id: string;
  party_name: string;
  event_date: string;
  salesperson?: string | null;
  days_until_event: number;
  readiness_score: number;
  status: WmReadinessStatus;
  lifecycle: {
    needs_measurements: number;
    ntbo: number;
    ordered: number;
    received: number;
    ready_for_pickup: number;
    picked_up: number;
    open: number;
  };
  member_counts: {
    total: number;
    measured: number;
    ordered: number;
    received: number;
    fitting: number;
    pickup_complete: number;
  };
  pickup: {
    ready_members: number;
    blocked_members: number;
    partial_ready_members: number;
    balance_blocked_members: number;
  };
  vendor_risk: {
    ntbo_count: number;
    stale_ordered_count: number;
    missing_vendor_count: number;
    delayed_vendor_count: number;
    next_eta?: string | null;
  };
  blockers: WmReadinessBlocker[];
  next_safe_action: string;
}

export interface WmReadinessMember {
  wedding_member_id: string;
  customer_name: string;
  role: string;
  status: 'ready' | 'partial' | 'blocked' | 'balance_blocked' | 'complete';
  balance_due: string | number;
  lifecycle: NonNullable<WmReadinessSummary['lifecycle']>;
  blockers: WmReadinessBlocker[];
  next_safe_action: string;
}

export interface WmReadinessDetail extends WmReadinessSummary {
  members: WmReadinessMember[];
}

export interface WmReadinessDashboard {
  safe_count: number;
  watch_count: number;
  at_risk_count: number;
  critical_count: number;
  complete_count: number;
  parties: WmReadinessSummary[];
}

export interface WmCutoverPartySummary {
  party_id: string;
  party_name: string;
  event_date: string;
  salesperson?: string | null;
  review_status: 'not_required' | 'needs_review' | 'in_review' | 'blocked' | 'reviewed';
  member_count: number;
  linked_transaction_count: number;
  candidate_transaction_count: number;
  needs_measurements: number;
  ntbo: number;
  ordered: number;
  received: number;
  ready_for_pickup: number;
  picked_up: number;
}

export interface WmCutoverMember {
  member_id: string;
  customer_id?: string | null;
  name: string;
  role: string;
  phone?: string | null;
  customer_verified: boolean;
}

export interface WmCutoverCandidate {
  suggested_member_id: string;
  transaction_id: string;
  display_id: string;
  booked_at: string;
  total_price: string | number;
  balance_due: string | number;
  customer_name: string;
  customer_code?: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  lines: Array<Record<string, unknown>>;
}

export interface WmCutoverPartyDetail {
  party: WmCutoverPartySummary;
  members: WmCutoverMember[];
  candidates: WmCutoverCandidate[];
}

export interface WmStaffSelectorRow {
  id: string;
  full_name: string;
  role?: string | null;
}

export const api: {
  getSalespeople: () => Promise<string[]>;
  getSalespeopleRows: () => Promise<WmStaffSelectorRow[]>;
  getSalespeopleForAppointments: () => Promise<string[]>;
  getAppointmentStaffRows: () => Promise<WmStaffSelectorRow[]>;
  getParties: (params?: WmPaginationParams) => Promise<{ data: WmParty[]; pagination: WmPagination }>;
  getParty: (id: string) => Promise<WmParty | null>;
  getWeddingHealth: (id: string) => Promise<WmHealthScore>;
  getReadinessDashboard: (params?: WmPaginationParams) => Promise<WmReadinessDashboard>;
  getPartyReadiness: (id: string) => Promise<WmReadinessDetail>;
  getCutoverSummary: () => Promise<{ parties: WmCutoverPartySummary[] }>;
  getPartyCutover: (id: string) => Promise<WmCutoverPartyDetail>;
  linkCutoverTransaction: (payload: Record<string, unknown>) => Promise<{ status: string; line_count: number }>;
  markCutoverReviewed: (partyId: string, payload: Record<string, unknown>) => Promise<{ status: string }>;
  updateParty: (id: string, updates: Partial<WmParty>) => Promise<WmParty>;
  updateMember: (id: string, updates: Partial<WmMember>) => Promise<WmMember>;
  addMember: (partyId: string, memberData: Partial<WmMember>) => Promise<WmMember>;
  deleteParty: (id: string, actor: string) => Promise<{ ok: boolean }>;
  deleteMember: (id: string, actor: string) => Promise<{ ok: boolean }>;
  [key: string]: unknown;
};
