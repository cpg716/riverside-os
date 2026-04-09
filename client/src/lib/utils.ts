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
  const cleaned = ("" + phone).replace(/\D/g, "");

  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
  }

  if (cleaned.length === 7) {
    if (cleaned.startsWith("716")) return phone;
    return `(716) ${cleaned.slice(0, 3)}-${cleaned.slice(3, 7)}`;
  }

  return phone;
}
