import { useEffect, useLayoutEffect, useState, useRef } from "react";
import localforage from "localforage";
import { type Customer } from "../components/pos/CustomerSelector";
import { type WeddingMember } from "../components/pos/WeddingLookupDrawer";
import { type CartLineItem, type FulfillmentKind } from "../components/pos/types";
import { type PosShippingSelection } from "../components/pos/PosShippingModal";

interface PersistedSale {
  sessionId: string;
  lines?: CartLineItem[];
  selectedCustomer?: Customer;
  activeWeddingMember?: WeddingMember;
  activeWeddingPartyName?: string;
  posShipping?: PosShippingSelection;
  primarySalespersonId?: string;
  checkoutOperator?: { staffId: string; fullName: string };
}

interface UseCartPersistenceProps {
  sessionId: string;
  lines: CartLineItem[];
  selectedCustomer: Customer | null;
  activeWeddingMember: WeddingMember | null;
  activeWeddingPartyName: string | null;
  posShipping: PosShippingSelection | null;
  primarySalespersonId: string;
  checkoutOperator: { staffId: string; fullName: string } | null;
  setLines: (lines: CartLineItem[]) => void;
  setSelectedCustomer: (customer: Customer | null) => void;
  setActiveWeddingMember: (member: WeddingMember | null) => void;
  setActiveWeddingPartyName: (name: string | null) => void;
  setPosShipping: (shipping: PosShippingSelection | null) => void;
  setPrimarySalespersonId: (id: string) => void;
  setCheckoutOperator: (operator: { staffId: string; fullName: string } | null) => void;
  clearCart: () => void;
}

export function useCartPersistence({
  sessionId,
  lines,
  selectedCustomer,
  activeWeddingMember,
  activeWeddingPartyName,
  posShipping,
  primarySalespersonId,
  checkoutOperator,
  setLines,
  setSelectedCustomer,
  setActiveWeddingMember,
  setActiveWeddingPartyName,
  setPosShipping,
  setPrimarySalespersonId,
  setCheckoutOperator,
  clearCart,
}: UseCartPersistenceProps) {
  const [saleHydrated, setSaleHydrated] = useState(false);
  const prevSessionIdForHydrateRef = useRef<string | null>(null);

  // Block disk writes until we've read localforage
  useLayoutEffect(() => {
    setSaleHydrated(false);
    const prev = prevSessionIdForHydrateRef.current;
    if (prev !== null && prev !== sessionId) {
      clearCart();
      setCheckoutOperator(null);
    }
    prevSessionIdForHydrateRef.current = sessionId;
  }, [sessionId, clearCart, setCheckoutOperator]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await localforage.getItem<PersistedSale>("ros_pos_active_sale");
        if (cancelled) return;

        if (saved && saved.sessionId === sessionId) {
          const rawLines = (saved.lines || []) as CartLineItem[];
          if (rawLines.length === 0) {
            await localforage.removeItem("ros_pos_active_sale");
          } else {
            const wm = saved.activeWeddingMember || null;
            setLines(
              rawLines.map((l) => {
                let f = l.fulfillment as FulfillmentKind | "custom" | "" | undefined;
                if (f == null || f === "") f = "takeaway";
                if (f === "wedding_order" && !wm) f = "special_order";
                return { ...l, fulfillment: f as FulfillmentKind };
              }),
            );
            
            const raw = saved.selectedCustomer as Customer | null | undefined;
            setSelectedCustomer(
              raw ? { ...raw, customer_code: raw.customer_code ?? "" } : null
            );
            
            setActiveWeddingMember(saved.activeWeddingMember || null);
            setActiveWeddingPartyName(saved.activeWeddingPartyName || null);
            
            const sp = saved.posShipping;
            if (sp && sp.rate_quote_id && sp.amount_cents != null && sp.to_address) {
              setPosShipping(sp);
            } else {
              setPosShipping(null);
            }
            
            const ps = saved.primarySalespersonId;
            if (ps?.trim()) {
              setPrimarySalespersonId(ps.trim());
            }

            const co = saved.checkoutOperator;
            if (co?.staffId?.trim() && co?.fullName?.trim()) {
              setCheckoutOperator({
                staffId: co.staffId.trim(),
                fullName: co.fullName.trim(),
              });
            }
          }
        } else if (saved && saved.sessionId !== sessionId) {
          clearCart();
        } else {
          setPrimarySalespersonId("");
        }
      } finally {
        if (!cancelled) setSaleHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [
    sessionId, 
    clearCart, 
    setLines, 
    setSelectedCustomer, 
    setActiveWeddingMember, 
    setActiveWeddingPartyName, 
    setPosShipping, 
    setPrimarySalespersonId, 
    setCheckoutOperator
  ]);

  // Persist to disk on change
  useEffect(() => {
    if (!saleHydrated) return;
    const sale: PersistedSale = {
      sessionId,
      lines,
      selectedCustomer: selectedCustomer || undefined,
      activeWeddingMember: activeWeddingMember || undefined,
      activeWeddingPartyName: activeWeddingPartyName || undefined,
      posShipping: posShipping || undefined,
      primarySalespersonId: primarySalespersonId || undefined,
      checkoutOperator: checkoutOperator || undefined,
    };
    void localforage.setItem("ros_pos_active_sale", sale);
  }, [
    saleHydrated,
    sessionId,
    lines,
    selectedCustomer,
    activeWeddingMember,
    activeWeddingPartyName,
    posShipping,
    primarySalespersonId,
    checkoutOperator,
  ]);

  return { saleHydrated };
}
