import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import { formatDate } from '../lib/utils';

const currency = (value) => {
    const number = Number(value || 0);
    return Number.isFinite(number)
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(number)
        : '$0.00';
};

const statusTone = (status) => {
    const normalized = String(status || '').toLowerCase();
    if (['connected', 'confirmed', 'matched', 'processed', 'success', 'closed'].includes(normalized)) {
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    }
    if (['pending', 'received', 'needs_review'].includes(normalized)) {
        return 'bg-amber-50 text-amber-700 border-amber-200';
    }
    if (['failed', 'error', 'missing', 'mismatched', 'voided'].includes(normalized)) {
        return 'bg-red-50 text-red-700 border-red-200';
    }
    return 'bg-app-surface-2 text-app-text border-app-border';
};

const Section = ({ icon, title, subtitle, action, children }) => (
    <div className="bg-app-surface border border-app-border rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-app-border/80 bg-app-surface-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-navy-900 text-white flex items-center justify-center shadow-sm">
                    <Icon name={icon} size={16} />
                </div>
                <div>
                    <div className="text-sm font-black uppercase tracking-wide text-app-text">{title}</div>
                    {subtitle ? <div className="text-[11px] text-app-text-muted font-medium">{subtitle}</div> : null}
                </div>
            </div>
            {action}
        </div>
        <div className="p-4">{children}</div>
    </div>
);

const Stat = ({ label, value, tone = 'text-app-text' }) => (
    <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2">
        <div className="text-[10px] font-black uppercase tracking-[0.12em] text-app-text-muted">{label}</div>
        <div className={`text-sm font-extrabold mt-1 ${tone}`}>{value}</div>
    </div>
);

