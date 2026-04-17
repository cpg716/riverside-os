import { useState, useCallback } from 'react';
import { weddingApi } from '../lib/weddingApi';
import { useBackofficeAuth } from '../context/BackofficeAuthContextLogic';
import { mergedPosStaffHeaders } from '../lib/posRegisterAuth';
import { useToast } from '../components/ui/ToastProviderLogic';

export interface WeddingMember {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  status: string;
  measured: boolean;
  suit_ordered: boolean;
  received: boolean;
  fitting: boolean;
  pickup: boolean | 'partial';
  customer_id: string;
  customer_email?: string;
  customer_phone?: string;
  suit_variant_id?: string | null;
  is_free_suit_promo: boolean;
  balance_due?: string;
  measure_date?: string;
  ordered_date?: string;
  received_date?: string;
  fitting_date?: string;
  pickup_date?: string;
  suit?: string;
  waist?: string;
  vest?: string;
  shirt?: string;
  shoe?: string;
  notes?: string;
  contact_history?: unknown[];
}

export interface WeddingMemberFinancials {
  wedding_member_id: string;
  balance_due: string;
  paid_total: string;
  order_total: string;
  order_count: number;
  payment_count: number;
}

export interface WeddingParty {
  id: string;
  party_name: string;
  groom_name: string;
  bride_name?: string;
  event_date: string;
  salesperson?: string;
  notes?: string;
  members: WeddingMember[];
}

export function useWeddingSync() {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  
  const [parties, setParties] = useState<WeddingParty[]>([]);
  const [selectedParty, setSelectedParty] = useState<WeddingParty | null>(null);
  const [loading, setLoading] = useState(false);
  const [financials, setFinancials] = useState<Record<string, WeddingMemberFinancials>>({});

  const headers = useCallback(() => mergedPosStaffHeaders(backofficeHeaders) as Record<string, string>, [backofficeHeaders]);

  const fetchParties = useCallback(async (search: string = "") => {
    setLoading(true);
    try {
      const data = await weddingApi.getParties({ search, headers: headers() });
      const rows = Array.isArray(data.data) ? data.data : [];
      // Simplified mapping for POS
      const mapped = rows.map((item: { party?: Partial<WeddingParty>; id?: string; party_name?: string; groom_name?: string; bride_name?: string; event_date?: string; members?: unknown[] }) => ({
        id: String(item.party?.id || item.id),
        party_name: item.party?.party_name || item.party_name || 'Unnamed Party',
        groom_name: item.party?.groom_name || item.groom_name || '',
        bride_name: item.party?.bride_name || item.bride_name,
        event_date: item.party?.event_date || item.event_date || '',
        members: ((item.members || []) as { id: string | number; customer_id: string | number }[]).map((m) => ({
          ...m,
          id: String(m.id),
          customer_id: String(m.customer_id)
        }))
      }));
      setParties(mapped);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch parties';
      toast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [headers, toast]);

  const fetchParty = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await weddingApi.getParty(id, { headers: headers() });
      const item = data; // the endpoint returns the party object directly or wrapped?
      // Based on weddings.rs, it returns the party with members.
      const mapped: WeddingParty = {
        id: String(item.party?.id || item.id),
        party_name: item.party?.party_name || item.party_name || 'Unnamed Party',
        groom_name: item.party?.groom_name || item.groom_name || '',
        bride_name: item.party?.bride_name || item.bride_name,
        event_date: item.party?.event_date || item.event_date || '',
        salesperson: item.party?.salesperson || item.salesperson,
        notes: item.party?.notes || item.notes,
        members: (item.members || []).map((m: { id: string | number; customer_id: string | number }) => ({
          ...m,
          id: String(m.id),
          customer_id: String(m.customer_id)
        }))
      };
      setSelectedParty(mapped);
      
      // Also fetch financials
      const fin = await weddingApi.getPartyFinancialContext(id, { headers: headers() });
      const finMap: Record<string, WeddingMemberFinancials> = {};
      (fin.members as WeddingMemberFinancials[]).forEach(m => {
        finMap[m.wedding_member_id] = m;
      });
      setFinancials(finMap);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch party details';
      toast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [headers, toast]);

  const updateMember = useCallback(async (memberId: string, data: Partial<WeddingMember>) => {
    try {
      await weddingApi.updateMember(memberId, data, { headers: headers() });
      toast('Member updated', 'success');
      // Refresh current party if loaded
      if (selectedParty) {
        await fetchParty(selectedParty.id);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      toast(message, 'error');
      return false;
    }
  }, [headers, toast, selectedParty, fetchParty]);

  const toggleStatus = useCallback(async (memberId: string, field: string, currentValue: boolean | 'partial' | string | null) => {
    const nextValue = !currentValue;
    const update: Partial<WeddingMember> = { [field]: nextValue } as unknown as Partial<WeddingMember>;
    
    // Auto-set dates like the full manager does
    if (nextValue) {
      if (field === 'measured') update.measure_date = new Date().toISOString().split('T')[0];
      if (field === 'ordered') update.ordered_date = new Date().toISOString().split('T')[0];
      if (field === 'received') update.received_date = new Date().toISOString().split('T')[0];
      if (field === 'fitting') update.fitting_date = new Date().toISOString().split('T')[0];
      if (field === 'pickup') update.pickup_date = new Date().toISOString().split('T')[0];
    }

    return updateMember(memberId, update);
  }, [updateMember]);

  return {
    parties,
    selectedParty,
    loading,
    financials,
    fetchParties,
    fetchParty,
    updateMember,
    toggleStatus,
    setSelectedParty
  };
}
