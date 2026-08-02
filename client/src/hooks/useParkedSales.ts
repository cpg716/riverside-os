import { useState, useCallback, useEffect, useRef } from "react";
import { type Customer } from "../components/pos/CustomerSelector";
import { 
  type CartLineItem, 
  type FulfillmentKind, 
  type WeddingMember,
  type PendingAlterationIntake,
} from "../components/pos/types";
import { 
  fetchParkedSales, 
  recallParkedSaleOnServer, 
  deleteParkedSaleOnServer,
  createParkedSale,
  type ServerParkedSale,
  type ParkedCartPayload
} from "../lib/posParkedSales";

export type WeddingCollectBuildDraft = {
  member: WeddingMember;
  lines: CartLineItem[];
  salespersonId: string;
  checkoutClientId: string;
  isTaxExempt: boolean;
  taxExemptReason: string | null;
  alterationIntakes: PendingAlterationIntake[];
};

export type WeddingCollectBuildResult = {
  transactionId: string;
  transactionDisplayId: string | null;
  totalCents: number;
  depositAppliedCents: number;
  balanceDueCents: number;
};

export type WeddingCollectBuildSession = {
  payer: Customer;
  payerMember: WeddingMember;
  payerLines: CartLineItem[];
  partyName: string;
  members: WeddingMember[];
  buildMembers: WeddingMember[];
  depositSalespersonId: string;
  defaultOrderSalespersonId: string;
  currentMemberId: string | null;
  phase:
    | "building"
    | "ready_for_payment"
    | "ready_to_post"
    | "posting"
    | "complete";
  fundedWorkflowId?: string | null;
  payerTransactionId?: string | null;
  operatorStaffId?: string | null;
  operatorName?: string | null;
  drafts: Record<string, WeddingCollectBuildDraft>;
  results: Record<string, WeddingCollectBuildResult>;
};

