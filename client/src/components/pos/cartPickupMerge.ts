import type { CartLineItem, PickupTransactionSelection } from "./types";

export function mergePickupTransactionSelections(
  currentSelections: PickupTransactionSelection[],
  incomingSelections: PickupTransactionSelection[],
): PickupTransactionSelection[] {
  const incomingTransactionIds = new Set(
    incomingSelections.map((selection) => selection.transactionId),
  );
  return [
    ...currentSelections.filter(
      (selection) => !incomingTransactionIds.has(selection.transactionId),
    ),
    ...incomingSelections,
  ];
}

export function mergePickupCartLines(
  currentLines: CartLineItem[],
  currentSelections: PickupTransactionSelection[],
  incomingSelections: PickupTransactionSelection[],
  incomingLines: CartLineItem[],
): CartLineItem[] {
  const incomingTransactionIds = new Set(
    incomingSelections.map((selection) => selection.transactionId),
  );
  const replacedPickupLineIds = new Set(
    currentSelections
      .filter((selection) =>
        incomingTransactionIds.has(selection.transactionId),
      )
      .flatMap((selection) => selection.lineIds),
  );
  const incomingPickupLineIds = new Set(
    incomingSelections.flatMap((selection) => selection.lineIds),
  );
  return [
    ...currentLines.filter(
      (line) =>
        !line.transaction_line_id ||
        (!replacedPickupLineIds.has(line.transaction_line_id) &&
          !incomingPickupLineIds.has(line.transaction_line_id)),
    ),
    ...incomingLines,
  ];
}
