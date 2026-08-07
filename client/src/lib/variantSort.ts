interface VariationSortable {
  sku: string;
  variation_label?: string | null;
  variation_values?: Record<string, unknown>;
}

const APPAREL_SIZE_ORDER = new Map<string, number>([
  ["OS", 0],
  ["ONESIZE", 0],
  ["XXXS", 1],
  ["3XS", 1],
  ["XXS", 2],
  ["2XS", 2],
  ["XS", 3],
  ["XSMALL", 3],
  ["EXTRASMALL", 3],
  ["S", 4],
  ["SM", 4],
  ["SML", 4],
  ["SMALL", 4],
  ["M", 5],
  ["MD", 5],
  ["MED", 5],
  ["MEDIUM", 5],
  ["L", 6],
  ["LG", 6],
  ["LRG", 6],
  ["LARGE", 6],
  ["XL", 7],
  ["1XL", 7],
  ["XLARGE", 7],
  ["EXTRALARGE", 7],
  ["XXL", 8],
  ["2XL", 8],
  ["2XLARGE", 8],
  ["XXXL", 9],
  ["3XL", 9],
  ["3XLARGE", 9],
  ["4XL", 10],
  ["4XLARGE", 10],
  ["5XL", 11],
  ["5XLARGE", 11],
  ["6XL", 12],
  ["6XLARGE", 12],
]);

function apparelSizeRank(value: string): number | undefined {
  const key = value
    .trim()
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[\s._/-]+/g, "");
  return APPAREL_SIZE_ORDER.get(key);
}

function normalizedNaturalText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([\p{L}\p{N}])\s*[/-]\s*(?=[\p{L}\p{N}])/gu, "$1-");
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function compareVariationSegment(a: string, b: string): number {
  const aText = a.trim();
  const bText = b.trim();
  const aRank = apparelSizeRank(aText);
  const bRank = apparelSizeRank(bText);
  if (aRank !== undefined || bRank !== undefined) {
    if (aRank === undefined) return 1;
    if (bRank === undefined) return -1;
    if (aRank !== bRank) return aRank - bRank;
  }
  return normalizedNaturalText(aText).localeCompare(
    normalizedNaturalText(bText),
    undefined,
    {
    numeric: true,
    sensitivity: "base",
    },
  );
}

export function compareVariationText(a: string, b: string): number {
  const aSegments = a.trim().split(/\s+\/\s+/);
  const bSegments = b.trim().split(/\s+\/\s+/);
  const segmentCount = Math.max(aSegments.length, bSegments.length);

  for (let index = 0; index < segmentCount; index += 1) {
    const comparison = compareVariationSegment(
      aSegments[index] ?? "",
      bSegments[index] ?? "",
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
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
    for (const axis of Object.keys(variant.variation_values ?? {}).sort()) {
      if (!axes.includes(axis)) axes.push(axis);
    }
  }

  return [...variants].sort((a, b) => {
    for (const axis of axes) {
      const comparison = compareVariationText(
        textValue(a.variation_values?.[axis]),
        textValue(b.variation_values?.[axis]),
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
