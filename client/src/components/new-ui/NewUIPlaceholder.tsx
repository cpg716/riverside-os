import React from 'react'

// Lightweight placeholder component for the new UI path behind feature flag.
// This is intentionally minimal to keep risk low while the overhaul is scoped and tested.
const NewUIPlaceholder: React.FC = () => {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h1 style={{ marginBottom: '1rem' }}>New UI Overhaul — Placeholder</h1>
      <p style={{ color: '#555' }}>
        The new user interface is behind a feature flag and is currently under staged rollout.
        This placeholder confirms the override path is wired and can be expanded in small, controlled steps.
      </p>
      <p style={{ color: '#888' }}>Flag: UI_OVERHAUL_ENABLED is currently off by default.</p>
    </div>
  )
}

export default NewUIPlaceholder
