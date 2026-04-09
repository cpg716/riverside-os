import {
  partyIdFromWeddingCreateResponse,
  splitWeddingPartyWithMembers,
} from "../../../lib/weddingPartyApiShape";
import { formatWeddingPartyTrackingLabel } from "../../../lib/weddingPartyDisplay";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
const API_URL = `${API_BASE}/api`;

const WM_CLIENT_KEY = "ros_wm_client_id";

/** @type {null | (() => Record<string, string>)} */
let weddingManagerAuthHeadersProvider = null;

/**
 * Registers Back Office staff headers for all wedding-manager fetches and for the live events stream
 * (native EventSource cannot send `x-riverside-staff-*` headers, so we use fetch + streaming).
 * @param {null | (() => Record<string, string>)} fn
 */
export function setWeddingManagerAuthHeadersProvider(fn) {
  weddingManagerAuthHeadersProvider = typeof fn === "function" ? fn : null;
}

function mergeAuthHeaders(headers) {
  if (!weddingManagerAuthHeadersProvider) return;
  try {
    const extra = weddingManagerAuthHeadersProvider();
    if (!extra || typeof extra !== "object") return;
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && String(v).trim() !== "") headers.set(k, String(v));
    }
  } catch {
    /* ignore */
  }
}

function getWeddingClientId() {
  try {
    let id = sessionStorage.getItem(WM_CLIENT_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `wm-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      sessionStorage.setItem(WM_CLIENT_KEY, id);
    }
    return id;
  } catch {
    return `wm-${Date.now()}`;
  }
}

/**
 * Wedding live refresh via SSE (`GET /api/weddings/events`).
 * Exposes the same shape as the legacy Socket.IO client: on/off, connected, id (for echo suppression).
 */
function createWeddingEventSocket() {
  /** @type {Map<string, Set<(data?: unknown) => void>>} */
  const listeners = new Map();
  /** @type {AbortController | null} */
  let abortCtrl = null;
  let reading = false;

  function dispatch(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch (_) {
        /* ignore subscriber errors */
      }
    }
  }

  async function startSseReader() {
    if (reading) return;
    reading = true;
    abortCtrl = new AbortController();
    const url = `${API_BASE}/api/weddings/events`;
    const headers = new Headers();
    mergeAuthHeaders(headers);
    const cid = getWeddingClientId();
    if (cid) headers.set("x-wedding-client-id", cid);
    headers.set("Accept", "text/event-stream");
    try {
      const res = await fetch(url, { headers, signal: abortCtrl.signal });
      if (!res.ok) {
        reading = false;
        dispatch("disconnect");
        return;
      }
      dispatch("connect");
      const reader = res.body?.getReader();
      if (!reader) {
        reading = false;
        dispatch("disconnect");
        return;
      }
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            const t = line.trim();
            if (t.startsWith("data:")) {
              const raw = t.slice(5).trim();
              try {
                const data = JSON.parse(raw);
                if (data?.type === "parties_updated") dispatch("parties_updated", data);
                if (data?.type === "appointments_updated") dispatch("appointments_updated", data);
              } catch (_) {
                /* ignore parse errors */
              }
            }
          }
        }
      }
    } catch (_) {
      /* aborted or network */
    } finally {
      reading = false;
      dispatch("disconnect");
    }
  }

  function ensureSse() {
    if (reading) return;
    void startSseReader();
  }

  const clientId = getWeddingClientId();

  return {
    get id() {
      return clientId;
    },
    get connected() {
      return reading;
    },
    on(event, fn) {
      if (event === "connect" || event === "disconnect" || event === "parties_updated" || event === "appointments_updated") {
        ensureSse();
      }
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      const set = listeners.get(event);
      if (!set) return;
      if (fn) set.delete(fn);
      else set.clear();
    },
    emit() {},
  };
}

export const socket = createWeddingEventSocket();

/**
 * @param {string} method
 * @param {string} url
 * @param {{ params?: Record<string, unknown>, body?: unknown }} [opts]
 */
async function wmJson(method, url, opts = {}) {
  const { params, body } = opts;
  let finalUrl = url;
  if (params && typeof params === "object") {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    finalUrl = u.toString();
  }
  const headers = new Headers();
  mergeAuthHeaders(headers);
  const cid = socket.id;
  if (cid) headers.set("x-wedding-client-id", cid);
  /** @type {RequestInit} */
  const init = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }
  const res = await fetch(finalUrl, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && data.error
        ? String(data.error)
        : `Request failed: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function mapPartyRowToWmParty(row) {
  const { party, members } = splitWeddingPartyWithMembers(row);
  if (!party?.id) return null;
  const trackingLabel =
    typeof party.party_tracking_label === "string" && party.party_tracking_label.trim()
      ? party.party_tracking_label.trim()
      : formatWeddingPartyTrackingLabel(
          party.party_name,
          party.groom_name,
          party.event_date
        );
  return {
    id: party.id,
    name: party.party_name || party.groom_name,
    trackingLabel,
    groomFirstName: party.groom_name,
    date: party.event_date,
    signUpDate: party.sign_up_date,
    salesperson: party.salesperson || "",
    styleInfo: party.style_info || "",
    priceInfo: party.price_info || "",
    brideName: party.bride_name || "",
    bridePhone: party.bride_phone || "",
    brideEmail: party.bride_email || "",
    groomPhone: party.groom_phone || "",
    groomEmail: party.groom_email || "",
    notes: party.notes || "",
    accessories: party.accessories || {},
    type: party.party_type || "Wedding",
    isDeleted: !!party.is_deleted,
    members: members.map(toWmMember),
  };
}

function yn(v) {
  return v === true || v === 1 || v === "1";
}

function toWmMember(m) {
  const first = m.first_name ?? "";
  const last = m.last_name ?? "";
  return {
    id: m.id,
    partyId: m.wedding_party_id,
    name: `${first} ${last}`.trim() || "Member",
    firstName: first,
    lastName: last,
    customerId: m.customer_id != null ? String(m.customer_id) : "",
    customerEmail: m.customer_email ?? "",
    role: m.role ?? "Member",
    phone: m.customer_phone ?? "",
    status: m.status ?? "prospect",
    measured: yn(m.measured),
    ordered: yn(m.suit_ordered),
    received: yn(m.received),
    fitting: yn(m.fitting),
    pickup: m.pickup_status === "complete" ? 1 : m.pickup_status === "partial" ? "partial" : 0,
    suit: m.suit ?? "",
    waist: m.waist ?? "",
    vest: m.vest ?? "",
    shirt: m.shirt ?? "",
    shoe: m.shoe ?? "",
    notes: m.notes ?? "",
    contactHistory: Array.isArray(m.contact_history) ? m.contact_history : [],
    stockInfo: m.stock_info ?? {},
    orderedDate: m.ordered_date ?? null,
    receivedDate: m.received_date ?? null,
    fittingDate: m.fitting_date ?? null,
    pickupDate: m.pickup_date ?? null,
    measureDate: m.measure_date ?? null,
    orderedPO: m.ordered_po ?? null,
  };
}

function parseLegacyName(name = "") {
  const trimmed = String(name).trim();
  const parts = trimmed.split(/\s+/);
  const first_name = parts.shift() || trimmed || "Member";
  const last_name = parts.join(" ") || "Member";
  return { first_name, last_name };
}

export const api = {
  // Salespeople (ROS staff) — all active names (parties, settings, etc.)
  getSalespeople: async () => {
    const json = await wmJson("GET", `${API_URL}/staff/list-for-pos`);
    const rows = Array.isArray(json) ? json : [];
    return [...new Set(rows.map((r) => String(r.full_name || "").trim()).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b),
    );
  },
  /** Role `salesperson` only — appointment staff dropdowns */
  getSalespeopleForAppointments: async () => {
    const json = await wmJson("GET", `${API_URL}/staff/list-for-pos`);
    const rows = Array.isArray(json) ? json : [];
    return [
      ...new Set(
        rows
          .filter((r) => r.role === "salesperson")
          .map((r) => String(r.full_name || "").trim())
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));
  },
  addSalesperson: async () => {
    throw new Error("Salespeople are managed in ROS.");
  },
  deleteSalesperson: async () => {
    throw new Error("Salespeople are managed in ROS.");
  },
  updateSalesperson: async () => {
    throw new Error("Salespeople are managed in ROS.");
  },

  // Parties
  getParties: async (params = {}) => {
    const query = {
      page: params.page ?? 1,
      limit: params.limit ?? 20,
      search: params.search ?? "",
      start_date: params.startDate,
      end_date: params.endDate,
      salesperson: params.salesperson,
      show_deleted: Boolean(params.showDeleted),
    };
    const resBody = await wmJson("GET", `${API_URL}/weddings/parties`, { params: query });
    const data = (resBody?.data || []).map((row) => mapPartyRowToWmParty(row)).filter(Boolean);
    return {
      data,
      pagination: {
        page: resBody?.pagination?.page ?? 1,
        total: resBody?.pagination?.total ?? data.length,
        totalPages: resBody?.pagination?.total_pages ?? 1,
      },
    };
  },

  getParty: async (partyId) => {
    const json = await wmJson("GET", `${API_URL}/weddings/parties/${partyId}`);
    return mapPartyRowToWmParty(json);
  },

  importParties: async (parties) => {
    const created = [];
    for (const p of parties) {
      const groom_name =
        p.groomFirstName ||
        p.groom_name ||
        p.name ||
        "Wedding";
      const payload = {
        party_name: p.name || p.party_name || null,
        groom_name,
        event_date: p.date || p.event_date,
        salesperson: p.salesperson || null,
        notes: p.notes || null,
        party_type: p.type || p.party_type || "Wedding",
        style_info: p.styleInfo || null,
        price_info: p.priceInfo || null,
        groom_phone: p.groomPhone || null,
        groom_email: p.groomEmail || null,
        bride_name: p.brideName || null,
        bride_phone: p.bridePhone || null,
        bride_email: p.brideEmail || null,
        accessories: p.accessories || {},
      };
      const createdBody = await wmJson("POST", `${API_URL}/weddings/parties`, { body: payload });
      const partyId = partyIdFromWeddingCreateResponse(createdBody);
      if (!partyId) {
        throw new Error("Create party response missing id");
      }
      const members = Array.isArray(p.members) ? p.members : [];
      for (const m of members) {
        if (String(m.role || "").toLowerCase() === "groom") continue;
        const name = parseLegacyName(m.name);
        await wmJson("POST", `${API_URL}/weddings/parties/${partyId}/members`, {
          body: {
            first_name: name.first_name,
            last_name: name.last_name,
            phone: m.phone || null,
            role: m.role || "Member",
            notes: m.notes || null,
          },
        });
      }
      created.push(createdBody);
    }
    return { created: created.length };
  },

  updateParty: async (id, updates) => {
    const payload = {
      party_name: updates.name ?? updates.party_name,
      groom_name: updates.groomFirstName ?? updates.groom_name,
      event_date: updates.date ?? updates.event_date,
      salesperson: updates.salesperson,
      notes: updates.notes,
      party_type: updates.type ?? updates.party_type,
      style_info: updates.styleInfo ?? updates.style_info,
      price_info: updates.priceInfo ?? updates.price_info,
      groom_phone: updates.groomPhone ?? updates.groom_phone,
      groom_email: updates.groomEmail ?? updates.groom_email,
      bride_name: updates.brideName ?? updates.bride_name,
      bride_phone: updates.bridePhone ?? updates.bride_phone,
      bride_email: updates.brideEmail ?? updates.bride_email,
      accessories: updates.accessories,
      actor_name: updates.updatedBy || null,
    };
    return wmJson("PATCH", `${API_URL}/weddings/parties/${id}`, { body: payload });
  },

  getPartyHistory: async () => {
    return wmJson("GET", `${API_URL}/weddings/activity-feed`, { params: { limit: 200 } });
  },

  updateMember: async (id, updates) => {
    const payload = {
      role: updates.role,
      notes: updates.notes,
      status: updates.status,
      measured: updates.measured,
      suit_ordered: updates.ordered ?? updates.suit_ordered,
      received: updates.received,
      fitting: updates.fitting,
      pickup_status:
        updates.pickup === 1
          ? "complete"
          : updates.pickup === "partial"
            ? "partial"
            : updates.pickup_status,
      suit: updates.suit,
      waist: updates.waist,
      vest: updates.vest,
      shirt: updates.shirt,
      shoe: updates.shoe,
      measure_date: updates.measureDate ?? updates.measure_date,
      ordered_date: updates.orderedDate ?? updates.ordered_date,
      received_date: updates.receivedDate ?? updates.received_date,
      fitting_date: updates.fittingDate ?? updates.fitting_date,
      pickup_date: updates.pickupDate ?? updates.pickup_date,
      contact_history: updates.contactHistory ?? updates.contact_history,
      ordered_po: updates.orderedPO ?? updates.ordered_po,
      stock_info: updates.stockInfo ?? updates.stock_info,
      actor_name: updates.updatedBy || null,
    };
    return wmJson("PATCH", `${API_URL}/weddings/members/${id}`, { body: payload });
  },

  batchUpdateMembers: async (ids, updates) => {
    for (const id of ids) {
      await api.updateMember(id, updates);
    }
    return { ok: true };
  },

  addMember: async (partyId, memberData) => {
    const name = parseLegacyName(memberData.name);
    const payload = {
      first_name: name.first_name,
      last_name: name.last_name,
      phone: memberData.phone || null,
      role: memberData.role || "Member",
      notes: memberData.notes || null,
    };
    return wmJson("POST", `${API_URL}/weddings/parties/${partyId}/members`, { body: payload });
  },
  getMember: async (id) => {
    const json = await wmJson("GET", `${API_URL}/weddings/members/${id}`);
    return toWmMember(json);
  },

  // Lightspeed features are ROS-managed elsewhere for now
  getLightspeedStatus: async () => ({ auth: { connected: false } }),
  getLightspeedConnections: async () => ({ data: [] }),
  activateLightspeedConnection: async () => ({ ok: false }),
  updateLightspeedConnectionProfile: async () => ({ ok: false }),
  getLightspeedPartySummary: async () => ({}),
  getLightspeedMemberSummary: async () => ({}),
  syncLightspeedParty: async () => ({ ok: false }),
  syncLightspeedMember: async () => ({ ok: false }),

  deleteParty: async (id, deletedBy) => {
    return wmJson("DELETE", `${API_URL}/weddings/parties/${id}`, {
      params: { actor_name: deletedBy || "Wedding App" },
    });
  },

  deleteMember: async (id, deletedBy) => {
    return wmJson("DELETE", `${API_URL}/weddings/members/${id}`, {
      params: { actor_name: deletedBy || "Wedding App" },
    });
  },

  restoreParty: async (id, restoredBy) => {
    return wmJson("POST", `${API_URL}/weddings/parties/${id}/restore`, {
      params: { actor_name: restoredBy || "Wedding App" },
    });
  },

  // Appointments
  getAppointments: async (start, end) => {
    const params = {};
    if (start) params.from = new Date(start).toISOString();
    if (end) params.to = new Date(end).toISOString();
    const json = await wmJson("GET", `${API_URL}/weddings/appointments`, { params });
    return (json || []).map((a) => ({
      id: a.id,
      datetime: a.starts_at,
      customerName: a.customer_display_name,
      phone: a.phone,
      type: a.appointment_type,
      status: a.status,
      salesperson: a.salesperson,
      memberId: a.wedding_member_id,
      partyId: a.wedding_party_id,
      customerId: a.customer_id,
      notes: a.notes || "",
    }));
  },
  searchCustomers: async (q, opts = {}) => {
    const trimmed = String(q || "").trim();
    if (trimmed.length < 2) return [];
    const params = { q: trimmed };
    if (opts.limit != null) params.limit = opts.limit;
    if (opts.offset != null) params.offset = opts.offset;
    const json = await wmJson("GET", `${API_URL}/customers/search`, { params });
    return json || [];
  },
  getConflicts: async (date, salesperson, excludeId) => {
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    const appts = await api.getAppointments(from, to);
    return appts.filter(
      (a) => a.salesperson === salesperson && (!excludeId || a.id !== excludeId),
    );
  },
  getDashboardOrders: async () => {
    return wmJson("GET", `${API_URL}/weddings/actions`);
  },
  getPartyFinancialContext: async (partyId) => {
    return wmJson("GET", `${API_URL}/weddings/parties/${partyId}/financial-context`);
  },
  addAppointment: async (apptData) => {
    const payload = {
      wedding_member_id: apptData.memberId?.trim?.() || null,
      customer_id: apptData.customerId?.trim?.() || null,
      customer_display_name: apptData.customerName?.trim?.() || null,
      phone: apptData.phone?.trim?.() || null,
      appointment_type: apptData.type || "Measurement",
      starts_at: new Date(apptData.datetime).toISOString(),
      notes: apptData.notes || null,
      status: apptData.status || "Scheduled",
      salesperson: apptData.salesperson || null,
    };
    return wmJson("POST", `${API_URL}/weddings/appointments`, { body: payload });
  },
  updateAppointment: async (id, updates) => {
    const payload = {
      customer_display_name: updates.customerName,
      phone: updates.phone,
      appointment_type: updates.type,
      starts_at: updates.datetime ? new Date(updates.datetime).toISOString() : undefined,
      notes: updates.notes,
      status: updates.status,
      salesperson: updates.salesperson,
    };
    return wmJson("PATCH", `${API_URL}/weddings/appointments/${id}`, { body: payload });
  },
  deleteAppointment: async (id) => {
    await wmJson("DELETE", `${API_URL}/weddings/appointments/${id}`);
    return { ok: true };
  },

  // App-only settings
  getSystemInfo: async () => ({
    ips: [window.location.hostname],
    connectedClients: 1,
    uptime: 0,
  }),
  getDatabaseStats: async () => ({}),
  clearDatabase: async () => ({ ok: false }),
  vacuumDatabase: async () => ({ ok: false }),
  getDatabaseHealth: async () => ({
    isIntegrityOk: true,
    integrity: "ok",
    isFragmented: false,
    fragmentation: 0,
    dbSizeMB: 0,
    counts: { parties: 0, members: 0, logs: 0 },
  }),
  registerAutoStart: async () => ({ ok: false }),
  syncAppointments: async () => ({ ok: false }),
  getLogs: async () => [],
  downloadBackup: () => {},
  restoreBackup: async () => ({ ok: false }),
  getDashboardActions: async (params = {}) => api.getDashboardOrders(params),
  getSettings: async () => ({ backup_frequency: "never", admin_passcode: "" }),
  updateSettings: async () => ({ ok: true }),
  getReportStats: async () => ({}),

  fetchCustomerMeasurementVault: async (customerId) => {
    if (!customerId) return null;
    const headers = new Headers();
    mergeAuthHeaders(headers);
    const res = await fetch(
      `${API_BASE}/api/customers/${customerId}/measurements`,
      { headers },
    );
    if (!res.ok) return null;
    return res.json();
  },
};
