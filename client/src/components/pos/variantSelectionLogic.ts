import type { VariantOption } from "./VariantSelectionModal";

const STANDARD_OPTION = "\u0000standard";

export function parseVariantAttributes(label: string): string[] {
  return label
    .split(/[ \t]+\/[ \t]+|[|,]/)
    .map((value) => value.trim())
    .filter((value) => value && value !== "*" && value !== "_");
}

export function buildVariantSelectionModel(variants: VariantOption[]): {
  steps: string[];
  entries: Array<{ variant: VariantOption; path: string[] }>;
} {
  const rawPaths = variants.map((variant) =>
    parseVariantAttributes(variant.variation_label),
  );
  const maxDepth = Math.max(1, ...rawPaths.map((path) => path.length));
  const normalizedPaths = rawPaths.map((path) => [
    ...path,
    ...Array.from({ length: maxDepth - path.length }, () => STANDARD_OPTION),
  ]);
  const signatureCounts = new Map<string, number>();
  normalizedPaths.forEach((path) => {
    const signature = JSON.stringify(path);
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  });
  const needsSkuChoice = [...signatureCounts.values()].some((count) => count > 1);

  return {
    steps: [
      ...Array.from({ length: maxDepth }, (_, index) => `Option ${index + 1}`),
      ...(needsSkuChoice ? ["SKU"] : []),
    ],
    entries: variants.map((variant, index) => ({
      variant,
      path: needsSkuChoice
        ? [...normalizedPaths[index], `SKU ${variant.sku}`]
        : normalizedPaths[index],
    })),
  };
}

export function variantSelectionChoiceLabel(choice: string): string {
  return choice === STANDARD_OPTION ? "Standard" : choice;
}

export function initialVariantSelectionPath(
  entries: Array<{ variant: VariantOption; path: string[] }>,
  initialVariantId?: string,
): string[] {
  const currentAttributes = entries.find(
    (entry) => entry.variant.variant_id === initialVariantId,
  )?.path;
  if (!currentAttributes) return [];
  const firstDifference = currentAttributes.findIndex((attribute, index) =>
    entries.some((entry) => entry.path[index] !== attribute),
  );
  const commonLength =
    firstDifference === -1 ? currentAttributes.length : firstDifference;
  return currentAttributes.slice(
    0,
    Math.min(commonLength, Math.max(0, currentAttributes.length - 1)),
  );
}
