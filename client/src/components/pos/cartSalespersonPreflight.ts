export interface SalespersonAttributionLine {
  sku: string;
  transaction_line_id?: string | null;
  salesperson_id?: string | null;
  gift_card_load_code?: string | null;
}

interface CheckoutSalespersonAttribution {
  lines: readonly SalespersonAttributionLine[];
  primarySalespersonId: string;
  isEmployeeSale: boolean;
  rmsPaymentSku?: string | null;
  staffAccountPaymentSku?: string | null;
}

function isSalespersonExemptLine(
  line: SalespersonAttributionLine,
  rmsPaymentSku?: string | null,
  staffAccountPaymentSku?: string | null,
): boolean {
  return (
    Boolean(line.gift_card_load_code?.trim()) ||
    Boolean(rmsPaymentSku && line.sku === rmsPaymentSku) ||
    Boolean(staffAccountPaymentSku && line.sku === staffAccountPaymentSku)
  );
}

export function hasCheckoutSalespersonAttribution({
  lines,
  primarySalespersonId,
  isEmployeeSale,
  rmsPaymentSku,
  staffAccountPaymentSku,
}: CheckoutSalespersonAttribution): boolean {
  if (isEmployeeSale || primarySalespersonId.trim()) return true;

  const postedSaleLines = lines.filter(
    (line) =>
      !line.transaction_line_id &&
      !isSalespersonExemptLine(
        line,
        rmsPaymentSku,
        staffAccountPaymentSku,
      ),
  );

  return postedSaleLines.every(
    (line) => Boolean(line.salesperson_id?.trim()),
  );
}
