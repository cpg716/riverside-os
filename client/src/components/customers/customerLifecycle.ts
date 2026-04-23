export type CustomerLifecycleState =
  | "new"
  | "active"
  | "pending"
  | "pickup"
  | "completed"
  | "issue";

export const CUSTOMER_LIFECYCLE_OPTIONS: Array<{
  value: CustomerLifecycleState;
  label: string;
}> = [
  { value: "new", label: "New" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "pickup", label: "Pickup" },
  { value: "completed", label: "Completed" },
  { value: "issue", label: "Issue" },
];

export function customerLifecycleLabel(
  state: CustomerLifecycleState | null | undefined,
): string {
  switch (state) {
    case "new":
      return "New";
    case "active":
      return "Active";
    case "pending":
      return "Pending";
    case "pickup":
      return "Pickup";
    case "completed":
      return "Completed";
    case "issue":
      return "Issue";
    default:
      return "Unknown";
  }
}

export function customerLifecycleDescription(
  state: CustomerLifecycleState | null | undefined,
): string {
  switch (state) {
    case "new":
      return "No completed sales or open customer work yet.";
    case "active":
      return "Recent customer activity is on file with no current follow-up blocking progress.";
    case "pending":
      return "Open customer work is still in progress.";
    case "pickup":
      return "An order is ready for pickup.";
    case "completed":
      return "Prior customer work is complete with no current follow-up.";
    case "issue":
      return "Customer work needs attention before it can move forward.";
    default:
      return "Customer lifecycle is not available yet.";
  }
}

export function customerLifecycleBadgeClassName(
  state: CustomerLifecycleState | null | undefined,
): string {
  switch (state) {
    case "new":
      return "border-slate-300 bg-slate-100/90 text-slate-800";
    case "active":
      return "border-sky-200 bg-sky-50 text-sky-900";
    case "pending":
      return "border-amber-300 bg-amber-100/90 text-amber-900";
    case "pickup":
      return "border-emerald-300 bg-emerald-100/90 text-emerald-900";
    case "completed":
      return "border-app-border bg-app-surface-2/90 text-app-text";
    case "issue":
      return "border-rose-300 bg-rose-100/90 text-rose-900";
    default:
      return "border-app-border bg-app-surface-2/90 text-app-text-muted";
  }
}
