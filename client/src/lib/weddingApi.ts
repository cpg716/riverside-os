import { getBaseUrl } from "./apiConfig";
const baseUrl = getBaseUrl();

/** Normalized appointment for scheduler / modals (camelCase). */
export type WeddingAppointmentClient = {
  id: string;
  datetime: string;
  customerName?: string | null;
  phone?: string | null;
  type: string;
  status: string;
  salesperson?: string | null;
  memberId?: string | null;
  partyId?: string | null;
  customerId?: string | null;
  notes?: string;
};

function mapAppointmentRow(a: Record<string, unknown>): WeddingAppointmentClient {
  return {
    id: String(a.id),
    datetime: String(a.starts_at ?? a.datetime ?? ""),
    customerName: (a.customer_display_name as string) ?? null,
    phone: (a.phone as string) ?? null,
    type: String(a.appointment_type ?? a.type ?? "Measurement"),
    status: String(a.status ?? "Scheduled"),
    salesperson: (a.salesperson as string) ?? null,
    memberId: a.wedding_member_id != null ? String(a.wedding_member_id) : null,
    partyId: a.wedding_party_id != null ? String(a.wedding_party_id) : null,
    customerId: a.customer_id != null ? String(a.customer_id) : null,
    notes: (a.notes as string) ?? "",
  };
}

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

export type WeddingApiFetchOpts = { headers?: HeadersInit };

export const weddingApi = {
  async getParties(params: { search?: string; headers?: Record<string, string> } = {}) {
    const q = new URLSearchParams();
    if (params.search) q.set("search", params.search);
    const res = await fetch(`${baseUrl}/api/weddings/parties?${q}`, {
      headers: params.headers,
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
    opts?: { limit?: number; offset?: number; headers?: HeadersInit },
  ): Promise<RosCustomerSearchHit[]> {
    const trimmed = q.trim();
    if (trimmed.length < 2) return [];
    const params = new URLSearchParams({ q: trimmed });
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const res = await fetch(`${baseUrl}/api/customers/search?${params}`, {
      headers: opts?.headers,
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
      type?: string;
      datetime?: string;
      notes?: string | null;
      status?: string;
      salesperson?: string | null;
    },
    opts?: WeddingApiFetchOpts,
  ) {
    const payload: Record<string, unknown> = {
      customer_display_name: data.customerName?.trim() ?? undefined,
      phone: data.phone?.trim() ?? undefined,
      appointment_type: data.type,
      notes: data.notes?.trim() ?? undefined,
      status: data.status,
      salesperson: data.salesperson?.trim() ?? undefined,
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
    params: { from?: string; to?: string; headers?: Record<string, string> } = {},
  ): Promise<WeddingAppointmentClient[]> {
    const q = new URLSearchParams();
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    const res = await fetch(`${baseUrl}/api/weddings/appointments?${q}`, {
      headers: params.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch appointments");
    const rows: Record<string, unknown>[] = await res.json();
    return rows.map(mapAppointmentRow);
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