// Simple helper to ensure cart row IDs (can move to posUtils later if needed)
function withEnsuredCartRowId(l: Partial<CartLineItem> & { [key: string]: unknown }): CartLineItem {
  return {
    ...l,
    cart_row_id: (typeof l.cart_row_id === "string" ? l.cart_row_id : null) || `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
  } as CartLineItem;
}

interface UseParkedSalesProps {
  sessionId: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  selectedCustomer: Customer | null;
  lines: CartLineItem[];
  canReplaceCurrentSale: () => boolean;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  ensurePosTokenForSession: () => Promise<string | null>;
  resolveActorStaffId: () => Promise<string | null>;
  setLines: (lines: CartLineItem[]) => void;
  setSelectedCustomer: (customer: Customer | null) => void;
  setActiveWeddingMember: (m: WeddingMember | null) => void;
  setActiveWeddingPartyName: (n: string | null) => void;
  setDisbursementMembers: (m: WeddingMember[]) => void;
  setPrimarySalespersonId: (id: string) => void;
  primarySalespersonId: string;
  weddingDepositSalespersonId: string;
  setWeddingDepositSalespersonId: (id: string) => void;
  weddingDepositPostPaymentAction: "build_orders" | "deposit_only";
  setWeddingDepositPostPaymentAction: (
    action: "build_orders" | "deposit_only",
  ) => void;
  weddingCollectBuildSession: WeddingCollectBuildSession | null;
  setWeddingCollectBuildSession: (
    session: WeddingCollectBuildSession | null,
  ) => void;
  clearCart: () => void;
  isReady: boolean;
  activeWeddingMember: WeddingMember | null;
  activeWeddingPartyName: string | null;
  disbursementMembers: WeddingMember[];
}

export function useParkedSales({
  sessionId,
  baseUrl,
  apiAuth,
  selectedCustomer,
  lines,
  canReplaceCurrentSale,
  toast,
  ensurePosTokenForSession,
  resolveActorStaffId,
  setLines,
  setSelectedCustomer,
  setActiveWeddingMember,
  setActiveWeddingPartyName,
  setDisbursementMembers,
  setPrimarySalespersonId,
  primarySalespersonId,
  weddingDepositSalespersonId,
  setWeddingDepositSalespersonId,
  weddingDepositPostPaymentAction,
  setWeddingDepositPostPaymentAction,
  weddingCollectBuildSession,
  setWeddingCollectBuildSession,
  clearCart,
  isReady,
  activeWeddingMember,
  activeWeddingPartyName,
  disbursementMembers,
}: UseParkedSalesProps) {
  const [parkedRows, setParkedRows] = useState<ServerParkedSale[]>([]);
  const [parkedListOpen, setParkedListOpen] = useState(false);
  const [parkedCustomerPrompt, setParkedCustomerPrompt] = useState<{
    customerId: string;
    rows: ServerParkedSale[];
  } | null>(null);

  const skippedParkedForCustomerRef = useRef<Set<string>>(new Set());
  const prevCustomerIdForParkedRef = useRef<string | null>(null);
  const primaryDefaultedRef = useRef(false);

  const refreshParkedSales = useCallback(async () => {
    if (!sessionId || !isReady) return;
    try {
      const list = await fetchParkedSales(baseUrl, sessionId, apiAuth);
      setParkedRows(list);
    } catch {
      /* best-effort */
    }
  }, [baseUrl, sessionId, apiAuth, isReady]);

  useEffect(() => {
    skippedParkedForCustomerRef.current = new Set();
  }, [sessionId]);

  useEffect(() => {
    void refreshParkedSales();
  }, [sessionId, refreshParkedSales]);

  // Prompt for parked sales when customer is selected
  useEffect(() => {
    const cid = selectedCustomer?.id ?? null;
    const prev = prevCustomerIdForParkedRef.current;
    prevCustomerIdForParkedRef.current = cid;

    if (!cid || !sessionId || !isReady) return;
    if (cid === prev) return;

    const skipKey = `${sessionId}:${cid}`;
    if (skippedParkedForCustomerRef.current.has(skipKey)) return;

    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchParkedSales(baseUrl, sessionId, apiAuth, cid);
        if (cancelled || rows.length === 0) return;
        setParkedCustomerPrompt({ customerId: cid, rows });
      } catch {
        /* best-effort */
      }
    })();

    return () => { cancelled = true; };
  }, [selectedCustomer?.id, sessionId, baseUrl, apiAuth, isReady]);

  const recallParkedSale = useCallback(async (parkId: string) => {
    if (!canReplaceCurrentSale()) return;
    const tok = await ensurePosTokenForSession();
    if (!tok) {
      toast("Register session token missing. Join register first.", "error");
      return;
    }
    const actor = await resolveActorStaffId();
    if (!actor) {
      toast("Sign in to recall sales.", "error");
      return;
    }

    let row = parkedRows.find((r) => r.id === parkId);
    if (!row) {
      try {
        const list = await fetchParkedSales(baseUrl, sessionId, apiAuth);
        row = list.find((r) => r.id === parkId);
      } catch {
        toast("Could not load parked sale", "error");
        return;
      }
    }
    if (!row) return;

    // Authentication and refreshes above are asynchronous. Re-check the live
    // sale boundary before mutating the audited parked-sale record.
    if (!canReplaceCurrentSale()) return;

    try {
      await recallParkedSaleOnServer(baseUrl, sessionId, parkId, apiAuth, actor);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Recall failed", "error");
      return;
    }

    const payload = row.payload_json;
    const rawLines = (payload.lines || []) as CartLineItem[];
    setLines(
      rawLines.map((l) =>
        withEnsuredCartRowId({
          ...l,
          fulfillment: l.fulfillment as FulfillmentKind,
        }),
      ),
    );

    const rawCust = payload.selectedCustomer as Customer | null | undefined;
    setSelectedCustomer(rawCust ? { ...rawCust, customer_code: rawCust.customer_code ?? "" } : null);
    setActiveWeddingMember((payload.activeWeddingMember as WeddingMember | null) ?? null);
    setActiveWeddingPartyName(payload.activeWeddingPartyName ?? null);
    setDisbursementMembers((payload.disbursementMembers as WeddingMember[]) ?? []);
    const rawCollectBuildSession =
      (payload.weddingCollectBuildSession as WeddingCollectBuildSession | null) ??
      null;
    const restoredCollectBuildSession = rawCollectBuildSession
      ? {
          ...rawCollectBuildSession,
          defaultOrderSalespersonId:
            rawCollectBuildSession.defaultOrderSalespersonId ?? "",
          results: rawCollectBuildSession.results ?? {},
          drafts: Object.fromEntries(
            Object.entries(rawCollectBuildSession.drafts ?? {}).map(
              ([memberId, draft]) => [
                memberId,
                {
                  ...draft,
                  checkoutClientId:
                    draft.checkoutClientId ?? crypto.randomUUID(),
                  isTaxExempt: draft.isTaxExempt ?? false,
                  taxExemptReason: draft.taxExemptReason ?? null,
                  alterationIntakes: draft.alterationIntakes ?? [],
                },
              ],
            ),
          ),
        }
      : null;
    setWeddingCollectBuildSession(restoredCollectBuildSession);
    setWeddingDepositSalespersonId(
      typeof payload.weddingDepositSalespersonId === "string"
        ? payload.weddingDepositSalespersonId.trim()
        : restoredCollectBuildSession?.depositSalespersonId.trim() ?? "",
    );
    setWeddingDepositPostPaymentAction(
      payload.weddingDepositPostPaymentAction === "build_orders" ||
        restoredCollectBuildSession
        ? "build_orders"
        : "deposit_only",
    );
    
    const parkedPrimary = typeof payload.primarySalespersonId === "string" ? payload.primarySalespersonId.trim() : "";
    setPrimarySalespersonId(parkedPrimary);
    primaryDefaultedRef.current = parkedPrimary.length > 0;

    await refreshParkedSales();
    setParkedListOpen(false);
    setParkedCustomerPrompt(null);
    toast("Parked sale restored.", "success");
  }, [
    sessionId, parkedRows, toast, ensurePosTokenForSession, resolveActorStaffId,
    canReplaceCurrentSale,
    baseUrl, apiAuth, setLines, setSelectedCustomer, setActiveWeddingMember, 
    setActiveWeddingPartyName, setDisbursementMembers, setPrimarySalespersonId,
    setWeddingCollectBuildSession, setWeddingDepositSalespersonId,
    setWeddingDepositPostPaymentAction, refreshParkedSales
  ]);

  const parkSale = useCallback(async (label: string = "Untitled Sale") => {
    if (lines.length === 0 && !weddingCollectBuildSession) {
      toast("Add at least one item before parking this sale.", "error");
      return false;
    }
    if (!selectedCustomer) {
      toast("Link a customer to this sale before parking.", "error");
      return false;
    }
    const tok = await ensurePosTokenForSession();
    if (!tok) {
      toast("Register session token missing. Join register first.", "error");
      return false;
    }
    const actor = await resolveActorStaffId();
    if (!actor) {
      toast("Sign in to park sales.", "error");
      return false;
    }

    const payload: ParkedCartPayload = {
      lines,
      selectedCustomer,
      activeWeddingMember,
      activeWeddingPartyName,
      disbursementMembers,
      primarySalespersonId: primarySalespersonId.trim() || null,
      weddingDepositSalespersonId:
        weddingDepositSalespersonId.trim() || null,
      weddingDepositPostPaymentAction,
      weddingCollectBuildSession,
    };

    try {
      await createParkedSale(baseUrl, sessionId, apiAuth, {
        parked_by_staff_id: actor,
        label: label.trim() || "Untitled Sale",
        customer_id: selectedCustomer?.id ?? null,
        payload_json: payload,
      });
      toast("Sale parked on server.", "success");
      setWeddingCollectBuildSession(null);
      setWeddingDepositSalespersonId("");
      setWeddingDepositPostPaymentAction("build_orders");
      clearCart();
      await refreshParkedSales();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Park failed", "error");
      return false;
    }
  }, [
    lines, sessionId, baseUrl, apiAuth, selectedCustomer, activeWeddingMember, 
    activeWeddingPartyName, disbursementMembers, primarySalespersonId,
    weddingDepositSalespersonId, weddingDepositPostPaymentAction,
    weddingCollectBuildSession, setWeddingCollectBuildSession,
    setWeddingDepositSalespersonId, setWeddingDepositPostPaymentAction,
    ensurePosTokenForSession, resolveActorStaffId, clearCart, refreshParkedSales, toast
  ]);

  const deleteParkedSale = useCallback(async (parkId: string) => {
    const tok = await ensurePosTokenForSession();
    if (!tok) return;
    const actor = await resolveActorStaffId();
    if (!actor) return;

    try {
      await deleteParkedSaleOnServer(baseUrl, sessionId, parkId, apiAuth, actor);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
      return;
    }

    setParkedCustomerPrompt(prev => {
      if (!prev) return null;
      const rows = prev.rows.filter(r => r.id !== parkId);
      return rows.length === 0 ? null : { ...prev, rows };
    });
    await refreshParkedSales();
    toast("Parked sale removed", "info");
  }, [sessionId, baseUrl, apiAuth, toast, ensurePosTokenForSession, resolveActorStaffId, refreshParkedSales]);

  const skipParkedPrompt = useCallback(() => {
    if (parkedCustomerPrompt) {
      const skipKey = `${sessionId}:${parkedCustomerPrompt.customerId}`;
      skippedParkedForCustomerRef.current.add(skipKey);
      setParkedCustomerPrompt(null);
    }
  }, [sessionId, parkedCustomerPrompt]);

  return {
    parkedRows,
    parkedListOpen,
    setParkedListOpen,
    parkedCustomerPrompt,
    setParkedCustomerPrompt,
    refreshParkedSales,
    recallParkedSale,
    parkSale,
    deleteParkedSale,
    skipParkedPrompt,
    primaryDefaultedRef,
    skippedParkedForCustomerRef,
  };
}
