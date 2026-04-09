/**
 * Server-backed register parked sales (audited on the API). Requires open POS session headers.
 */

export type ParkedCartPayload = {
  lines: unknown[];
  selectedCustomer: unknown | null;
  activeWeddingMember: unknown | null;
  activeWeddingPartyName: string | null;
  disbursementMembers: unknown[];
  /** Register sale default salesperson (commissions); optional for older parked rows. */
  primarySalespersonId?: string | null;
};

export type ServerParkedSale = {
  id: string;
  register_session_id: string;
  parked_by_staff_id: string;
  customer_id: string | null;
  label: string;
  payload_json: ParkedCartPayload;
  status: string;
  created_at: string;
  updated_at: string;
};

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (typeof j.error === "string" && j.error.trim()) return j.error.trim();
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

export async function fetchParkedSales(
  baseUrl: string,
  sessionId: string,
  getHeaders: () => HeadersInit,
  customerId?: string | null,
): Promise<ServerParkedSale[]> {
  const q =
    customerId && customerId.trim()
      ? `?customer_id=${encodeURIComponent(customerId.trim())}`
      : "";
  const res = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/parked-sales${q}`,
    { headers: getHeaders(), cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data as ServerParkedSale[];
}

export async function createParkedSale(
  baseUrl: string,
  sessionId: string,
  getHeaders: () => HeadersInit,
  body: {
    parked_by_staff_id: string;
    label: string;
    customer_id: string | null;
    payload_json: ParkedCartPayload;
  },
): Promise<ServerParkedSale> {
  const res = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/parked-sales`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as ServerParkedSale;
}

export async function recallParkedSaleOnServer(
  baseUrl: string,
  sessionId: string,
  parkId: string,
  getHeaders: () => HeadersInit,
  actorStaffId: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/parked-sales/${encodeURIComponent(parkId)}/recall`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify({ actor_staff_id: actorStaffId }),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    throw new Error(await readError(res));
  }
}

export async function deleteParkedSaleOnServer(
  baseUrl: string,
  sessionId: string,
  parkId: string,
  getHeaders: () => HeadersInit,
  actorStaffId: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/parked-sales/${encodeURIComponent(parkId)}/delete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify({ actor_staff_id: actorStaffId }),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    throw new Error(await readError(res));
  }
}
