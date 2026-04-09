import React, { useEffect } from 'react';
import Icon from './Icon';

const GlobalModal = ({
    isOpen,
    type,
    title,
    message,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
    variant = 'info'
}) => {
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            if (type === 'confirm') onCancel();
            else onConfirm();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [isOpen, type, onCancel, onConfirm]);

    if (!isOpen) return null;

    const getVariantStyles = () => {
        switch (variant) {
            case 'danger':
                return {
                    icon: 'AlertTriangle',
                    iconColor: 'text-red-500',
                    buttonBg: 'bg-red-600 hover:bg-red-700',
                    buttonText: 'text-white'
                };
            case 'success':
                return {
                    icon: 'Check',
                    iconColor: 'text-green-500',
                    buttonBg: 'bg-green-600 hover:bg-green-700',
                    buttonText: 'text-white'
                };
            case 'warning':
                return {
                    icon: 'AlertCircle',
                    iconColor: 'text-gold-500',
                    buttonBg: 'bg-gold-500 hover:bg-gold-600',
                    buttonText: 'text-white'
                };
            default:
                return {
                    icon: 'Info',
                    iconColor: 'text-app-text',
                    buttonBg: 'bg-navy-900 hover:bg-navy-800',
                    buttonText: 'text-white'
                };
        }
    };

    const styles = getVariantStyles();

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wm-global-modal-title"
            aria-describedby={message ? "wm-global-modal-desc" : undefined}
        >
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-sm border border-app-border transform transition-all scale-100">
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className={`p-2 rounded-full bg-app-surface-2 shrink-0 ${styles.iconColor}`}>
                            <Icon name={styles.icon} size={24} />
                        </div>
                        <div className="flex-1">
                            <h3 id="wm-global-modal-title" className="text-lg font-bold text-app-text mb-2">
                                {title}
                            </h3>
                            <p id="wm-global-modal-desc" className="text-app-text text-sm leading-relaxed whitespace-pre-line">
                                {message}
                            </p>
                        </div>
                    </div>
                </div>
                <div className="bg-app-surface-2 px-6 py-4 rounded-b-lg flex justify-end gap-3 border-t border-app-border/80">
                    {type === 'confirm' && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="px-4 py-2 text-app-text font-bold hover:bg-app-border/50 rounded-lg transition-all text-sm min-h-[44px] active:scale-95"
                        >
                            {cancelText}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={`px-6 py-2 font-bold rounded-lg shadow-sm transition-all text-sm min-h-[44px] active:scale-95 ${styles.buttonBg} ${styles.buttonText}`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default GlobalModal;
