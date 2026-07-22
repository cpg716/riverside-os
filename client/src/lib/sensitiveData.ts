function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitivePinKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized === "pin" ||
    normalized.endsWith("accesspin") ||
    normalized.endsWith("managerpin") ||
    normalized.endsWith("staffpin")
  );
}

/** Remove legacy Access PIN fields before local persistence, replay, or mirroring. */
export function scrubSensitivePinKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitivePinKeys(item)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitivePinKey(key)) continue;
      output[key] = scrubSensitivePinKeys(nested);
    }
    return output as T;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object") {
          const scrubbed = scrubSensitivePinKeys(parsed);
          if (JSON.stringify(parsed) !== JSON.stringify(scrubbed)) {
            return JSON.stringify(scrubbed) as T;
          }
        }
      } catch {
        // Preserve ordinary staff-entered text that only resembles JSON.
      }
    }
  }
  return value;
}

export function sensitivePinKeysWereRemoved<T>(before: T, after: T): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
