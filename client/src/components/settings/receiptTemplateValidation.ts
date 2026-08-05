const INTENTIONAL_BARCODE_STUB_TOKENS = new Set([
  "{{CUSTOMER_LINE}}",
  "{{RECEIPT_ID}}",
  "{{RECEIPT_DATE}}",
]);

export function duplicateReceiptTokens(template: string) {
  const positions = new Map<string, number[]>();
  for (const match of template.matchAll(/\{\{[A-Z_]+\}\}/g)) {
    const token = match[0];
    positions.set(token, [...(positions.get(token) ?? []), match.index]);
  }
  const barcodeIndex = template.indexOf("{{BARCODE_IMAGE}}");

  return [...positions.entries()]
    .filter(([token, tokenPositions]) => {
      if (tokenPositions.length <= 1) return false;
      const isIntentionalBarcodeStub =
        INTENTIONAL_BARCODE_STUB_TOKENS.has(token) &&
        tokenPositions.length === 2 &&
        barcodeIndex >= 0 &&
        tokenPositions[0] < barcodeIndex &&
        tokenPositions[1] > barcodeIndex;
      return !isIntentionalBarcodeStub;
    })
    .map(([token]) => token);
}
