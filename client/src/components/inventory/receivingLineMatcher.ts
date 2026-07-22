export interface ReceivingLineIdentifiers {
  variant_id: string;
}

export interface ReceivingStageLine extends ReceivingLineIdentifiers {
  qty_ordered: number;
  qty_previously_received: number;
  qty_receiving: number;
}

export interface ReceivingScanStageResult<T extends ReceivingStageLine> {
  status: "staged" | "not_found" | "ambiguous" | "at_limit";
  lines: T[];
  line?: T;
}

export function matchReceivingVariantIndex(
  lines: ReceivingLineIdentifiers[],
  variantId: string,
): number {
  const normalizedVariantId = variantId.trim().toLowerCase();
  if (!normalizedVariantId) return -1;
  const matchingLineIndexes = lines
    .map((line, index) => ({
      index,
      variantId: line.variant_id.trim().toLowerCase(),
    }))
    .filter((line) => line.variantId === normalizedVariantId)
    .map((line) => line.index);

  if (matchingLineIndexes.length > 1) return -2;
  return matchingLineIndexes[0] ?? -1;
}

export function stageReceivingVariantScan<T extends ReceivingStageLine>(
  lines: T[],
  variantId: string,
): ReceivingScanStageResult<T> {
  const index = matchReceivingVariantIndex(lines, variantId);
  if (index === -2) return { status: "ambiguous", lines };
  if (index === -1) return { status: "not_found", lines };

  const line = lines[index];
  const remaining = Math.max(
    0,
    line.qty_ordered - line.qty_previously_received,
  );
  if (line.qty_receiving >= remaining) {
    return { status: "at_limit", lines, line };
  }

  const stagedLine = { ...line, qty_receiving: line.qty_receiving + 1 };
  const next = [...lines];
  next[index] = stagedLine;
  return { status: "staged", lines: next, line: stagedLine };
}
