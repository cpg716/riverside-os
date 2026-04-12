import React from 'react'

// Minimal incremental UI panel to seed future UI work behind the feature flag.
const NewUIPanel: React.FC = () => {
  return (
    <div style={{ width: 320, padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ fontWeight: 700, fontSize: 12, color: '#374151', marginBottom: 6 }}>Panel A</div>
      <div style={{ fontSize: 11, color: '#555' }}>A tiny, incremental UI panel to validate the incremental rollout path.</div>
    </div>
  )
}

export default NewUIPanel
