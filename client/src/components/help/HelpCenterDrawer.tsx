import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { CircleHelp, X } from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { HELP_MANUALS, helpManualById } from "../../lib/help/help-manifest";
import {
  buildLocalSearchChunks,
  localHelpSearch,
  orderedSectionSlugs,
  parseHelpToc,
} from "../../lib/help/helpParse";
import { slugifyHeading } from "../../lib/help/helpSlug";
import { resolveHelpImageSrc } from "../../lib/help/helpImages";
import { stripYamlFrontMatter } from "../../lib/help/helpFrontMatter";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type ApiHit = {
  id: string;
  manual_id: string;
  manual_title: string;
  section_slug: string;
  section_heading: string;
  excerpt: string;
};

type ResultRow =
  | (ApiHit & { source: "api" })
  | {
      source: "local";
      manual_id: string;
      manual_title: string;
      section_slug: string;
      section_heading: string;
      excerpt: string;
    };

type HelpManualListEntry = {
  id: string;
  title: string;
  summary: string;
  order: number;
  has_markdown_override?: boolean;
};

function extractText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const p = (node as { props?: { children?: unknown } }).props;
    return extractText(p?.children);
  }
  return "";
}

function HelpMarkdownBody({
  manualId,
  markdown,
  onImageClick,
}: {
  manualId: string;
  markdown: string;
  onImageClick?: (resolvedSrc: string, alt: string) => void;
}) {
  const slugs = useMemo(() => orderedSectionSlugs(markdown), [markdown]);
  let slugIdx = 0;

  const components: Partial<Components> = {
    h1: ({ children, ...props }) => (
      <h1
        id={`help-${manualId}-overview`}
        className="help-center-prose-heading help-center-prose-h1"
        {...props}
      >
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => {
      const slug = slugs[slugIdx++] ?? slugifyHeading(extractText(children));
      return (
        <h2
          id={`help-${manualId}-${slug}`}
          className="help-center-prose-heading help-center-prose-h2"
          {...props}
        >
          {children}
        </h2>
      );
    },
    h3: ({ children, ...props }) => {
      const slug = slugs[slugIdx++] ?? slugifyHeading(extractText(children));
      return (
        <h3
          id={`help-${manualId}-${slug}`}
          className="help-center-prose-heading help-center-prose-h3"
          {...props}
        >
          {children}
        </h3>
      );
    },
    p: ({ children, ...props }) => (
      <p className="help-center-prose-p" {...props}>
        {children}
      </p>
    ),
    ul: ({ children, ...props }) => (
      <ul className="help-center-prose-ul" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol className="help-center-prose-ol" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="help-center-prose-li" {...props}>
        {children}
      </li>
    ),
    strong: ({ children, ...props }) => (
      <strong className="font-semibold text-app-text" {...props}>
        {children}
      </strong>
    ),
    code: ({ className, children, ...props }) => {
      const inline = !className;
      if (inline) {
        return (
          <code className="rounded bg-app-surface-2 px-1 py-0.5 font-mono text-[0.85em]" {...props}>
            {children}
          </code>
        );
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children, ...props }) => (
      <pre
        className="mb-3 overflow-x-auto rounded-lg border border-app-border bg-app-surface-2 p-3 text-xs font-mono"
        {...props}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="mb-3 border-l-4 border-app-border pl-3 text-app-text-muted italic"
        {...props}
      >
        {children}
      </blockquote>
    ),
    a: ({ href, children, ...props }) => (
      <a
        href={href}
        className="text-app-accent underline-offset-2 hover:underline"
        target="_blank"
        rel="noreferrer"
        {...props}
      >
        {children}
      </a>
    ),
    img: ({ src, alt, ...props }) => {
      const resolved = resolveHelpImageSrc(String(src ?? ""));
      const altText = String(alt ?? "");
      const label = altText ? `View larger: ${altText}` : "View larger image";
      if (!onImageClick) {
        return (
          <img
            src={resolved}
            alt={altText}
            className="my-3 max-h-64 max-w-full rounded-lg border border-app-border object-contain"
            {...props}
          />
        );
      }
      return (
        <button
          type="button"
          onClick={() => onImageClick(resolved, altText)}
          className="group my-3 block max-w-full rounded-lg border border-app-border p-0 text-left transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
          aria-label={label}
        >
          <img
            src={resolved}
            alt={altText}
            className="max-h-64 max-w-full rounded-lg object-contain pointer-events-none select-none"
            draggable={false}
            {...props}
          />
          <span className="sr-only">{label}</span>
        </button>
      );
    },
    hr: (props) => <hr className="my-4 border-app-border" {...props} />,
    table: ({ children, ...props }) => (
      <div className="mb-3 overflow-x-auto">
        <table className="help-center-prose-table w-full text-left text-sm" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...props }) => (
      <th className="border border-app-border bg-app-surface-2 px-2 py-1 font-semibold" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="border border-app-border px-2 py-1" {...props}>
        {children}
      </td>
    ),
  };

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {markdown}
    </ReactMarkdown>
  );
}

