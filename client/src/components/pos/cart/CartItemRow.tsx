import { CreditCard, Edit3, Gift, Scissors, Trash2, Tag } from "lucide-react";
import { type CartLineItem, type FulfillmentKind, type PosStaffRow } from "../types";
import { centsToFixed2, parseMoneyToCents } from "../../../lib/money";
import StaffMiniSelector from "../../ui/StaffMiniSelector";
import { isCustomOrderSku } from "../../../lib/customOrders";
import { isLockedNonTaxableLine } from "../../../lib/cartTax";

interface CartItemRowProps {
  line: CartLineItem;
  orderLaterFulfillment: FulfillmentKind;
  selectedLineKey: string | null;
  setSelectedLineKey: (key: string | null) => void;
  keypadMode: "qty" | "price";
  setKeypadMode: (mode: "qty" | "price") => void;
  setKeypadBuffer: (v: string) => void;
  updateLineFulfillment: (rowId: string, next: FulfillmentKind) => void;
  updateLineSalesperson: (rowId: string, salespersonId: string) => void;
  removeLine: (rowId: string) => void;
  toggleLineTaxCategory: (rowId: string) => void;
  onEditAlterationLine?: (intakeId: string) => void;
  onLineProductTitleClick: (line: CartLineItem) => void;
  orderSalespersonId?: string;
  orderSalespersonLabel: string;
  hideLineSalesperson?: boolean;
  updateLineGiftWrapStatus: (rowId: string, status: boolean) => void;
  commissionStaff: PosStaffRow[];
}

function cartLineKey(l: Pick<CartLineItem, "cart_row_id">): string {
  return l.cart_row_id;
}

function discountDisplayLabel(reason?: string): string | null {
  const normalized = reason?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "customer profile discount") return "Special Discount";
  if (normalized === "employee discount") return "Employee Discount";
  return null;
}

function isRmsChargePaymentLine(line: CartLineItem): boolean {
  return (
    line.custom_item_type === "rms_charge_payment" ||
    line.sku === "ROS-RMS-CHARGE-PAYMENT" ||
    line.name.trim().toUpperCase() === "RMS CHARGE PAYMENT"
  );
}

function isStaffAccountPaymentLine(line: CartLineItem): boolean {
  return (
    line.custom_item_type === "staff_account_payment" ||
    line.sku === "ROS-STAFF-ACCOUNT-PAYMENT" ||
    line.name.trim().toUpperCase() === "STAFF ACCOUNT PAYMENT"
  );
}

