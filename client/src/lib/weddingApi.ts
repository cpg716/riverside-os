import { getBaseUrl } from "./apiConfig";
const baseUrl = getBaseUrl();

/** Normalized appointment for scheduler / modals (camelCase). */
export type WeddingAppointmentClient = {
  id: string;
  datetime: string;
  endsAt: string;
  customerName?: string | null;
  phone?: string | null;
  type: string;
  status: string;
  salesperson?: string | null;
  salespersonStaffId?: string | null;
  memberId?: string | null;
  partyId?: string | null;
  customerId?: string | null;
  notes?: string;
  serviceTypeId?: string | null;
  resourceIds: string[];
  revision: number;
};

function mapAppointmentRow(a: Record<string, unknown>): WeddingAppointmentClient {
  return {
    id: String(a.id),
    datetime: String(a.starts_at ?? a.datetime ?? ""),
    endsAt: String(a.ends_at ?? a.endsAt ?? a.starts_at ?? a.datetime ?? ""),
    customerName: (a.customer_display_name as string) ?? null,
    phone: (a.phone as string) ?? null,
    type: String(a.appointment_type ?? a.type ?? "Measurement"),
    status: String(a.status ?? "Scheduled"),
    salesperson: (a.salesperson as string) ?? null,
    salespersonStaffId: a.salesperson_staff_id != null ? String(a.salesperson_staff_id) : null,
    memberId: a.wedding_member_id != null ? String(a.wedding_member_id) : null,
    partyId: a.wedding_party_id != null ? String(a.wedding_party_id) : null,
    customerId: a.customer_id != null ? String(a.customer_id) : null,
    notes: (a.notes as string) ?? "",
    serviceTypeId: a.service_type_id != null ? String(a.service_type_id) : null,
    resourceIds: Array.isArray(a.resource_ids) ? a.resource_ids.map(String) : [],
    revision: Number(a.revision ?? 1),
  };
}

export type AppointmentServiceType = {
  id: string;
  code: string;
  display_name: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
};

export type AppointmentResource = {
  id: string;
  name: string;
  capacity: number;
  notes?: string | null;
};

export type AppointmentConflict = {
  appointment_id: string;
  customer_display_name?: string | null;
  appointment_type: string;
  starts_at: string;
  ends_at: string;
  salesperson?: string | null;
  salesperson_staff_id?: string | null;
  resource_names: string[];
};

export type RosCustomerSearchHit = {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  wedding_active: boolean;
  wedding_party_name?: string | null;
  wedding_party_id?: string | null;
  wedding_member_id?: string | null;
};

export type WeddingApiFetchOpts = { headers?: HeadersInit; signal?: AbortSignal };

export type AppointmentStaffRow = {
  id: string;
  full_name: string;
  role?: string | null;
};

