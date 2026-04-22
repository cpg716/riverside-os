export type CustomOrderVendorFamily =
  | "hart_schaffner_marx"
  | "individualized_shirts"
  | "manual_custom";

export type CustomOrderSubtypeKey =
  | "hsm_suit"
  | "hsm_sport_coat"
  | "hsm_slacks"
  | "individualized_shirt";

export interface HsmCustomFitDetails {
  hsm_coat_size?: string | null;
  hsm_pant_size?: string | null;
  hsm_vest_size?: string | null;
  hsm_coat_length?: string | null;
  hsm_pant_inseam?: string | null;
  hsm_left_sleeve?: string | null;
  hsm_right_sleeve?: string | null;
  hsm_left_out?: string | null;
  hsm_right_out?: string | null;
  hsm_vent_style?: string | null;
  hsm_lapel_style?: string | null;
  hsm_button_stance?: string | null;
  hsm_fabric_reservation_number?: string | null;
}

export interface IndividualizedShirtFitDetails {
  shirt_previous_order_number?: string | null;
  shirt_try_on_size?: string | null;
  shirt_shaping?: string | null;
  shirt_collar_size?: string | null;
  shirt_tail_length?: string | null;
  shirt_yoke?: string | null;
  shirt_right_sleeve_length?: string | null;
  shirt_left_sleeve_length?: string | null;
  shirt_right_cuff_size?: string | null;
  shirt_left_cuff_size?: string | null;
  shirt_shoulder_line?: string | null;
  shirt_front_style?: string | null;
  shirt_back_style?: string | null;
  shirt_tail_style?: string | null;
  shirt_button_choice?: string | null;
  shirt_pocket_style?: string | null;
}

export interface CustomOrderDetails
  extends HsmCustomFitDetails,
    IndividualizedShirtFitDetails {
  subtype_key: CustomOrderSubtypeKey;
  vendor_form_family: CustomOrderVendorFamily;
  garment_description?: string | null;
  fabric_reference?: string | null;
  style_reference?: string | null;
  reference_number?: string | null;
  custom_notes?: string | null;
  hsm_garment_type?: string | null;
  hsm_model_code?: string | null;
  hsm_trim_reference?: string | null;
  shirt_description?: string | null;
  shirt_fit_notes?: string | null;
  shirt_collar_style?: string | null;
  shirt_cuff_style?: string | null;
}

export const CUSTOM_ORDER_SUBTYPES = [
  {
    sku: "100",
    itemType: "HSM Suit",
    mappingKey: "hsm_suit",
    vendorFormFamily: "hart_schaffner_marx",
    garmentDescriptionLabel: "Suit description",
  },
  {
    sku: "105",
    itemType: "HSM Sport Coat",
    mappingKey: "hsm_sport_coat",
    vendorFormFamily: "hart_schaffner_marx",
    garmentDescriptionLabel: "Sport coat description",
  },
  {
    sku: "110",
    itemType: "HSM Slacks",
    mappingKey: "hsm_slacks",
    vendorFormFamily: "hart_schaffner_marx",
    garmentDescriptionLabel: "Slacks description",
  },
  {
    sku: "200",
    itemType: "Individualized Shirt",
    mappingKey: "individualized_shirt",
    vendorFormFamily: "individualized_shirts",
    garmentDescriptionLabel: "Shirt description",
  },
] as const;

export const MANUAL_CUSTOM_ITEM_TYPES = [
  "Suit",
  "Sport Coat",
  "Slacks",
  "Individualized Shirt",
  "Other",
] as const;

