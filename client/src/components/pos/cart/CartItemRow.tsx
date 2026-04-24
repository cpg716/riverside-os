import { Gift, Trash2, Tag } from "lucide-react";
import { type CartLineItem, type FulfillmentKind, type PosStaffRow } from "../types";
import { centsToFixed2, parseMoneyToCents } from "../../../lib/money";
import StaffMiniSelector from "../../ui/StaffMiniSelector";

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
  onLineProductTitleClick: (line: CartLineItem) => void;
  orderSalespersonLabel: string;
  hideLineSalesperson?: boolean;
  updateLineGiftWrapStatus: (rowId: string, status: boolean) => void;
  commissionStaff: PosStaffRow[];
}

function cartLineKey(l: Pick<CartLineItem, "cart_row_id">): string {
  return l.cart_row_id;
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
  onLineProductTitleClick,
  commissionStaff,
  orderSalespersonLabel,
  hideLineSalesperson = false,
  updateLineGiftWrapStatus,
}: CartItemRowProps) {
  const lk = cartLineKey(line);
  const isSelected = selectedLineKey === lk;
  const regCents = parseMoneyToCents(
    line.original_unit_price ?? line.standard_retail_price,
  );
  const saleCents = parseMoneyToCents(line.standard_retail_price);
  const showRegSale =
    line.original_unit_price != null && regCents > saleCents;
  const offPct =
    showRegSale && regCents > 0
      ? Math.round((1 - saleCents / regCents) * 100)
      : 0;

  const laterLabel =
    orderLaterFulfillment === "wedding_order"
      ? "Order"
      : "Order"; 

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
              <Tag size={10} />
              {line.sku}
            </span>
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
          </div>

          {!hideLineSalesperson && (
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
              placeholder={`Default (${orderSalespersonLabel || 'None'})`}
              className="scale-90 origin-left"
            />
          </div>
          )}
        </div>
      </div>

      {/* 2. Fulfillment Toggle (Middle) */}
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

      {/* 3. Qty & Sale Buttons (Right) */}
      <div 
        className="flex shrink-0 items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => {
            setSelectedLineKey(lk);
            setKeypadMode("qty");
            setKeypadBuffer("");
          }}
          className={`flex h-11 w-14 flex-col items-center justify-center rounded-xl border-2 transition-all ${
            keypadMode === "qty" && isSelected
              ? "border-app-accent bg-app-accent text-white shadow-lg"
              : "border-app-border bg-app-surface-2 text-app-text"
          }`}
        >
          <span className={`text-[8px] font-black uppercase tracking-widest ${keypadMode === "qty" && isSelected ? "text-white/80" : "text-app-text-muted"}`}>
            Qty
          </span>
          <span className="text-sm font-black tabular-nums leading-none">
            {line.quantity}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setSelectedLineKey(lk);
            setKeypadMode("price");
            setKeypadBuffer("");
          }}
          className={`flex h-11 min-w-[5.5rem] flex-col items-end justify-center rounded-xl border-2 px-3 transition-all ${
            keypadMode === "price" && isSelected
              ? "border-app-accent bg-app-accent text-white shadow-lg"
              : "border-app-border bg-app-surface-2 text-app-text"
          }`}
        >
          <span className={`text-[8px] font-black uppercase tracking-widest ${keypadMode === "price" && isSelected ? "text-white/80" : "text-app-text-muted"}`}>
            Sale
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
