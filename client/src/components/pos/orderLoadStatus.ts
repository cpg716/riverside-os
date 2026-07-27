export const REGISTER_ORDER_STATUS_SCOPE = "open";

export const normalizeOrderStatus = (
  status: string | null | undefined,
): string =>
  status
    ?.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase() ?? "";

export const isOrderStatus = (
  status: string | null | undefined,
  expected: string,
): boolean => normalizeOrderStatus(status) === expected;
