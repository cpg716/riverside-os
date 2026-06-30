const STATION_KEY_STORAGE = "ros_station_key";

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
