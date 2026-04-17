import { centsToFixed2 } from "./money";

export type TaxCategory = "clothing" | "footwear" | "other";

const CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_CENTS = 11000; // $110.00
const NYS_STATE_SALES_TAX_RATE = 0.04;
const ERIE_LOCAL_SALES_TAX_RATE = 0.0475;

/** 
 * Recalculates tax for a single unit based on NYS §3.3 rules.
 * Clothing/Footwear under $110 net price is exempt from the 4% state tax.
 * returns { stateTaxCents, localTaxCents }
 */
export function calculateNysErieTaxForUnit(
  category: TaxCategory,
  unitPriceCents: number
): { stateTaxCents: number; localTaxCents: number } {
  const normalizedCategory = category.toLowerCase();
  const isClothingOrFootwear = normalizedCategory === "clothing" || normalizedCategory === "footwear";
  const exemptFromState = isClothingOrFootwear && unitPriceCents < CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_CENTS;

  const stateRate = exemptFromState ? 0 : NYS_STATE_SALES_TAX_RATE;
  const localRate = ERIE_LOCAL_SALES_TAX_RATE;

  // Use Math.round to match rust_decimal MidpointAwayFromZero for positive numbers
  const stateTaxCents = Math.round(unitPriceCents * stateRate);
  const localTaxCents = Math.round(unitPriceCents * localRate);

  return { stateTaxCents, localTaxCents };
}

/** Utility to return the taxes as fixed-2 strings for component state. */
export function calculateNysErieTaxStringsForUnit(
  category: TaxCategory,
  unitPriceCents: number
) {
  const { stateTaxCents, localTaxCents } = calculateNysErieTaxForUnit(category, unitPriceCents);
  return {
    stateTax: centsToFixed2(stateTaxCents),
    localTax: centsToFixed2(localTaxCents),
  };
}
