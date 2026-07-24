export const REGISTER_ORDER_STATUS_SCOPE = "open";

export const normalizeOrderStatus = (
  status: string | null | undefined,
): string => status?.trim().toLowerCase() ?? "";

export const isOrderStatus = (
  status: string | null | undefined,
  expected: string,
): boolean => normalizeOrderStatus(status) === expected;
