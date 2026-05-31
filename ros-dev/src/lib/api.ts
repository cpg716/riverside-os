import { invoke } from "@tauri-apps/api/core";

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

// Asynchronously load secure PINs from macOS keychain into memory
export async function initializeProfiles(): Promise<void> {
  for (const p of profiles) {
    try {
      const pin = await invoke<string>("get_secure_pin", { profileId: p.id });
      p.staffCode = pin;
    } catch (e) {
      console.error(`Failed to load secure PIN for profile ${p.id} from keychain:`, e);
    }
  }
}

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
    profiles[idx] = { ...profile };
  } else {
    profiles.push({ ...profile });
  }

  // Save to Keychain asynchronously
  invoke("save_secure_pin", { profileId: profile.id, pin: profile.staffCode })
    .catch((e: any) => console.error(`Failed to save secure PIN for profile ${profile.id} in keychain:`, e));

  // Strip PIN from localstorage profiles array
  const strippedProfiles = profiles.map(p => ({ ...p, staffCode: "" }));
  localStorage.setItem(PROFILES_KEY, JSON.stringify(strippedProfiles));
}

export function deleteProfile(id: string) {
  profiles = profiles.filter((p) => p.id !== id);
  if (activeProfileId === id) {
    activeProfileId = profiles[0]?.id || "";
    localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId);
  }

  // Delete from Keychain asynchronously
  invoke("delete_secure_pin", { profileId: id })
    .catch((e: any) => console.error(`Failed to delete secure PIN for profile ${id} from keychain:`, e));

  const strippedProfiles = profiles.map(p => ({ ...p, staffCode: "" }));
  localStorage.setItem(PROFILES_KEY, JSON.stringify(strippedProfiles));
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
    return await invoke<TailscaleStatus>("check_tailscale_status");
  } catch (e) {
    console.error("Native checkTailscale failed:", e);
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

// Call tauri native scanner
export async function discoverServers(): Promise<DiscoveredServer[]> {
  try {
    return await invoke<DiscoveredServer[]>("discover_servers");
  } catch (e) {
    console.error("Native discovery failed, fallback to empty list:", e);
    return [];
  }
}

export interface RosieAnalysisResult {
  analysis: string;
  rosie_available: boolean;
  model?: string;
  error?: string;
}
