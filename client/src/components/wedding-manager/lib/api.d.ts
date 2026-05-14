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
  lifecycle?: {
    ntbo: number;
    ordered: number;
    received: number;
    ready_for_pickup: number;
    picked_up: number;
    open: number;
  };
  pickup?: {
    ready_members: number;
    blocked_members: number;
    partial_ready_members: number;
    balance_blocked_members: number;
  };
  blockers: WmReadinessBlocker[];
  next_safe_action: string;
}

export interface WmReadinessDashboard {
  safe_count: number;
  watch_count: number;
  at_risk_count: number;
  critical_count: number;
  complete_count: number;
  parties: WmReadinessSummary[];
}

export const api: {
  getSalespeople: () => Promise<string[]>;
  getParties: (params?: WmPaginationParams) => Promise<{ data: WmParty[]; pagination: WmPagination }>;
  getParty: (id: string) => Promise<WmParty | null>;
  getWeddingHealth: (id: string) => Promise<WmHealthScore>;
  getReadinessDashboard: (params?: WmPaginationParams) => Promise<WmReadinessDashboard>;
  getPartyReadiness: (id: string) => Promise<unknown>;
  updateParty: (id: string, updates: Partial<WmParty>) => Promise<WmParty>;
  updateMember: (id: string, updates: Partial<WmMember>) => Promise<WmMember>;
  addMember: (partyId: string, memberData: Partial<WmMember>) => Promise<WmMember>;
  deleteParty: (id: string, actor: string) => Promise<{ ok: boolean }>;
  deleteMember: (id: string, actor: string) => Promise<{ ok: boolean }>;
  [key: string]: unknown;
};