const Pill = ({ children, status }) => (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${statusTone(status)}`}>
        {children}
    </span>
);

const ConnectionBanner = ({ connected, expired, scopes = [] }) => {
    if (!connected) {
        return (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-semibold">
                Lightspeed is not connected. Admin setup is required before live sync and status panels can fully populate.
            </div>
        );
    }

    return (
        <div className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${expired ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <span>{expired ? 'Lightspeed token is expiring and will refresh on next API call.' : 'Lightspeed connection is active.'}</span>
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{scopes.length} scopes</span>
            </div>
        </div>
    );
};

const InventoryList = ({ inventory }) => {
    if (!inventory || inventory.length === 0) {
        return <div className="text-xs text-app-text-muted italic">No matching Lightspeed inventory cached for this record yet.</div>;
    }

    return (
        <div className="space-y-2">
            {inventory.slice(0, 6).map((item) => (
                <div key={`${item.lightspeed_product_id}-${item.lightspeed_outlet_id || 'all'}`} className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-bold text-app-text">{item.name || item.sku || 'Lightspeed Item'}</div>
                            <div className="text-[11px] text-app-text-muted">{item.outlet_name || 'Outlet'} {item.sku ? `• SKU ${item.sku}` : ''}</div>
                        </div>
                        <div className="text-right">
                            <div className="text-lg font-black text-app-text">{item.available ?? 0}</div>
                            <div className="text-[10px] uppercase tracking-wider text-app-text-muted font-black">Available</div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

const FinancialList = ({ links, payments }) => {
    if ((!links || links.length === 0) && (!payments || payments.length === 0)) {
        return <div className="text-xs text-app-text-muted italic">No linked Lightspeed financial activity found yet.</div>;
    }

    return (
        <div className="space-y-2">
            {(links || []).slice(0, 5).map((link) => (
                <div key={`link-${link.id}`} className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="text-sm font-bold text-app-text">{link.link_type} • {currency(link.amount)}</div>
                            <div className="text-[11px] text-app-text-muted">Sale {link.lightspeed_sale_id || 'Pending'} {link.lightspeed_payment_id ? `• Payment ${link.lightspeed_payment_id}` : ''}</div>
                        </div>
                        <Pill status={link.status}>{link.status || 'unknown'}</Pill>
                    </div>
                </div>
            ))}
            {(payments || []).slice(0, 3).map((payment) => (
                <div key={`payment-${payment.lightspeed_payment_id}`} className="rounded-xl border border-dashed border-app-border bg-app-surface px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="text-sm font-bold text-app-text">{currency(payment.amount)} • {payment.payment_type_name || 'Payment'}</div>
                            <div className="text-[11px] text-app-text-muted">{payment.payment_date ? formatDate(payment.payment_date) : 'No payment date'} {payment.lightspeed_payment_id ? `• ${payment.lightspeed_payment_id}` : ''}</div>
                        </div>
                        <Pill status={payment.status}>{payment.status || 'cached'}</Pill>
                    </div>
                </div>
            ))}
        </div>
    );
};

const FulfillmentList = ({ fulfillments }) => {
    if (!fulfillments || fulfillments.length === 0) {
        return <div className="text-xs text-app-text-muted italic">No Lightspeed fulfillment records are cached for this record.</div>;
    }

    return (
        <div className="space-y-2">
            {fulfillments.slice(0, 5).map((item) => (
                <div key={item.lightspeed_fulfillment_id} className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 flex items-start justify-between gap-3">
                    <div>
                        <div className="text-sm font-bold text-app-text">{item.type || 'Fulfillment'} • Sale {item.lightspeed_sale_id || 'n/a'}</div>
                        <div className="text-[11px] text-app-text-muted">{item.outlet_id || 'No outlet'} {item.updated_at ? `• Updated ${formatDate(item.updated_at)}` : ''}</div>
                    </div>
                    <Pill status={item.status}>{item.status || 'unknown'}</Pill>
                </div>
            ))}
        </div>
    );
};

const PartyMembersList = ({ members }) => {
    if (!members || members.length === 0) {
        return <div className="text-xs text-app-text-muted italic">No party members loaded.</div>;
    }

    return (
        <div className="space-y-2">
            {members.map((member) => (
                <div key={member.id} className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 flex items-start justify-between gap-3">
                    <div>
                        <div className="text-sm font-bold text-app-text">{member.name}</div>
                        <div className="text-[11px] text-app-text-muted">{member.role || 'Member'} {member.lightspeedCustomer?.lightspeed_customer_id ? `• ${member.lightspeedCustomer.lightspeed_customer_id}` : '• Not linked yet'}</div>
                    </div>
                    <Pill status={member.lightspeedCustomer ? 'connected' : 'pending'}>
                        {member.lightspeedCustomer ? 'Linked' : 'Pending'}
                    </Pill>
                </div>
            ))}
        </div>
    );
};

const PanelShell = ({ title, icon, connection, loading, error, onRefresh, children }) => (
    <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-navy-900 text-white flex items-center justify-center shadow-sm">
                    <Icon name={icon} size={18} />
                </div>
                <div>
                    <div className="text-lg font-black uppercase tracking-tight text-app-text">{title}</div>
                    <div className="text-xs text-app-text-muted font-medium">Lightspeed X-Series status inside WASOM</div>
                </div>
            </div>
            <button
                type="button"
                onClick={onRefresh}
                className="px-4 py-2 rounded-xl border border-app-border bg-app-surface text-app-text text-xs font-black uppercase tracking-wider hover:bg-app-surface-2 transition-colors"
            >
                Refresh Lightspeed
            </button>
        </div>

        <ConnectionBanner connected={connection?.auth?.connected} expired={connection?.auth?.expired} scopes={connection?.requiredScopes || []} />

        {loading ? <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-8 text-center text-sm text-app-text-muted font-semibold">Loading Lightspeed data...</div> : null}
        {error ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-semibold">{error}</div> : null}
        {!loading && !error ? children : null}
    </div>
);

export const PartyLightspeedPanel = ({ party }) => {
    const [connection, setConnection] = useState(null);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState('');

    const load = async () => {
        setLoading(true);
        setError('');
        try {
            const [status, details] = await Promise.all([
                api.getLightspeedStatus(),
                api.getLightspeedPartySummary(party.id),
            ]);
            setConnection(status);
            setSummary(details.data);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (party?.id) load();
    }, [party]);

    const handleSync = async () => {
        setSyncing(true);
        try {
            await api.syncLightspeedParty(party.id);
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSyncing(false);
        }
    };

    return (
        <PanelShell title="Lightspeed Party Status" icon="Users" connection={connection} loading={loading} error={error} onRefresh={load}>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Section
                    icon="Users"
                    title="Customer Group"
                    subtitle="Party group in Lightspeed"
                    action={
                        <button type="button" onClick={handleSync} disabled={syncing} className="px-3 py-2 rounded-xl bg-navy-900 text-white text-[10px] font-black uppercase tracking-wider disabled:opacity-60">
                            {syncing ? 'Syncing...' : 'Sync Party'}
                        </button>
                    }
                >
                    <div className="grid grid-cols-2 gap-3 mb-3">
                        <Stat label="Group Name" value={summary?.partyGroup?.group_name || 'Not synced'} />
                        <Stat label="Linked Members" value={`${summary?.linkedMembers?.filter((member) => member.lightspeedCustomer).length || 0}/${summary?.linkedMembers?.length || 0}`} />
                    </div>
                    {summary?.partyGroup?.lightspeed_group_id ? (
                        <div className="text-xs text-app-text-muted font-semibold">Lightspeed Group ID: <span className="text-app-text">{summary.partyGroup.lightspeed_group_id}</span></div>
                    ) : (
                        <div className="text-xs text-app-text-muted italic">No Lightspeed group is cached yet for this party.</div>
                    )}
                </Section>

                <Section icon="Activity" title="Financial State" subtitle="Links, payments, and transaction health">
                    <div className="grid grid-cols-3 gap-3 mb-3">
                        <Stat label="Links" value={summary?.financialLinks?.length || 0} />
                        <Stat label="Payments" value={summary?.payments?.length || 0} />
                        <Stat label="Total" value={currency((summary?.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0))} />
                    </div>
                    <FinancialList links={summary?.financialLinks} payments={summary?.payments} />
                </Section>

                <Section icon="ShoppingBag" title="Party Members" subtitle="Who is linked to a Lightspeed customer">
                    <PartyMembersList members={summary?.linkedMembers} />
                </Section>

                <Section icon="ShoppingCart" title="Inventory & Fulfillment" subtitle="Cached Lightspeed stock and fulfillment state">
                    <div className="grid grid-cols-2 gap-3 mb-3">
                        <Stat label="Inventory Matches" value={summary?.inventory?.length || 0} />
                        <Stat label="Fulfillments" value={summary?.fulfillments?.length || 0} />
                    </div>
                    <div className="space-y-3">
                        <FulfillmentList fulfillments={summary?.fulfillments} />
                        <InventoryList inventory={summary?.inventory} />
                    </div>
                </Section>
            </div>
        </PanelShell>
    );
};

export const MemberLightspeedPanel = ({ member }) => {
    const [connection, setConnection] = useState(null);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState('');

    const load = async () => {
        setLoading(true);
        setError('');
        try {
            const [status, details] = await Promise.all([
                api.getLightspeedStatus(),
                api.getLightspeedMemberSummary(member.id),
            ]);
            setConnection(status);
            setSummary(details.data);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (member?.id && !member?.isNew) load();
    }, [member]);

    if (!member || member.isNew || member.role === 'Info') {
        return null;
    }

    const handleSync = async () => {
        setSyncing(true);
        try {
            await api.syncLightspeedMember(member.id);
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSyncing(false);
        }
    };

    return (
        <PanelShell title="Lightspeed Member Status" icon="ShoppingBag" connection={connection} loading={loading} error={error} onRefresh={load}>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Section
                    icon="Users"
                    title="Customer Link"
                    subtitle="Customer record and group membership in Lightspeed"
                    action={
                        <button type="button" onClick={handleSync} disabled={syncing} className="px-3 py-2 rounded-xl bg-navy-900 text-white text-[10px] font-black uppercase tracking-wider disabled:opacity-60">
                            {syncing ? 'Syncing...' : 'Sync Member'}
                        </button>
                    }
                >
                    <div className="grid grid-cols-2 gap-3 mb-3">
                        <Stat label="Customer" value={summary?.customer?.lightspeed_customer_id || 'Not linked'} />
                        <Stat label="Groups" value={summary?.groups?.length || 0} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {(summary?.groups || []).length > 0 ? summary.groups.map((group) => (
                            <Pill key={group.lightspeed_group_id} status="connected">{group.name}</Pill>
                        )) : <div className="text-xs text-app-text-muted italic">No Lightspeed groups cached for this member.</div>}
                    </div>
                </Section>

                <Section icon="Activity" title="Financial State" subtitle="Deposits, balances, refunds, and cached payments">
                    <div className="grid grid-cols-3 gap-3 mb-3">
                        <Stat label="Links" value={summary?.financialLinks?.length || 0} />
                        <Stat label="Payments" value={summary?.payments?.length || 0} />
                        <Stat label="Paid" value={currency((summary?.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0))} />
                    </div>
                    <FinancialList links={summary?.financialLinks} payments={summary?.payments} />
                </Section>

                <Section icon="ShoppingCart" title="Inventory Match" subtitle="Closest Lightspeed inventory cached for this member">
                    <InventoryList inventory={summary?.inventory} />
                </Section>

                <Section icon="Calendar" title="Fulfillment State" subtitle="Cached Lightspeed fulfillment records for this member">
                    <FulfillmentList fulfillments={summary?.fulfillments} />
                </Section>
            </div>
        </PanelShell>
    );
};
