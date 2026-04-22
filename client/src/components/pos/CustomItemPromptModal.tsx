import { useState, useEffect } from "react";
import type { TaxCategory } from "../../lib/tax";
import {
  MANUAL_CUSTOM_ITEM_TYPES,
  normalizeCustomOrderDetails,
  customOrderSubtypeForSku,
  type CustomOrderDetails,
} from "../../lib/customOrders";

interface CustomItemPromptModalProps {
  isOpen: boolean;
  sku?: string | null;
  onClose: () => void;
  onConfirm: (data: {
    itemType: string;
    price: string;
    needByDate: string | null;
    isRush: boolean; 
    needsGiftWrap: boolean;
    taxCategory: TaxCategory;
    customOrderDetails?: CustomOrderDetails | null;
  }) => void;
}

export default function CustomItemPromptModal({
  isOpen,
  sku,
  onClose,
  onConfirm,
}: CustomItemPromptModalProps) {
  const knownSubtype = customOrderSubtypeForSku(sku);
  const [itemType, setItemType] = useState<string>(
    knownSubtype?.itemType ?? MANUAL_CUSTOM_ITEM_TYPES[0],
  );
  const [price, setPrice] = useState("");
  const [needByDate, setNeedByDate] = useState("");
  const [isRush, setIsRush] = useState(false);
  const [needsGiftWrap, setNeedsGiftWrap] = useState(false);
  const [taxCategory, setTaxCategory] = useState<TaxCategory>("clothing");
  const [garmentDescription, setGarmentDescription] = useState("");
  const [fabricReference, setFabricReference] = useState("");
  const [styleReference, setStyleReference] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [customNotes, setCustomNotes] = useState("");
  const [hsmGarmentType, setHsmGarmentType] = useState("");
  const [hsmModelCode, setHsmModelCode] = useState("");
  const [hsmTrimReference, setHsmTrimReference] = useState("");
  const [hsmCoatSize, setHsmCoatSize] = useState("");
  const [hsmPantSize, setHsmPantSize] = useState("");
  const [hsmVestSize, setHsmVestSize] = useState("");
  const [hsmCoatLength, setHsmCoatLength] = useState("");
  const [hsmPantInseam, setHsmPantInseam] = useState("");
  const [hsmLeftSleeve, setHsmLeftSleeve] = useState("");
  const [hsmRightSleeve, setHsmRightSleeve] = useState("");
  const [hsmLeftOut, setHsmLeftOut] = useState("");
  const [hsmRightOut, setHsmRightOut] = useState("");
  const [hsmVentStyle, setHsmVentStyle] = useState("");
  const [hsmLapelStyle, setHsmLapelStyle] = useState("");
  const [hsmButtonStance, setHsmButtonStance] = useState("");
  const [hsmFabricReservationNumber, setHsmFabricReservationNumber] = useState("");
  const [shirtFitNotes, setShirtFitNotes] = useState("");
  const [shirtCollarStyle, setShirtCollarStyle] = useState("");
  const [shirtCuffStyle, setShirtCuffStyle] = useState("");
  const [shirtPreviousOrderNumber, setShirtPreviousOrderNumber] = useState("");
  const [shirtTryOnSize, setShirtTryOnSize] = useState("");
  const [shirtShaping, setShirtShaping] = useState("");
  const [shirtCollarSize, setShirtCollarSize] = useState("");
  const [shirtTailLength, setShirtTailLength] = useState("");
  const [shirtYoke, setShirtYoke] = useState("");
  const [shirtRightSleeveLength, setShirtRightSleeveLength] = useState("");
  const [shirtLeftSleeveLength, setShirtLeftSleeveLength] = useState("");
  const [shirtRightCuffSize, setShirtRightCuffSize] = useState("");
  const [shirtLeftCuffSize, setShirtLeftCuffSize] = useState("");
  const [shirtShoulderLine, setShirtShoulderLine] = useState("");
  const [shirtFrontStyle, setShirtFrontStyle] = useState("");
  const [shirtBackStyle, setShirtBackStyle] = useState("");
  const [shirtTailStyle, setShirtTailStyle] = useState("");
  const [shirtButtonChoice, setShirtButtonChoice] = useState("");
  const [shirtPocketStyle, setShirtPocketStyle] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setItemType(knownSubtype?.itemType ?? MANUAL_CUSTOM_ITEM_TYPES[0]);
    setGarmentDescription("");
    setFabricReference("");
    setStyleReference("");
    setReferenceNumber("");
    setCustomNotes("");
    setHsmGarmentType("");
    setHsmModelCode("");
    setHsmTrimReference("");
    setHsmCoatSize("");
    setHsmPantSize("");
    setHsmVestSize("");
    setHsmCoatLength("");
    setHsmPantInseam("");
    setHsmLeftSleeve("");
    setHsmRightSleeve("");
    setHsmLeftOut("");
    setHsmRightOut("");
    setHsmVentStyle("");
    setHsmLapelStyle("");
    setHsmButtonStance("");
    setHsmFabricReservationNumber("");
    setShirtFitNotes("");
    setShirtCollarStyle("");
    setShirtCuffStyle("");
    setShirtPreviousOrderNumber("");
    setShirtTryOnSize("");
    setShirtShaping("");
    setShirtCollarSize("");
    setShirtTailLength("");
    setShirtYoke("");
    setShirtRightSleeveLength("");
    setShirtLeftSleeveLength("");
    setShirtRightCuffSize("");
    setShirtLeftCuffSize("");
    setShirtShoulderLine("");
    setShirtFrontStyle("");
    setShirtBackStyle("");
    setShirtTailStyle("");
    setShirtButtonChoice("");
    setShirtPocketStyle("");
  }, [isOpen, knownSubtype]);

  // Sync tax category when item type changes
  useEffect(() => {
    if (itemType === "Other") {
      setTaxCategory("other");
    } else {
      setTaxCategory("clothing");
    }
  }, [itemType]);

  const parsedPrice = Number.parseFloat(price);
  const priceIsValid = Number.isFinite(parsedPrice) && parsedPrice > 0;

  const handleConfirm = () => {
    if (!priceIsValid) return;
    const customOrderDetails = normalizeCustomOrderDetails(sku, {
      garment_description:
        knownSubtype?.mappingKey === "individualized_shirt"
          ? null
          : garmentDescription,
      shirt_description:
        knownSubtype?.mappingKey === "individualized_shirt"
          ? garmentDescription
          : null,
      fabric_reference: fabricReference,
      style_reference: styleReference,
      reference_number: referenceNumber,
      custom_notes: customNotes,
      hsm_garment_type: hsmGarmentType,
      hsm_model_code: hsmModelCode,
      hsm_trim_reference: hsmTrimReference,
      hsm_coat_size: hsmCoatSize,
      hsm_pant_size: hsmPantSize,
      hsm_vest_size: hsmVestSize,
      hsm_coat_length: hsmCoatLength,
      hsm_pant_inseam: hsmPantInseam,
      hsm_left_sleeve: hsmLeftSleeve,
      hsm_right_sleeve: hsmRightSleeve,
      hsm_left_out: hsmLeftOut,
      hsm_right_out: hsmRightOut,
      hsm_vent_style: hsmVentStyle,
      hsm_lapel_style: hsmLapelStyle,
      hsm_button_stance: hsmButtonStance,
      hsm_fabric_reservation_number: hsmFabricReservationNumber,
      shirt_fit_notes: shirtFitNotes,
      shirt_collar_style: shirtCollarStyle,
      shirt_cuff_style: shirtCuffStyle,
      shirt_previous_order_number: shirtPreviousOrderNumber,
      shirt_try_on_size: shirtTryOnSize,
      shirt_shaping: shirtShaping,
      shirt_collar_size: shirtCollarSize,
      shirt_tail_length: shirtTailLength,
      shirt_yoke: shirtYoke,
      shirt_right_sleeve_length: shirtRightSleeveLength,
      shirt_left_sleeve_length: shirtLeftSleeveLength,
      shirt_right_cuff_size: shirtRightCuffSize,
      shirt_left_cuff_size: shirtLeftCuffSize,
      shirt_shoulder_line: shirtShoulderLine,
      shirt_front_style: shirtFrontStyle,
      shirt_back_style: shirtBackStyle,
      shirt_tail_style: shirtTailStyle,
      shirt_button_choice: shirtButtonChoice,
      shirt_pocket_style: shirtPocketStyle,
    });
    onConfirm({
      itemType,
      price: price || "0.00",
      needByDate: needByDate || null,
      isRush,
      needsGiftWrap,
      taxCategory,
      customOrderDetails,
    });
    // Reset
    setPrice("");
    setNeedByDate("");
    setIsRush(false);
    setNeedsGiftWrap(false);
    setGarmentDescription("");
    setFabricReference("");
    setStyleReference("");
    setReferenceNumber("");
    setCustomNotes("");
    setHsmGarmentType("");
    setHsmModelCode("");
    setHsmTrimReference("");
    setHsmCoatSize("");
    setHsmPantSize("");
    setHsmVestSize("");
    setHsmCoatLength("");
    setHsmPantInseam("");
    setHsmLeftSleeve("");
    setHsmRightSleeve("");
    setHsmLeftOut("");
    setHsmRightOut("");
    setHsmVentStyle("");
    setHsmLapelStyle("");
    setHsmButtonStance("");
    setHsmFabricReservationNumber("");
    setShirtFitNotes("");
    setShirtCollarStyle("");
    setShirtCuffStyle("");
    setShirtPreviousOrderNumber("");
    setShirtTryOnSize("");
    setShirtShaping("");
    setShirtCollarSize("");
    setShirtTailLength("");
    setShirtYoke("");
    setShirtRightSleeveLength("");
    setShirtLeftSleeveLength("");
    setShirtRightCuffSize("");
    setShirtLeftCuffSize("");
    setShirtShoulderLine("");
    setShirtFrontStyle("");
    setShirtBackStyle("");
    setShirtTailStyle("");
    setShirtButtonChoice("");
    setShirtPocketStyle("");
  };

  return (
    <div
      className={`fixed inset-0 z-[120] flex items-center justify-center p-4 transition-all ${
        isOpen ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="border-b border-app-border bg-app-surface-2 px-6 py-4">
          <h3 className="text-lg font-black uppercase italic tracking-tighter text-app-text">
            Custom Order
          </h3>
          <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
            Enter booking details
          </p>
        </div>

        <div className="space-y-4 p-6">
          {knownSubtype ? (
            <div className="space-y-1.5 rounded-2xl border border-app-border bg-app-surface-2 p-4">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Custom Type
              </label>
              <p className="text-sm font-black text-app-text">{knownSubtype.itemType}</p>
              <p className="text-[11px] font-semibold text-app-text-muted">
                This SKU always books as a Custom order.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Item Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                {MANUAL_CUSTOM_ITEM_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setItemType(t)}
                    className={`rounded-xl border-2 px-3 py-2 text-[10px] font-black uppercase tracking-wide transition-all ${
                      itemType === t
                        ? "border-app-accent bg-app-accent/10 text-app-accent shadow-sm"
                        : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-input-border hover:bg-app-surface"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tax Category Override */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Tax Classification
            </label>
            <div className="flex gap-2">
              {(["clothing", "footwear", "other"] as TaxCategory[]).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setTaxCategory(cat)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${
                    taxCategory === cat
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
                      : "border-app-border bg-app-surface-2 text-app-text-muted"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Price */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Sale Price ($)
            </label>
            <input
              type="text"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="ui-input h-12 w-full text-lg font-black tabular-nums tracking-tight"
            />
          </div>

          <div className="rounded-2xl border border-amber-200/70 bg-amber-50/60 p-3 text-[11px] font-semibold text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            Actual vendor cost is entered when the custom garment is received.
          </div>

          {/* Need By Date */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Need By Date
            </label>
            <input
              type="date"
              value={needByDate}
              onChange={(e) => setNeedByDate(e.target.value)}
              className="ui-input h-12 w-full text-sm font-bold uppercase tracking-widest"
            />
          </div>

          {knownSubtype?.vendorFormFamily === "hart_schaffner_marx" && (
            <div className="space-y-3 rounded-2xl border border-app-border bg-app-surface-2 p-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  HSM Form Details
                </p>
                <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                  Capture the key details from the HSM form. Full measurements can stay on the
                  paper form for now.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {knownSubtype.garmentDescriptionLabel}
                </label>
                <input
                  type="text"
                  value={garmentDescription}
                  onChange={(e) => setGarmentDescription(e.target.value)}
                  placeholder="Navy single-breasted suit"
                  className="ui-input h-11 w-full text-sm font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Fabric Reference
                  </label>
                  <input
                    type="text"
                    value={fabricReference}
                    onChange={(e) => setFabricReference(e.target.value)}
                    placeholder="Fabric book / swatch"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Style Reference
                  </label>
                  <input
                    type="text"
                    value={styleReference}
                    onChange={(e) => setStyleReference(e.target.value)}
                    placeholder="Style / fabric range"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Garment Type
                  </label>
                  <input
                    type="text"
                    value={hsmGarmentType}
                    onChange={(e) => setHsmGarmentType(e.target.value)}
                    placeholder="CP / CVP"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Model Code
                  </label>
                  <input
                    type="text"
                    value={hsmModelCode}
                    onChange={(e) => setHsmModelCode(e.target.value)}
                    placeholder="302L0140"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Lining / Trim
                  </label>
                  <input
                    type="text"
                    value={hsmTrimReference}
                    onChange={(e) => setHsmTrimReference(e.target.value)}
                    placeholder="Lining / trim"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Coat Size
                  </label>
                  <input
                    type="text"
                    value={hsmCoatSize}
                    onChange={(e) => setHsmCoatSize(e.target.value)}
                    placeholder="40R"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Pant Size
                  </label>
                  <input
                    type="text"
                    value={hsmPantSize}
                    onChange={(e) => setHsmPantSize(e.target.value)}
                    placeholder="34"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Vest Size
                  </label>
                  <input
                    type="text"
                    value={hsmVestSize}
                    onChange={(e) => setHsmVestSize(e.target.value)}
                    placeholder="40R"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Coat Length
                  </label>
                  <input
                    type="text"
                    value={hsmCoatLength}
                    onChange={(e) => setHsmCoatLength(e.target.value)}
                    placeholder="R / L / XL"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Pant Inseam
                  </label>
                  <input
                    type="text"
                    value={hsmPantInseam}
                    onChange={(e) => setHsmPantInseam(e.target.value)}
                    placeholder="32"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Fabric Reservation
                  </label>
                  <input
                    type="text"
                    value={hsmFabricReservationNumber}
                    onChange={(e) => setHsmFabricReservationNumber(e.target.value)}
                    placeholder="Reservation #"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Left Sleeve
                  </label>
                  <input
                    type="text"
                    value={hsmLeftSleeve}
                    onChange={(e) => setHsmLeftSleeve(e.target.value)}
                    placeholder="16 3/4"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Right Sleeve
                  </label>
                  <input
                    type="text"
                    value={hsmRightSleeve}
                    onChange={(e) => setHsmRightSleeve(e.target.value)}
                    placeholder="16 3/4"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Left Out
                  </label>
                  <input
                    type="text"
                    value={hsmLeftOut}
                    onChange={(e) => setHsmLeftOut(e.target.value)}
                    placeholder="1/2"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Right Out
                  </label>
                  <input
                    type="text"
                    value={hsmRightOut}
                    onChange={(e) => setHsmRightOut(e.target.value)}
                    placeholder="1/2"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Vent
                  </label>
                  <input
                    type="text"
                    value={hsmVentStyle}
                    onChange={(e) => setHsmVentStyle(e.target.value)}
                    placeholder="Center / Side"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Lapel
                  </label>
                  <input
                    type="text"
                    value={hsmLapelStyle}
                    onChange={(e) => setHsmLapelStyle(e.target.value)}
                    placeholder="Peak / Notch"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Button Stance
                  </label>
                  <input
                    type="text"
                    value={hsmButtonStance}
                    onChange={(e) => setHsmButtonStance(e.target.value)}
                    placeholder="2 button"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Reservation / Reference
                  </label>
                  <input
                    type="text"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    placeholder="Fabric reservation"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Custom Notes
                  </label>
                  <input
                    type="text"
                    value={customNotes}
                    onChange={(e) => setCustomNotes(e.target.value)}
                    placeholder="Lapel / vent / button notes"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>
            </div>
          )}

          {knownSubtype?.vendorFormFamily === "individualized_shirts" && (
            <div className="space-y-3 rounded-2xl border border-app-border bg-app-surface-2 p-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Shirt Form Details
                </p>
                <p className="mt-1 text-[11px] font-semibold text-app-text-muted">
                  Capture the key references from the Individualized Shirts form. Detailed fit
                  measurements can stay on the paper form.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Shirt Description
                </label>
                <input
                  type="text"
                  value={garmentDescription}
                  onChange={(e) => setGarmentDescription(e.target.value)}
                  placeholder="White spread-collar shirt"
                  className="ui-input h-11 w-full text-sm font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Fabric Reference
                  </label>
                  <input
                    type="text"
                    value={fabricReference}
                    onChange={(e) => setFabricReference(e.target.value)}
                    placeholder="Fabric / price range"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Style Reference
                  </label>
                  <input
                    type="text"
                    value={styleReference}
                    onChange={(e) => setStyleReference(e.target.value)}
                    placeholder="Style code"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Collar Style
                  </label>
                  <input
                    type="text"
                    value={shirtCollarStyle}
                    onChange={(e) => setShirtCollarStyle(e.target.value)}
                    placeholder="Style code"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Cuff Style
                  </label>
                  <input
                    type="text"
                    value={shirtCuffStyle}
                    onChange={(e) => setShirtCuffStyle(e.target.value)}
                    placeholder="Style code"
                    className="ui-input h-11 w-full text-sm font-bold uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Order / Ref #
                  </label>
                  <input
                    type="text"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    placeholder="Vendor order no."
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Previous Order
                  </label>
                  <input
                    type="text"
                    value={shirtPreviousOrderNumber}
                    onChange={(e) => setShirtPreviousOrderNumber(e.target.value)}
                    placeholder="Previous order #"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Try-On Size
                  </label>
                  <input
                    type="text"
                    value={shirtTryOnSize}
                    onChange={(e) => setShirtTryOnSize(e.target.value)}
                    placeholder="40"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Shaping
                  </label>
                  <input
                    type="text"
                    value={shirtShaping}
                    onChange={(e) => setShirtShaping(e.target.value)}
                    placeholder="-6"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Collar Size
                  </label>
                  <input
                    type="text"
                    value={shirtCollarSize}
                    onChange={(e) => setShirtCollarSize(e.target.value)}
                    placeholder="16 1/2"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Tail Length
                  </label>
                  <input
                    type="text"
                    value={shirtTailLength}
                    onChange={(e) => setShirtTailLength(e.target.value)}
                    placeholder="30"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Yoke
                  </label>
                  <input
                    type="text"
                    value={shirtYoke}
                    onChange={(e) => setShirtYoke(e.target.value)}
                    placeholder="18 1/2"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Right Sleeve
                  </label>
                  <input
                    type="text"
                    value={shirtRightSleeveLength}
                    onChange={(e) => setShirtRightSleeveLength(e.target.value)}
                    placeholder="34 3/4"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Left Sleeve
                  </label>
                  <input
                    type="text"
                    value={shirtLeftSleeveLength}
                    onChange={(e) => setShirtLeftSleeveLength(e.target.value)}
                    placeholder="34 3/4"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Right Cuff
                  </label>
                  <input
                    type="text"
                    value={shirtRightCuffSize}
                    onChange={(e) => setShirtRightCuffSize(e.target.value)}
                    placeholder="10 1/2"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Left Cuff
                  </label>
                  <input
                    type="text"
                    value={shirtLeftCuffSize}
                    onChange={(e) => setShirtLeftCuffSize(e.target.value)}
                    placeholder="10 1/2"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Shoulder Line
                  </label>
                  <input
                    type="text"
                    value={shirtShoulderLine}
                    onChange={(e) => setShirtShoulderLine(e.target.value)}
                    placeholder="Regular Shoulder"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Front
                  </label>
                  <input
                    type="text"
                    value={shirtFrontStyle}
                    onChange={(e) => setShirtFrontStyle(e.target.value)}
                    placeholder="Plain / Fly"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Back
                  </label>
                  <input
                    type="text"
                    value={shirtBackStyle}
                    onChange={(e) => setShirtBackStyle(e.target.value)}
                    placeholder="Plain / Box Pleat"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Tail
                  </label>
                  <input
                    type="text"
                    value={shirtTailStyle}
                    onChange={(e) => setShirtTailStyle(e.target.value)}
                    placeholder="Square"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Buttons
                  </label>
                  <input
                    type="text"
                    value={shirtButtonChoice}
                    onChange={(e) => setShirtButtonChoice(e.target.value)}
                    placeholder="BH4 C260"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Pocket
                  </label>
                  <input
                    type="text"
                    value={shirtPocketStyle}
                    onChange={(e) => setShirtPocketStyle(e.target.value)}
                    placeholder="No / Plain Front"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Fit Notes
                  </label>
                  <input
                    type="text"
                    value={shirtFitNotes}
                    onChange={(e) => setShirtFitNotes(e.target.value)}
                    placeholder="Shaping / fit notes"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Custom Notes
                  </label>
                  <input
                    type="text"
                    value={customNotes}
                    onChange={(e) => setCustomNotes(e.target.value)}
                    placeholder="Monogram / trim notes"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {/* Rush Order */}
            <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 p-3 transition-colors hover:bg-app-surface">
              <div className="flex flex-col">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Rush
                </span>
                <span className="text-[10px] font-bold text-red-600">
                  URGENT
                </span>
              </div>
              <div
                onClick={() => setIsRush(!isRush)}
                className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                  isRush ? "bg-red-600" : "bg-zinc-300 dark:bg-zinc-700"
                }`}
              >
                <div
                  className={`absolute left-0.5 top-0.5 h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                    isRush ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </label>

            {/* Gift Wrap */}
            <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 p-3 transition-colors hover:bg-app-surface">
              <div className="flex flex-col">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Wrap
                </span>
                <span className="text-[10px] font-bold text-emerald-600">
                  DECO
                </span>
              </div>
              <div
                onClick={() => setNeedsGiftWrap(!needsGiftWrap)}
                className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                  needsGiftWrap ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
                }`}
              >
                <div
                  className={`absolute left-0.5 top-0.5 h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                    needsGiftWrap ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </label>
          </div>
        </div>

        <div className="flex gap-2 border-t border-app-border bg-app-surface-2 p-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl py-3 text-xs font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!priceIsValid}
            className="flex-1 rounded-xl bg-app-accent py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/30 transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
          >
            Add to Cart
          </button>
        </div>
      </div>
    </div>
  );
}
