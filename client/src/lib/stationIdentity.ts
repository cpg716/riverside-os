const STATION_KEY_STORAGE = "ros_station_key";
const CONNECTION_KEY_STORAGE = "ros_connection_key";

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
