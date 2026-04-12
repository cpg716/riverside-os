import { Info, Gift, Trash2 } from "lucide-react";
import { type CartLineItem, type FulfillmentKind, type PosStaffRow } from "../types";
import { centsToFixed2, parseMoneyToCents } from "../../../lib/money";

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
      ? "Wedding order"
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
      className={`relative flex cursor-pointer items-stretch gap-2 rounded-xl border-2 p-2 transition-all ${
        isSelected
          ? "border-app-accent bg-app-accent/[0.06] shadow-md shadow-app-accent/10 ring-2 ring-app-accent/25"
          : "border-app-border bg-app-surface hover:bg-app-surface-2"
      }`}
    >
      {isSelected ? (
        <div className="absolute bottom-1.5 start-0 top-1.5 w-1 rounded-full bg-app-accent" />
      ) : null}

      {/* Inline start: product info */}
      <div className="min-w-0 flex-1 ps-2">
        {/* Title row */}
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            className="group/name min-w-0 flex-1 text-start"
            onClick={(e) => {
              e.stopPropagation();
              onLineProductTitleClick(line);
            }}
          >
            <div className="flex items-center gap-1">
              <h4 className="truncate text-sm font-black uppercase italic leading-tight tracking-tighter text-app-text group-hover/name:text-app-accent">
                {line.name}
              </h4>
              <Info size={12} className="shrink-0 text-app-text-muted opacity-0 transition-opacity group-hover/name:opacity-100" aria-hidden />
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeLine(line.cart_row_id); }}
            className="shrink-0 rounded-lg p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-600"
            aria-label="Remove line"
          >
            <Trash2 size={17} strokeWidth={2.25} />
          </button>
        </div>

        {/* SKU / variation / salesperson row */}
        <div
          className="mt-1 flex flex-wrap items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-xs font-black uppercase tracking-wide text-app-text">
            {line.sku}
          </span>
          {line.gift_card_load_code ? (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs font-black text-emerald-900 dark:text-emerald-200">
              #{line.gift_card_load_code}
            </span>
          ) : null}
          {line.variation_label ? (
            <span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-black uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
              {line.variation_label}
            </span>
          ) : null}
          {!hideLineSalesperson ? (
            <label className="flex min-w-0 items-center gap-1">
              <span className="sr-only">Line salesperson</span>
              <span className="shrink-0 text-[9px] font-black uppercase tracking-widest text-app-text-muted">Line</span>
              <select
                className="ui-input max-w-[9rem] cursor-pointer py-1 text-[10px] font-bold"
                value={line.salesperson_id ?? ""}
                onChange={(e) => updateLineSalesperson(line.cart_row_id, e.target.value)}
              >
                <option value="">
                  Same as sale{orderSalespersonLabel ? ` (${orderSalespersonLabel})` : ""}
                </option>
                {commissionStaff.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {/* Inline end: fulfillment + qty/price buttons */}
      <div
        className="flex shrink-0 flex-col gap-1.5"
        style={{ minWidth: "8.5rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Take now / Order later toggle */}
        <div className="flex rounded-lg border-2 border-app-border bg-app-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => updateLineFulfillment(line.cart_row_id, "takeaway")}
            className={`min-h-[32px] flex-1 rounded-md px-1.5 py-1 text-[9px] font-black uppercase tracking-wide transition-all ${
              line.fulfillment === "takeaway"
                ? "bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900"
                : "bg-transparent text-app-text"
            }`}
          >
            Take now
          </button>
          <button
            type="button"
            onClick={() => updateLineFulfillment(line.cart_row_id, orderLaterFulfillment)}
            className={`min-h-[32px] flex-1 rounded-md px-1.5 py-1 text-[9px] font-black uppercase tracking-wide transition-all ${
              line.fulfillment === orderLaterFulfillment
                ? "bg-amber-500 text-white shadow-sm"
                : "bg-transparent text-app-text"
            }`}
          >
            {laterLabel}
          </button>
        </div>

        {/* Gift Wrap Toggle */}
        <button
          type="button"
          onClick={() => updateLineGiftWrapStatus(line.cart_row_id, !line.needs_gift_wrap)}
          className={`group flex items-center justify-between rounded-lg border-2 px-2 py-1.5 transition-all active:scale-[0.97] ${
            line.needs_gift_wrap
              ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-app-border bg-app-surface text-app-text-muted hover:border-app-accent/30 hover:bg-app-accent/5 hover:text-app-text"
          }`}
        >
          <div className="flex items-center gap-1.5 overflow-hidden">
            <Gift
              size={13}
              className={`shrink-0 transition-transform ${
                line.needs_gift_wrap ? "scale-110" : "opacity-60 group-hover:scale-110 group-hover:opacity-100"
              }`}
            />
            <span className="truncate text-[9px] font-black uppercase tracking-widest">
              Gift Wrap
            </span>
          </div>
          <div
            className={`h-2 w-2 shrink-0 rounded-full transition-colors ${
              line.needs_gift_wrap ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-zinc-300 dark:bg-zinc-700"
            }`}
          />
        </button>

        {/* Qty / Price tap targets */}
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedLineKey(lk);
              setKeypadMode("qty");
              setKeypadBuffer("");
            }}
            className={`flex min-h-[40px] w-12 flex-col items-center justify-center rounded-lg border-2 px-1 transition-all ${
              keypadMode === "qty" && isSelected
                ? "border-app-accent bg-app-accent text-white shadow-md"
                : "border-app-border bg-app-surface-2 text-app-text"
            }`}
          >
            <span className={`text-[9px] font-black uppercase tracking-widest ${keypadMode === "qty" && isSelected ? "text-white/80" : "text-app-text-muted"}`}>
              Qty
            </span>
            <span className="text-base font-black tabular-nums leading-none">
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
            className={`flex min-h-[40px] flex-1 flex-col items-end justify-center rounded-lg border-2 px-2 text-right transition-all ${
              keypadMode === "price" && isSelected
                ? "border-app-accent bg-app-accent text-white shadow-md"
                : "border-app-border bg-app-surface-2 text-app-text"
            }`}
          >
            <span className={`text-[9px] font-black uppercase tracking-widest ${keypadMode === "price" && isSelected ? "text-white/80" : "text-app-text-muted"}`}>
              Sale
            </span>
            {showRegSale ? (
              <div className="flex flex-col items-end leading-tight">
                <span className={`text-[10px] font-bold tabular-nums line-through ${keypadMode === "price" && isSelected ? "text-white/70" : "text-app-text-muted"}`}>
                  ${centsToFixed2(regCents)}
                </span>
                <span className="text-sm font-black tabular-nums">
                  ${centsToFixed2(saleCents)}
                </span>
                {offPct > 0 ? (
                  <span className={`text-[9px] font-black ${keypadMode === "price" && isSelected ? "text-white/90" : "text-emerald-600 dark:text-emerald-400"}`}>
                    −{offPct}%
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="text-sm font-black tabular-nums">
                ${centsToFixed2(saleCents)}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