export const weddingApi = {
  async getParties(params: { search?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const q = new URLSearchParams();
    if (params.search) q.set("search", params.search);
    const res = await fetch(`${baseUrl}/api/weddings/parties?${q}`, {
      headers: params.headers,
      signal: params.signal,
    });
    if (!res.ok) throw new Error("Failed to fetch parties");
    return res.json();
  },

  async getParty(id: string, opts?: WeddingApiFetchOpts) {
    const res = await fetch(`${baseUrl}/api/weddings/parties/${id}`, {
      headers: opts?.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch party");
    return res.json();
  },

  async updateMember(id: string, data: Record<string, unknown>, opts?: WeddingApiFetchOpts) {
    const headers = new Headers(opts?.headers ?? undefined);
    headers.set("Content-Type", "application/json");
    const res = await fetch(`${baseUrl}/api/weddings/members/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Failed to update member");
    return res.json();
  },

  /** ROS customer directory (min 2 chars). Supports `limit` / `offset` (server defaults: 25 / 0; max limit 100). */
  async searchCustomers(
    q: string,
    opts?: { limit?: number; offset?: number; headers?: HeadersInit; signal?: AbortSignal },
  ): Promise<RosCustomerSearchHit[]> {
    const trimmed = q.trim();
    if (trimmed.length < 2) return [];
    const params = new URLSearchParams({ q: trimmed });
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const res = await fetch(`${baseUrl}/api/customers/search?${params}`, {
      headers: opts?.headers,
      signal: opts?.signal,
    });
    if (res.status === 400) return [];
    if (!res.ok) throw new Error("Failed to search customers");
    return res.json();
  },

  async addAppointment(
    data: {
      memberId?: string | null;
      customerId?: string | null;
      datetime: string;
      customerName?: string | null;
      phone?: string | null;
      type?: string;
      notes?: string | null;
      status?: string;
      salesperson?: string | null;
      salespersonStaffId?: string | null;
      scheduleOverrideReason?: string | null;
      conflictOverrideReason?: string | null;
      durationMinutes?: number;
      serviceTypeId?: string | null;
      resourceIds?: string[];
    },
    opts?: WeddingApiFetchOpts,
  ) {
    const payload = {
      wedding_member_id: data.memberId?.trim() || null,
      customer_id: data.customerId?.trim() || null,
      customer_display_name: data.customerName?.trim() || null,
      phone: data.phone?.trim() || null,
      appointment_type: data.type ?? "Measurement",
      starts_at: new Date(data.datetime).toISOString(),
      notes: data.notes?.trim() || null,
      status: data.status || "Scheduled",
      salesperson: data.salesperson?.trim() || null,
      salesperson_staff_id: data.salespersonStaffId?.trim() || null,
      schedule_override_reason: data.scheduleOverrideReason?.trim() || null,
      conflict_override_reason: data.conflictOverrideReason?.trim() || null,
      duration_minutes: data.durationMinutes,
      service_type_id: data.serviceTypeId?.trim() || null,
      resource_ids: data.resourceIds ?? [],
    };
    const headers = new Headers(opts?.headers ?? undefined);
    headers.set("Content-Type", "application/json");
    const res = await fetch(`${baseUrl}/api/weddings/appointments`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Failed to create appointment");
    }
    return res.json();
  },

  async updateAppointment(
    id: string,
    data: {
      customerName?: string | null;
      phone?: string | null;
      memberId?: string | null;
      customerId?: string | null;
      type?: string;
      datetime?: string;
      notes?: string | null;
      status?: string;
      salesperson?: string | null;
      salespersonStaffId?: string | null;
      scheduleOverrideReason?: string | null;
      conflictOverrideReason?: string | null;
      cancellationReason?: string | null;
      durationMinutes?: number;
      serviceTypeId?: string | null;
      resourceIds?: string[];
      expectedRevision?: number;
      completeMemberMilestone?: boolean;
      clearWeddingLink?: boolean;
      clearCustomerLink?: boolean;
      clearSalesperson?: boolean;
    },
    opts?: WeddingApiFetchOpts,
  ) {
    const payload: Record<string, unknown> = {
      customer_display_name: data.customerName?.trim() ?? undefined,
      phone: data.phone?.trim() ?? undefined,
      wedding_member_id: data.memberId?.trim() || undefined,
      customer_id: data.customerId?.trim() || undefined,
      appointment_type: data.type,
      notes: data.notes?.trim() ?? undefined,
      status: data.status,
      salesperson: data.salesperson?.trim() ?? undefined,
      salesperson_staff_id: data.salespersonStaffId?.trim() || undefined,
      schedule_override_reason: data.scheduleOverrideReason?.trim() || undefined,
      conflict_override_reason: data.conflictOverrideReason?.trim() || undefined,
      cancellation_reason: data.cancellationReason?.trim() || undefined,
      duration_minutes: data.durationMinutes,
      service_type_id: data.serviceTypeId?.trim() || undefined,
      resource_ids: data.resourceIds,
      expected_revision: data.expectedRevision,
      complete_member_milestone: data.completeMemberMilestone ?? false,
      clear_wedding_link: data.clearWeddingLink ?? false,
      clear_customer_link: data.clearCustomerLink ?? false,
      clear_salesperson: data.clearSalesperson ?? false,
    };
    if (data.datetime) {
      payload.starts_at = new Date(data.datetime).toISOString();
    }
    const headers = new Headers(opts?.headers ?? undefined);
    headers.set("Content-Type", "application/json");
    const res = await fetch(`${baseUrl}/api/weddings/appointments/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Failed to update appointment");
    }
    return res.json();
  },

  async deleteAppointment(id: string, opts?: WeddingApiFetchOpts) {
    const res = await fetch(`${baseUrl}/api/weddings/appointments/${id}`, {
      method: "DELETE",
      headers: opts?.headers,
    });
    if (!res.ok) throw new Error("Failed to delete appointment");
  },

  async getAppointment(
    id: string,
    opts?: WeddingApiFetchOpts,
  ): Promise<WeddingAppointmentClient> {
    const res = await fetch(`${baseUrl}/api/weddings/appointments/${id}`, {
      headers: opts?.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch appointment");
    const row: Record<string, unknown> = await res.json();
    return mapAppointmentRow(row);
  },

  async getAppointments(
    params: {
      from?: string;
      to?: string;
      partyId?: string;
      memberId?: string;
      customerId?: string;
      resourceId?: string;
      status?: string;
      limit?: number;
      offset?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<WeddingAppointmentClient[]> {
    const q = new URLSearchParams();
    if (params.from) q.set("from", new Date(params.from).toISOString());
    if (params.to) q.set("to", new Date(params.to).toISOString());
    if (params.partyId) q.set("party_id", params.partyId);
    if (params.memberId) q.set("member_id", params.memberId);
    if (params.customerId) q.set("customer_id", params.customerId);
    if (params.resourceId) q.set("resource_id", params.resourceId);
    if (params.status) q.set("status", params.status);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    const res = await fetch(`${baseUrl}/api/weddings/appointments?${q}`, {
      headers: params.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch appointments");
    const rows: Record<string, unknown>[] = await res.json();
    return rows.map(mapAppointmentRow);
  },

  async getAppointmentServiceTypes(opts?: WeddingApiFetchOpts): Promise<AppointmentServiceType[]> {
    const res = await fetch(`${baseUrl}/api/weddings/appointments/service-types`, {
      headers: opts?.headers,
      signal: opts?.signal,
    });
    if (!res.ok) throw new Error("Failed to fetch appointment service types");
    return res.json();
  },

  async getAppointmentResources(opts?: WeddingApiFetchOpts): Promise<AppointmentResource[]> {
    const res = await fetch(`${baseUrl}/api/weddings/appointments/resources`, {
      headers: opts?.headers,
      signal: opts?.signal,
    });
    if (!res.ok) throw new Error("Failed to fetch appointment resources");
    return res.json();
  },

  async saveAppointmentResource(
    data: { id?: string; name: string; capacity: number; notes?: string | null; isActive?: boolean },
    opts?: WeddingApiFetchOpts,
  ): Promise<AppointmentResource> {
    const headers = new Headers(opts?.headers ?? undefined);
    headers.set("Content-Type", "application/json");
    const res = await fetch(
      data.id
        ? `${baseUrl}/api/weddings/appointments/resources/${data.id}`
        : `${baseUrl}/api/weddings/appointments/resources`,
      {
        method: data.id ? "PATCH" : "POST",
        headers,
        body: JSON.stringify({
          name: data.name,
          capacity: data.capacity,
          notes: data.notes?.trim() || null,
          is_active: data.isActive ?? true,
        }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Failed to save appointment resource");
    }
    return res.json();
  },

  async getAppointmentConflicts(
    params: { from: string; to: string; headers?: Record<string, string> },
  ): Promise<AppointmentConflict[]> {
    const q = new URLSearchParams({
      from: new Date(params.from).toISOString(),
      to: new Date(params.to).toISOString(),
    });
    const res = await fetch(`${baseUrl}/api/weddings/appointments/conflicts?${q}`, {
      headers: params.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch appointment conflicts");
    return res.json();
  },

  async attachOrderToWedding(
    data: {
      orderId: string;
      weddingPartyId?: string | null;
      newPartyInfo?: {
        party_name?: string | null;
        groom_name: string;
        event_date: string;
        venue?: string | null;
        notes?: string | null;
        party_type?: string | null;
      } | null;
      role: string;
      actorName?: string | null;
    },
    opts?: WeddingApiFetchOpts,
  ) {
    const payload = {
      order_id: data.orderId,
      wedding_party_id: data.weddingPartyId || null,
      new_party_info: data.newPartyInfo || null,
      role: data.role,
      actor_name: data.actorName || null,
    };
    const headers = new Headers(opts?.headers ?? undefined);
    headers.set("Content-Type", "application/json");
    const res = await fetch(`${baseUrl}/api/weddings/attach-order`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Failed to attach order to wedding");
    }
    return res.json();
  },

  /**
   * Active floor staff (salesperson + sales support), for appointment attribution — aligned with schedule rules.
   */
  async getSalespeople(opts?: WeddingApiFetchOpts): Promise<string[]> {
    const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
      headers: opts?.headers,
    });
    if (!res.ok) return [];
    const rows: { full_name?: string; role?: string }[] = await res.json();
    const names = rows
      .filter((r) => r.role === "salesperson" || r.role === "sales_support")
      .map((r) => String(r.full_name ?? "").trim())
      .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  },

  async getAppointmentStaff(opts?: WeddingApiFetchOpts): Promise<AppointmentStaffRow[]> {
    const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
      headers: opts?.headers,
    });
    if (!res.ok) return [];
    const rows: AppointmentStaffRow[] = await res.json();
    return rows
      .filter((r) => r.role === "salesperson" || r.role === "sales_support")
      .filter((r) => r.id && String(r.full_name ?? "").trim())
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  },

  /** Search inventory for wedding suit products */
  async searchWeddingProducts(
    params: { q?: string; limit?: number; offset?: number; headers?: Record<string, string> } = {},
  ): Promise<{
    variant_id: string;
    product_id: string;
    sku: string;
    name: string;
    variation_label: string | null;
    retail_price: string;
    stock_on_hand: number;
  }[]> {
    const q = new URLSearchParams();
    if (params.q) q.set("q", params.q);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    const res = await fetch(`${baseUrl}/api/inventory/wedding-products?${q}`, {
      headers: params.headers,
    });
    if (!res.ok) throw new Error("Failed to search wedding products");
    return res.json();
  },
};
