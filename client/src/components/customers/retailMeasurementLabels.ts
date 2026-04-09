/**
 * Shared labels: CRM vault `customer_measurements` retail_* keys ↔ wedding member suit fields.
 * Used by hub, POS measurements drawer, and wedding manager sizing row.
 */

/** Body + retail fields for `PATCH /api/customers/{id}/measurements` (vault). */
export const VAULT_MEASUREMENT_FIELDS: {
  key: string;
  label: string;
  kind: "decimal" | "text";
}[] = [
  { key: "neck", label: "Neck", kind: "decimal" },
  { key: "chest", label: "Chest", kind: "decimal" },
  { key: "waist", label: "Waist (body)", kind: "decimal" },
  { key: "sleeve", label: "Sleeve", kind: "decimal" },
  { key: "inseam", label: "Inseam", kind: "decimal" },
  { key: "outseam", label: "Outseam", kind: "decimal" },
  { key: "seat", label: "Seat", kind: "decimal" },
  { key: "shoulder", label: "Shoulder", kind: "decimal" },
  { key: "retail_suit", label: "Suit size", kind: "text" },
  { key: "retail_waist", label: "Suit waist", kind: "text" },
  { key: "retail_vest", label: "Vest", kind: "text" },
  { key: "retail_shirt", label: "Shirt", kind: "text" },
  { key: "retail_shoe", label: "Shoe", kind: "text" },
];

export const CRM_RETAIL_MEASUREMENT_FIELDS: {
  crmKey:
    | "retail_suit"
    | "retail_waist"
    | "retail_vest"
    | "retail_shirt"
    | "retail_shoe";
  label: string;
}[] = [
  { crmKey: "retail_suit", label: "Suit size" },
  { crmKey: "retail_waist", label: "Suit waist" },
  { crmKey: "retail_vest", label: "Vest" },
  { crmKey: "retail_shirt", label: "Shirt" },
  { crmKey: "retail_shoe", label: "Shoe" },
];

/** Wedding API `WeddingMember` string fields for retail sizing. */
export const WEDDING_MEMBER_RETAIL_SIZE_FIELDS: {
  memberField: "suit" | "waist" | "vest" | "shirt" | "shoe";
  label: string;
}[] = [
  { memberField: "suit", label: "Suit size" },
  { memberField: "waist", label: "Suit waist" },
  { memberField: "vest", label: "Vest" },
  { memberField: "shirt", label: "Shirt" },
  { memberField: "shoe", label: "Shoe" },
];
