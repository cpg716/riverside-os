import type { ResolvedSkuItem } from "../components/pos/types";

type ScanCandidate = Pick<
  ResolvedSkuItem,
  "resolution_kind" | "sku" | "vendor_sku"
>;

const VERIFIED_SCAN_RESOLUTION_KINDS = new Set<
  NonNullable<ResolvedSkuItem["resolution_kind"]>
>([
  "variant_id",
  "sku",
  "barcode",
  "barcode_alias",
  "catalog_handle",
  "vendor_upc",
]);

/**
 * Only exact identifier resolution may mutate the cart from a scanner event.
 * A unique product-name search still requires staff to choose the item.
 */
export function isVerifiedPosScanResult(
  item: ScanCandidate,
  scannedCode: string,
): boolean {
  const resolutionKind = item.resolution_kind;
  if (resolutionKind) {
    return VERIFIED_SCAN_RESOLUTION_KINDS.has(resolutionKind);
  }

  const normalizedCode = scannedCode.trim().toLowerCase();
  if (!normalizedCode) return false;
  return (
    item.sku.trim().toLowerCase() === normalizedCode ||
    item.vendor_sku?.trim().toLowerCase() === normalizedCode
  );
}
