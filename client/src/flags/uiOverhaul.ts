// UI Overhaul flag: enables the new UI path behind a feature flag.
// Default is false to keep the stable, known-good UI in production.
// This flag is consumed by the UI code to gate rendering of the new visuals.
export const UI_OVERHAUL_ENABLED = (import.meta.env.VITE_UI_OVERHAUL_ENABLED ?? 'false') === 'true';