export function CartItemRow({
  line,
  orderLaterFulfillment,
  selectedLineKey,
  setSelectedLineKey,
  keypadMode,
  setKeypadMode,
  setKeypadBuffer,
  updateLineFulfillment,
  updateLineSalesperson,
  removeLine,
  toggleLineTaxCategory,
  onEditAlterationLine,
  onLineProductTitleClick,
  commissionStaff,
  orderSalespersonId = "",
  orderSalespersonLabel,
  hideLineSalesperson = false,
  updateLineGiftWrapStatus,
}: CartItemRowProps) {
  const lk = cartLineKey(line);
  const isSelected = selectedLineKey === lk;
  const isAlterationLine =
    line.line_type === "alteration_service" ||
    line.custom_item_type === "alteration_service" ||
    line.sku === "ROS-ALTERATION-FEE";
  const isRmsPaymentLine = isRmsChargePaymentLine(line);
  const isStaffAccountPayment = isStaffAccountPaymentLine(line);
  const regCents = parseMoneyToCents(
    line.original_unit_price ?? line.standard_retail_price,
  );
  const saleCents = parseMoneyToCents(line.standard_retail_price);
  const showRegSale =
    line.original_unit_price != null && regCents > saleCents;
  const automaticDiscountLabel = discountDisplayLabel(line.price_override_reason);
  const offPct =
    showRegSale && regCents > 0
      ? Math.round((1 - saleCents / regCents) * 100)
      : 0;

  const laterLabel =
    line.fulfillment === "custom" || isCustomOrderSku(line.sku) || line.custom_item_type
      ? "Order (Custom)"
      : orderLaterFulfillment === "wedding_order"
        ? "Order (Wedding)"
        : "Order (Special)";

  const isPickupLine = Boolean(line.transaction_line_id);
  const isReturnTenderLine = Boolean(line.return_tender_original_transaction_id);
  const isLockedAmountLine = isPickupLine || isReturnTenderLine;
  const taxCategoryLabel =
    line.tax_category === "service"
      ? "No Tax"
      : line.tax_category === "clothing" || line.tax_category === "footwear"
        ? "Clothing"
        : "Standard";
  const canToggleTaxCategory =
    !isLockedNonTaxableLine(line) &&
    !isRmsPaymentLine &&
    !isStaffAccountPayment &&
    !isLockedAmountLine;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setSelectedLineKey(lk)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setSelectedLineKey(lk);
        }
      }}
      className={`relative flex cursor-pointer items-center gap-4 rounded-2xl border-2 p-2.5 transition-all ${
        isSelected
          ? "border-app-accent bg-app-accent/[0.04] shadow-md shadow-app-accent/5 ring-1 ring-app-accent/20"
          : "border-app-border bg-app-surface hover:bg-app-surface-2"
      }`}
    >
      {isSelected ? (
        <div className="absolute bottom-2 start-0 top-2 w-1 rounded-full bg-app-accent" />
      ) : null}

      {/* 1. Product Info & Salesperson (Far Left) */}
      <div className="min-w-0 flex-[1.5] flex flex-col gap-1">
        <div className="flex items-center gap-2">
           <button
             type="button"
             className="group/name min-w-0 flex-1 text-start"
             onClick={(e) => {
               e.stopPropagation();
               onLineProductTitleClick(line);
             }}
           >
             <h4 className="truncate text-[13px] font-black uppercase italic tracking-tighter text-app-text group-hover/name:text-app-accent leading-tight">
               {line.name}
             </h4>
           </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="flex items-center gap-1 rounded bg-app-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-app-text-muted ring-1 ring-app-border/70">
              {isRmsPaymentLine || isStaffAccountPayment ? <CreditCard size={10} /> : isAlterationLine ? <Scissors size={10} /> : <Tag size={10} />}
              {line.sku}
            </span>
            {isRmsPaymentLine ? (
              <span className="rounded bg-app-info/12 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-info ring-1 ring-app-info/15">
                RMS Payment
              </span>
            ) : null}
            {isStaffAccountPayment ? (
              <span className="rounded bg-cyan-700/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-cyan-700 ring-1 ring-cyan-700/15">
                Staff Account Payment
              </span>
            ) : null}
            {isAlterationLine ? (
              <span className="rounded bg-app-accent/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-accent ring-1 ring-app-accent/20">
                Alteration
              </span>
            ) : null}
            {line.variation_label ? (
              <span className="rounded bg-app-success/12 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-tight text-app-success ring-1 ring-app-success/15">
                {line.variation_label}
              </span>
            ) : null}
            {line.gift_card_load_code ? (
              <span className="rounded bg-app-info/12 px-1.5 py-0.5 font-mono text-[10px] font-black text-app-info ring-1 ring-app-info/15">
                #{line.gift_card_load_code}
              </span>
            ) : null}
            {canToggleTaxCategory ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLineTaxCategory(line.cart_row_id);
                }}
                className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest ring-1 transition-all hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 ${
                  taxCategoryLabel === "Standard"
                    ? "bg-app-warning/10 text-app-warning ring-app-warning/20 focus-visible:ring-app-warning/25"
                    : taxCategoryLabel === "No Tax"
                      ? "bg-app-info/12 text-app-info ring-app-info/20 focus-visible:ring-app-info/25"
                      : "bg-app-success/12 text-app-success ring-app-success/20 focus-visible:ring-app-success/25"
                }`}
                aria-label={`Change tax category from ${taxCategoryLabel}`}
                title="Change this line between Standard, Clothing, and No Tax"
              >
                {taxCategoryLabel}
              </button>
            ) : null}
            {automaticDiscountLabel ? (
              <span className="rounded bg-app-accent/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-accent ring-1 ring-app-accent/20">
                {automaticDiscountLabel}
              </span>
            ) : null}
            {line.fulfillment !== "takeaway" ? (
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest border ${
                line.fulfillment === "custom"
                  ? "border-app-info/20 bg-app-info/10 text-app-info"
                  : line.fulfillment === "wedding_order"
                    ? "border-app-danger/20 bg-app-danger/10 text-app-danger"
                    : "border-app-warning/20 bg-app-warning/10 text-app-warning"
              }`}>
                {line.fulfillment === "custom"
                  ? "ORDER (Custom)"
                  : line.fulfillment === "wedding_order"
                    ? "ORDER (Wedding)"
                    : "ORDER (Special)"}
              </span>
            ) : null}
          </div>

          {!isAlterationLine && !hideLineSalesperson && (
            <div 
              className="flex items-center gap-1.5" 
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted/60">Sales</span>
              <StaffMiniSelector
                size="sm"
                staff={commissionStaff}
                selectedId={line.salesperson_id ?? ""}
                onSelect={(id) => updateLineSalesperson(line.cart_row_id, id)}
                placeholder={`Default (${orderSalespersonLabel || "None"})`}
                placeholderAvatarId={orderSalespersonId || undefined}
                placeholderAvatarName={orderSalespersonLabel || undefined}
                className="scale-90 origin-left"
              />
          </div>
          )}
        </div>
      </div>

      {/* 2. Fulfillment Toggle (Middle) */}
      {!isAlterationLine && !isRmsPaymentLine ? (
        isLockedAmountLine ? (
          <div className={`flex shrink-0 items-center rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
            isReturnTenderLine
              ? "border-app-danger/25 bg-app-danger/10 text-app-danger"
              : "border-amber-500/25 bg-amber-500/10 text-amber-600"
          }`}>
            {isReturnTenderLine ? "Return" : "Pickup"}
          </div>
        ) : (
          <div 
            className="flex shrink-0 items-center gap-1 rounded-xl border border-app-border/60 bg-app-surface-2/40 p-1"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => updateLineFulfillment(line.cart_row_id, "takeaway")}
              className={`h-8 rounded-lg px-2.5 text-[9px] font-black uppercase tracking-widest transition-all ${
                line.fulfillment === "takeaway"
                  ? "bg-app-text text-app-surface shadow-sm"
                  : "bg-transparent text-app-text-muted hover:text-app-text"
              }`}
            >
              Take Now
            </button>
            <button
              type="button"
              onClick={() => updateLineFulfillment(line.cart_row_id, orderLaterFulfillment)}
              className={`h-8 rounded-lg px-2.5 text-[9px] font-black uppercase tracking-widest transition-all ${
                (line.fulfillment === orderLaterFulfillment || line.fulfillment === "custom")
                  ? "bg-app-warning text-white shadow-sm"
                  : "bg-transparent text-app-text-muted hover:text-app-text"
              }`}
            >
              {laterLabel}
            </button>
            
             <button
              type="button"
              onClick={() => updateLineGiftWrapStatus(line.cart_row_id, !line.needs_gift_wrap)}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-all ${
                line.needs_gift_wrap
                  ? "border-app-success/40 bg-app-success/10 text-app-success"
                  : "border-transparent text-app-text-muted hover:bg-app-surface"
              }`}
            >
              <Gift size={14} />
            </button>
          </div>
        )
      ) : (
        <div className={`flex shrink-0 items-center rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
          isRmsPaymentLine
            ? "border-app-info/25 bg-app-info/10 text-app-info"
            : "border-app-accent/25 bg-app-accent/10 text-app-accent"
        }`}>
          {isRmsPaymentLine ? "Payment" : "Work order"}
        </div>
      )}

      {/* 3. Qty & Sale Buttons (Right) */}
      <div 
        className="flex shrink-0 items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {!isAlterationLine && !isRmsPaymentLine ? (
        <button
          type="button"
          disabled={isLockedAmountLine}
          onClick={() => {
            setSelectedLineKey(lk);
            setKeypadMode("qty");
            setKeypadBuffer("");
          }}
          className={`flex h-11 w-14 flex-col items-center justify-center rounded-xl border-2 transition-all ${
            keypadMode === "qty" && isSelected && !isLockedAmountLine
              ? line.quantity < 0
                ? "border-app-danger bg-app-danger text-white shadow-lg shadow-app-danger/20"
                : "border-app-accent bg-app-accent text-white shadow-lg"
              : line.quantity < 0
                ? "border-app-danger/40 bg-app-danger/10 text-app-danger"
                : "border-app-border bg-app-surface-2 text-app-text"
          } ${isLockedAmountLine ? "cursor-default opacity-80" : ""}`}
        >
          <span className={`text-[8px] font-black uppercase tracking-widest ${keypadMode === "qty" && isSelected && !isLockedAmountLine ? "text-white/80" : "text-app-text-muted"}`}>
            Qty
          </span>
          <span className="text-sm font-black tabular-nums leading-none">
            {line.quantity}
          </span>
        </button>
        ) : null}

        <button
          type="button"
          disabled={isLockedAmountLine}
          onClick={() => {
            if (isAlterationLine && line.alteration_intake_id && onEditAlterationLine) {
              onEditAlterationLine(line.alteration_intake_id);
              return;
            }
            setSelectedLineKey(lk);
            setKeypadMode("price");
            setKeypadBuffer("");
          }}
          className={`flex h-11 min-w-[5.5rem] flex-col items-end justify-center rounded-xl border-2 px-3 transition-all ${
            keypadMode === "price" && isSelected && !isLockedAmountLine
              ? "border-app-accent bg-app-accent text-white shadow-lg"
              : "border-app-border bg-app-surface-2 text-app-text"
          } ${isLockedAmountLine ? "cursor-default opacity-80" : ""}`}
        >
          <span className={`text-[8px] font-black uppercase tracking-widest ${keypadMode === "price" && isSelected && !isLockedAmountLine ? "text-white/80" : "text-app-text-muted"}`}>
            {isAlterationLine ? "Amount" : "Sale"}
          </span>
          <div className="flex items-center gap-1.5">
            {showRegSale && (
               <span className="text-[9px] font-bold tabular-nums text-app-text-disabled line-through">
                 ${centsToFixed2(regCents)}
               </span>
            )}
            <span className={`text-sm font-black tabular-nums ${offPct > 0 && !(keypadMode === "price" && isSelected) ? "text-app-success" : ""}`}>
              ${centsToFixed2(saleCents)}
            </span>
          </div>
        </button>
      </div>

      {/* 4. Delete Action (Far Right) */}
      <div className="flex shrink-0 items-center pl-1">
        {isAlterationLine && line.alteration_intake_id && onEditAlterationLine ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditAlterationLine(line.alteration_intake_id!);
            }}
            className="group mr-1 flex h-9 w-9 items-center justify-center rounded-full text-app-accent transition-all hover:bg-app-accent hover:text-white"
            aria-label="Edit alteration line"
            data-testid="pos-alteration-line-edit"
          >
            <Edit3 size={15} className="transition-transform group-hover:scale-110" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); removeLine(line.cart_row_id); }}
          className="group flex h-9 w-9 items-center justify-center rounded-full text-app-danger transition-all hover:bg-app-danger hover:text-white"
          aria-label="Remove line"
        >
          <Trash2 size={16} className="transition-transform group-hover:scale-110" />
        </button>
      </div>
    </div>
  );
}
