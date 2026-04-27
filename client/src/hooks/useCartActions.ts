import { useCallback, useState } from "react";
import { 
  type CartLineItem, 
  type FulfillmentKind, 
  type ResolvedSkuItem, 
  type RmsPaymentLineMeta, 
  type GiftCardLoadLineMeta,
  type SearchResult,
  type AppliedPaymentLine,
  type PosShippingSelection,
  type ActiveDiscountEvent
} from "../components/pos/types";
import { type Customer } from "../components/pos/CustomerSelector";
import { type WeddingMember } from "../components/pos/WeddingLookupDrawer";
import { centsToFixed2, parseMoneyToCents } from "../lib/money";
import { calculateNysErieTaxStringsForUnit } from "../lib/tax";
import { playPosScanSuccess } from "../lib/posAudio";
import { isCustomOrderSku } from "../lib/customOrders";

function newCartRowId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function cartLineKey(l: Pick<CartLineItem, "cart_row_id">): string {
  return l.cart_row_id;
}

interface UseCartActionsProps {
  checkoutOperator: { staffId: string; fullName: string } | null;
  rmsPaymentMeta: RmsPaymentLineMeta | null;
  giftCardLoadMeta: GiftCardLoadLineMeta | null;
  activeWeddingMember: WeddingMember | null;
  employeeCustomerId: string | null;
  selectedCustomer: Customer | null;
  setSelectedCustomer: (v: Customer | null) => void;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  setSearch: (v: string) => void;
  setSearchResults: (v: SearchResult[]) => void;
  setActiveWeddingMember: (v: WeddingMember | null) => void;
  setActiveWeddingPartyName: (v: string | null) => void;
  setDisbursementMembers: (v: WeddingMember[]) => void;
  setPendingCustomItem: (v: ResolvedSkuItem | null) => void;
  setCustomPromptOpen: (v: boolean) => void;
  setGiftCardLoadOpen: (v: boolean) => void;
  setPrimarySalespersonId: (v: string) => void;
  setCheckoutAppliedPayments: (v: AppliedPaymentLine[]) => void;
  setCheckoutDepositLedger: (v: string) => void;
  setPosShipping: (v: PosShippingSelection | null) => void;
  setPickupConfirmed: (v: boolean) => void;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
}

