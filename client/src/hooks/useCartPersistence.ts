import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import localforage from "localforage";
import { type Customer } from "../components/pos/CustomerSelector";
import { type WeddingMember } from "../components/pos/WeddingLookupDrawer";
import {
  type CartLineItem,
  type FulfillmentKind,
  type PendingAlterationIntake,
  type OrderPaymentCartLine,
  type AppliedPaymentLine,
  type ExchangeReturnHandoffLine,
} from "../components/pos/types";
import { type PosShippingSelection } from "../components/pos/PosShippingModal";
import { newCheckoutClientId } from "../lib/posUtils";
import {
  scrubSensitivePinKeys,
  sensitivePinKeysWereRemoved,
} from "../lib/sensitiveData";

interface PersistedSale {
  sessionId: string;
  checkoutClientId?: string;
  appliedPayments?: AppliedPaymentLine[];
  lines?: CartLineItem[];
  selectedCustomer?: Customer;
  activeWeddingMember?: WeddingMember;
  activeWeddingPartyName?: string;
  disbursementMembers?: WeddingMember[];
  posShipping?: PosShippingSelection;
  primarySalespersonId?: string;
  checkoutOperator?: { staffId: string; fullName: string };
  pendingAlterationIntakes?: PendingAlterationIntake[];
  orderPaymentLines?: OrderPaymentCartLine[];
  pendingReturnLineDrafts?: Record<string, ExchangeReturnHandoffLine[]>;
}

interface UseCartPersistenceProps {
  sessionId: string;
  checkoutClientId: string;
  appliedPayments: AppliedPaymentLine[];
  lines: CartLineItem[];
  selectedCustomer: Customer | null;
  activeWeddingMember: WeddingMember | null;
  activeWeddingPartyName: string | null;
  disbursementMembers: WeddingMember[];
  posShipping: PosShippingSelection | null;
  primarySalespersonId: string;
  checkoutOperator: { staffId: string; fullName: string } | null;
  pendingAlterationIntakes?: PendingAlterationIntake[];
  orderPaymentLines?: OrderPaymentCartLine[];
  pendingReturnLineDrafts?: Record<string, ExchangeReturnHandoffLine[]>;
  retainCheckoutIdentity?: boolean;
  setLines: (lines: CartLineItem[]) => void;
  setSelectedCustomer: (customer: Customer | null) => void;
  setActiveWeddingMember: (member: WeddingMember | null) => void;
  setActiveWeddingPartyName: (name: string | null) => void;
  setDisbursementMembers: (members: WeddingMember[]) => void;
  setPosShipping: (shipping: PosShippingSelection | null) => void;
  setPrimarySalespersonId: (id: string) => void;
  setCheckoutOperator: (operator: { staffId: string; fullName: string } | null) => void;
  setCheckoutClientId: (id: string) => void;
  setAppliedPayments: (payments: AppliedPaymentLine[]) => void;
  setPendingAlterationIntakes?: (intakes: PendingAlterationIntake[]) => void;
  setOrderPaymentLines?: (lines: OrderPaymentCartLine[]) => void;
  setPendingReturnLineDrafts?: (
    drafts: Record<string, ExchangeReturnHandoffLine[]>,
  ) => void;
  clearCart: () => void;
}