type HelpImageLightbox = { src: string; alt: string };

export default function HelpCenterDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [imageLightbox, setImageLightbox] = useState<HelpImageLightbox | null>(null);
  const closeLightbox = useCallback(() => setImageLightbox(null), []);
  const { dialogRef: lightboxRef, titleId: lightboxTitleId } = useDialogAccessibility(
    imageLightbox !== null,
    { onEscape: closeLightbox },
  );

  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [activeManualId, setActiveManualId] = useState(HELP_MANUALS[0]?.id ?? "pos");
  const [searchQ, setSearchQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [resultRows, setResultRows] = useState<ResultRow[] | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{
    manualId: string;
    slug: string;
  } | null>(null);

  const [manualList, setManualList] = useState<HelpManualListEntry[] | null>(null);
  const [helpListSource, setHelpListSource] = useState<"api" | "static">("static");
  const [markdownById, setMarkdownById] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setManualList(null);
      setMarkdownById({});
      setHelpListSource("static");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/help/manuals`, { headers: apiAuth() });
        if (!res.ok) throw new Error("help manuals");
        const j = (await res.json()) as { manuals?: HelpManualListEntry[] };
        const list = j.manuals ?? [];
        if (cancelled) return;
        if (list.length === 0) throw new Error("empty");
        setManualList(list);
        setHelpListSource("api");
      } catch {
        if (cancelled) return;
        const fallback = [...HELP_MANUALS]
          .map((m) => ({
            id: m.id,
            title: m.title,
            summary: m.summary ?? "",
            order: 100,
          }))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        setManualList(fallback);
        setHelpListSource("static");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, apiAuth]);

  useEffect(() => {
    if (!manualList?.length) return;
    if (!manualList.some((m) => m.id === activeManualId)) {
      setActiveManualId(manualList[0].id);
    }
  }, [manualList, activeManualId]);

  useEffect(() => {
    if (!isOpen || helpListSource !== "api" || !activeManualId) return;
    if (markdownById[activeManualId]) return;
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/help/manuals/${encodeURIComponent(activeManualId)}`,
          { headers: apiAuth() },
        );
        if (!res.ok) throw new Error("detail");
        const j = (await res.json()) as { markdown: string };
        if (cancelled) return;
        setMarkdownById((prev) => ({ ...prev, [activeManualId]: j.markdown }));
      } catch {
        const m = helpManualById(activeManualId);
        if (!cancelled && m) {
          setMarkdownById((prev) => ({
            ...prev,
            [activeManualId]: stripYamlFrontMatter(m.markdown),
          }));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, helpListSource, activeManualId, apiAuth]);

  const allowedManualIds = useMemo(() => {
    if (manualList?.length) return new Set(manualList.map((m) => m.id));
    return new Set(HELP_MANUALS.map((m) => m.id));
  }, [manualList]);

  const localChunks = useMemo(() => {
    const out: ReturnType<typeof buildLocalSearchChunks> = [];
    for (const m of HELP_MANUALS) {
      if (!allowedManualIds.has(m.id)) continue;
      out.push(
        ...buildLocalSearchChunks(m.id, m.title, stripYamlFrontMatter(m.markdown)),
      );
    }
    return out;
  }, [allowedManualIds]);

  const effectiveList = manualList ?? [];
  const activeEntry = effectiveList.find((x) => x.id === activeManualId);
  const activeTitle =
    activeEntry?.title ?? helpManualById(activeManualId)?.title ?? activeManualId;
  const displayMarkdown = useMemo(() => {
    if (helpListSource === "api") {
      const c = markdownById[activeManualId];
      if (c) return c;
      return "";
    }
    const m = helpManualById(activeManualId);
    return m ? stripYamlFrontMatter(m.markdown) : "";
  }, [helpListSource, markdownById, activeManualId]);

  const activeManual =
    activeManualId !== ""
      ? { id: activeManualId, title: activeTitle, markdown: displayMarkdown }
      : null;

  const toc = useMemo(
    () =>
      activeManual && displayMarkdown
        ? parseHelpToc(displayMarkdown, activeManual.title)
        : [],
    [activeManual, displayMarkdown],
  );

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(searchQ.trim()), 320);
    return () => window.clearTimeout(t);
  }, [searchQ]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQ("");
      setDebouncedQ("");
      setResultRows(null);
      setScrollTarget(null);
      setImageLightbox(null);
      return;
    }
    if (debouncedQ.length < 2) {
      setResultRows(null);
      setSearchBusy(false);
      return;
    }

    let cancelled = false;
    setSearchBusy(true);

    const run = async () => {
      let apiHits: ApiHit[] = [];
      try {
        const res = await fetch(
          `${baseUrl}/api/help/search?q=${encodeURIComponent(debouncedQ)}&limit=12`,
          { headers: apiAuth() },
        );
        if (res.ok) {
          const j = (await res.json()) as { hits?: ApiHit[] };
          apiHits = j.hits ?? [];
        }
      } catch {
        /* offline / CORS — use local only */
      }
      if (cancelled) return;

      if (apiHits.length > 0) {
        setResultRows(apiHits.map((h) => ({ ...h, source: "api" as const })));
        setSearchBusy(false);
        return;
      }

      const local = localHelpSearch(debouncedQ, localChunks, 12)
        .filter((c) => allowedManualIds.has(c.manualId))
        .map((c) => ({
          source: "local" as const,
          manual_id: c.manualId,
          manual_title: c.manualTitle,
          section_slug: c.sectionSlug,
          section_heading: c.sectionHeading,
          excerpt: c.excerpt,
        }));
      setResultRows(local);
      setSearchBusy(false);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, isOpen, apiAuth, localChunks, allowedManualIds]);

  const scrollToSection = useCallback((manualId: string, sectionSlug: string) => {
    setActiveManualId(manualId);
    setSearchQ("");
    setDebouncedQ("");
    setResultRows(null);
    setScrollTarget({ manualId, slug: sectionSlug });
  }, []);

  useEffect(() => {
    if (!scrollTarget) return;
    if (scrollTarget.manualId !== activeManualId) return;
    if (resultRows && resultRows.length > 0) return;
    const el = document.getElementById(
      `help-${scrollTarget.manualId}-${scrollTarget.slug}`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollTarget(null);
    }
  }, [scrollTarget, activeManualId, displayMarkdown, resultRows]);

  const lightboxPortal =
    imageLightbox &&
    (typeof document !== "undefined"
      ? createPortal(
          <div
            ref={lightboxRef}
            className="fixed inset-0 z-[120] flex items-center justify-center p-4 outline-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby={lightboxTitleId}
          >
            <div
              className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
              aria-hidden="true"
              onClick={closeLightbox}
            />
            <div className="relative z-10 flex max-h-[min(92vh,900px)] max-w-[min(96vw,1200px)] flex-col items-center gap-3">
              <p id={lightboxTitleId} className="sr-only">
                {imageLightbox.alt ? `Image preview: ${imageLightbox.alt}` : "Image preview"}
              </p>
              <button
                type="button"
                onClick={closeLightbox}
                className="absolute -right-1 -top-10 flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-white/20 bg-black/50 text-white shadow-lg transition-colors hover:bg-black/70 sm:right-0 sm:top-0 sm:translate-x-full sm:translate-y-0 sm:border-app-border sm:bg-app-surface sm:text-app-text"
                aria-label="Close"
              >
                <X size={20} strokeWidth={2} aria-hidden />
              </button>
              <img
                src={imageLightbox.src}
                alt={imageLightbox.alt}
                className="max-h-[min(88vh,860px)] max-w-full rounded-lg border border-app-border object-contain shadow-2xl"
              />
            </div>
          </div>,
          document.body,
        )
      : null);

  return (
    <>
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Help"
      panelMaxClassName="max-w-3xl"
      noPadding
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-3 border-b border-app-border bg-app-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="help-center-search">
              Search help
            </label>
            <input
              id="help-center-search"
              data-testid="help-center-search"
              type="search"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Search manuals…"
              className="ui-input min-w-[12rem] flex-1 text-sm"
              autoComplete="off"
            />
            {searchBusy ? (
              <span className="text-xs text-app-text-muted">Searching…</span>
            ) : null}
          </div>
          {effectiveList.length > 1 ? (
            <select
              className="ui-input max-w-xs text-sm"
              value={activeManualId}
              onChange={(e) => {
                setActiveManualId(e.target.value);
                setResultRows(null);
              }}
            >
              {effectiveList.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          ) : null}
          {manualList === null && isOpen ? (
            <p className="text-xs text-app-text-muted">Loading manuals…</p>
          ) : null}
          {helpListSource === "api" && detailLoading && !displayMarkdown ? (
            <p className="text-xs text-app-text-muted">Loading article…</p>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1">
          {resultRows && resultRows.length > 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Results
              </p>
              <ul className="space-y-2">
                {resultRows.map((row, i) => (
                  <li key={`${row.manual_id}-${row.section_slug}-${i}`}>
                    <button
                      type="button"
                      onClick={() => scrollToSection(row.manual_id, row.section_slug)}
                      className="w-full rounded-xl border border-app-border bg-app-surface-2 p-3 text-left transition-colors hover:bg-app-border/15"
                    >
                      <p className="text-xs font-bold text-app-text">{row.manual_title}</p>
                      <p className="mt-0.5 text-sm font-semibold text-app-accent">
                        {row.section_heading}
                      </p>
                      <p className="mt-1 line-clamp-3 text-xs text-app-text-muted">
                        {row.excerpt}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <nav
                className="hidden w-44 shrink-0 overflow-y-auto border-r border-app-border bg-app-surface-2/40 py-3 sm:block"
                aria-label="On this page"
              >
                <p className="px-3 pb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  On this page
                </p>
                <ul className="space-y-0.5 px-2">
                  {toc.map((e, ti) => (
                    <li key={`${e.slug}-${ti}`}>
                      <button
                        type="button"
                        onClick={() => scrollToSection(activeManualId, e.slug)}
                        className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-app-border/20 ${
                          e.level === 3 ? "pl-4 text-app-text-muted" : "font-medium text-app-text"
                        }`}
                      >
                        {e.heading}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="help-center-prose min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm text-app-text">
                {activeManual && displayMarkdown ? (
                  <HelpMarkdownBody
                    manualId={activeManual.id}
                    markdown={displayMarkdown}
                    onImageClick={(src, alt) => setImageLightbox({ src, alt })}
                  />
                ) : activeManual && helpListSource === "api" && detailLoading ? (
                  <p className="text-app-text-muted">Loading…</p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </DetailDrawer>
    {lightboxPortal}
    </>
  );
}

export function HelpCenterTriggerButton({
  onOpen,
  className = "",
}: {
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="help-center-trigger"
      className={`relative inline-flex touch-manipulation items-center justify-center rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text shadow-sm transition-colors hover:bg-app-border/20 ${className}`.trim()}
      aria-label="Help"
    >
      <CircleHelp size={18} strokeWidth={2} aria-hidden />
    </button>
  );
}
