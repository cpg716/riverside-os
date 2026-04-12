import React from 'react'

// Minimal real UI section behind the feature flag — a small scaffold to evolve into a real panel later.
const NewUISection: React.FC = () => {
  return (
    <section aria-label="new-ui-section" style={{ display: 'inline-block', width: '420px', padding: 16, borderRadius: 12, background: '#ffffff', border: '1px solid #e5e7eb' }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#374151' }}>New UI Section (placeholder)</h3>
      <p style={{ marginTop: 8, fontSize: 12, color: '#555' }}>This is a small, isolated fragment behind the feature flag. It can be expanded into a real panel without affecting the rest of the layout.</p>
    </section>
  )
}

export default NewUISection
