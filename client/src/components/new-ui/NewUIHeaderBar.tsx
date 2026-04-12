import React from 'react'

// Minimal header bar skeleton for the new UI path behind the feature flag.
const NewUIHeaderBar: React.FC = () => {
  return (
    <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#f8fafc', borderBottom: '1px solid #e5e7eb', marginBottom: 12 }}>
      {['Home','Explore','Alerts','Help'].map((t, idx) => (
        <span key={idx} style={{ padding: '6px 12px', borderRadius: 999, fontSize: 12, color: '#374151', background: '#e6eaf0' }}>
          {t}
        </span>
      ))}
    </div>
  )
}

export default NewUIHeaderBar
