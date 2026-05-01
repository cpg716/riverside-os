import React, { useState, useEffect } from 'react';
import Icon from '../components/Icon';
import logo from '../../../assets/images/riverside_logo.jpg';

import SettingsModal from '../components/SettingsModal';
import ImportDataModal from '../components/ImportDataModal';
import AddPartyModal from '../components/AddPartyModal';
import PrintPartyView from '../components/PrintPartyView';
import { api, socket } from '../lib/api';

import AppointmentScheduler from '../components/AppointmentScheduler';
import CalendarView from '../components/CalendarView';
import AppointmentModal from '../components/AppointmentModal';

import ActionDashboard from '../components/ActionDashboard';
import PartyList from '../components/PartyList';
import PartyDetail from '../components/PartyDetail';
import OrderDashboard from '../components/OrderDashboard';
import ReportsDashboard from '../components/ReportsDashboard';
import WeddingHealthHeatmap from '../components/WeddingHealthHeatmap';
import { useModal } from '../hooks/useModal';

const Dashboard = ({ initialPartyId = null, onInitialPartyConsumed }) => {
    const { showAlert, showConfirm, selectSalesperson } = useModal();
    const [parties, setParties] = useState([]);
    // ... (keep existing state)
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedParty, setSelectedParty] = useState(null);

    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('parties');
    const [dateFilter, setDateFilter] = useState('next-90');
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalParties, setTotalParties] = useState(0);


    // Modal States
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [partyToPrint, setPartyToPrint] = useState(null);
    const [showOrderDashboard, setShowOrderDashboard] = useState(false);

    const [salespeople, setSalespeople] = useState([]);
    const [salespersonFilter, setSalespersonFilter] = useState('');
    const [showDeleted, setShowDeleted] = useState(false);

    const [isApptModalOpen, setIsApptModalOpen] = useState(false);
    const [apptInitialData, setApptInitialData] = useState(null);
    const [calendarMode, setCalendarMode] = useState('weekly');

    // Debounce Search - MUST BE BEFORE ANY CONDITIONAL RETURNS
    const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearchTerm(searchTerm);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchTerm]);

    const [isConnected, setIsConnected] = useState(socket.connected);
    const [lastUpdated, setLastUpdated] = useState(new Date());

    // Open a specific party when launched from Customers / global search (ROS deep link).
    useEffect(() => {
        if (!initialPartyId) return;
        let cancelled = false;
        (async () => {
            try {
                const p = await api.getParty(initialPartyId);
                if (cancelled || !p) return;
                setSelectedParty(p);
                setActiveTab('parties');
            } catch (e) {
                console.error('Failed to open wedding party by id', e);
            } finally {
                if (!cancelled && typeof onInitialPartyConsumed === 'function') {
                    onInitialPartyConsumed();
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [initialPartyId, onInitialPartyConsumed]);

    // Initial Fetch & Socket Listener
    useEffect(() => {
        fetchParties();
        fetchSalespeople();

        socket.on('connect', () => setIsConnected(true));
        socket.on('disconnect', () => setIsConnected(false));

        socket.on('parties_updated', (data) => {
            // Ignore updates initiated by this client to prevent race conditions
            if (data && data.senderId === socket.id) return;
            fetchParties();
            setLastUpdated(new Date());
        });

        return () => {
            socket.off('connect');
            socket.off('disconnect');
            socket.off('parties_updated');
        };
    }, []);

    // Sync selectedParty with parties updates (e.g. from socket)
    useEffect(() => {
        if (selectedParty) {
            const updated = parties.find(p => p.id === selectedParty.id);
            // Only update if the object reference changed (meaning data changed)
            if (updated && updated !== selectedParty) {
                setSelectedParty(updated);
            }
        }
    }, [parties]);

    // Refetch when filters change - MOVED BEFORE CONDITIONAL RETURNS
    useEffect(() => {
        fetchParties();
    }, [currentPage, debouncedSearchTerm, dateFilter, salespersonFilter, showDeleted]);

    // Auto-Refresh every 10 minutes - MOVED BEFORE CONDITIONAL RETURNS
    useEffect(() => {
        const interval = setInterval(() => {
            fetchParties();
        }, 600000); // 10 minutes
        return () => clearInterval(interval);
    }, [currentPage, debouncedSearchTerm, dateFilter, salespersonFilter, showDeleted]);

    // Render Order Dashboard - NOW AFTER ALL HOOKS
    if (showOrderDashboard) {
        return (
            <div className="fixed inset-0 z-50 bg-app-surface">
                <OrderDashboard
                    onBack={() => setShowOrderDashboard(false)}
                />
            </div>
        );
    }

    // Render Print View
    if (partyToPrint) {
        return <PrintPartyView party={partyToPrint} onCancel={() => setPartyToPrint(null)} />;
    }

    const fetchSalespeople = async () => {
        try {
            const data = await api.getSalespeople();
            setSalespeople(data);
        } catch (err) { console.error(err); }
    };

    const fetchParties = async () => {
        setLoading(true);
        try {
            let startDate, endDate;
            const today = new Date();

            if (dateFilter === 'next-90') {
                startDate = today.toISOString().split('T')[0];
                const future = new Date(today);
                future.setDate(today.getDate() + 90);
                endDate = future.toISOString().split('T')[0];
            } else if (dateFilter !== 'all') {
                // YYYY-MM
                const [year, month] = dateFilter.split('-').map(Number);
                startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
                endDate = new Date(year, month, 0).toISOString().split('T')[0];
            }

            const res = await api.getParties({
                page: currentPage,
                limit: 20,
                search: debouncedSearchTerm,
                startDate: showDeleted ? undefined : startDate,
                endDate: showDeleted ? undefined : endDate,
                salesperson: salespersonFilter,
                showDeleted
            });

            // Handle both old (array) and new (object) formats for safety
            if (Array.isArray(res)) {
                setParties(res);
                setTotalPages(1);
                setTotalParties(res.length);
            } else {
                setParties(res.data);
                setTotalPages(res.pagination.totalPages);
                setTotalParties(res.pagination.total);
                setCurrentPage(res.pagination.page);
            }

        } catch (err) {
            console.error("Failed to fetch parties:", err);
        } finally {
            setLoading(false);
        }
    };

    // Filter Logic - Now handled by backend, but we keep sorting here if needed
    // or just use the backend order. Backend sorts by date ASC.
    const filteredParties = parties; // Pass through as backend handles filtering

    // Handlers
    const handlePartyClick = (party) => {
        console.log("Party clicked:", party);
        setSelectedParty(party);
    };

    const handleBackToDashboard = async () => {
        setSelectedParty(null);
        try {
            fetchParties();
        } catch (err) {
            console.error("Failed to refresh parties:", err);
        }
    };

    // Update Functions
    const handleImportData = async (importedParties) => {
        try {
            const result = await api.importParties(importedParties);
            await fetchParties(); // REFRESH THE LIST SO THE IMPORTED PARTIES APPEAR
            return result;
        } catch (err) {
            console.error("Import failed:", err);
            showAlert("Import failed. Check console.", "Error", { variant: 'danger' });
            throw err;
        }
    };

    const handleAddNewParty = async (newParty) => {
        try {
            // Use importParties to save the new party (it handles insert/replace)
            await api.importParties([newParty]);
            await fetchParties(); // REFRESH THE LIST SO THE NEW PARTY APPEARS

            // Onboarding Hook: If "Schedule Now" was checked, trigger the appointment modal for the Groom
            if (newParty.scheduleGroomMeasure) {
                // Find the groom in the newParty.members list (should be ID 1)
                const groom = newParty.members.find(m => m.role === 'Groom');
                if (groom) {
                    setApptInitialData({
                        type: 'Measurement',
                        customerName: groom.name,
                        phone: groom.phone,
                        partyId: newParty.id,
                        memberId: groom.id
                    });
                    setIsApptModalOpen(true);
                }
            }
        } catch (err) {
            console.error("Failed to add party:", err);
            showAlert("Failed to add party. Check console.", "Error", { variant: 'danger' });
        }
    };



    // Loading state removed to prevent UI blocking/focus loss during search
    // if (loading) {
    //     return <div className="min-h-screen flex items-center justify-center bg-app-surface-2 text-app-text font-bold">Loading...</div>;
    // }

    // Render Print View
    if (partyToPrint) {
        return <PrintPartyView party={partyToPrint} onCancel={() => setPartyToPrint(null)} />;
    }

    // Render Main Dashboard
    // Render Main Dashboard
    return (
        <div className="min-h-full bg-app-surface-2 p-0 transition-colors duration-300 relative print:p-0 print:bg-app-surface overflow-x-hidden">
            <div className="max-w-7xl mx-auto px-4 py-8 sm:px-8 print:max-w-none print:w-full">
                {selectedParty ? (
                    <PartyDetail
                        party={selectedParty}
                        parties={parties}
                        onBack={handleBackToDashboard}
                        onUpdate={(updatedParty) => {
                            setSelectedParty(updatedParty);
                            setParties(prev => prev.map(p => p.id === updatedParty.id ? updatedParty : p));
                        }}
                        onRefresh={fetchParties}
                        onPrint={() => setPartyToPrint(selectedParty)}
                        onNewAppointment={(data) => {
                            setApptInitialData(data);
                            setIsApptModalOpen(true);
                        }}
                    />
                ) : (
                    <>
                        {/* Header */}
                        <div className="flex flex-col lg:flex-row justify-between items-center mb-8 gap-4 bg-app-surface p-4 sm:p-8 rounded-3xl border border-app-border transition-all print:hidden">
                            <div className="flex flex-col items-start gap-1">
                                <div className="h-16 md:h-20 flex-shrink-0">
                                    <img src={logo} alt="Riverside Men's Shop" className="h-full w-auto object-contain rounded-lg" />
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                    <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
                                    <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest leading-none">
                                        {isConnected ? 'System Online' : 'System Offline (Reconnecting...)'}
                                        {isConnected && ` • Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center gap-2 sm:gap-4 flex-wrap justify-center">
                                {/* Tab Switcher */}
                                <div className="flex bg-app-border/50/50 rounded-xl p-1.5 transition-colors gap-1">
                                    <button type="button"
                                        onClick={() => setActiveTab('parties')}
                                        className={`px-3 sm:px-6 py-2 sm:py-2.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all duration-200 flex items-center gap-1.5 sm:gap-2 ${activeTab === 'parties' ? 'bg-navy-900 text-white shadow-md transform scale-105' : 'text-app-text-muted hover:text-app-text hover:bg-app-border/50'}`}
                                    >
                                        <Icon name="Users" size={16} className={activeTab === 'parties' ? 'text-gold-400' : ''} />
                                        Parties
                                    </button>
                                    <button type="button"
                                        onClick={() => setActiveTab('calendar')}
                                        className={`px-3 sm:px-6 py-2 sm:py-2.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all duration-200 flex items-center gap-1.5 sm:gap-2 ${activeTab === 'calendar' ? 'bg-navy-900 text-white shadow-md transform scale-105' : 'text-app-text-muted hover:text-app-text hover:bg-app-border/50'}`}
                                    >
                                        <Icon name="Calendar" size={16} className={activeTab === 'calendar' ? 'text-gold-400' : ''} />
                                        Appointments
                                    </button>
                                    <button type="button"
                                        onClick={() => setActiveTab('health')}
                                        className={`px-3 sm:px-6 py-2 sm:py-2.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all duration-200 flex items-center gap-1.5 sm:gap-2 ${activeTab === 'health' ? 'bg-navy-900 text-white shadow-md transform scale-105' : 'text-app-text-muted hover:text-app-text hover:bg-app-border/50'}`}
                                    >
                                        <Icon name="Activity" size={16} className={activeTab === 'health' ? 'text-gold-400' : ''} />
                                        Health
                                    </button>
                                    <button type="button"
                                        onClick={() => setActiveTab('reports')}
                                        className={`px-3 sm:px-6 py-2 sm:py-2.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all duration-200 flex items-center gap-1.5 sm:gap-2 ${activeTab === 'reports' ? 'bg-navy-900 text-white shadow-md transform scale-105' : 'text-app-text-muted hover:text-app-text hover:bg-app-border/50'}`}
                                    >
                                        <Icon name="BarChart3" size={16} className={activeTab === 'reports' ? 'text-gold-400' : ''} />
                                        Reports
                                    </button>
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <button type="button"
                                    onClick={() => setIsSettingsModalOpen(true)}
                                    className="bg-app-surface text-app-text border border-app-border hover:bg-app-surface-2 px-4 py-2.5 rounded-lg font-bold transition-all flex items-center justify-center gap-2 shadow-sm min-h-[44px] active:scale-95"
                                    title="Settings"
                                >
                                    <Icon name="Settings" size={18} />
                                    <span className="hidden lg:inline">Settings</span>
                                </button>
                                <button type="button"
                                    onClick={() => setIsAddModalOpen(true)}
                                    className="bg-gradient-to-r from-gold-500 to-gold-600 hover:from-gold-600 hover:to-gold-700 text-white px-5 py-2.5 rounded-lg font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-gold-500/30 hover:shadow-gold-500/40 transform active:scale-95 md:hover:-translate-y-0.5 min-h-[44px]"
                                >
                                    <Icon name="Plus" size={18} /> New Party
                                </button>
                            </div>
                        </div>

                        {activeTab === 'health' ? (
                            <div className="px-4 md:px-0">
                                <WeddingHealthHeatmap onPartyClick={handlePartyClick} />
                            </div>
                        ) : activeTab === 'reports' ? (
                            <div className="px-4 md:px-0">
                                <ReportsDashboard />
                            </div>
                        ) : activeTab === 'calendar' ? (
                            <div className="flex min-h-[20rem] h-[min(52rem,calc(100dvh-13rem))] flex-col">
                                {/* Weekly / Monthly Toggle */}
                                <div className="flex items-center gap-2 mb-3 px-1">
                                    <div className="flex bg-app-border/50/60 rounded-lg p-1 gap-0.5">
                                        <button type="button"
                                            onClick={() => setCalendarMode('weekly')}
                                            className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all ${calendarMode === 'weekly' ? 'bg-app-surface shadow text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
                                        >
                                            <Icon name="Rows3" size={13} className="inline mr-1" />Weekly
                                        </button>
                                        <button type="button"
                                            onClick={() => setCalendarMode('monthly')}
                                            className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all ${calendarMode === 'monthly' ? 'bg-app-surface shadow text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
                                        >
                                            <Icon name="Grid3x3" size={13} className="inline mr-1" />Monthly
                                        </button>
                                    </div>
                                </div>
                                <div className="flex-1 min-h-0">
                                    {calendarMode === 'monthly' ? (
                                        <CalendarView parties={parties} />
                                    ) : (
                                        <AppointmentScheduler parties={parties} />
                                    )}
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* Search & Filter - Moved to Top */}
                                <div className="bg-app-surface p-4 rounded-xl shadow-sm border border-app-border mb-8 flex flex-col lg:flex-row items-center gap-4 transition-colors">
                                    <div className="flex-1 flex items-center gap-3 w-full bg-app-surface-2 p-2.5 rounded-lg border border-app-border focus-within:ring-2 focus-within:ring-navy-200 focus-within:border-navy-400 transition-all">
                                        <Icon name="Search" className="text-app-text-muted" size={20} />
                                        <input
                                            type="text"
                                            placeholder="Search by Party Name, Member Name..."
                                            className="flex-1 outline-none text-app-text placeholder:text-app-text-muted font-medium bg-transparent text-lg"
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            style={{ minHeight: '44px' }} // Touch target size
                                        />
                                        {searchTerm && (
                                            <button type="button" onClick={() => setSearchTerm('')} className="text-app-text-muted hover:text-app-text p-2">
                                                <Icon name="X" size={18} />
                                            </button>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-3 w-full lg:w-auto overflow-x-auto pb-2 lg:pb-0 scrollbar-hide">
                                        <div className="relative flex-shrink-0">
                                            <select
                                                className="appearance-none bg-app-surface p-3 pr-8 border border-app-border rounded-lg text-sm font-bold text-app-text outline-none focus:ring-2 focus:ring-navy-900 transition-all shadow-sm"
                                                value={salespersonFilter}
                                                onChange={(e) => setSalespersonFilter(e.target.value)}
                                                style={{ minHeight: '44px' }}
                                            >
                                                <option value="">All Salespeople</option>
                                                {salespeople.map(sp => (
                                                    <option key={sp} value={sp}>{sp}</option>
                                                ))}
                                            </select>
                                            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-app-text-muted">
                                                <Icon name="ChevronDown" size={14} />
                                            </div>
                                        </div>

                                        <div className="flex bg-app-surface-2 rounded-lg p-1 flex-shrink-0">
                                            <button type="button"
                                                onClick={() => setDateFilter('next-90')}
                                                className={`px-4 py-2 rounded-md text-sm font-bold transition-all min-h-[44px] ${dateFilter === 'next-90' ? 'bg-app-surface text-app-text shadow-sm' : 'text-app-text-muted hover:text-app-text active:bg-app-border/50'}`}
                                            >
                                                Next 90 Days
                                            </button>
                                            <button type="button"
                                                onClick={() => setDateFilter('all')}
                                                className={`px-4 py-2 rounded-md text-sm font-bold transition-all min-h-[44px] ${dateFilter === 'all' ? 'bg-app-surface text-app-text shadow-sm' : 'text-app-text-muted hover:text-app-text active:bg-app-border/50'}`}
                                            >
                                                All Time
                                            </button>
                                        </div>

                                        {/* Month Picker - simplified for cleaner UI */}
                                        <div className="relative flex-shrink-0">
                                            <select
                                                value={dateFilter.includes('-') ? dateFilter : ''}
                                                onChange={(e) => setDateFilter(e.target.value)}
                                                className="appearance-none bg-app-surface p-3 pr-8 border border-app-border rounded-lg text-sm font-bold text-app-text outline-none focus:ring-2 focus:ring-navy-900 transition-all shadow-sm"
                                                style={{ minHeight: '44px' }}
                                            >
                                                <option value="" disabled>Specific Month</option>
                                                {Array.from({ length: 12 }, (_, i) => {
                                                    const d = new Date();
                                                    d.setDate(1);
                                                    d.setMonth(d.getMonth() + i);
                                                    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                                                    return <option key={val} value={val}>{d.toLocaleString('default', { month: 'long', year: 'numeric' })}</option>
                                                })}
                                            </select>
                                            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-app-text-muted">
                                                <Icon name="ChevronDown" size={14} />
                                            </div>
                                        </div>

                                        {/* Show Deleted Toggle */}
                                        <button type="button"
                                            onClick={() => {
                                                setShowDeleted(prev => !prev);
                                                setCurrentPage(1); // Reset to page 1 when toggling
                                            }}
                                            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all border shadow-sm min-h-[44px] flex-shrink-0 ${showDeleted
                                                    ? 'bg-red-600 text-white border-red-700 shadow-red-200'
                                                    : 'bg-app-surface text-app-text-muted border-app-border hover:text-red-600 hover:border-red-300'
                                                }`}
                                            title={showDeleted ? 'Back to Active Parties' : 'View Deleted Parties'}
                                        >
                                            <Icon name={showDeleted ? 'RotateCcw' : 'Trash2'} size={16} />
                                            <span className="hidden sm:inline">{showDeleted ? 'Show Active' : 'Deleted'}</span>
                                        </button>
                                    </div>
                                </div>

                                <ActionDashboard
                                    onMemberClick={(member, partyId, item) => {
                                        const party = parties.find(p => p.id === partyId);
                                        if (party) {
                                            handlePartyClick(party);
                                        } else if (item && item.date) {
                                            // Standalone appointment or member detail not found
                                            setApptInitialData({
                                                id: item.id,
                                                type: item.type,
                                                customerName: item.member.name,
                                                phone: item.member.phone,
                                                datetime: item.date,
                                                partyId: null,
                                                memberId: null
                                            });
                                            setIsApptModalOpen(true);
                                        }
                                    }}
                                    filters={{
                                        search: debouncedSearchTerm,
                                        salesperson: salespersonFilter,
                                        // Calculate dates based on filter
                                        startDate: dateFilter === 'next-90' ? new Date().toISOString().split('T')[0] :
                                            dateFilter === 'all' ? null :
                                                new Date(dateFilter.split('-')[0], dateFilter.split('-')[1] - 1, 1).toISOString().split('T')[0],
                                        endDate: dateFilter === 'next-90' ? new Date(new Date().setDate(new Date().getDate() + 90)).toISOString().split('T')[0] :
                                            dateFilter === 'all' ? null :
                                                new Date(dateFilter.split('-')[0], dateFilter.split('-')[1], 0).toISOString().split('T')[0] // Last day of month
                                    }}
                                    onViewOrders={() => setShowOrderDashboard(true)}
                                />

                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="text-xl font-bold text-app-text flex items-center gap-2">
                                        <Icon name={showDeleted ? "Trash2" : "Users"} className={showDeleted ? "text-red-400" : "text-app-text-muted"} />
                                        {showDeleted ? 'Deleted Parties' : 'Active Parties'}
                                        {showDeleted && (
                                            <span className="text-xs font-bold text-red-500 bg-red-50 border border-red-200 px-2 py-1 rounded-full">
                                                Showing Deleted Records
                                            </span>
                                        )}
                                    </h3>
                                    <span className="text-sm font-bold text-app-text-muted bg-app-surface px-3 py-1 rounded-full border border-app-border shadow-sm whitespace-nowrap">{totalParties} Parties</span>
                                </div>

                                <PartyList
                                    parties={filteredParties}
                                    loading={loading}
                                    onPartyClick={handlePartyClick}
                                    currentPage={currentPage}
                                    totalPages={totalPages}
                                    setCurrentPage={setCurrentPage}
                                    totalParties={totalParties}
                                    searchTerm={debouncedSearchTerm}
                                    showDeleted={showDeleted}
                                    onRestore={async (party) => {
                                        const confirmed = await showConfirm(`Restore party "${party.name}"? It will reappear in the system.`, 'Restore Party', { variant: 'info', confirmText: 'Yes, Restore' });
                                        if (!confirmed) return;
                                        const restoredBy = await selectSalesperson();
                                        if (!restoredBy) return;
                                        try {
                                            await api.restoreParty(party.id, restoredBy);
                                            fetchParties();
                                        } catch (err) {
                                            showAlert('Failed to restore party.', 'Error', { variant: 'danger' });
                                        }
                                    }}
                                />
                            </>
                        )}
                    </>
                )}

                <ImportDataModal isOpen={isImportModalOpen} onClose={() => setIsImportModalOpen(false)} onImport={handleImportData} />
                <AddPartyModal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} onAdd={handleAddNewParty} />
                <SettingsModal
                    isOpen={isSettingsModalOpen}
                    onClose={() => {
                        setIsSettingsModalOpen(false);
                        fetchParties();
                    }}
                    onImport={handleImportData}
                />

                <AppointmentModal
                    isOpen={isApptModalOpen}
                    onClose={() => setIsApptModalOpen(false)}
                    initialData={apptInitialData}
                    parties={parties}
                    onSave={() => {
                        // Refresh if needed, though appointments are separate
                        setIsApptModalOpen(false);
                    }}
                />


            </div >
        </div >
    );
};

export default Dashboard;
