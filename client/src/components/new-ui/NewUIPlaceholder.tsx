import React from 'react'
import NewUISection from './NewUISection'
import NewUIPanel from './NewUIPanel'

// Lightweight placeholder component for the new UI path behind feature flag.
// This is intentionally minimal to keep risk low while the overhaul is scoped and tested.
const NewUIPlaceholder: React.FC = () => {
  return (
    <div data-testid="new-ui-container" role="main" aria-label="New UI Overhaul Placeholder Main" style={{ padding: '2rem', textAlign: 'center' }}>
      <span style={{ position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clipPath: 'inset(50%)' }}>New UI Overhaul</span>
      <div role="navigation" aria-label="new-ui-nav" style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 16 }}>
        {['Overview','Inventory','Checkout'].map((t,i)=> (
          <span key={i} style={{ padding: '6px 12px', borderRadius: 999, background: '#e5e7eb', fontSize:12, color:'#374151' }}>{t}</span>
        ))}
      </div>
      <h1 style={{ marginBottom: '1rem' }}>New UI Overhaul — Placeholder</h1>
      <p style={{ color: '#555' }}>
        The new user interface is behind a feature flag and is currently under staged rollout.
        This placeholder confirms the override path is wired and can be expanded in small, controlled steps.
      </p>
      <p style={{ color: '#888' }}>Flag: UI_OVERHAUL_ENABLED is currently off by default.</p>
      {/* Lightweight skeleton preview to give a sense of the new layout without impacting UX */}
      <div
        aria-label="new-ui-skeleton"
        data-testid="new-ui-skeleton"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '16px',
          maxWidth: '900px',
          margin: '32px auto 0',
        }}
        >
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ height: '120px', borderRadius: '8px', background: '#e5e7eb', position: 'relative' }}>
            <span style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 12, color: '#374151' }}>Card {i + 1}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 16 }}>
        <NewUISection />
        <NewUIPanel />
      </div>
      {/* Small inline tweak to help QA notice the new path without affecting layout */}
      <div data-testid="ui-overhaul-note" style={{ marginTop: 24, display: 'inline-block', padding: '6px 12px', borderRadius: 999, background: '#f3f4f6', border: '1px solid #e5e7eb', fontSize: 12, color: '#374151' }} aria-label="ui-overhaul-note">
        Preview mode: UI overhaul skeleton visible when flag is on.
      </div>
    </div>
  )
}

export default NewUIPlaceholder
