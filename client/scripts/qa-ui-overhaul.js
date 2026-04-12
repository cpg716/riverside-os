// Lightweight CI guard for UI Overhaul feature flag
// Reads VITE_UI_OVERHAUL_ENABLED from environment and validates value
// Exits with non-zero code if value is not a recognized boolean.
try {
  const raw = process.env.VITE_UI_OVERHAUL_ENABLED || 'false'
  const val = String(raw).toLowerCase()
  if (val !== 'true' && val !== 'false') {
    console.error(`Invalid VITE_UI_OVERHAUL_ENABLED value: ${raw}`)
    process.exit(1)
  }
  console.log(`UI Overhaul flag: ${val}`)
  process.exit(0)
} catch (e) {
  console.error('UI Overhaul QA hook failed:', e)
  process.exit(1)
}
