import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { useToast } from "../ui/ToastProvider";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { GRAPESJS_STUDIO_LICENSE_KEY } from "../../lib/grapesjsStudioLicense";
import type { StoreStudioApi } from "./StorePageStudioEditor";

const StorePageStudioEditor = lazy(() => import("./StorePageStudioEditor"));

interface StorePageRow {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  updated_at: string;
}

interface StoreCouponRow {
  id: string;
  code: string;
  kind: string;
  value: string;
  is_active: boolean;
  uses_count: number;
  max_uses: number | null;
}

export default function OnlineStoreSettingsPanel({ baseUrl }: { baseUrl: string }) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const headers = useCallback(
    () =>
      ({
        "Content-Type": "application/json",
        ...mergedPosStaffHeaders(backofficeHeaders),
      }) as Record<string, string>,
    [backofficeHeaders],
  );

  const canManage =
    hasPermission("online_store.manage") || hasPermission("settings.admin");

  const [sub, setSub] = useState<"pages" | "coupons">("pages");
  const [pages, setPages] = useState<StorePageRow[]>([]);
  const [coupons, setCoupons] = useState<StoreCouponRow[]>([]);
  const [slugDraft, setSlugDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editSlug, setEditSlug] = useState<string | null>(null);
  const [pageEditMode, setPageEditMode] = useState<"html" | "studio">("html");
  const [projectJsonDraft, setProjectJsonDraft] = useState<unknown>({});
  const [studioMountKey, setStudioMountKey] = useState(0);
  const [htmlDraft, setHtmlDraft] = useState("");
  const studioApiRef = useRef<StoreStudioApi | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [couponKind, setCouponKind] = useState("percent");
  const [couponValue, setCouponValue] = useState("10");

  const loadPages = useCallback(async () => {
    const res = await fetch(`${baseUrl}/api/admin/store/pages`, {
      headers: headers(),
    });
    if (!res.ok) {
      toast("Could not load store pages", "error");
      return;
    }
    const j = (await res.json()) as { pages?: StorePageRow[] };
    setPages(Array.isArray(j.pages) ? j.pages : []);
  }, [baseUrl, headers, toast]);

  const loadCoupons = useCallback(async () => {
    const res = await fetch(`${baseUrl}/api/admin/store/coupons`, {
      headers: headers(),
    });
    if (!res.ok) {
      toast("Could not load coupons", "error");
      return;
    }
    const j = (await res.json()) as { coupons?: StoreCouponRow[] };
    setCoupons(Array.isArray(j.coupons) ? j.coupons : []);
  }, [baseUrl, headers, toast]);

  useEffect(() => {
    if (!canManage) return;
    void loadPages();
    void loadCoupons();
  }, [canManage, loadPages, loadCoupons]);

  const openEditor = async (slug: string) => {
    setEditSlug(slug);
    const res = await fetch(
      `${baseUrl}/api/admin/store/pages/${encodeURIComponent(slug)}`,
      { headers: headers() },
    );
    if (!res.ok) {
      toast("Could not load page", "error");
      return;
    }
    const j = (await res.json()) as {
      published_html?: string;
      project_json?: unknown;
    };
    setHtmlDraft(typeof j.published_html === "string" ? j.published_html : "");
    setProjectJsonDraft(j.project_json ?? {});
    setStudioMountKey((k) => k + 1);
    setPageEditMode("html");
    studioApiRef.current = null;
  };

  const saveHtml = async () => {
    if (!editSlug) return;
    const res = await fetch(
      `${baseUrl}/api/admin/store/pages/${encodeURIComponent(editSlug)}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ published_html: htmlDraft }),
      },
    );
    if (!res.ok) {
      toast("Save failed", "error");
      return;
    }
    toast("Page HTML saved", "success");
    await loadPages();
  };

  const saveStudioProject = async (project: unknown) => {
    if (!editSlug) return;
    const res = await fetch(
      `${baseUrl}/api/admin/store/pages/${encodeURIComponent(editSlug)}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ project_json: project }),
      },
    );
    if (!res.ok) {
      toast("Studio project save failed", "error");
      return;
    }
    await loadPages();
  };

  const exportStudioToHtmlDraft = async () => {
    const html = await studioApiRef.current?.exportHtml();
    if (html == null) {
      toast("Could not export HTML from Studio yet", "error");
      return;
    }
    setHtmlDraft(html);
    toast("HTML placed in raw draft — choose Save draft HTML", "info");
    setPageEditMode("html");
  };

  const publishPage = async (slug: string) => {
    const res = await fetch(
      `${baseUrl}/api/admin/store/pages/${encodeURIComponent(slug)}/publish`,
      { method: "POST", headers: headers() },
    );
    if (!res.ok) {
      toast("Publish failed", "error");
      return;
    }
    toast("Published", "success");
    await loadPages();
  };

  const createPage = async () => {
    const slug = slugDraft.trim().toLowerCase();
    if (!slug || !titleDraft.trim()) {
      toast("Slug and title required", "info");
      return;
    }
    const res = await fetch(`${baseUrl}/api/admin/store/pages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, title: titleDraft.trim() }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast(j.error ?? "Create failed", "error");
      return;
    }
    toast("Page created", "success");
    setSlugDraft("");
    setTitleDraft("");
    await loadPages();
  };

  const createCoupon = async () => {
    const res = await fetch(`${baseUrl}/api/admin/store/coupons`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        code: couponCode.trim(),
        kind: couponKind,
        value: couponValue,
      }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast(j.error ?? "Create failed", "error");
      return;
    }
    toast("Coupon created", "success");
    setCouponCode("");
    await loadCoupons();
  };

  const toggleCoupon = async (id: string, isActive: boolean) => {
    const res = await fetch(`${baseUrl}/api/admin/store/coupons/${id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ is_active: !isActive }),
    });
    if (!res.ok) {
      toast("Update failed", "error");
      return;
    }
    await loadCoupons();
  };

  if (!canManage) {
    return (
      <p className="text-sm text-app-text-muted">
        You need Online store or Settings admin permission to manage storefront
        pages and coupons.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black uppercase italic tracking-tight text-app-text">
          Online store
        </h2>
        <p className="mt-1 text-xs text-app-text-muted">
          Marketing pages for public <span className="font-mono">/shop/…</span>{" "}
          (raw HTML or GrapesJS Studio visual builder, saved as{" "}
          <span className="font-mono">project_json</span>
          ), plus web coupon codes. Optional: set{" "}
          <span className="font-mono">VITE_GRAPESJS_STUDIO_LICENSE_KEY</span> for
          production Studio licensing.
        </p>
      </div>

      <div className="flex gap-2">
        {(["pages", "coupons"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setSub(id)}
            className={`rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-widest ${
              sub === id
                ? "bg-app-accent text-white"
                : "border border-app-border bg-app-surface text-app-text-muted"
            }`}
          >
            {id}
          </button>
        ))}
      </div>

      {sub === "pages" ? (
        <div className="space-y-4">
          <div className="ui-card space-y-3 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              New page
            </p>
            <input
              className="ui-input w-full max-w-xs font-mono lowercase"
              placeholder="slug"
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
            />
            <input
              className="ui-input w-full max-w-md"
              placeholder="Title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
            />
            <button
              type="button"
              onClick={() => void createPage()}
              className="ui-btn-primary text-[10px] font-black uppercase tracking-widest"
            >
              Create
            </button>
          </div>

          <ul className="space-y-2">
            {pages.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2"
              >
                <div>
                  <div className="font-bold text-app-text">{p.title}</div>
                  <div className="font-mono text-[10px] text-app-text-muted">
                    /shop/{p.slug}{" "}
                    {p.published ? (
                      <span className="text-emerald-600">published</span>
                    ) : (
                      <span className="text-amber-600">draft</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void openEditor(p.slug)}
                    className="ui-btn-secondary text-[10px] font-black uppercase"
                  >
                    Edit page
                  </button>
                  <button
                    type="button"
                    onClick={() => void publishPage(p.slug)}
                    className="ui-btn-primary text-[10px] font-black uppercase"
                  >
                    Publish
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {editSlug ? (
            <div className="ui-card space-y-3 p-4">
              <p className="text-[10px] font-black uppercase text-app-text-muted">
                Page — {editSlug}
              </p>
              <div className="flex flex-wrap gap-2">
                {(["html", "studio"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPageEditMode(m)}
                    className={`rounded-lg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest ${
                      pageEditMode === m
                        ? "bg-app-accent text-white"
                        : "border border-app-border bg-app-surface text-app-text-muted"
                    }`}
                  >
                    {m === "html" ? "Raw HTML" : "Visual (Studio)"}
                  </button>
                ))}
              </div>
              {pageEditMode === "html" ? (
                <>
                  <textarea
                    className="ui-input min-h-[220px] w-full font-mono text-xs"
                    value={htmlDraft}
                    onChange={(e) => setHtmlDraft(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void saveHtml()}
                      className="ui-btn-primary text-[10px] font-black uppercase"
                    >
                      Save draft HTML
                    </button>
                  </div>
                </>
              ) : (
                <Suspense
                  fallback={
                    <p className="text-sm text-app-text-muted">
                      Loading Studio editor…
                    </p>
                  }
                >
                  <StorePageStudioEditor
                    key={studioMountKey}
                    licenseKey={GRAPESJS_STUDIO_LICENSE_KEY}
                    projectJson={projectJsonDraft}
                    onSaveProject={(p) => saveStudioProject(p)}
                    onEditorReady={(api) => {
                      studioApiRef.current = api;
                    }}
                    studioAssetUpload={{
                      apiBaseUrl: baseUrl,
                      headers: () =>
                        mergedPosStaffHeaders(backofficeHeaders) as Record<
                          string,
                          string
                        >,
                    }}
                  />
                </Suspense>
              )}
              <div className="flex flex-wrap gap-2 border-t border-app-border pt-3">
                {pageEditMode === "studio" ? (
                  <button
                    type="button"
                    onClick={() => void exportStudioToHtmlDraft()}
                    className="ui-btn-secondary text-[10px] font-black uppercase"
                  >
                    Export Studio HTML to raw draft
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setEditSlug(null);
                    studioApiRef.current = null;
                  }}
                  className="ui-btn-secondary text-[10px] font-black uppercase"
                >
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="ui-card flex flex-wrap items-end gap-3 p-4">
            <div>
              <label className="text-[10px] font-black uppercase text-app-text-muted">
                Code
              </label>
              <input
                className="ui-input mt-1 font-mono uppercase"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value)}
              />
            </div>
            <div>
              <label className="text-[10px] font-black uppercase text-app-text-muted">
                Kind
              </label>
              <select
                className="ui-input mt-1"
                value={couponKind}
                onChange={(e) => setCouponKind(e.target.value)}
              >
                <option value="percent">percent</option>
                <option value="fixed_amount">fixed_amount</option>
                <option value="free_shipping">free_shipping</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-black uppercase text-app-text-muted">
                Value
              </label>
              <input
                className="ui-input mt-1 font-mono"
                value={couponValue}
                onChange={(e) => setCouponValue(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => void createCoupon()}
              className="ui-btn-primary text-[10px] font-black uppercase"
            >
              Add coupon
            </button>
          </div>
          <ul className="space-y-2">
            {coupons.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-app-border px-3 py-2"
              >
                <div>
                  <span className="font-mono font-bold">{c.code}</span>{" "}
                  <span className="text-xs text-app-text-muted">
                    {c.kind} {c.value} · uses {c.uses_count}
                    {c.max_uses != null ? ` / ${c.max_uses}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void toggleCoupon(c.id, c.is_active)}
                  className="text-[10px] font-black uppercase text-app-accent"
                >
                  {c.is_active ? "Deactivate" : "Activate"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
