export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  staffCode: string;
  isTailscale: boolean;
}

const PROFILES_KEY = "rosdev:profiles";
const ACTIVE_PROFILE_KEY = "rosdev:activeProfile";

function loadProfiles(): ServerProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  // Default profiles
  return [
    { id: "local", name: "Local Dev", url: "http://localhost:3000", staffCode: "", isTailscale: false },
    { id: "tailscale", name: "Production (Tailscale)", url: "http://riverside-server:3000", staffCode: "", isTailscale: true },
  ];
}

let profiles: ServerProfile[] = loadProfiles();
let activeProfileId: string = localStorage.getItem(ACTIVE_PROFILE_KEY) || profiles[0]?.id || "local";

function getActiveProfile(): ServerProfile {
  return profiles.find((p) => p.id === activeProfileId) || profiles[0];
}

export function getProfiles(): ServerProfile[] {
  return [...profiles];
}

export function getActiveProfileId(): string {
  return activeProfileId;
}

export function setActiveProfile(id: string) {
  activeProfileId = id;
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function saveProfile(profile: ServerProfile) {
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function deleteProfile(id: string) {
  profiles = profiles.filter((p) => p.id !== id);
  if (activeProfileId === id) {
    activeProfileId = profiles[0]?.id || "";
    localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId);
  }
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function getServerUrl(): string {
  return getActiveProfile().url.replace(/\/$/, "");
}

export function getStaffCode(): string {
  return getActiveProfile().staffCode;
}

export function isTailscaleProfile(): boolean {
  return getActiveProfile().isTailscale;
}

export function setServerConfig(c: { url: string; staffCode: string }) {
  const active = getActiveProfile();
  const updated = { ...active, url: c.url, staffCode: c.staffCode };
  saveProfile(updated);
}

export function authHeaders(): Record<string, string> {
  return {
    "x-riverside-staff-code": getActiveProfile().staffCode,
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

// --- Tailscale Detection ---

export interface TailscaleStatus {
  running: boolean;
  version?: string;
  tailnet?: string;
}

export async function checkTailscale(): Promise<TailscaleStatus> {
  try {
    // Try to fetch Tailscale's local API (requires macOS and Tailscale running)
    const res = await fetch("http://100.100.100.100:8080/localapi/v0/status", {
      method: "GET",
      // Short timeout — this only works if Tailscale is running locally
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        running: data.BackendState === "Running",
        version: data.Version,
        tailnet: data.CurrentTailnet?.Name,
      };
    }
  } catch {
    // Tailscale local API not reachable
  }
  return { running: false };
}

// --- Types ---

export interface DiagnosticsSnapshot {
  generated_at: string;
  server: {
    version: string;
    uptime_seconds: number;
    rust_version: string;
  };
  database: {
    connected: boolean;
    pool_size: number;
    active_connections: number;
    idle_connections: number;
    migration_count: number;
  };
  errors: LogEntry[];
  warnings: LogEntry[];
  github: { token_configured: boolean };
  ai_prompt: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  target: string;
  message: string;
}

export interface DiscoveredServer {
  url: string;
  name?: string;
  tailscale?: boolean;
  latency_ms?: number;
}

export async function discoverServers(): Promise<DiscoveredServer[]> {
  const found: DiscoveredServer[] = [];

  // 1. Try Tailscale device discovery first (if Tailscale is running)
  try {
    const tsRes = await fetch("http://100.100.100.100:8080/localapi/v0/status", {
      signal: AbortSignal.timeout(3000),
    });
    if (tsRes.ok) {
      const tsData = await tsRes.json();
      const peers = tsData.Peer || [];
      for (const peer of peers) {
        const ip = peer.TailscaleIPs?.[0];
        if (!ip) continue;
        const url = `http://${ip}:3000`;
        try {
          const start = performance.now();
          const res = await fetch(`${url}/api/health`, {
            headers: { "x-riverside-staff-code": "" },
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            found.push({
              url,
              name: peer.DNSName || peer.HostName || ip,
              tailscale: true,
              latency_ms: Math.round(performance.now() - start),
            });
          }
        } catch {
          // Not a ROS server
        }
      }
    }
  } catch {
    // Tailscale not running
  }

  // 2. Scan local subnet (common ranges)
  const subnets = getLocalSubnets();
  const candidates: string[] = [];
  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      candidates.push(`http://${subnet}.${i}:3000`);
    }
  }

  // Scan in batches to avoid overwhelming the network
  const batchSize = 20;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const start = performance.now();
          const res = await fetch(`${url}/api/health`, {
            headers: { "x-riverside-staff-code": "" },
            signal: AbortSignal.timeout(800),
          });
          if (res.ok) {
            const data = await res.json();
            return {
              url,
              name: data.version ? `Riverside OS v${data.version}` : undefined,
              latency_ms: Math.round(performance.now() - start),
            };
          }
        } catch {
          // Not reachable
        }
        return null;
      })
    );
    for (const r of results) {
      if (r) found.push(r);
    }
    // Stop early if we found enough
    if (found.length >= 5) break;
  }

  return found;
}

function getLocalSubnets(): string[] {
  // Heuristic: common home/small office subnets
  return ["192.168.1", "192.168.0", "10.0.0", "10.0.1"];
}

export interface RosieAnalysisResult {
  analysis: string;
  rosie_available: boolean;
  model?: string;
  error?: string;
}
