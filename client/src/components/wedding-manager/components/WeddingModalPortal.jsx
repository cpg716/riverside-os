import React from 'react';
import { createPortal } from 'react-dom';

/** Wedding overlays share the app-wide modal root and z-index contract. */
export default function WeddingModalPortal({ children, className = '', ...props }) {
    const root = document.getElementById('drawer-root');
    if (!root) return null;
    return createPortal(
        <div {...props} className={`ui-overlay-backdrop fixed inset-0 z-[200] ${className}`}>
            {children}
        </div>,
        root
    );
}
