// Minimal, test-only gating helper for UI Overhaul feature flag.
// This is a lightweight stub to help future automation wire gating checks
// without introducing runtime dependencies into the production code.

export function uiOverhaulGatingCheck(flagEnabled: boolean): string {
  return flagEnabled ? "PLACEHOLDER_RENDER" : "OLD_UI_RENDER";
}