export function useCartPersistence({
  sessionId,
  checkoutClientId,
  appliedPayments,
  lines,
  selectedCustomer,
  activeWeddingMember,
  activeWeddingPartyName,
  disbursementMembers,
  posShipping,
  primarySalespersonId,
  checkoutOperator,
  pendingAlterationIntakes = [],
  orderPaymentLines = [],
  pendingReturnLineDrafts = {},
  retainCheckoutIdentity = false,
  setLines,
  setSelectedCustomer,
  setActiveWeddingMember,
  setActiveWeddingPartyName,
  setDisbursementMembers,
  setPosShipping,
  setPrimarySalespersonId,
  setCheckoutOperator,
  setCheckoutClientId,
  setAppliedPayments,
  setPendingAlterationIntakes,
  setOrderPaymentLines,
  setPendingReturnLineDrafts,
  clearCart,
}: UseCartPersistenceProps) {
  const [saleHydrated, setSaleHydrated] = useState(false);
  const prevSessionIdForHydrateRef = useRef<string | null>(null);
  const hadActiveSaleRef = useRef(false);
  const persistenceWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const queuePersistenceWrite = useCallback((write: () => Promise<void>) => {
    const next = persistenceWriteQueueRef.current.then(write, write);
    persistenceWriteQueueRef.current = next.catch(() => undefined);
    void next.catch((error) => {
      console.error("POS sale persistence update failed", error);
    });
  }, []);

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
        const persisted = await localforage.getItem<PersistedSale>("ros_pos_active_sale");
        const saved = persisted ? scrubSensitivePinKeys(persisted) : null;
        if (persisted && saved && sensitivePinKeysWereRemoved(persisted, saved)) {
          await localforage.setItem("ros_pos_active_sale", saved);
        }
        if (cancelled) return;

        if (saved && saved.sessionId === sessionId) {
          const rawLines = (saved.lines || []) as CartLineItem[];
          const rawDisbursementMembers = saved.disbursementMembers || [];
          const rawOrderPaymentLines = saved.orderPaymentLines || [];
          const rawAlterationIntakes = saved.pendingAlterationIntakes || [];
          const rawReturnDrafts = saved.pendingReturnLineDrafts || {};
          if (
            rawLines.length === 0 &&
            rawDisbursementMembers.length === 0 &&
            rawOrderPaymentLines.length === 0 &&
            rawAlterationIntakes.length === 0 &&
            (saved.appliedPayments?.length ?? 0) === 0 &&
            Object.keys(rawReturnDrafts).length === 0
          ) {
            await localforage.removeItem("ros_pos_active_sale");
            setCheckoutClientId(newCheckoutClientId());
            setAppliedPayments([]);
          } else {
            if (saved.checkoutClientId?.trim()) {
              setCheckoutClientId(saved.checkoutClientId.trim());
            }
            setAppliedPayments(saved.appliedPayments ?? []);
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
            setDisbursementMembers(rawDisbursementMembers);
            
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
            setPendingAlterationIntakes?.(rawAlterationIntakes);
            setOrderPaymentLines?.(rawOrderPaymentLines);
            setPendingReturnLineDrafts?.(rawReturnDrafts);
          }
        } else if (saved && saved.sessionId !== sessionId) {
          clearCart();
          setCheckoutClientId(newCheckoutClientId());
          setAppliedPayments([]);
        } else {
          setPrimarySalespersonId("");
          setCheckoutClientId(newCheckoutClientId());
          setAppliedPayments([]);
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
    setDisbursementMembers,
    setPosShipping, 
    setPrimarySalespersonId, 
    setCheckoutOperator,
    setCheckoutClientId,
    setAppliedPayments,
    setPendingAlterationIntakes,
    setOrderPaymentLines,
    setPendingReturnLineDrafts,
  ]);

  // Persist to disk on change
  useEffect(() => {
    if (!saleHydrated) return;
    const hasActiveSale =
      lines.length > 0 ||
      disbursementMembers.length > 0 ||
      orderPaymentLines.length > 0 ||
      pendingAlterationIntakes.length > 0 ||
      appliedPayments.length > 0 ||
      Object.keys(pendingReturnLineDrafts).length > 0 ||
      retainCheckoutIdentity;
    if (!hasActiveSale) {
      queuePersistenceWrite(() => localforage.removeItem("ros_pos_active_sale"));
      if (hadActiveSaleRef.current) {
        hadActiveSaleRef.current = false;
        setCheckoutClientId(newCheckoutClientId());
        setAppliedPayments([]);
      }
      return;
    }
    hadActiveSaleRef.current = true;
    const sale: PersistedSale = {
      sessionId,
      checkoutClientId,
      appliedPayments: appliedPayments.length > 0 ? appliedPayments : undefined,
      lines,
      selectedCustomer: selectedCustomer || undefined,
      activeWeddingMember: activeWeddingMember || undefined,
      activeWeddingPartyName: activeWeddingPartyName || undefined,
      disbursementMembers: disbursementMembers.length > 0 ? disbursementMembers : undefined,
      posShipping: posShipping || undefined,
      primarySalespersonId: primarySalespersonId || undefined,
      checkoutOperator: checkoutOperator || undefined,
      pendingAlterationIntakes: pendingAlterationIntakes.length > 0 ? pendingAlterationIntakes : undefined,
      orderPaymentLines: orderPaymentLines.length > 0 ? orderPaymentLines : undefined,
      pendingReturnLineDrafts:
        Object.keys(pendingReturnLineDrafts).length > 0
          ? pendingReturnLineDrafts
          : undefined,
    };
    queuePersistenceWrite(() =>
      localforage
        .setItem("ros_pos_active_sale", scrubSensitivePinKeys(sale))
        .then(() => undefined),
    );
  }, [
    saleHydrated,
    sessionId,
    checkoutClientId,
    appliedPayments,
    lines,
    selectedCustomer,
    activeWeddingMember,
    activeWeddingPartyName,
    disbursementMembers,
    posShipping,
    primarySalespersonId,
    checkoutOperator,
    pendingAlterationIntakes,
    orderPaymentLines,
    pendingReturnLineDrafts,
    retainCheckoutIdentity,
    queuePersistenceWrite,
    setCheckoutClientId,
    setAppliedPayments,
  ]);

  return { saleHydrated };
}
