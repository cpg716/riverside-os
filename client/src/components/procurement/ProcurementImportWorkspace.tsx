import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  Loader2,
  Paperclip,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";

type Vendor = {
  id: string;
  name: string;
};

type Category = {
  id: string;
  name: string;
};

type ProcurementAiStatus = {
  enabled: boolean;
  model: string;
  timeout_ms: number;
  deterministic_formats: string[];
  ai_required_formats: string[];
  prompt_version: string;
};

type ImportDocument = {
  id: string;
  vendor_id?: string | null;
  vendor_name?: string | null;
  document_kind: string;
  status: string;
  source_filename: string;
  invoice_number?: string | null;
  external_po_number?: string | null;
  document_date?: string | null;
  document_total?: string | null;
  duplicate_of_document_id?: string | null;
  converted_purchase_order_id?: string | null;
  line_count: number;
  unresolved_line_count: number;
};

type ImportLine = {
  id: string;
  line_index: number;
  vendor_sku?: string | null;
  vendor_upc?: string | null;
  barcode?: string | null;
  description?: string | null;
  product_name?: string | null;
  brand?: string | null;
  color?: string | null;
  size?: string | null;
  fit?: string | null;
  quantity: string;
  unit_cost: string;
  line_total?: string | null;
  match_status: string;
  matched_variant_id?: string | null;
  matched_product_id?: string | null;
  matched_sku?: string | null;
  matched_product_name?: string | null;
  matched_variation_label?: string | null;
  match_confidence?: string | null;
  match_reason?: string | null;
  review_action: string;
  review_payload: Record<string, unknown>;
  staff_notes?: string | null;
};

type ImportDetail = {
  document: ImportDocument;
  lines: ImportLine[];
  duplicate_warning?: string | null;
};

const DOCUMENT_KIND_OPTIONS = [
  ["unknown", "Unknown"],
  ["purchase_order", "Purchase Order"],
  ["order_confirmation", "Order Confirmation"],
  ["packing_slip", "Packing Slip"],
  ["invoice", "Invoice"],
  ["credit_memo", "Credit Memo"],
  ["statement", "Statement"],
];

const ACTION_OPTIONS = [
  ["needs_review", "Needs Review"],
  ["use_existing_variant", "Use Existing SKU"],
  ["create_variant", "Create Variant"],
  ["create_product", "Create Product"],
  ["ignore", "Ignore Line"],
];

const ACCEPTED_TYPES = ".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.xls,.txt,.json,.doc,.docx";

