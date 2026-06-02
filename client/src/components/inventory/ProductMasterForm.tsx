import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import VariationsBuilder, {
  type AxisInput,
  type GeneratedVariationRow,
} from "./VariationsBuilder";
import { apiUrl } from "../../lib/apiUrl";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import ProductImageGenerator from "./ProductImageGenerator";
import {
  Plus,
  Sparkles,
  Settings2,
  DollarSign,
  Layers,
  CheckCircle2,
  Globe,
  Bell,
  PackagePlus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Star,
  Tag,
} from "lucide-react";

interface Category {
  id: string;
  name: string;
  is_clothing_footwear: boolean;
  matrix_row_axis_key?: string | null;
  matrix_col_axis_key?: string | null;
  variation_axis_presets?: string[];
}

interface Vendor {
  id: string;
  name: string;
  vendor_code?: string | null;
}

interface CopyProductResult {
  product_id: string;
  product_name: string;
  brand: string | null;
  category_name: string | null;
}

interface CopyProductHub {
  product: {
    variation_axes?: string[];
  };
  variants: Array<{
    variation_values?: Record<string, unknown>;
  }>;
}

interface NextRosSkuResponse {
  start: number;
}

interface ProductMasterFormProps {
  onCreated?: () => void;
}

type FormStep = "shell" | "financials" | "matrix" | "web" | "review";
type ProductTaxOverride = "" | "clothing" | "footwear" | "accessory" | "service";

interface WebCategory {
  id: string;
  parent_id?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  sort_order: number;
  is_active: boolean;
}

interface LocalWebImageInput {
  url: string;
  alt_text: string;
  sort_order: number;
  is_hero: boolean;
}