export function useCartActions({
  checkoutOperator,
  rmsPaymentMeta,
  giftCardLoadMeta,
  activeWeddingMember,
  employeeCustomerId,
  selectedCustomer,
  setSelectedCustomer,
  toast,
  setSearch,
  setSearchResults,
  setActiveWeddingMember,
  setActiveWeddingPartyName,
  setDisbursementMembers,
  setPendingCustomItem,
  setCustomPromptOpen,
  setGiftCardLoadOpen,
  setPrimarySalespersonId,
  setCheckoutAppliedPayments,
  setCheckoutDepositLedger,
  setPosShipping,
  setPickupConfirmed,
  baseUrl,
  apiAuth,
}: UseCartActionsProps) {
  const [lines, setLines] = useState<CartLineItem[]>([]);
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [keypadMode, setKeypadMode] = useState<"qty" | "price">("qty");
  const [keypadBuffer, setKeypadBuffer] = useState("");

  const ensureSaleCashier = useCallback((): boolean => {
    if (!checkoutOperator) {
      toast("Sign in as cashier on the register sign-in screen before performing this action.", "error");
      return false;
    }
    return true;
  }, [checkoutOperator, toast]);

  const clearCart = useCallback(() => {
    setLines([]);
    setSelectedLineKey(null);
    setSearch("");
    setSearchResults([]);
    setActiveWeddingMember(null);
    setActiveWeddingPartyName(null);
    setDisbursementMembers([]);
    setCheckoutAppliedPayments([]);
    setCheckoutDepositLedger("");
    setPosShipping(null);
    setPrimarySalespersonId("");
    setPickupConfirmed(false);
  }, [
    setSearch, 
    setSearchResults, 
    setActiveWeddingMember, 
    setActiveWeddingPartyName, 
    setDisbursementMembers, 
    setCheckoutAppliedPayments, 
    setCheckoutDepositLedger, 
    setPosShipping, 
    setPrimarySalespersonId, 
    setPickupConfirmed,
  ]);

  const addItem = useCallback((item: ResolvedSkuItem, priceOverride?: string, fulfillmentOverride?: FulfillmentKind) => {
    if (!checkoutOperator) {
      toast("Sign in as cashier on the register sign-in screen before adding items.", "error");
      return;
    }

    if (isCustomOrderSku(item.sku) && !item.custom_item_type) {
      setPendingCustomItem(item);
      setCustomPromptOpen(true);
      return;
    }

    if (giftCardLoadMeta && item.sku === giftCardLoadMeta.sku) {
      toast("Use the Gift card button to add a load amount and card code.", "error");
      return;
    }

    if (rmsPaymentMeta && item.sku === rmsPaymentMeta.sku) {
      if (lines.some((l) => l.sku === rmsPaymentMeta.sku)) {
        toast("RMS CHARGE PAYMENT is already in the cart.", "error");
        return;
      }
      if (activeWeddingMember) {
        toast("Clear the wedding party link before collecting an R2S payment.", "error");
        return;
      }
      setActiveWeddingMember(null);
      setActiveWeddingPartyName(null);
      setDisbursementMembers([]);
    }

    setLines((prev) => {
      const existing = prev.find(
        (l) =>
          l.sku === item.sku &&
          l.fulfillment === "takeaway" &&
          !priceOverride &&
          !l.gift_card_load_code,
      );
      if (existing) {
        setSelectedLineKey(cartLineKey(existing));
        return prev.map((l) =>
          l.sku === item.sku &&
          l.fulfillment === "takeaway" &&
          !priceOverride &&
          !l.gift_card_load_code
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        );
      }

      const newLine: CartLineItem = {
        ...item,
        quantity: 1,
        fulfillment: fulfillmentOverride || "takeaway",
        cart_row_id: newCartRowId(),
      };

      if (rmsPaymentMeta && item.sku === rmsPaymentMeta.sku) {
        newLine.standard_retail_price = "0.00";
        newLine.state_tax = "0.00";
        newLine.local_tax = "0.00";
        newLine.original_unit_price = undefined;
        newLine.price_override_reason = undefined;
      }

      const cartUsesEmployeePrice =
        Boolean(employeeCustomerId) &&
        selectedCustomer?.id === employeeCustomerId &&
        !priceOverride &&
        item.employee_price != null &&
        String(item.employee_price).trim() !== "";
      if (cartUsesEmployeePrice) {
        const empCents = parseMoneyToCents(item.employee_price as string | number);
        const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(item.tax_category || "other", empCents);
        newLine.standard_retail_price = centsToFixed2(empCents);
        newLine.state_tax = stateTax;
        newLine.local_tax = localTax;
        newLine.original_unit_price = undefined;
        newLine.price_override_reason = undefined;
      }

      if (priceOverride) {
        const overrideCents = parseMoneyToCents(priceOverride);
        const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(item.tax_category || "other", overrideCents);
        newLine.standard_retail_price = centsToFixed2(overrideCents);
        newLine.state_tax = stateTax;
        newLine.local_tax = localTax;
        newLine.original_unit_price = centsToFixed2(
          parseMoneyToCents(item.standard_retail_price),
        );
        newLine.price_override_reason = "Manual override";
      }

      setSelectedLineKey(newLine.cart_row_id);
      return [...prev, newLine];
    });

    setSearch("");
    setSearchResults([]);
    playPosScanSuccess();
  }, [
    checkoutOperator, giftCardLoadMeta, rmsPaymentMeta, lines, activeWeddingMember, 
    employeeCustomerId, selectedCustomer, toast, setPendingCustomItem, 
    setCustomPromptOpen, setActiveWeddingMember, setActiveWeddingPartyName, 
    setDisbursementMembers, setSearch, setSearchResults
  ]);

  const addGiftCardLoadToCart = useCallback((code: string, amountCents: number) => {
    if (!checkoutOperator) {
      toast("Sign in as cashier on the register sign-in screen before adding a gift card load.", "error");
      return;
    }
    if (!giftCardLoadMeta) {
      toast("Gift card load line is not configured. Run migrations or check API.", "error");
      return;
    }
    const rowId = newCartRowId();
    const line: CartLineItem = {
      product_id: giftCardLoadMeta.product_id,
      variant_id: giftCardLoadMeta.variant_id,
      sku: giftCardLoadMeta.sku,
      name: giftCardLoadMeta.name,
      standard_retail_price: centsToFixed2(amountCents),
      unit_cost: "0.00",
      state_tax: "0.00",
      local_tax: "0.00",
      quantity: 1,
      fulfillment: "takeaway",
      cart_row_id: rowId,
      gift_card_load_code: code.trim().toUpperCase(),
      price_override_reason: "pos_gift_card_load",
      original_unit_price: "0.00",
    };
    setLines((prev) => [...prev, line]);
    setSelectedLineKey(rowId);
    setSearch("");
    setSearchResults([]);
    setGiftCardLoadOpen(false);
    playPosScanSuccess();
  }, [checkoutOperator, giftCardLoadMeta, toast, setSearch, setSearchResults, setGiftCardLoadOpen]);

  const onExchangeContinue = useCallback(
    (args: { originalTransactionId: string; customer: Customer | null }) => {
      const linkedCustomer = args.customer;
      if (!linkedCustomer) return;
      void (async () => {
        try {
          const res = await fetch(`${baseUrl}/api/customers/${linkedCustomer.id}`, {
            headers: { ...apiAuth() },
          });
          if (res.ok) {
            const c = (await res.json()) as Customer & { id: string };
            setSelectedCustomer({
              id: String(c.id),
              customer_code: c.customer_code ?? "",
              first_name: c.first_name,
              last_name: c.last_name,
              company_name: c.company_name ?? null,
              email: c.email ?? null,
              phone: c.phone ?? null,
            });
          } else {
            setSelectedCustomer(args.customer);
          }
        } catch {
          setSelectedCustomer(args.customer);
        }
      })();
    },
    [setSelectedCustomer, baseUrl, apiAuth],
  );

  const handleLaserScan = useCallback(
    (code: string, runSearch: (q: string) => Promise<SearchResult[] | undefined>) => {
      if (!ensureSaleCashier()) return;
      const trimmed = code.trim();
      if (trimmed.length < 2) return;

      const existing = lines.find(l => l.sku.toLowerCase() === trimmed.toLowerCase() || l.vendor_sku?.toLowerCase() === trimmed.toLowerCase());
      if (existing) {
        setLines(prev => prev.map(l => l.cart_row_id === existing.cart_row_id ? { ...l, quantity: l.quantity + 1 } : l));
        setSearch("");
        setSearchResults([]);
        playPosScanSuccess();
        return;
      }

      setSearch(trimmed);
      runSearch(trimmed).then(results => {
        if (!results) return;
        const exact = results.filter(r => r.sku.toLowerCase() === trimmed.toLowerCase() || r.vendor_sku?.toLowerCase() === trimmed.toLowerCase());
        if (exact.length === 1) {
          addItem(exact[0]);
        }
      }).catch(() => {});
    },
    [ensureSaleCashier, setSearch, lines, setLines, setSearchResults, addItem],
  );
  
  const handleSearchResultClick = useCallback((
    item: SearchResult, 
    searchResults: SearchResult[], 
    search: string,
    setActiveVariationSelection: (v: {
      product_id: string;
      name: string;
      variants: {
        variant_id: string;
        sku: string;
        variation_label: string;
        stock_on_hand: number;
        retail_price: string;
      }[];
    }) => void
  ) => {
    if (!ensureSaleCashier()) return;
    const siblings = searchResults.filter(r => r.product_id === item.product_id);
    const exactSkuMatch = search.trim().toLowerCase() === item.sku.toLowerCase();

    if (siblings.length > 1 && !exactSkuMatch) {
       setActiveVariationSelection({
         product_id: item.product_id,
         name: item.name,
         variants: siblings.map(s => ({
           variant_id: s.variant_id,
           sku: s.sku,
           variation_label: s.variation_label || "Standard",
           stock_on_hand: s.stock_on_hand || 0,
           retail_price: String(s.standard_retail_price),
         }))
       });
    } else {
       addItem(item);
    }
  }, [ensureSaleCashier, addItem]);

  const removeLine = useCallback((rowId: string) => {
    setLines((prev) => prev.filter((l) => l.cart_row_id !== rowId));
    setSelectedLineKey((prev) => (prev === rowId ? null : prev));
  }, []);

  const updateLineFulfillment = useCallback((rowId: string, next: FulfillmentKind) => {
    const line = lines.find((l) => l.cart_row_id === rowId);
    if (rmsPaymentMeta && line && line.sku === rmsPaymentMeta.sku && next !== "takeaway") {
      toast("R2S payment must stay on Take Now.", "info");
      return;
    }
    if (giftCardLoadMeta && line && line.sku === giftCardLoadMeta.sku && next !== "takeaway") {
      toast("Gift card load must stay on Take Now.", "info");
      return;
    }
    setLines((prev) =>
      prev.map((l) => (l.cart_row_id === rowId ? { ...l, fulfillment: next } : l))
    );
  }, [lines, rmsPaymentMeta, giftCardLoadMeta, toast]);

  const updateLineSalesperson = useCallback((rowId: string, salespersonId: string) => {
    setLines((prev) =>
      prev.map((l) => (l.cart_row_id === rowId ? { ...l, salesperson_id: salespersonId } : l))
    );
  }, []);

  const updateLineGiftWrapStatus = useCallback((rowId: string, status: boolean) => {
    setLines((prev) =>
      prev.map((l) => (l.cart_row_id === rowId ? { ...l, needs_gift_wrap: status } : l))
    );
  }, []);

  const handleNumpadKey = useCallback((key: string) => {
    if (!selectedLineKey) return;
    if (key === "CLEAR") {
      setKeypadBuffer("");
      return;
    }
    if (key === "ENTER") {
      // Apply buffer to selected line
      const line = lines.find(l => l.cart_row_id === selectedLineKey);
      if (!line) return;

      if (keypadMode === "qty") {
        const nextQty = parseInt(keypadBuffer || "1", 10);
        if (isNaN(nextQty) || nextQty <= 0) {
          toast("Invalid quantity", "error");
          return;
        }
        setLines(prev => prev.map(l => l.cart_row_id === selectedLineKey ? { ...l, quantity: nextQty } : l));
      } else {
        // Price override
        const amt = parseMoneyToCents(keypadBuffer);
        if (isNaN(amt)) {
          toast("Invalid price", "error");
          return;
        }
        setLines(prev => prev.map(l => {
          if (l.cart_row_id !== selectedLineKey) return l;
          const oldPrice = parseMoneyToCents(l.original_unit_price || l.standard_retail_price);
          
          const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(l.tax_category || "other", amt);
          
          return {
            ...l,
            standard_retail_price: centsToFixed2(amt),
            state_tax: stateTax,
            local_tax: localTax,
            original_unit_price: l.original_unit_price ?? centsToFixed2(oldPrice),
            price_override_reason: "Manual Override"
          };
        }));
      }
      setKeypadBuffer("");
      return;
    }

    if (key === "%") {
      if (!selectedLineKey || !keypadBuffer) return;
      const line = lines.find(l => l.cart_row_id === selectedLineKey);
      if (!line) return;
      
      const pct = parseFloat(keypadBuffer);
      if (isNaN(pct) || pct <= 0) {
        toast("Invalid discount percentage", "error");
        return;
      }
      
      const baseCents = parseMoneyToCents(line.original_unit_price || line.standard_retail_price);
      const nextCents = Math.round(baseCents * (1 - pct / 100));
      const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(line.tax_category || "other", nextCents);

      setLines(prev => prev.map(l => {
        if (l.cart_row_id !== selectedLineKey) return l;
        return {
          ...l,
          standard_retail_price: centsToFixed2(nextCents),
          state_tax: stateTax,
          local_tax: localTax,
          original_unit_price: l.original_unit_price ?? centsToFixed2(baseCents),
          price_override_reason: `Manual ${pct}% Off`
        };
      }));
      setKeypadBuffer("");
      toast(`${pct}% discount applied`, "success");
      return;
    }

    if (key === "$") {
      setKeypadMode("price");
      return;
    }

    setKeypadBuffer(prev => {
      if (key === "." && prev.includes(".")) return prev;
      return prev + key;
    });
  }, [selectedLineKey, keypadBuffer, keypadMode, lines, toast]);

  const applyDiscountEvent = useCallback((event: ActiveDiscountEvent) => {
    if (!selectedLineKey) {
      toast("Select a line item first.", "info");
      return;
    }
    const line = lines.find(l => l.cart_row_id === selectedLineKey);
    if (!line) return;

    if (rmsPaymentMeta && line.sku === rmsPaymentMeta.sku) {
      toast("Discounts do not apply to R2S payments.", "info");
      return;
    }

    const pct = parseFloat(event.percent_off);
    if (isNaN(pct) || pct <= 0) return;

    const baseCents = parseMoneyToCents(line.original_unit_price || line.standard_retail_price);
    const nextCents = Math.round(baseCents * (1 - pct / 100));

    const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(line.tax_category || "other", nextCents);

    setLines(prev => prev.map(l => {
      if (l.cart_row_id !== selectedLineKey) return l;
      return {
        ...l,
        standard_retail_price: centsToFixed2(nextCents),
        state_tax: stateTax,
        local_tax: localTax,
        original_unit_price: l.original_unit_price ?? centsToFixed2(baseCents),
        discount_event_id: event.id
      };
    }));
    toast(`${event.receipt_label} applied`, "success");
  }, [selectedLineKey, lines, rmsPaymentMeta, toast]);

  return {
    lines,
    setLines,
    selectedLineKey,
    setSelectedLineKey,
    keypadMode,
    setKeypadMode,
    keypadBuffer,
    setKeypadBuffer,
    addItem,
    addGiftCardLoadToCart,
    removeLine,
    updateLineFulfillment,
    updateLineSalesperson,
    updateLineGiftWrapStatus,
    handleNumpadKey,
    applyDiscountEvent,
    ensureSaleCashier,
    clearCart,
    handleLaserScan,
    handleSearchResultClick,
    onExchangeContinue,
  };
}
