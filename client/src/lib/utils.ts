import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** US-style display helper (matches wedding-manager `formatPhone`). */
export function formatPhone(
  phone: string | null | undefined,
): string | null | undefined {
  if (!phone) return phone;
  const cleanedRaw = ("" + phone).replace(/\D/g, "");
  const cleaned =
    cleanedRaw.length === 11 && cleanedRaw.startsWith("1")
      ? cleanedRaw.slice(1)
      : cleanedRaw;

  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
  }

  return phone;
}
