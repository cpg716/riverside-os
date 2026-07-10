import { centsToFixed2 } from "./money";

export type TaxCategory = "clothing" | "footwear" | "accessory" | "service" | "other";

const CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_CENTS = 11000; // $110.00
const NYS_STATE_SALES_TAX_RATE = 0.04;
const ERIE_LOCAL_SALES_TAX_RATE = 0.0475;

function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

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
  if (normalizedCategory === "service") {
    return { stateTaxCents: 0, localTaxCents: 0 };
  }
  const isClothingOrFootwear = normalizedCategory === "clothing" || normalizedCategory === "footwear";
  const exemptFromState = isClothingOrFootwear && unitPriceCents < CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_CENTS;

  const stateRate = exemptFromState ? 0 : NYS_STATE_SALES_TAX_RATE;
  const localRate = ERIE_LOCAL_SALES_TAX_RATE;

  // Match rust_decimal MidpointAwayFromZero for both sales and negative adjustments.
  const stateTaxCents = roundHalfAwayFromZero(unitPriceCents * stateRate);
  const localTaxCents = roundHalfAwayFromZero(unitPriceCents * localRate);

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
