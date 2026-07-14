interface VariationSortable {
  sku: string;
  variation_label?: string | null;
  variation_values: Record<string, unknown>;
}

const APPAREL_SIZE_ORDER = new Map<string, number>([
  ["XXXS", 0],
  ["3XS", 0],
  ["XXS", 1],
  ["2XS", 1],
  ["XS", 2],
  ["S", 3],
  ["SM", 3],
  ["M", 4],
  ["MD", 4],
  ["L", 5],
  ["LG", 5],
  ["XL", 6],
  ["1XL", 6],
  ["XXL", 7],
  ["2XL", 7],
  ["XXXL", 8],
  ["3XL", 8],
  ["4XL", 9],
  ["5XL", 10],
  ["6XL", 11],
]);

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function compareVariationText(a: string, b: string): number {
  const aText = a.trim();
  const bText = b.trim();
  const aRank = APPAREL_SIZE_ORDER.get(aText.toUpperCase());
  const bRank = APPAREL_SIZE_ORDER.get(bText.toUpperCase());
  if (aRank !== undefined || bRank !== undefined) {
    if (aRank === undefined) return 1;
    if (bRank === undefined) return -1;
    if (aRank !== bRank) return aRank - bRank;
  }
  return aText.localeCompare(bText, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortVariantsByVariation<T extends VariationSortable>(
  variants: readonly T[],
  preferredAxes: readonly (string | null | undefined)[] = [],
): T[] {
  const axes: string[] = [];
  for (const axis of preferredAxes) {
    const normalized = axis?.trim();
    if (normalized && !axes.includes(normalized)) axes.push(normalized);
  }
  for (const variant of variants) {
    for (const axis of Object.keys(variant.variation_values).sort()) {
      if (!axes.includes(axis)) axes.push(axis);
    }
  }

  return [...variants].sort((a, b) => {
    for (const axis of axes) {
      const comparison = compareVariationText(
        textValue(a.variation_values[axis]),
        textValue(b.variation_values[axis]),
      );
      if (comparison !== 0) return comparison;
    }
    const labelComparison = compareVariationText(
      a.variation_label ?? "",
      b.variation_label ?? "",
    );
    return labelComparison || compareVariationText(a.sku, b.sku);
  });
}