export default function ProductMasterForm({
  onCreated,
}: ProductMasterFormProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = getBaseUrl();

  const [step, setStep] = useState<FormStep>("shell");
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [webCategories, setWebCategories] = useState<WebCategory[]>([]);

  // Shell Info
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [primaryVendorId, setPrimaryVendorId] = useState("");

  // Financials
  const [baseRetail, setBaseRetail] = useState("0.00");
  const [baseCost, setBaseCost] = useState("0.00");
  const [taxCategoryOverride, setTaxCategoryOverride] = useState<ProductTaxOverride>("");

  // Options
  const [imagesRaw] = useState("");
  const [trackLowStockTemplate, setTrackLowStockTemplate] = useState(false);
  const [publishVariantsToWeb, setPublishVariantsToWeb] = useState(false);

  // Web Listing states
  const [webTitle, setWebTitle] = useState("");
  const [webDescription, setWebDescription] = useState("");
  const [seoMetaTitle, setSeoMetaTitle] = useState("");
  const [seoMetaDescription, setSeoMetaDescription] = useState("");
  const [webTagsRaw, setWebTagsRaw] = useState("");
  const [selectedWebCategoryIds, setSelectedWebCategoryIds] = useState<string[]>([]);
  const [webImages, setWebImages] = useState<LocalWebImageInput[]>([]);
  const [newImageUrl, setNewImageUrl] = useState("");
  const [newImageAlt, setNewImageAlt] = useState("");

  // Matrix
  const [rows, setRows] = useState<GeneratedVariationRow[]>([]);
  const [axes, setAxes] = useState<string[]>([]);
  const [variationTemplate, setVariationTemplate] = useState<AxisInput[]>([]);
  const [variationTemplateVersion, setVariationTemplateVersion] = useState(0);
  const [rosSkuStart, setRosSkuStart] = useState(1);
  const [copySearch, setCopySearch] = useState("");
  const [copyResults, setCopyResults] = useState<CopyProductResult[]>([]);
  const [copyBusy, setCopyBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [categoryRes, vendorRes, skuRes, webCategoryRes] = await Promise.all([
          fetch(apiUrl(baseUrl, "/api/categories"), { headers: apiAuth() }),
          fetch(apiUrl(baseUrl, "/api/vendors"), { headers: apiAuth() }),
          fetch(apiUrl(baseUrl, "/api/products/next-ros-skus?count=1"), {
            headers: apiAuth(),
          }),
          fetch(apiUrl(baseUrl, "/api/web-categories"), { headers: apiAuth() }),
        ]);
        const categoryData = categoryRes.ok ? ((await categoryRes.json()) as unknown) : [];
        const vendorData = vendorRes.ok ? ((await vendorRes.json()) as unknown) : [];
        setCategories(Array.isArray(categoryData) ? (categoryData as Category[]) : []);
        setVendors(Array.isArray(vendorData) ? (vendorData as Vendor[]) : []);
        if (skuRes.ok) {
          const skuData = (await skuRes.json()) as NextRosSkuResponse;
          setRosSkuStart(Number.isFinite(skuData.start) ? skuData.start : 1);
        }
        if (webCategoryRes.ok) {
          const webCategoryData = (await webCategoryRes.json()) as { web_categories: WebCategory[] };
          setWebCategories(Array.isArray(webCategoryData.web_categories) ? webCategoryData.web_categories : []);
        }
      } catch {
        setCategories([]);
        setVendors([]);
        setWebCategories([]);
      }
    })();
  }, [baseUrl, apiAuth]);

  const categoryBadge = useMemo(
    () => categories.find((c) => c.id === categoryId),
    [categories, categoryId],
  );

  useEffect(() => {
    const category = categories.find((c) => c.id === categoryId);
    const presets =
      category?.variation_axis_presets?.length
        ? category.variation_axis_presets
        : [category?.matrix_row_axis_key, category?.matrix_col_axis_key].filter(
            (axis): axis is string => Boolean(axis?.trim()),
          );
    setVariationTemplate(
      presets.length
        ? presets.slice(0, 3).map((axis) => ({ name: axis, optionsRaw: "" }))
        : [{ name: "", optionsRaw: "" }],
    );
    setVariationTemplateVersion((v) => v + 1);
  }, [categories, categoryId]);

  const canContinueToFinancials = name.trim() && categoryId && primaryVendorId;
  const baseRetailCents = parseMoneyToCents(baseRetail || "0");
  const baseCostCents = parseMoneyToCents(baseCost || "0");
  const hasInvalidGeneratedRows = rows.some(
    (row) => !row.sku.trim() || row.stock_on_hand < 0,
  );
  const canSubmitProduct =
    !busy &&
    name.trim().length > 0 &&
    rows.length > 0 &&
    baseRetailCents >= 0 &&
    baseCostCents >= 0 &&
    !hasInvalidGeneratedRows;

  const addWebImage = () => {
    if (!newImageUrl.trim()) {
      toast("Image URL is required.", "error");
      return;
    }
    const isFirst = webImages.length === 0;
    const newImg: LocalWebImageInput = {
      url: newImageUrl.trim(),
      alt_text: newImageAlt.trim(),
      sort_order: webImages.length,
      is_hero: isFirst,
    };
    setWebImages([...webImages, newImg]);
    setNewImageUrl("");
    setNewImageAlt("");
    toast("Image added to gallery list.", "success");
  };

  const removeWebImage = (index: number) => {
    const nextImages = webImages.filter((_, idx) => idx !== index);
    if (webImages[index]?.is_hero && nextImages.length > 0) {
      nextImages[0].is_hero = true;
    }
    nextImages.forEach((img, idx) => {
      img.sort_order = idx;
    });
    setWebImages(nextImages);
  };

  const setWebImageHero = (index: number) => {
    setWebImages(
      webImages.map((img, idx) => ({
        ...img,
        is_hero: idx === index,
      }))
    );
  };

  const moveWebImageUp = (index: number) => {
    if (index === 0) return;
    const next = [...webImages];
    const temp = next[index - 1];
    next[index - 1] = next[index];
    next[index] = temp;
    next.forEach((img, idx) => {
      img.sort_order = idx;
    });
    setWebImages(next);
  };

  const moveWebImageDown = (index: number) => {
    if (index === webImages.length - 1) return;
    const next = [...webImages];
    const temp = next[index + 1];
    next[index + 1] = next[index];
    next[index] = temp;
    next.forEach((img, idx) => {
      img.sort_order = idx;
    });
    setWebImages(next);
  };

  const hierarchicalWebCategories = useMemo(() => {
    const root = webCategories.filter((c) => !c.parent_id);
    const childrenMap = new Map<string, WebCategory[]>();
    webCategories.forEach((c) => {
      if (c.parent_id) {
        if (!childrenMap.has(c.parent_id)) {
          childrenMap.set(c.parent_id, []);
        }
        childrenMap.get(c.parent_id)!.push(c);
      }
    });
    return root.map((parent) => ({
      ...parent,
      children: childrenMap.get(parent.id) || [],
    }));
  }, [webCategories]);

  const submitProduct = async () => {
    if (!name.trim() || rows.length === 0) return;
    if (!primaryVendorId) {
      toast("Select a primary vendor before saving the item.", "error");
      return;
    }
    if (baseRetailCents < 0) {
      toast("Retail price must be zero or higher.", "error");
      return;
    }
    if (baseCostCents < 0) {
      toast("Cost must be zero or higher.", "error");
      return;
    }
    if (hasInvalidGeneratedRows) {
      toast(
        "Each SKU needs a code and starting stock of zero or higher.",
        "error",
      );
      return;
    }
    setBusy(true);
    try {
      const images = imagesRaw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 5);
      const res = await fetch(apiUrl(baseUrl, "/api/products"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          category_id: categoryId || null,
          primary_vendor_id: primaryVendorId,
          name: name.trim(),
          brand: brand.trim() || null,
          description: description.trim() || null,
          base_retail_price: centsToFixed2(baseRetailCents),
          base_cost: centsToFixed2(baseCostCents),
          variation_axes: axes,
          images,
          track_low_stock: trackLowStockTemplate,
          publish_variants_to_web: publishVariantsToWeb,
          tax_category_override: taxCategoryOverride || null,
          variants: rows,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create product");
      }
      const createdProduct = (await res.json()) as { id: string };

      let webSyncFailed = false;
      if (publishVariantsToWeb) {
        try {
          const webListingRes = await fetch(apiUrl(baseUrl, `/api/products/${createdProduct.id}/web-listing`), {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...apiAuth(),
            },
            body: JSON.stringify({
              web_title: webTitle.trim() || null,
              web_description: webDescription.trim() || null,
              seo_meta_title: seoMetaTitle.trim() || null,
              seo_meta_description: seoMetaDescription.trim() || null,
              web_tags: webTagsRaw ? webTagsRaw.split(",").map(t => t.trim()).filter(Boolean) : [],
            }),
          });
          if (!webListingRes.ok) webSyncFailed = true;

          if (selectedWebCategoryIds.length > 0) {
            const webCategoriesRes = await fetch(apiUrl(baseUrl, `/api/products/${createdProduct.id}/web-categories`), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...apiAuth(),
              },
              body: JSON.stringify({
                web_category_ids: selectedWebCategoryIds,
              }),
            });
            if (!webCategoriesRes.ok) webSyncFailed = true;
          }

          if (webImages.length > 0) {
            const imagePromises = webImages.map(img =>
              fetch(apiUrl(baseUrl, `/api/products/${createdProduct.id}/web-images`), {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...apiAuth(),
                },
                body: JSON.stringify({
                  url: img.url.trim(),
                  alt_text: img.alt_text.trim() || null,
                  sort_order: img.sort_order,
                  is_hero: img.is_hero,
                }),
              })
            );
            const imageResults = await Promise.all(imagePromises);
            if (imageResults.some(r => !r.ok)) webSyncFailed = true;
          }
        } catch (e) {
          console.error("Web listing sync error:", e);
          webSyncFailed = true;
        }
      }

      // Success Cleanup
      setName("");
      setBrand("");
      setDescription("");
      setBaseRetail("0.00");
      setBaseCost("0.00");
      setTaxCategoryOverride("");
      setRows([]);
      setPrimaryVendorId("");
      setStep("shell");
      setTrackLowStockTemplate(false);
      setPublishVariantsToWeb(false);
      setWebTitle("");
      setWebDescription("");
      setSeoMetaTitle("");
      setSeoMetaDescription("");
      setWebTagsRaw("");
      setSelectedWebCategoryIds([]);
      setWebImages([]);
      setNewImageUrl("");
      setNewImageAlt("");

      onCreated?.();
      if (webSyncFailed) {
        toast("Item added to inventory, but web listing details failed to update.", "info");
      } else {
        toast("Item added to inventory.", "success");
      }
    } catch (e) {
      toast(
        e instanceof Error ? e.message : "Failed to create product",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const searchCopyProducts = async () => {
    const q = copySearch.trim();
    if (q.length < 2) {
      toast("Enter at least two characters to search products to copy from.", "info");
      return;
    }
    setCopyBusy(true);
    try {
      const res = await fetch(
        apiUrl(baseUrl, `/api/inventory/control-board?search=${encodeURIComponent(q)}&limit=80`),
        { headers: apiAuth() },
      );
      if (!res.ok) {
        toast("We couldn't search products to copy from.", "error");
        return;
      }
      const data = (await res.json()) as { rows?: CopyProductResult[] };
      const byProduct = new Map<string, CopyProductResult>();
      for (const row of data.rows ?? []) {
        if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, row);
      }
      setCopyResults([...byProduct.values()].slice(0, 12));
    } finally {
      setCopyBusy(false);
    }
  };

  const copyVariationSetup = async (product: CopyProductResult) => {
    setCopyBusy(true);
    try {
      const res = await fetch(apiUrl(baseUrl, `/api/products/${product.product_id}/hub`), {
        headers: apiAuth(),
      });
      if (!res.ok) {
        toast("We couldn't load that product setup.", "error");
        return;
      }
      const hub = (await res.json()) as CopyProductHub;
      const axesFromProduct = hub.product.variation_axes ?? [];
      const axesToUse =
        axesFromProduct.length > 0
          ? axesFromProduct
          : [
              ...new Set(
                hub.variants.flatMap((variant) =>
                  Object.keys(variant.variation_values ?? {}),
                ),
              ),
            ];
      const template = axesToUse.slice(0, 5).map((axis) => {
        const options = new Set<string>();
        for (const variant of hub.variants) {
          const raw = variant.variation_values?.[axis];
          if (typeof raw === "string" && raw.trim()) options.add(raw.trim());
          if (typeof raw === "number") options.add(String(raw));
        }
        return { name: axis, optionsRaw: [...options].join(", ") };
      });
      setVariationTemplate(template.length ? template : [{ name: "", optionsRaw: "" }]);
      setVariationTemplateVersion((v) => v + 1);
      toast(`Copied option setup from ${product.product_name}.`, "success");
    } finally {
      setCopyBusy(false);
    }
  };

  /* ── Derived vendor info for contextual intelligence ── */
  const selectedVendor = vendors.find((v) => v.id === primaryVendorId);

  const StepNav = () => {
    const steps: { id: FormStep; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
      { id: "shell", label: "Product & Pricing", icon: Sparkles },
      { id: "matrix", label: "Sizes & Options", icon: Settings2 },
      ...(publishVariantsToWeb ? [{ id: "web" as FormStep, label: "Web Listing", icon: Globe }] : []),
      { id: "review", label: "Review & Save", icon: CheckCircle2 },
    ];
    return (
      <nav className="flex items-center gap-1 p-1.5 rounded-2xl border border-app-border bg-app-surface-2/60 backdrop-blur-sm self-start">
        {steps.map(({ id, label, icon: Icon }, i) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              if (id === "matrix" && !canContinueToFinancials) return;
              if (id === "web" && rows.length === 0) return;
              if (id === "review" && rows.length === 0) return;
              setStep(id);
            }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${
              step === id
                ? "bg-app-accent text-white shadow-md shadow-app-accent/20"
                : "text-app-text-muted hover:text-app-text hover:bg-app-surface"
            }`}
          >
            <Icon size={15} />
            <span className="hidden sm:inline">{i + 1}.</span> {label}
          </button>
        ))}
      </nav>
    );
  };

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <StepNav />

      {/* ── STEP 1: Product & Pricing (combined) ── */}
      {(step === "shell" || step === "financials") && (
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <section className="space-y-6">
            {/* Core Identity Card */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent">
                  <Plus size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app-text">Product Identity</h3>
                  <p className="text-xs text-app-text-muted">Name it, categorize it, assign the vendor who supplies it.</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2 flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Product Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Italian Wool Suit (Super 120s)"
                    autoFocus
                    className="ui-input h-12 text-sm font-bold w-full"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Category</label>
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="ui-input h-12 text-sm font-bold w-full"
                  >
                    <option value="">Select category...</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Primary Vendor</label>
                  <select
                    value={primaryVendorId}
                    onChange={(e) => setPrimaryVendorId(e.target.value)}
                    className="ui-input h-12 text-sm font-bold w-full"
                  >
                    <option value="">Select vendor...</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}{v.vendor_code ? ` (${v.vendor_code})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Brand <span className="text-app-text-muted/50">(optional)</span></label>
                  <input
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Hickey Freeman, David Donahue..."
                    className="ui-input h-12 text-sm font-bold w-full"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Description <span className="text-app-text-muted/50">(optional)</span></label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Fit, fabric, care, or selling notes..."
                    rows={2}
                    className="ui-input py-2.5 text-sm font-bold resize-none w-full"
                  />
                </div>
              </div>
            </div>

            {/* Pricing Card */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
                  <DollarSign size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app-text">Pricing</h3>
                  <p className="text-xs text-app-text-muted">Set the retail price customers pay and the cost you pay the vendor.</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Retail Price (USD)</label>
                  <div className="relative w-full">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-app-text-muted/40">$</span>
                    <input
                      value={baseRetail}
                      onChange={(e) => setBaseRetail(e.target.value)}
                      type="number"
                      min="0"
                      step="0.01"
                      className="ui-input h-14 pl-9 text-xl font-black tabular-nums w-full"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Vendor Cost (USD)</label>
                  <div className="relative w-full">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-app-text-muted/40">$</span>
                    <input
                      value={baseCost}
                      onChange={(e) => setBaseCost(e.target.value)}
                      type="number"
                      min="0"
                      step="0.01"
                      className="ui-input h-14 pl-9 text-xl font-black tabular-nums text-app-text-muted w-full"
                    />
                  </div>
                </div>
              </div>

              {/* Margin hint */}
              {baseRetailCents > 0 && baseCostCents > 0 && (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-app-surface-2 px-4 py-2.5 border border-app-border/40">
                  <Sparkles size={14} className="text-app-accent shrink-0" />
                  <p className="text-xs font-bold text-app-text-muted">
                    Margin: <span className="text-app-text">{((1 - baseCostCents / baseRetailCents) * 100).toFixed(1)}%</span>
                    {" · "}Markup: <span className="text-app-text">{((baseRetailCents / baseCostCents - 1) * 100).toFixed(1)}%</span>
                  </p>
                </div>
              )}
            </div>

            {/* Item Rules Card (collapsible feel - always visible but compact) */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <h3 className="text-sm font-bold text-app-text mb-4">Item Rules</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex items-center gap-3 rounded-2xl border border-app-border/40 bg-app-surface-2 p-3 cursor-pointer group hover:border-app-accent/40 transition-all">
                  <input
                    type="checkbox"
                    checked={taxCategoryOverride !== ""}
                    onChange={() => setTaxCategoryOverride(taxCategoryOverride ? "" : "clothing")}
                    className="h-4 w-4 rounded border-app-border text-app-accent"
                  />
                  <div>
                    <span className="text-xs font-bold text-app-text block">Tax Override</span>
                    {taxCategoryOverride && (
                      <select
                        value={taxCategoryOverride}
                        onChange={(e) => setTaxCategoryOverride(e.target.value as ProductTaxOverride)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 h-8 w-full rounded-lg border border-app-border bg-app-surface px-2 text-[10px] font-bold text-app-text"
                      >
                        <option value="clothing">Clothing</option>
                        <option value="footwear">Footwear</option>
                        <option value="accessory">Accessory / taxable</option>
                        <option value="service">Service / non-taxable</option>
                      </select>
                    )}
                  </div>
                </label>
                <label className="flex items-center gap-3 rounded-2xl border border-app-border/40 bg-app-surface-2 p-3 cursor-pointer group hover:border-app-accent/40 transition-all">
                  <input
                    type="checkbox"
                    checked={trackLowStockTemplate}
                    onChange={(e) => setTrackLowStockTemplate(e.target.checked)}
                    className="h-4 w-4 rounded border-app-border text-app-accent"
                  />
                  <div>
                    <span className="text-xs font-bold text-app-text flex items-center gap-1.5"><Bell size={12} /> Low-Stock Alerts</span>
                    <span className="text-[10px] text-app-text-muted block mt-0.5">Morning digest warnings</span>
                  </div>
                </label>
                <label className="flex items-center gap-3 rounded-2xl border border-app-border/40 bg-app-surface-2 p-3 cursor-pointer group hover:border-app-accent/40 transition-all">
                  <input
                    type="checkbox"
                    checked={publishVariantsToWeb}
                    onChange={(e) => setPublishVariantsToWeb(e.target.checked)}
                    className="h-4 w-4 rounded border-app-border text-app-accent"
                  />
                  <div>
                    <span className="text-xs font-bold text-app-text flex items-center gap-1.5"><Globe size={12} /> Publish to Web</span>
                    <span className="text-[10px] text-app-text-muted block mt-0.5">Online store visibility</span>
                  </div>
                </label>
              </div>
            </div>

            {/* Continue CTA */}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setStep("matrix")}
                disabled={!canContinueToFinancials}
                className="h-12 rounded-2xl bg-app-accent px-8 text-xs font-bold text-white shadow-lg shadow-app-accent/20 hover:brightness-110 active:scale-95 disabled:opacity-30 transition-all"
              >
                Continue to Sizes & Options →
              </button>
            </div>
          </section>

          {/* Contextual Sidebar */}
          <aside className="space-y-4">
            {/* Vendor Intelligence */}
            {selectedVendor && (
              <div className="rounded-2xl border border-app-accent/20 bg-app-accent/5 p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-app-accent mb-2">Vendor Selected</p>
                <p className="text-sm font-bold text-app-text">{selectedVendor.name}</p>
                {selectedVendor.vendor_code && (
                  <p className="text-xs text-app-text-muted mt-1">Code: <span className="font-mono font-bold">{selectedVendor.vendor_code}</span></p>
                )}
                <p className="text-[10px] text-app-text-muted mt-2 leading-relaxed">
                  This vendor will be linked for ordering and receiving. You can add more vendors to an item later from Product Hub.
                </p>
              </div>
            )}

            {/* Tax Intelligence */}
            <div className="rounded-2xl border border-app-border bg-app-surface p-5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted mb-2">Tax Rule</p>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${categoryBadge?.is_clothing_footwear ? "bg-emerald-500" : "bg-app-text-muted/40"}`} />
                <span className="text-xs font-bold text-app-text leading-tight">
                  {categoryBadge?.is_clothing_footwear
                    ? "Clothing exemption — NY sales under $110 are tax-free."
                    : "Standard merchandise tax rules apply."}
                </span>
              </div>
            </div>

            {/* Size / Option hint */}
            <div className="rounded-2xl border border-app-border bg-app-surface p-5">
              <div className="flex items-center gap-2 mb-2">
                <Settings2 size={14} className="text-app-accent" />
                <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Size / Option Builder</p>
              </div>
              <p className="text-xs text-app-text-muted leading-relaxed">
                Add sizes, colors, fits, or other options in the next step. Riverside OS creates one sellable SKU for each combination.
              </p>
            </div>

            {/* Audit note */}
            <div className="rounded-2xl border border-app-border bg-violet-600/90 p-5 text-white shadow-lg shadow-violet-600/10">
              <div className="flex items-center gap-2 mb-2 opacity-80">
                <Layers size={14} />
                <p className="text-[10px] font-bold uppercase tracking-wider">Audit Trail</p>
              </div>
              <p className="text-xs font-medium leading-relaxed opacity-90">
                Every item creation is logged with the current staff member. Keep descriptions customer-friendly — they appear on receipts and the online store.
              </p>
            </div>
          </aside>
        </div>
      )}

      {/* ── STEP 2: Sizes & Options ── */}
      {step === "matrix" && (
        <div className="space-y-6">
          {/* Copy from existing item */}
          <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
                <Layers size={20} />
              </div>
              <div>
                <h3 className="text-base font-bold text-app-text">Copy from Existing Item</h3>
                <p className="text-xs text-app-text-muted">Pull the size/option setup from a similar product already in your catalog.</p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1 space-y-1">
                <input
                  value={copySearch}
                  onChange={(e) => setCopySearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void searchCopyProducts();
                    }
                  }}
                  placeholder="Search by product name..."
                  className="ui-input h-11 text-sm font-bold"
                />
              </div>
              <button
                type="button"
                disabled={copyBusy}
                onClick={() => void searchCopyProducts()}
                className="h-11 rounded-xl border border-app-border bg-app-surface-2 px-5 text-xs font-bold text-app-text hover:border-app-accent hover:text-app-accent disabled:opacity-40 transition-all"
              >
                {copyBusy ? "Searching..." : "Find"}
              </button>
            </div>
            {copyResults.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {copyResults.map((product) => (
                  <button
                    key={product.product_id}
                    type="button"
                    onClick={() => void copyVariationSetup(product)}
                    className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-2.5 text-left transition-all hover:border-app-accent hover:text-app-accent"
                  >
                    <span className="block text-xs font-bold text-app-text">{product.product_name}</span>
                    <span className="mt-0.5 block text-[10px] text-app-text-muted">
                      {[product.brand, product.category_name].filter(Boolean).join(" · ") || "Existing item"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Variation builder */}
          <VariationsBuilder
            initialAxes={variationTemplate}
            templateVersion={variationTemplateVersion}
            skuStart={rosSkuStart}
            onGenerated={(generated, axisNames) => {
              setRows(generated);
              setAxes(axisNames);
              if (generated.length > 0) {
                setStep(publishVariantsToWeb ? "web" : "review");
              }
            }}
          />

          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => setStep("shell")}
              className="text-xs font-bold text-app-text-muted hover:text-app-text transition-all"
            >
              ← Back to Product & Pricing
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2.5: Web Listing ── */}
      {step === "web" && (
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <section className="space-y-6">
            {/* Web Identity & Marketing Copy */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent">
                  <Globe size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app-text">Web Listing Content</h3>
                  <p className="text-xs text-app-text-muted">Define the customer-facing name, marketing description, and search tags.</p>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">
                    Web Storefront Title <span className="text-app-text-muted/50">(optional override)</span>
                  </label>
                  <input
                    value={webTitle}
                    onChange={(e) => setWebTitle(e.target.value)}
                    placeholder={name || "e.g. Italian Wool Suit (Super 120s)"}
                    className="ui-input h-12 text-sm font-bold"
                  />
                  <p className="text-[10px] text-app-text-muted/70 ml-1">If left blank, storefront will fall back to product name: "{name || "Product Name"}"</p>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">
                    Web Description <span className="text-app-text-muted/50">(optional override)</span>
                  </label>
                  <textarea
                    value={webDescription}
                    onChange={(e) => setWebDescription(e.target.value)}
                    placeholder={description || "FIT DETAILS: Modern slim fit. FABRIC: 100% fine Italian merino wool..."}
                    rows={4}
                    className="ui-input py-2.5 text-sm font-bold resize-none"
                  />
                  <p className="text-[10px] text-app-text-muted/70 ml-1">Rich marketing copy displayed on the web product page. Falls back to base description if blank.</p>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1 flex items-center gap-1">
                    <Tag size={10} /> Web Tags <span className="text-app-text-muted/50">(comma separated)</span>
                  </label>
                  <input
                    value={webTagsRaw}
                    onChange={(e) => setWebTagsRaw(e.target.value)}
                    placeholder="suit, wool, wedding, tuxedo, formal"
                    className="ui-input h-12 text-sm font-bold"
                  />
                </div>
              </div>
            </div>

            {/* Web Categories Selector */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-600">
                  <Layers size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app-text">Online Store Categories</h3>
                  <p className="text-xs text-app-text-muted">Select which online storefront categories this item belongs to.</p>
                </div>
              </div>

              {hierarchicalWebCategories.length === 0 ? (
                <div className="rounded-xl border border-dashed border-app-border p-6 text-center text-xs text-app-text-muted">
                  No online categories defined. Create them under Web Store Settings first.
                </div>
              ) : (
                <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2">
                  {hierarchicalWebCategories.map((parent) => (
                    <div key={parent.id} className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={selectedWebCategoryIds.includes(parent.id)}
                          onChange={() => {
                            if (selectedWebCategoryIds.includes(parent.id)) {
                              setSelectedWebCategoryIds(selectedWebCategoryIds.filter(id => id !== parent.id));
                            } else {
                              setSelectedWebCategoryIds([...selectedWebCategoryIds, parent.id]);
                            }
                          }}
                          className="h-4 w-4 rounded border-app-border text-app-accent focus:ring-app-accent"
                        />
                        <span className="text-sm font-bold text-app-text group-hover:text-app-accent transition-colors">
                          {parent.name}
                        </span>
                      </label>

                      {parent.children.length > 0 && (
                        <div className="pl-6 grid gap-2 border-l border-app-border/40 ml-2">
                          {parent.children.map((child: WebCategory) => (
                            <label key={child.id} className="flex items-center gap-2 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={selectedWebCategoryIds.includes(child.id)}
                                onChange={() => {
                                  if (selectedWebCategoryIds.includes(child.id)) {
                                    setSelectedWebCategoryIds(selectedWebCategoryIds.filter(id => id !== child.id));
                                  } else {
                                    setSelectedWebCategoryIds([...selectedWebCategoryIds, child.id]);
                                  }
                                }}
                                className="h-4 w-4 rounded border-app-border text-app-accent focus:ring-app-accent"
                              />
                              <span className="text-xs font-bold text-app-text-muted group-hover:text-app-text transition-colors">
                                {child.name}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Web Image Management */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
                  <Globe size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app-text">Web Listing Images</h3>
                  <p className="text-xs text-app-text-muted">Add specialized product photos for the storefront, manage sort order, and pick the hero image.</p>
                </div>
              </div>

              <div className="mb-6">
                <ProductImageGenerator
                  onGenerated={(url) => {
                    const isFirst = webImages.length === 0;
                    const newImg: LocalWebImageInput = {
                      url,
                      alt_text: "AI Generated Product Image",
                      sort_order: webImages.length,
                      is_hero: isFirst,
                    };
                    setWebImages([...webImages, newImg]);
                    toast("AI Product Image generated and added to gallery!", "success");
                  }}
                  disabled={busy}
                />
              </div>

              {/* Add Web Image Form */}
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end rounded-2xl border border-app-border/40 bg-app-surface-2 p-4 mb-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Image URL</label>
                  <input
                    value={newImageUrl}
                    onChange={(e) => setNewImageUrl(e.target.value)}
                    placeholder="https://example.com/images/suit.jpg"
                    className="ui-input h-10 text-xs font-bold"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Alt Text</label>
                  <input
                    value={newImageAlt}
                    onChange={(e) => setNewImageAlt(e.target.value)}
                    placeholder="Navy suit front view details"
                    className="ui-input h-10 text-xs font-bold"
                  />
                </div>
                <button
                  type="button"
                  onClick={addWebImage}
                  className="h-10 rounded-xl bg-app-accent px-4 text-xs font-bold text-white shadow-md shadow-app-accent/15 hover:brightness-110 active:scale-95 transition-all"
                >
                  Add Image
                </button>
              </div>

              {/* Web Images Gallery */}
              {webImages.length === 0 ? (
                <div className="rounded-xl border border-dashed border-app-border p-8 text-center">
                  <Globe size={32} className="mx-auto text-app-text-muted/30 mb-2" />
                  <p className="text-xs text-app-text-muted">No web-specific images added.</p>
                  <p className="text-[10px] text-app-text-muted/60 mt-1">If empty, the online listing will use standard POS images if configured.</p>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {webImages.map((img, index) => (
                    <div key={index} className={`relative flex flex-col rounded-2xl border p-3 bg-app-surface-2 transition-all ${img.is_hero ? "border-amber-500 shadow-md shadow-amber-500/5 bg-amber-500/5" : "border-app-border/40"}`}>
                      {/* Image Preview & Actions */}
                      <div className="flex gap-3">
                        <div className="h-14 w-14 rounded-xl bg-app-surface border border-app-border/40 overflow-hidden flex items-center justify-center shrink-0">
                          {img.url.startsWith("http") ? (
                            <img src={img.url} alt={img.alt_text} className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLElement).style.display = "none"; }} />
                          ) : (
                            <Globe size={18} className="text-app-text-muted/35" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-app-text truncate">{img.url}</p>
                          <p className="text-[10px] text-app-text-muted truncate mt-0.5">{img.alt_text || "No alt text set"}</p>

                          <div className="flex gap-2 mt-1">
                            {img.is_hero ? (
                              <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-600">
                                <Star size={8} fill="currentColor" /> Hero Image
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setWebImageHero(index)}
                                className="inline-flex items-center gap-1 rounded bg-app-surface border border-app-border/40 px-1.5 py-0.5 text-[9px] font-bold text-app-text-muted hover:text-app-text transition-colors"
                              >
                                Set Hero
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Sorting & Deletion Controls */}
                      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-app-border/30">
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => moveWebImageUp(index)}
                            className="h-6 w-6 flex items-center justify-center rounded border border-app-border/40 bg-app-surface text-app-text-muted hover:text-app-text disabled:opacity-40 transition-colors"
                          >
                            <ArrowUp size={12} />
                          </button>
                          <button
                            type="button"
                            disabled={index === webImages.length - 1}
                            onClick={() => moveWebImageDown(index)}
                            className="h-6 w-6 flex items-center justify-center rounded border border-app-border/40 bg-app-surface text-app-text-muted hover:text-app-text disabled:opacity-40 transition-colors"
                          >
                            <ArrowDown size={12} />
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeWebImage(index)}
                          className="h-6 px-2 flex items-center justify-center gap-1 rounded bg-rose-500/10 text-rose-600 text-[10px] font-bold hover:bg-rose-500/15 transition-colors"
                        >
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* SEO Fields */}
            <div className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
                  <Sparkles size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app-text">SEO Optimization</h3>
                  <p className="text-xs text-app-text-muted">Customize HTML title tags and meta descriptions to improve Google search visibility.</p>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">
                    Meta Title Tag <span className="text-app-text-muted/50">(optional override)</span>
                  </label>
                  <input
                    value={seoMetaTitle}
                    onChange={(e) => setSeoMetaTitle(e.target.value)}
                    placeholder={webTitle || name || "SEO Title Tag"}
                    maxLength={70}
                    className="ui-input h-12 text-sm font-bold"
                  />
                  <div className="flex justify-between text-[10px] text-app-text-muted/70 px-1 mt-0.5">
                    <span>Appears in Google tab header</span>
                    <span>{seoMetaTitle.length}/70 chars</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">
                    Meta Description <span className="text-app-text-muted/50">(optional override)</span>
                  </label>
                  <textarea
                    value={seoMetaDescription}
                    onChange={(e) => setSeoMetaDescription(e.target.value)}
                    placeholder="Find premium Italian wool suits at Riverside. Shop our handcrafted weddings and formalwear collection."
                    maxLength={160}
                    rows={2}
                    className="ui-input py-2.5 text-sm font-bold resize-none"
                  />
                  <div className="flex justify-between text-[10px] text-app-text-muted/70 px-1 mt-0.5">
                    <span>Appears in Google search snippets</span>
                    <span>{seoMetaDescription.length}/160 chars</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Nav */}
            <div className="flex justify-between items-center mt-6">
              <button
                type="button"
                onClick={() => setStep("matrix")}
                className="text-xs font-bold text-app-text-muted hover:text-app-text transition-all"
              >
                ← Back to Sizes & Options
              </button>
              <button
                type="button"
                onClick={() => setStep("review")}
                className="h-12 rounded-2xl bg-app-accent px-8 text-xs font-bold text-white shadow-lg shadow-app-accent/20 hover:brightness-110 active:scale-95 transition-all"
              >
                Continue to Review & Save →
              </button>
            </div>
          </section>

          {/* Right Preview Sidebar */}
          <aside className="space-y-4">
            <div className="rounded-3xl border border-app-border bg-app-surface p-5 shadow-sm sticky top-6">
              <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted mb-4">Web Listing Preview</p>

              <div className="rounded-2xl border border-app-border bg-app-surface-2 overflow-hidden shadow-sm">
                {/* Image */}
                <div className="h-44 bg-app-surface flex items-center justify-center border-b border-app-border/40 relative">
                  {webImages.find(img => img.is_hero)?.url.startsWith("http") ? (
                    <img
                      src={webImages.find(img => img.is_hero)?.url}
                      alt="Hero preview"
                      className="w-full h-full object-cover"
                    />
                  ) : webImages.length > 0 && webImages[0].url.startsWith("http") ? (
                    <img
                      src={webImages[0].url}
                      alt="First preview"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-app-text-muted/30">
                      <Globe size={32} />
                      <span className="text-[9px] font-bold uppercase">No Web Image</span>
                    </div>
                  )}
                  <span className="absolute top-3 right-3 rounded bg-app-surface/80 backdrop-blur-md px-2 py-0.5 text-[9px] font-black text-app-text">
                    ${baseRetail}
                  </span>
                </div>

                {/* Details */}
                <div className="p-4 space-y-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {selectedWebCategoryIds.map(catId => {
                      const cat = webCategories.find(c => c.id === catId);
                      return cat ? (
                        <span key={catId} className="rounded bg-app-accent/10 text-app-accent text-[9px] font-bold px-1.5 py-0.5">
                          {cat.name}
                        </span>
                      ) : null;
                    })}
                  </div>
                  <h4 className="text-xs font-black text-app-text leading-snug">
                    {webTitle.trim() || name || "Italian Wool Suit"}
                  </h4>
                  <p className="text-[10px] text-app-text-muted line-clamp-3 leading-relaxed">
                    {webDescription.trim() || description || "No description provided."}
                  </p>

                  {webTagsRaw.trim() && (
                    <div className="flex items-center gap-1 flex-wrap pt-1 border-t border-app-border/30">
                      <Tag size={8} className="text-app-text-muted shrink-0" />
                      {webTagsRaw.split(",").map((tag, i) => tag.trim() && (
                        <span key={i} className="text-[9px] text-app-text-muted">
                          #{tag.trim()}{i < webTagsRaw.split(",").length - 1 && ","}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* SEO preview */}
              <div className="mt-4 rounded-2xl border border-app-border bg-app-surface p-4 text-[10px] space-y-1.5">
                <p className="font-bold text-app-text flex items-center gap-1">
                  <Sparkles size={10} className="text-app-accent" /> Google Search Preview
                </p>
                <div className="bg-app-surface border border-app-border rounded p-2 text-left font-sans select-none pointer-events-none">
                  <div className="text-[#1a0dab] hover:underline text-xs truncate font-medium">
                    {seoMetaTitle.trim() || webTitle.trim() || name || "Italian Wool Suit"} | Riverside
                  </div>
                  <div className="text-[#006621] text-[9px] truncate">
                    https://riverside.store/products/{webTitle.trim() ? webTitle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") : (name || "product").toLowerCase().replace(/[^a-z0-9]+/g, "-")}
                  </div>
                  <div className="text-[#545454] text-[9px] line-clamp-2 leading-snug">
                    {seoMetaDescription.trim() || webDescription.trim() || description || "Discover formalwear details, size selectors, and checkout."}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* ── STEP 3: Review & Save ── */}
      {step === "review" && (
        <section className="rounded-3xl border border-app-border bg-app-surface p-6 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
              <PackagePlus size={20} />
            </div>
            <div>
              <h3 className="text-base font-bold text-app-text">Review — {name || "New Item"}</h3>
              <p className="text-xs text-app-text-muted">
                {rows.length} SKU{rows.length === 1 ? "" : "s"} · Retail ${baseRetail} · Cost ${baseCost}
                {selectedVendor ? ` · ${selectedVendor.name}` : ""}
              </p>
            </div>
          </div>

          {publishVariantsToWeb && (
            <div className="mb-6 rounded-2xl border border-app-border bg-app-surface-2 p-4 text-xs space-y-2">
              <p className="font-bold text-app-text flex items-center gap-1.5">
                <Globe size={13} className="text-app-accent" /> Storefront Publication Summary
              </p>
              <div className="grid gap-2 sm:grid-cols-2 text-app-text-muted">
                <div>
                  <span className="font-semibold text-app-text">Web Title:</span> {webTitle.trim() || name || "Default"}
                </div>
                <div>
                  <span className="font-semibold text-app-text">Web Categories:</span> {selectedWebCategoryIds.length} assigned
                </div>
                <div>
                  <span className="font-semibold text-app-text">Web Images:</span> {webImages.length} uploaded ({webImages.filter(img => img.is_hero).length ? "hero set" : "no hero"})
                </div>
                <div>
                  <span className="font-semibold text-app-text">SEO Tags:</span> {webTagsRaw ? webTagsRaw.split(",").filter(Boolean).length : 0} keywords
                </div>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-app-border overflow-hidden bg-app-surface-2 mb-6">
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 bg-app-surface border-b border-app-border z-10">
                  <tr>
                    <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">SKU</th>
                    <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Option</th>
                    <th className="px-5 py-3 text-right text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Starting Stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/30">
                  {rows.map((r, i) => (
                    <tr key={`${r.sku}-${i}`} className="hover:bg-app-surface/40 transition-colors">
                      <td className="px-5 py-3 font-mono font-bold text-app-text">{r.sku}</td>
                      <td className="px-5 py-3">
                        <span className="rounded-lg bg-app-surface border border-app-border/40 px-2 py-0.5 text-[10px] font-bold text-app-text-muted">
                          {r.variation_label}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right font-bold tabular-nums text-app-text-muted">{r.stock_on_hand}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-2xl bg-emerald-50 border border-emerald-200 p-5">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={22} className="text-emerald-600 shrink-0" />
              <p className="text-xs font-bold text-emerald-800">
                Ready to save. Prices, category, and SKU codes validated.
              </p>
            </div>
            <button
              type="button"
              onClick={submitProduct}
              disabled={!canSubmitProduct}
              className="h-12 shrink-0 rounded-2xl bg-emerald-600 px-8 text-xs font-bold text-white shadow-lg shadow-emerald-500/20 hover:brightness-110 active:scale-95 disabled:opacity-50 transition-all"
            >
              {busy ? "Saving..." : `Create ${rows.length} SKU${rows.length === 1 ? "" : "s"}`}
            </button>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => setStep("matrix")}
              className="text-xs font-bold text-app-text-muted hover:text-app-text transition-all"
            >
              ← Edit Options
            </button>
            <button
              type="button"
              onClick={() => setStep("shell")}
              className="text-xs font-bold text-app-text-muted hover:text-app-text transition-all"
            >
              ← Edit Product & Pricing
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
