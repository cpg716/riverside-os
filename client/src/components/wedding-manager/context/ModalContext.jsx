import React, { createContext, useState, useCallback, useRef } from 'react';
import GlobalModal from '../components/GlobalModal';
import SelectSalespersonModal from '../components/SelectSalespersonModal';

export const ModalContext = createContext();


export const ModalProvider = ({ children, rosActorName = null }) => {
    const [modalConfig, setModalConfig] = useState({
        isOpen: false,
        type: 'alert', // 'alert' | 'confirm'
        title: '',
        message: '',
        confirmText: 'Confirm',
        cancelText: 'Cancel',
        onConfirm: () => { },
        onCancel: () => { },
        variant: 'info' // 'info' | 'danger' | 'success' | 'warning'
    });

    const close = useCallback(() => {
        setModalConfig(prev => ({ ...prev, isOpen: false }));
    }, []);

    const showAlert = useCallback((message, title = 'Alert', options = {}) => {
        return new Promise((resolve) => {
            setModalConfig({
                isOpen: true,
                type: 'alert',
                title,
                message,
                confirmText: 'OK',
                variant: options.variant || 'info',
                onConfirm: () => {
                    close();
                    resolve(true);
                },
                onCancel: () => {
                    close();
                    resolve(true);
                }
            });
        });
    }, [close]);

    const showConfirm = useCallback((message, title = 'Confirm', options = {}) => {
        return new Promise((resolve) => {
            setModalConfig({
                isOpen: true,
                type: 'confirm',
                title,
                message,
                confirmText: options.confirmText || 'Confirm',
                cancelText: options.cancelText || 'Cancel',
                variant: options.variant || 'info',
                onConfirm: () => {
                    close();
                    resolve(true);
                },
                onCancel: () => {
                    close();
                    resolve(false);
                }
            });
        });
    }, [close]);

    /** Avoid stale closures on SelectSalespersonModal callbacks (parent can re-render while picker is open). */
    const salespersonResolveRef = useRef(null);
    const [salespersonPickerOpen, setSalespersonPickerOpen] = useState(false);

    const settleSalespersonPicker = useCallback((value) => {
        const resolve = salespersonResolveRef.current;
        salespersonResolveRef.current = null;
        setSalespersonPickerOpen(false);
        if (typeof resolve === 'function') {
            resolve(value);
        }
    }, []);

    const selectSalesperson = useCallback(() => {
        const trimmed =
            typeof rosActorName === 'string' ? rosActorName.trim() : '';
        if (trimmed) {
            return Promise.resolve(trimmed);
        }
        return new Promise((resolve) => {
            salespersonResolveRef.current = resolve;
            setSalespersonPickerOpen(true);
        });
    }, [rosActorName]);

    return (
        <ModalContext.Provider value={{ showAlert, showConfirm, selectSalesperson }}>
            {children}
            <GlobalModal
                isOpen={modalConfig.isOpen}
                type={modalConfig.type}
                title={modalConfig.title}
                message={modalConfig.message}
                confirmText={modalConfig.confirmText}
                cancelText={modalConfig.cancelText}
                onConfirm={modalConfig.onConfirm}
                onCancel={modalConfig.onCancel}
                variant={modalConfig.variant}
            />
            <SelectSalespersonModal
                isOpen={salespersonPickerOpen}
                onClose={() => settleSalespersonPicker(null)}
                onSelect={(name) => settleSalespersonPicker(name)}
            />
        </ModalContext.Provider>
    );
};
