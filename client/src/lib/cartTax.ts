import type { CartLineItem } from "../components/pos/types";
import { calculateNysErieTaxStringsForUnit } from "./tax";

type CartTaxLine = Pick<
  CartLineItem,
  "line_type" | "custom_item_type" | "tax_category" | "sku"
>;

export function isAlterationServiceLine(line: CartTaxLine): boolean {
  return line.line_type === "alteration_service" || line.custom_item_type === "alteration_service";
}

export function isShippingChargeLine(line: CartTaxLine): boolean {
  return line.sku.trim().toUpperCase() === "SHIPPING";
}

export function isLockedNonTaxableLine(line: CartTaxLine): boolean {
  return isAlterationServiceLine(line) || isShippingChargeLine(line);
}

export function isNonTaxableServiceLine(line: CartTaxLine): boolean {
  return line.tax_category === "service" || isLockedNonTaxableLine(line);
}

export function calculateCartLineTaxStrings(line: CartTaxLine, unitPriceCents: number) {
  if (isNonTaxableServiceLine(line)) {
    return { stateTax: "0.00", localTax: "0.00" };
  }
  return calculateNysErieTaxStringsForUnit(line.tax_category || "other", unitPriceCents);
}
