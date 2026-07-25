const STATION_KEY_STORAGE = "ros_station_key";
const CONNECTION_KEY_STORAGE = "ros_connection_key";
const STATION_LABEL_STORAGE = "ros.station.label";

/**
 * Installer-provided labels identify desktop registers more reliably than the
 * Tauri webview hostname, which is always `tauri.localhost`.
 */
export function getStationLabel(): string {
  const configured = window.localStorage.getItem(STATION_LABEL_STORAGE)?.trim();
  if (configured) return configured;

  const hostname = window.location.hostname.trim();
  return hostname && hostname !== "tauri.localhost" ? hostname : "Riverside Station";
}

export function getStableStationKey(): string {
  const existing = window.localStorage.getItem(STATION_KEY_STORAGE)?.trim();
  if (existing) return existing;
  const generated = (
    window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  ).toString();
  const value = `station-${generated}`;
  window.localStorage.setItem(STATION_KEY_STORAGE, value);
  return value;
}

export function stationKeyHeader(): Record<string, string> {
  return { "x-riverside-station-key": getStableStationKey() };
}

/** Distinguishes concurrent tabs/windows while surviving a normal page reload. */
export function getConnectionKey(): string {
  const existing = window.sessionStorage.getItem(CONNECTION_KEY_STORAGE)?.trim();
  if (existing) return existing;
  const generated = (
    window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  ).toString();
  const value = `connection-${generated}`;
  window.sessionStorage.setItem(CONNECTION_KEY_STORAGE, value);
  return value;
}
