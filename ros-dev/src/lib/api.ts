export interface ServerConfig {
  url: string;
  staffCode: string;
}

let config: ServerConfig = {
  url: localStorage.getItem("rosdev:serverUrl") || "http://localhost:3000",
  staffCode: localStorage.getItem("rosdev:staffCode") || "",
};

export function getServerUrl(): string {
  return config.url.replace(/\/$/, "");
}

export function getStaffCode(): string {
  return config.staffCode;
}

export function setServerConfig(c: ServerConfig) {
  config = c;
  localStorage.setItem("rosdev:serverUrl", c.url);
  localStorage.setItem("rosdev:staffCode", c.staffCode);
}

export function authHeaders(): Record<string, string> {
  return {
    "x-riverside-staff-code": config.staffCode,
    "Content-Type": "application/json",
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${getServerUrl()}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${getServerUrl()}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}
