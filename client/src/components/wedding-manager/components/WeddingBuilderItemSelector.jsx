import React from "react";
import VariantSearchInput from "../../ui/VariantSearchInput";

export const BUILDER_ITEM_AUDIENCES = [
  { value: "all", label: "All", help: "Required for every party member." },
  {
    value: "groom_only",
    label: "Groom Only",
    help: "Required only for the Groom.",
  },
  {
    value: "groomsmen_only",
    label: "Groomsmen Only",
    help: "Required for Groomsmen, Best Man, and Ushers.",
  },
  {
    value: "any",
    label: "Any",
    help: "Optional choice shown to every member.",
  },
  {
    value: "other",
    label: "Other",
    help: "Required only for the role entered below.",
  },
];

export function builderItemAudienceIsValid(item) {
  const audience = item?.audience || "all";
  return (
    audience !== "other" || String(item?.other_role || "").trim().length > 0
  );
}

export default function WeddingBuilderItemSelector({ items = [], onChange }) {
  const addItem = (variant) => {
    if (items.some((item) => item.product_id === variant.product_id)) return;
    onChange([
      ...items,
      {
        product_id: variant.product_id,
        variant_id: variant.variant_id,
        product_name: variant.product_name,
        sku: variant.sku,
        audience: "all",
        other_role: null,
      },
    ]);
  };

  const updateItem = (productId, patch) => {
    onChange(
      items.map((item) =>
        item.product_id === productId ? { ...item, ...patch } : item,
      ),
    );
  };

  const removeItem = (productId) => {
    onChange(items.filter((item) => item.product_id !== productId));
  };

  return (
    <div>
      <VariantSearchInput
        placeholder="Search ROS products by name or SKU (shirt, tie, shoes…)"
        onSelect={addItem}
      />
      {items.length > 0 ? (
        <div className="mt-3 space-y-2">
          {items.map((item) => {
            const audience = item.audience || "all";
            const audienceOption =
              BUILDER_ITEM_AUDIENCES.find(
                (option) => option.value === audience,
              ) || BUILDER_ITEM_AUDIENCES[0];
            return (
              <div
                key={item.product_id}
                className="rounded-xl border border-app-border bg-app-surface-2 p-3"
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-start">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-app-text">
                      {item.product_name}
                    </p>
                    <p className="truncate text-[10px] font-semibold text-app-text-muted">
                      Parent product · example SKU {item.sku}
                    </p>
                  </div>
                  <label className="text-[10px] font-black uppercase tracking-wide text-app-text-muted">
                    Who gets this item?
                    <select
                      value={audience}
                      onChange={(event) =>
                        updateItem(item.product_id, {
                          audience: event.target.value,
                          other_role:
                            event.target.value === "other"
                              ? item.other_role || ""
                              : null,
                        })
                      }
                      className="ui-input mt-1 min-h-10 w-full text-xs font-bold normal-case tracking-normal"
                    >
                      {BUILDER_ITEM_AUDIENCES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeItem(item.product_id)}
                    className="min-h-10 rounded-lg border border-app-danger/30 px-3 text-[10px] font-black uppercase text-app-danger hover:bg-app-danger hover:text-white"
                  >
                    Remove
                  </button>
                </div>
                {audience === "other" ? (
                  <label className="mt-2 block text-[10px] font-black uppercase tracking-wide text-app-text-muted">
                    Exact member role
                    <input
                      type="text"
                      required
                      value={item.other_role || ""}
                      onChange={(event) =>
                        updateItem(item.product_id, {
                          other_role: event.target.value,
                        })
                      }
                      placeholder="e.g. Father, Ring Bearer"
                      className="ui-input mt-1 min-h-10 w-full normal-case tracking-normal"
                    />
                  </label>
                ) : null}
                <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                  {audienceOption.help}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 rounded-lg border border-dashed border-app-border bg-app-surface-2 p-3 text-xs font-semibold text-app-text-muted">
          No sellable party items selected. Register will not have a product
          checklist for members.
        </p>
      )}
    </div>
  );
}