function normalizeSku(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function customOrderSubtypeForSku(
  sku: string | null | undefined,
): (typeof CUSTOM_ORDER_SUBTYPES)[number] | null {
  const normalized = normalizeSku(sku);
  return CUSTOM_ORDER_SUBTYPES.find((entry) => entry.sku === normalized) ?? null;
}

export function customOrderItemTypeForSku(
  sku: string | null | undefined,
): string | null {
  return customOrderSubtypeForSku(sku)?.itemType ?? null;
}

export function isCustomOrderSku(sku: string | null | undefined): boolean {
  const normalized = normalizeSku(sku);
  return normalized.startsWith("CUSTOM") || customOrderSubtypeForSku(normalized) !== null;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function customVendorLabel(value: string | null | undefined): string {
  switch (value) {
    case "hart_schaffner_marx":
      return "HSM Form";
    case "individualized_shirts":
      return "Individualized Form";
    default:
      return "Custom Form";
  }
}

export function customOrderDetailEntries(
  details: Partial<CustomOrderDetails> | null | undefined,
): Array<{ label: string; value: string }> {
  if (!details) return [];

  const entries: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    const cleaned = cleanText(value);
    if (cleaned) entries.push({ label, value: cleaned });
  };

  push("Description", details.garment_description ?? details.shirt_description);
  push("Fabric", details.fabric_reference);
  push("Style", details.style_reference);
  push("Reference", details.reference_number);
  push("Model", details.hsm_model_code);
  push("Garment Type", details.hsm_garment_type);
  push("Trim", details.hsm_trim_reference);
  push("Coat Size", details.hsm_coat_size);
  push("Pant Size", details.hsm_pant_size);
  push("Vest Size", details.hsm_vest_size);
  push("Coat Length", details.hsm_coat_length);
  push("Pant Inseam", details.hsm_pant_inseam);
  push("Left Sleeve", details.hsm_left_sleeve);
  push("Right Sleeve", details.hsm_right_sleeve);
  push("Left Out", details.hsm_left_out);
  push("Right Out", details.hsm_right_out);
  push("Vent", details.hsm_vent_style);
  push("Lapel", details.hsm_lapel_style);
  push("Button Stance", details.hsm_button_stance);
  push("Fabric Reservation", details.hsm_fabric_reservation_number);
  push("Previous Order", details.shirt_previous_order_number);
  push("Try-On Size", details.shirt_try_on_size);
  push("Shaping", details.shirt_shaping);
  push("Collar", details.shirt_collar_style);
  push("Collar Size", details.shirt_collar_size);
  push("Cuff", details.shirt_cuff_style);
  push("Tail Length", details.shirt_tail_length);
  push("Yoke", details.shirt_yoke);
  push("Right Sleeve", details.shirt_right_sleeve_length);
  push("Left Sleeve", details.shirt_left_sleeve_length);
  push("Right Cuff", details.shirt_right_cuff_size);
  push("Left Cuff", details.shirt_left_cuff_size);
  push("Shoulder Line", details.shirt_shoulder_line);
  push("Front", details.shirt_front_style);
  push("Back", details.shirt_back_style);
  push("Tail", details.shirt_tail_style);
  push("Buttons", details.shirt_button_choice);
  push("Pocket", details.shirt_pocket_style);
  push("Fit Notes", details.shirt_fit_notes);
  push("Notes", details.custom_notes);

  return entries;
}

export function normalizeCustomOrderDetails(
  sku: string | null | undefined,
  details: Partial<CustomOrderDetails> | null | undefined,
): CustomOrderDetails | null {
  const subtype = customOrderSubtypeForSku(sku);
  if (!subtype || !details) return null;

  const base: CustomOrderDetails = {
    subtype_key: subtype.mappingKey,
    vendor_form_family: subtype.vendorFormFamily,
    garment_description: cleanText(details.garment_description),
    fabric_reference: cleanText(details.fabric_reference),
    style_reference: cleanText(details.style_reference),
    reference_number: cleanText(details.reference_number),
    custom_notes: cleanText(details.custom_notes),
    hsm_garment_type: cleanText(details.hsm_garment_type),
    hsm_model_code: cleanText(details.hsm_model_code),
    hsm_trim_reference: cleanText(details.hsm_trim_reference),
    hsm_coat_size: cleanText(details.hsm_coat_size),
    hsm_pant_size: cleanText(details.hsm_pant_size),
    hsm_vest_size: cleanText(details.hsm_vest_size),
    hsm_coat_length: cleanText(details.hsm_coat_length),
    hsm_pant_inseam: cleanText(details.hsm_pant_inseam),
    hsm_left_sleeve: cleanText(details.hsm_left_sleeve),
    hsm_right_sleeve: cleanText(details.hsm_right_sleeve),
    hsm_left_out: cleanText(details.hsm_left_out),
    hsm_right_out: cleanText(details.hsm_right_out),
    hsm_vent_style: cleanText(details.hsm_vent_style),
    hsm_lapel_style: cleanText(details.hsm_lapel_style),
    hsm_button_stance: cleanText(details.hsm_button_stance),
    hsm_fabric_reservation_number: cleanText(details.hsm_fabric_reservation_number),
    shirt_description: cleanText(details.shirt_description),
    shirt_fit_notes: cleanText(details.shirt_fit_notes),
    shirt_collar_style: cleanText(details.shirt_collar_style),
    shirt_cuff_style: cleanText(details.shirt_cuff_style),
    shirt_previous_order_number: cleanText(details.shirt_previous_order_number),
    shirt_try_on_size: cleanText(details.shirt_try_on_size),
    shirt_shaping: cleanText(details.shirt_shaping),
    shirt_collar_size: cleanText(details.shirt_collar_size),
    shirt_tail_length: cleanText(details.shirt_tail_length),
    shirt_yoke: cleanText(details.shirt_yoke),
    shirt_right_sleeve_length: cleanText(details.shirt_right_sleeve_length),
    shirt_left_sleeve_length: cleanText(details.shirt_left_sleeve_length),
    shirt_right_cuff_size: cleanText(details.shirt_right_cuff_size),
    shirt_left_cuff_size: cleanText(details.shirt_left_cuff_size),
    shirt_shoulder_line: cleanText(details.shirt_shoulder_line),
    shirt_front_style: cleanText(details.shirt_front_style),
    shirt_back_style: cleanText(details.shirt_back_style),
    shirt_tail_style: cleanText(details.shirt_tail_style),
    shirt_button_choice: cleanText(details.shirt_button_choice),
    shirt_pocket_style: cleanText(details.shirt_pocket_style),
  };

  return Object.values(base).some((value) => value != null && value !== subtype.mappingKey && value !== subtype.vendorFormFamily)
    ? base
    : {
        subtype_key: base.subtype_key,
        vendor_form_family: base.vendor_form_family,
      };
}