function money(value?: string | number | null): string {
  if (value === null || value === undefined || value === "") return "0.00";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function statusTone(status: string): string {
  switch (status) {
    case "converted":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "matched":
    case "extracted":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "needs_review":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "failed":
    case "cancelled":
      return "bg-red-50 text-red-700 border-red-200";
    default:
      return "bg-app-surface-2 text-app-text-muted border-app-border";
  }
}

function confidencePercent(value?: string | null): string {
  if (!value) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export default function ProcurementImportWorkspace({
  onOpenReceiving,
}: {
  onOpenReceiving?: () => void;
}) {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [imports, setImports] = useState<ImportDocument[]>([]);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [vendorId, setVendorId] = useState("");
  const [documentKind, setDocumentKind] = useState("unknown");
  const [busy, setBusy] = useState<string | null>(null);
  const [learnVendorProfile, setLearnVendorProfile] = useState(true);
  const [aiStatus, setAiStatus] = useState<ProcurementAiStatus | null>(null);

  const headers = useMemo(() => backofficeHeaders() as Record<string, string>, [backofficeHeaders]);

  const loadReferenceData = useCallback(async () => {
    const [vendorRes, categoryRes] = await Promise.all([
      fetch(apiUrl(baseUrl, "/api/vendors"), { headers }),
      fetch(apiUrl(baseUrl, "/api/categories"), { headers }),
    ]);
    if (vendorRes.ok) setVendors(await vendorRes.json());
    if (categoryRes.ok) setCategories(await categoryRes.json());
  }, [baseUrl, headers]);

  const loadImports = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/procurement/imports?limit=25"), { headers });
    if (!res.ok) return;
    setImports(await res.json());
  }, [baseUrl, headers]);

  const loadAiStatus = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/procurement/imports/ai-status"), { headers });
    if (!res.ok) return;
    setAiStatus(await res.json());
  }, [baseUrl, headers]);

  const openImport = useCallback(
    async (documentId: string) => {
      const res = await fetch(apiUrl(baseUrl, `/api/procurement/imports/${documentId}`), {
        headers,
      });
      if (!res.ok) {
        toast("Could not open import.", "error");
        return;
      }
      setDetail(await res.json());
    },
    [baseUrl, headers, toast],
  );

  useEffect(() => {
    void loadReferenceData();
    void loadImports();
    void loadAiStatus();
  }, [loadAiStatus, loadImports, loadReferenceData]);

  const upload = async () => {
    if (!selectedFile) {
      toast("Choose a vendor document first.", "error");
      return;
    }
    setBusy("upload");
    try {
      const body = new FormData();
      body.append("file", selectedFile);
      if (vendorId) body.append("vendor_id", vendorId);
      body.append("document_kind", documentKind);
      const res = await fetch(apiUrl(baseUrl, "/api/procurement/imports/upload"), {
        method: "POST",
        headers,
        body,
      });
      if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
      const uploaded = (await res.json()) as ImportDocument;
      toast("Vendor document uploaded.", "success");
      await loadImports();
      await openImport(uploaded.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Upload failed.", "error");
    } finally {
      setBusy(null);
    }
  };

  const runStep = async (step: "extract" | "match" | "learn" | "cancel") => {
    if (!detail) return;
    setBusy(step);
    try {
      const res = await fetch(
        apiUrl(baseUrl, `/api/procurement/imports/${detail.document.id}/${step}`),
        { method: "POST", headers },
      );
      if (!res.ok) throw new Error((await res.json()).error || `${step} failed`);
      setDetail(await res.json());
      await loadImports();
      toast(
        step === "extract"
          ? "ROSIE extraction completed or fell back safely."
          : step === "match"
            ? "Line matching complete."
            : step === "learn"
              ? "Vendor learning profile updated."
              : "Import cancelled.",
        "success",
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : `${step} failed.`, "error");
    } finally {
      setBusy(null);
    }
  };

  const patchDocument = async (patch: Partial<ImportDocument>) => {
    if (!detail) return;
    const res = await fetch(apiUrl(baseUrl, `/api/procurement/imports/${detail.document.id}`), {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) setDetail(await res.json());
  };

  const patchLine = async (lineId: string, patch: Record<string, unknown>) => {
    if (!detail) return;
    const res = await fetch(
      apiUrl(baseUrl, `/api/procurement/imports/${detail.document.id}/lines/${lineId}`),
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) {
      toast((await res.json()).error || "Could not update line.", "error");
      return;
    }
    setDetail(await res.json());
  };

  const convert = async (target: "direct_invoice" | "standard_po") => {
    if (!detail) return;
    setBusy(target);
    try {
      const res = await fetch(apiUrl(baseUrl, `/api/procurement/imports/${detail.document.id}/convert`), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ target, learn_vendor_profile: learnVendorProfile }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Conversion failed");
      const converted = await res.json();
      toast(`Created ${converted.po_number}. Stock has not been posted.`, "success");
      await loadImports();
      await openImport(detail.document.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Conversion failed.", "error");
    } finally {
      setBusy(null);
    }
  };

  const applyVariant = (line: ImportLine, variant: VariantSearchResult) => {
    void patchLine(line.id, {
      matched_variant_id: variant.variant_id,
      matched_product_id: variant.product_id,
      match_status: "exact",
      match_confidence: "1.0000",
      match_reason: "staff selected existing variant",
      review_action: "use_existing_variant",
    });
  };

  const updateReviewPayload = (line: ImportLine, patch: Record<string, unknown>) => {
    void patchLine(line.id, {
      review_payload: { ...(line.review_payload || {}), ...patch },
    });
  };

  return (
    <div className="space-y-6">
      <section className="rounded-[28px] border border-app-border bg-app-surface p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
              <Sparkles size={24} strokeWidth={2.6} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Import PO / Invoice
              </p>
              <h3 className="mt-1 text-xl font-black tracking-tight text-app-text">
                AI-assisted vendor document intake.
              </h3>
              <p className="mt-2 max-w-4xl text-sm font-semibold leading-relaxed text-app-text-muted">
                Upload PDF, Word, Excel, CSV, JSON, TXT, JPG, or PNG documents. ROSIE reads the
                original file when enabled, while deterministic parsers pre-read structured data for
                speed and fallback safety. No stock posts until staff finishes Receiving.
              </p>
              {aiStatus ? (
                <div
                  className={`mt-3 rounded-2xl border px-4 py-3 text-xs font-bold ${
                    aiStatus.enabled
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                >
                  {aiStatus.enabled
                    ? `ROSIE procurement AI is enabled (${aiStatus.model}). PDF, image, and Word files can be analyzed by the local sidecar before staff review.`
                    : `ROSIE procurement AI sidecar is off. CSV, Excel, JSON, and TXT still parse deterministically; PDF, image, and Word uploads will need sidecar setup before useful line extraction.`}
                </div>
              ) : null}
            </div>
          </div>
          {onOpenReceiving ? (
            <button
              type="button"
              onClick={onOpenReceiving}
              className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent hover:text-app-accent"
            >
              Open Receiving
            </button>
          ) : null}
        </div>

        <div className="mt-6 grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr_auto]">
          <label className="flex min-h-[92px] cursor-pointer flex-col justify-center rounded-2xl border border-dashed border-app-border bg-app-surface-2 px-5 py-4 hover:border-app-accent">
            <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <UploadCloud size={16} /> Vendor File
            </span>
            <span className="mt-2 truncate text-sm font-black text-app-text">
              {selectedFile?.name || "Choose PDF, Word, Excel, CSV, image, TXT, or JSON"}
            </span>
            <input
              type="file"
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <select className="ui-input h-full" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Vendor optional until review</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
            ))}
          </select>
          <select
            className="ui-input h-full"
            value={documentKind}
            onChange={(e) => setDocumentKind(e.target.value)}
          >
            {DOCUMENT_KIND_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={upload}
            disabled={busy === "upload"}
            className="rounded-2xl bg-app-accent px-6 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
          >
            {busy === "upload" ? <Loader2 className="animate-spin" size={18} /> : "Upload"}
          </button>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[330px_1fr]">
        <section className="rounded-[28px] border border-app-border bg-app-surface p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <FileSearch size={16} /> Recent Imports
          </div>
          <div className="space-y-2">
            {imports.length === 0 ? (
              <p className="rounded-2xl bg-app-surface-2 p-4 text-sm font-semibold text-app-text-muted">
                No imports yet.
              </p>
            ) : (
              imports.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openImport(item.id)}
                  className={`w-full rounded-2xl border p-3 text-left transition-all hover:border-app-accent ${
                    detail?.document.id === item.id ? "border-app-accent bg-app-accent/5" : "border-app-border bg-app-surface-2"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-black text-app-text">{item.source_filename}</span>
                    <span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase ${statusTone(item.status)}`}>
                      {item.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[11px] font-semibold text-app-text-muted">
                    {item.vendor_name || "Vendor not selected"} · {item.line_count} lines
                  </p>
                </button>
              ))
            )}
          </div>
        </section>

        {detail ? (
          <section className="space-y-6">
            <div className="rounded-[28px] border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-2xl font-black tracking-tight text-app-text">
                      {detail.document.source_filename}
                    </h3>
                    <span className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${statusTone(detail.document.status)}`}>
                      {detail.document.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-app-text-muted">
                    {detail.document.line_count} extracted lines · {detail.document.unresolved_line_count} need review
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void runStep("extract")} disabled={busy === "extract"} className="rounded-2xl bg-app-accent px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50">
                    {busy === "extract" ? <Loader2 className="animate-spin" size={16} /> : "Run ROSIE Extract"}
                  </button>
                  <button type="button" onClick={() => void runStep("match")} disabled={busy === "match"} className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent">
                    Match Lines
                  </button>
                  <button type="button" onClick={() => void runStep("learn")} disabled={busy === "learn"} className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent">
                    Learn Vendor
                  </button>
                </div>
              </div>

              {detail.duplicate_warning ? (
                <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-800">
                  <AlertTriangle className="mr-2 inline" size={16} /> {detail.duplicate_warning}
                </div>
              ) : null}

              <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <select className="ui-input" value={detail.document.vendor_id || ""} onChange={(e) => void patchDocument({ vendor_id: e.target.value || null })}>
                  <option value="">Select vendor before conversion</option>
                  {vendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                  ))}
                </select>
                <select className="ui-input" value={detail.document.document_kind} onChange={(e) => void patchDocument({ document_kind: e.target.value })}>
                  {DOCUMENT_KIND_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <input className="ui-input" placeholder="Invoice #" defaultValue={detail.document.invoice_number || ""} onBlur={(e) => void patchDocument({ invoice_number: e.target.value })} />
                <input className="ui-input" placeholder="External PO #" defaultValue={detail.document.external_po_number || ""} onBlur={(e) => void patchDocument({ external_po_number: e.target.value })} />
              </div>
            </div>

            <div className="rounded-[28px] border border-app-border bg-app-surface shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border p-5">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Review Lines</p>
                  <h3 className="text-lg font-black text-app-text">Approve matches before PO creation</h3>
                </div>
                <div className="flex items-center gap-2 rounded-2xl bg-app-surface-2 px-4 py-3 text-xs font-bold text-app-text-muted">
                  <Paperclip size={16} /> Stock is not posted by this import.
                </div>
              </div>
              <div className="divide-y divide-app-border">
                {detail.lines.map((line) => (
                  <div key={line.id} className="grid gap-4 p-5 xl:grid-cols-[1.2fr_0.8fr_0.8fr]">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-black text-app-text">{line.product_name || line.description || `Line ${line.line_index}`}</span>
                        <span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase ${statusTone(line.match_status)}`}>
                          {line.match_status.replace(/_/g, " ")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-semibold text-app-text-muted">
                        SKU {line.vendor_sku || "—"} · UPC {line.vendor_upc || line.barcode || "—"} · Qty {line.quantity} · Cost ${money(line.unit_cost)}
                      </p>
                      {line.match_reason ? (
                        <p className="mt-2 text-[11px] font-semibold text-app-text-muted">
                          {line.match_reason} · Confidence {confidencePercent(line.match_confidence)}
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Match Resolver</p>
                      {line.matched_variant_id ? (
                        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-800">
                          <CheckCircle2 className="mr-1 inline" size={14} />
                          {line.matched_product_name} · {line.matched_sku}
                          {line.matched_variation_label ? ` · ${line.matched_variation_label}` : ""}
                        </div>
                      ) : null}
                      <VariantSearchInput
                        placeholder="Search ROS SKU/product…"
                        onSelect={(variant) => applyVariant(line, variant)}
                      />
                    </div>

                    <div className="space-y-2">
                      <select
                        className="ui-input"
                        value={line.review_action}
                        onChange={(e) => void patchLine(line.id, { review_action: e.target.value })}
                      >
                        {ACTION_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                      {line.review_action === "create_product" ? (
                        <div className="grid gap-2">
                          <input className="ui-input" placeholder="New product name" defaultValue={(line.review_payload.name as string) || line.product_name || line.description || ""} onBlur={(e) => updateReviewPayload(line, { name: e.target.value })} />
                          <input className="ui-input" placeholder="New SKU" defaultValue={(line.review_payload.sku as string) || line.vendor_sku || ""} onBlur={(e) => updateReviewPayload(line, { sku: e.target.value })} />
                          <input className="ui-input" placeholder="Retail price" defaultValue={(line.review_payload.base_retail_price as string) || ""} onBlur={(e) => updateReviewPayload(line, { base_retail_price: e.target.value })} />
                          <select className="ui-input" value={(line.review_payload.category_id as string) || ""} onChange={(e) => updateReviewPayload(line, { category_id: e.target.value || null })}>
                            <option value="">Category optional</option>
                            {categories.map((category) => (
                              <option key={category.id} value={category.id}>{category.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                      {line.review_action === "create_variant" ? (
                        <div className="grid gap-2">
                          <input className="ui-input" placeholder="New SKU" defaultValue={(line.review_payload.sku as string) || line.vendor_sku || ""} onBlur={(e) => updateReviewPayload(line, { sku: e.target.value })} />
                          <VariantSearchInput
                            placeholder="Choose parent product…"
                            onSelect={(variant) => updateReviewPayload(line, { product_id: variant.product_id })}
                          />
                          <input className="ui-input" placeholder="Variation label" defaultValue={(line.review_payload.variation_label as string) || [line.color, line.size, line.fit].filter(Boolean).join(" / ")} onBlur={(e) => updateReviewPayload(line, { variation_label: e.target.value })} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[28px] border border-app-border bg-app-surface p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Convert</p>
                  <h3 className="text-xl font-black text-app-text">Create draft procurement document</h3>
                  <p className="mt-2 text-sm font-semibold text-app-text-muted">
                    Conversion creates a PO/direct invoice draft and line rows only. Receiving remains the only stock-posting step.
                  </p>
                  <label className="mt-3 flex items-center gap-2 text-xs font-bold text-app-text-muted">
                    <input type="checkbox" checked={learnVendorProfile} onChange={(e) => setLearnVendorProfile(e.target.checked)} />
                    Learn corrected vendor aliases for next import
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void convert("direct_invoice")} disabled={!!busy} className="rounded-2xl bg-app-accent px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50">
                    Create Direct Invoice Draft
                  </button>
                  <button type="button" onClick={() => void convert("standard_po")} disabled={!!busy} className="rounded-2xl border border-app-border bg-app-surface-2 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent disabled:opacity-50">
                    Create PO Draft
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-[28px] border border-dashed border-app-border bg-app-surface p-10 text-center shadow-sm">
            <FileSearch className="mx-auto text-app-text-muted" size={36} />
            <h3 className="mt-4 text-xl font-black text-app-text">Upload or open an import.</h3>
            <p className="mx-auto mt-2 max-w-xl text-sm font-semibold text-app-text-muted">
              Start with vendor paperwork, then run ROSIE extraction and staff review before creating procurement drafts.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
