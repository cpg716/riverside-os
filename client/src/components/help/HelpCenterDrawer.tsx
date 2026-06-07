import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  CircleHelp,
  BookOpen,
  Mic,
  Printer,
  SendHorizonal,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import RosieIcon from "../common/RosieIcon";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { HELP_MANUALS, helpManualById } from "../../lib/help/help-manifest";
import {
  orderedSectionSlugs,
  parseHelpToc,
} from "../../lib/help/helpParse";
import { formatHelpDisplayHeading, formatHelpDisplayTitle } from "../../lib/help/helpDisplay";
import { slugifyHeading } from "../../lib/help/helpSlug";
import { resolveHelpImageSrc } from "../../lib/help/helpImages";
import { stripYamlFrontMatter } from "../../lib/help/helpFrontMatter";
import { writeAndPrintDocumentWindow } from "../../lib/browserPrint";
import {
  askRosieGroundedHelpStream,
  getRosieVoiceCapabilities,
  loadLocalRosieSettings,
  speakRosieText,
  startRosieVoiceCapture,
  stopRosieSpeechPlayback,
  type RosieGroundedHelpRequest,
  type RosieHelpGroundingSource,
  type RosieSuggestedAction,
  type RosieSettings,
  type RosieVoiceCapabilities,
  type RosieSpeechPlayback,
  type RosieVoiceCaptureSession,
} from "../../lib/rosie";

const baseUrl = getBaseUrl();

type ApiHit = {
  id: string;
  manual_id: string;
  manual_title: string;
  section_slug: string;
  section_heading: string;
  excerpt: string;
};

type HelpSearchResponse = {
  hits?: ApiHit[];
  search_mode?: "meilisearch" | "unavailable";
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

type RosiChatEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: RosieHelpGroundingSource[];
  suggestedActions?: RosieSuggestedAction[];
  transparency?: "grounded-help" | "grounded-conversation";
  error?: boolean;
  streaming?: boolean;
};

type DrawerMode = "browse" | "ask" | "conversation";

export type HelpCenterDrawerMode = DrawerMode;

const DRAWER_MODE_COPY: Record<
  DrawerMode,
  {
    title: string;
    lead: string;
    detail: string;
  }
> = {
  browse: {
    title: "Help Library",
    lead: "Find staff manuals, procedures, and screen guides.",
    detail: "Use this when staff need the official step-by-step instructions.",
  },
  ask: {
    title: "Ask ROSIE",
    lead: "Ask a focused question and get a sourced answer from Riverside help.",
    detail: "Best for quick procedure, policy, and how-to questions. ROSIE shows sources when available.",
  },
  conversation: {
    title: "ROSIE Chat",
    lead: "Chat with ROSIE about Riverside workflows and store information.",
    detail: "Best for broader workflow questions, follow-ups, and voice conversations. Sources appear when available.",
  },
};

export type HelpCenterInitialTarget = {
  query: string;
  manualId: string;
  sectionSlug: string;
};

const PINNED_HELP_MANUAL_ORDER = new Map(
  [
    "pos",
    "pos-nexo-checkout-drawer",
    "pos-receipt-summary-modal",
    "pos-sidebar",
    "pos-register-dashboard",
    "pos-register-reports",
    "operations-operational-home",
    "customers-customer-relationship-hub-drawer",
    "customers-workspace",
    "orders-workspace",
    "alterations-workspace",
    "scheduler-workspace",
    "inventory-control-board",
    "inventory-receiving-bay",
    "inventory-purchase-order-panel",
    "inventory-product-hub-drawer",
    "gift-cards-workspace",
    "qbo-workspace",
    "settings-counterpoint-sync-settings-panel",
    "help-center-drawer",
    "bug-report-flow",
    "settings-bug-reports-settings-panel",
    "settings-ros-dev-center-panel",
    "settings-rosie-settings-panel",
  ].map((id, index) => [id, index] as const),
);

function helpManualDomainRank(entry: HelpManualListEntry): number {
  const text = `${entry.id} ${entry.title}`.toLowerCase();
  if (text.includes("pos") || text.includes("register") || text.includes("checkout") || text.includes("receipt")) return 10;
  if (text.includes("operation")) return 20;
  if (text.includes("customer") || text.includes("podium")) return 30;
  if (text.includes("order") || text.includes("pickup")) return 40;
  if (text.includes("alteration") || text.includes("scheduler")) return 50;
  if (
    text.includes("inventory") ||
    text.includes("receiv") ||
    text.includes("purchase") ||
    text.includes("product") ||
    text.includes("vendor") ||
    text.includes("variation")
  ) return 60;
  if (text.includes("gift") || text.includes("loyalty") || text.includes("reward")) return 70;
  if (text.includes("shipping") || text.includes("shipment")) return 80;
  if (text.includes("qbo") || text.includes("counterpoint") || text.includes("report") || text.includes("insight")) return 90;
  if (text.includes("settings") || text.includes("help") || text.includes("rosie") || text.includes("bug") || text.includes("dev")) return 100;
  return 200;
}

function orderHelpManuals(entries: HelpManualListEntry[]): HelpManualListEntry[] {
  return [...entries].sort((a, b) => {
    const pinnedA = PINNED_HELP_MANUAL_ORDER.get(a.id);
    const pinnedB = PINNED_HELP_MANUAL_ORDER.get(b.id);
    if (pinnedA !== undefined || pinnedB !== undefined) {
      return (pinnedA ?? 10_000) - (pinnedB ?? 10_000);
    }
    return (
      helpManualDomainRank(a) - helpManualDomainRank(b) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    );
  });
}

function isDraftHelpMarkdown(markdown: string): boolean {
  const match = markdown.replace(/^\uFEFF/, "").match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return false;
  return match[1]
    .split(/\r?\n/)
    .some((line) => /^status:\s*['"]?draft['"]?\s*$/i.test(line.trim()));
}

function cleanHelpMarkdownForDisplay(markdown: string): string {
  return markdown
    .replace(/<!--\s*help:component-source\s*-->[\s\S]*?<!--\s*\/help:component-source\s*-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

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

function markdownToSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^[>*-]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\b(?:source|sources|suggested actions?)\s*:\s*/gi, "")
    .replace(/[•*_~`#>]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/->|→/g, " then ")
    .replace(/&/g, " and ")
    .replace(/#+\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePrintHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inlineHelpMarkdownToHtml(value: string): string {
  return escapePrintHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(manual:([^)]+)\)/g, '<a href="#guide-$2">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function helpMarkdownToPrintHtml(manualId: string, markdown: string): string {
  const lines = cleanHelpMarkdownForDisplay(stripYamlFrontMatter(markdown)).split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let skippedH1 = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inlineHelpMarkdownToHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };
  const ensureList = (type: "ul" | "ol") => {
    flushParagraph();
    if (listType === type) return;
    closeList();
    listType = type;
    html.push(`<${type}>`);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      flushParagraph();
      closeList();
      const alt = image[1].trim();
      const src = resolveHelpImageSrc(image[2].trim());
      html.push(
        `<figure><img src="${escapePrintHtml(src)}" alt="${escapePrintHtml(alt)}" />${
          alt ? `<figcaption>${escapePrintHtml(alt)}</figcaption>` : ""
        }</figure>`,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      if (heading[1] === "#" && !skippedH1) {
        skippedH1 = true;
        continue;
      }
      const level = heading[1].length === 3 ? 3 : 2;
      const text = formatHelpDisplayHeading(heading[2].trim());
      const id = `guide-${manualId}-${slugifyHeading(text)}`;
      html.push(`<h${level} id="${escapePrintHtml(id)}">${escapePrintHtml(text)}</h${level}>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      ensureList("ol");
      html.push(`<li>${inlineHelpMarkdownToHtml(ordered[1])}</li>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      ensureList("ul");
      html.push(`<li>${inlineHelpMarkdownToHtml(unordered[1])}</li>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join("\n");
}

function fullHelpGuideHtml(manuals: Array<{ id: string; title: string; markdown: string }>): string {
  const generatedAt = new Date().toLocaleString();
  const toc = manuals
    .map(
      (manual) =>
        `<li><a href="#guide-${escapePrintHtml(manual.id)}">${escapePrintHtml(
          formatHelpDisplayTitle(manual.title),
        )}<span class="toc-page" data-target="guide-${escapePrintHtml(manual.id)}"></span></a></li>`,
    )
    .join("\n");
  const sections = manuals
    .map((manual) => {
      const title = formatHelpDisplayTitle(manual.title);
      return `<section class="manual-section" id="guide-${escapePrintHtml(manual.id)}">
        <h1>${escapePrintHtml(title)}</h1>
        ${helpMarkdownToPrintHtml(manual.id, manual.markdown)}
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Riverside OS Help Guide</title>
  <style>
    @page {
      size: letter;
      margin: 0.72in;
      @bottom-center {
        content: "Riverside OS Help Guide - Page " counter(page) " of " counter(pages);
        font-size: 9px;
        color: #475569;
      }
    }
    body {
      color: #111827;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
      line-height: 1.45;
    }
    .cover {
      break-after: page;
      min-height: 8.4in;
      display: flex;
      flex-direction: column;
      justify-content: center;
      border: 2px solid #111827;
      padding: 0.7in;
    }
    .cover .eyebrow {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #475569;
    }
    .cover h1 {
      margin: 0.18in 0 0;
      font-size: 42px;
      line-height: 1;
      letter-spacing: 0;
    }
    .cover p {
      max-width: 5.8in;
      font-size: 13px;
      color: #475569;
    }
    .toc {
      break-after: page;
    }
    .toc h1 {
      font-size: 26px;
      margin: 0 0 0.25in;
    }
    .toc ol {
      columns: 2;
      column-gap: 0.35in;
      padding-left: 0.2in;
    }
    .toc li {
      break-inside: avoid;
      margin: 0 0 6px;
    }
    .toc a {
      color: #111827;
      text-decoration: none;
    }
    .toc a::after {
      content: leader(".") target-counter(attr(href), page);
    }
    .toc-page {
      float: right;
      margin-left: 8px;
      color: #475569;
      font-variant-numeric: tabular-nums;
    }
    .manual-section {
      break-before: page;
    }
    h1 {
      margin: 0 0 0.18in;
      font-size: 24px;
      line-height: 1.1;
    }
    h2 {
      margin: 0.22in 0 0.08in;
      padding-top: 0.06in;
      border-top: 1px solid #cbd5e1;
      font-size: 15px;
    }
    h3 {
      margin: 0.16in 0 0.06in;
      font-size: 12px;
    }
    p, ul, ol {
      margin: 0 0 0.1in;
    }
    li {
      margin: 0 0 0.04in;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      padding: 1px 3px;
    }
    figure {
      margin: 0.16in 0;
      break-inside: avoid;
    }
    img {
      max-width: 100%;
      max-height: 3.9in;
      border: 1px solid #cbd5e1;
      object-fit: contain;
    }
    figcaption {
      margin-top: 4px;
      color: #64748b;
      font-size: 9px;
    }
    a {
      color: #0f4f9f;
    }
  </style>
</head>
<body>
  <section class="cover">
    <div class="eyebrow">Riverside OS</div>
    <h1>Help Guide</h1>
    <p>Current staff Help Library manuals generated from the live Riverside OS Help Center catalog.</p>
    <p>Generated ${escapePrintHtml(generatedAt)} - ${manuals.length} manuals</p>
  </section>
  <section class="toc">
    <h1>Full Index</h1>
    <ol>${toc}</ol>
  </section>
  ${sections}
  <script>
    (() => {
      const pageHeight = 960;
      let page = 3;
      document.querySelectorAll(".manual-section").forEach((section) => {
        document
          .querySelectorAll('.toc-page[data-target="' + section.id + '"]')
          .forEach((node) => {
            node.textContent = String(page);
          });
        page += Math.max(1, Math.ceil(section.scrollHeight / pageHeight));
      });
    })();
  </script>
</body>
</html>`;
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
        {formatHelpDisplayTitle(extractText(children))}
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
          {formatHelpDisplayHeading(extractText(children))}
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
          {formatHelpDisplayHeading(extractText(children))}
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

function RosieAnswerBody({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
        code: ({ className, children, ...props }) => {
          const inline = !className;
          if (inline) {
            return (
              <code
                className="rounded bg-app-surface-2 px-1 py-0.5 font-mono text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
        pre: ({ children, ...props }) => (
          <pre
            className="mb-3 overflow-x-auto rounded-lg border border-app-border bg-app-surface-2 p-3 text-xs font-mono"
            {...props}
          >
            {children}
          </pre>
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
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

type HelpImageLightbox = { src: string; alt: string };

export default function HelpCenterDrawer({
  isOpen,
  onClose,
  openMode = "browse",
  initialTarget = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  openMode?: HelpCenterDrawerMode;
  initialTarget?: HelpCenterInitialTarget | null;
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
  const [searchFallbackActive, setSearchFallbackActive] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{
    manualId: string;
    slug: string;
  } | null>(null);

  const [manualList, setManualList] = useState<HelpManualListEntry[] | null>(null);
  const [helpListSource, setHelpListSource] = useState<"api" | "static">("static");
  const [markdownById, setMarkdownById] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [fullGuideBusy, setFullGuideBusy] = useState(false);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("browse");
  const [rosieSettings, setRosieSettings] = useState<RosieSettings>(() =>
    loadLocalRosieSettings(),
  );
  const [rosieMessages, setRosieMessages] = useState<RosiChatEntry[]>([]);
  const [rosieConversationMessages, setRosieConversationMessages] = useState<RosiChatEntry[]>([]);
  const [rosieQuestion, setRosieQuestion] = useState("");
  const [rosieConversationQuestion, setRosieConversationQuestion] = useState("");
  const [rosieBusy, setRosieBusy] = useState(false);
  const [rosieStatus, setRosieStatus] = useState<string | null>(null);
  const [rosieThinkingDots, setRosieThinkingDots] = useState(".");
  const [rosieListening, setRosieListening] = useState(false);
  const [rosieSpeaking, setRosieSpeaking] = useState(false);
  const [rosieChatSpeechEnabled, setRosieChatSpeechEnabled] = useState(false);
  const [rosieTranscriptPreview, setRosieTranscriptPreview] = useState("");
  const [voiceCapabilities, setVoiceCapabilities] = useState<RosieVoiceCapabilities>({
    speech_to_text_supported: false,
    text_to_speech_supported: false,
  });
  const voiceCaptureRef = useRef<RosieVoiceCaptureSession | null>(null);
  const speechPlaybackRef = useRef<RosieSpeechPlayback | null>(null);
  const rosieChatEndRef = useRef<HTMLDivElement | null>(null);
  const activeManualContentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setManualList(null);
      setMarkdownById({});
      setHelpListSource("static");
      setDrawerMode("browse");
      setRosieSettings(loadLocalRosieSettings());
      setRosieMessages([]);
      setRosieQuestion("");
      setRosieConversationQuestion("");
      setRosieBusy(false);
      setRosieStatus(null);
      setRosieThinkingDots(".");
      setRosieChatSpeechEnabled(false);
      voiceCaptureRef.current?.stop();
      voiceCaptureRef.current = null;
      speechPlaybackRef.current?.stop();
      speechPlaybackRef.current = null;
      stopRosieSpeechPlayback({ headers: apiAuth() as Record<string, string> });
      setRosieListening(false);
      setRosieSpeaking(false);
      setRosieTranscriptPreview("");
      return;
    }
    setDrawerMode(openMode);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/help/manuals`, { headers: apiAuth() });
        if (!res.ok) throw new Error("help manuals");
        const j = (await res.json()) as { manuals?: HelpManualListEntry[] };
        const list = j.manuals ?? [];
        if (cancelled) return;
        if (list.length === 0) throw new Error("empty");
        setManualList(orderHelpManuals(list));
        setHelpListSource("api");
      } catch {
        if (cancelled) return;
        const fallback = [...HELP_MANUALS]
          .filter((m) => !isDraftHelpMarkdown(m.markdown))
          .map((m) => ({
            id: m.id,
            title: m.title,
            summary: m.summary ?? "",
            order: 100,
          }));
        setManualList(orderHelpManuals(fallback));
        setHelpListSource("static");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, apiAuth, openMode]);

  useEffect(() => {
    if (!isOpen || !initialTarget) return;
    setDrawerMode("browse");
    setSearchQ(initialTarget.query);
    setDebouncedQ(initialTarget.query);
    setActiveManualId(initialTarget.manualId);
    setResultRows(null);
    setScrollTarget({
      manualId: initialTarget.manualId,
      slug: initialTarget.sectionSlug,
    });
  }, [initialTarget, isOpen]);

  useEffect(() => {
    if (!rosieBusy) {
      setRosieThinkingDots(".");
      return;
    }
    const frames = [".", "..", "...", "...."];
    let index = 0;
    const timer = window.setInterval(() => {
      index = (index + 1) % frames.length;
      setRosieThinkingDots(frames[index]);
    }, 320);
    return () => window.clearInterval(timer);
  }, [rosieBusy]);

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
            [activeManualId]: cleanHelpMarkdownForDisplay(stripYamlFrontMatter(m.markdown)),
          }));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, helpListSource, activeManualId, apiAuth, markdownById]);

  useEffect(() => {
    if (!isOpen) return;
    const settings = loadLocalRosieSettings();
    setRosieSettings(settings);
    setRosieChatSpeechEnabled(Boolean(settings.voice_enabled && settings.speak_responses));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void getRosieVoiceCapabilities({
      headers: apiAuth() as Record<string, string>,
    }).then((capabilities) => {
      if (!cancelled) {
        setVoiceCapabilities(capabilities);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, apiAuth]);

  useEffect(() => {
    return () => {
      voiceCaptureRef.current?.stop();
      voiceCaptureRef.current = null;
      speechPlaybackRef.current?.stop();
      speechPlaybackRef.current = null;
      stopRosieSpeechPlayback({ headers: apiAuth() as Record<string, string> });
    };
  }, [apiAuth]);

  const effectiveList = manualList ?? [];
  const activeEntry = effectiveList.find((x) => x.id === activeManualId);
  const activeTitle =
    activeEntry?.title ?? helpManualById(activeManualId)?.title ?? activeManualId;
  const activeDisplayTitle = formatHelpDisplayTitle(activeTitle);
  const displayMarkdown = useMemo(() => {
    if (helpListSource === "api") {
      const c = markdownById[activeManualId];
      if (c) return cleanHelpMarkdownForDisplay(c);
      return "";
    }
    const m = helpManualById(activeManualId);
    return m ? cleanHelpMarkdownForDisplay(stripYamlFrontMatter(m.markdown)) : "";
  }, [helpListSource, markdownById, activeManualId]);

  const { activeManual, toc } = useMemo(() => {
    const manual =
      activeManualId !== ""
        ? { id: activeManualId, title: activeTitle, markdown: displayMarkdown }
        : null;
    const tableOfContents =
      manual && displayMarkdown ? parseHelpToc(displayMarkdown, manual.title) : [];
    return { activeManual: manual, toc: tableOfContents };
  }, [activeManualId, activeTitle, displayMarkdown]);

  const printViewedHelp = useCallback(() => {
    if (!activeManual || !displayMarkdown || !activeManualContentRef.current) return;
    const printWindow = window.open("", "_blank", "width=900,height=1100");
    if (!printWindow) return;

    const contentHtml = activeManualContentRef.current.innerHTML;
    writeAndPrintDocumentWindow(printWindow, `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
      <title>${escapePrintHtml(activeDisplayTitle)}</title>
  <style>
    body {
      margin: 0;
      background: #ffffff;
      color: #111827;
      font-family: Inter, Arial, sans-serif;
      line-height: 1.5;
    }
    main {
      max-width: 780px;
      margin: 0 auto;
      padding: 32px 36px;
    }
    h1, h2, h3 {
      break-after: avoid;
      color: #111827;
      letter-spacing: 0;
    }
    h1 {
      margin: 0 0 20px;
      font-size: 28px;
    }
    h2 {
      margin-top: 28px;
      font-size: 20px;
    }
    h3 {
      margin-top: 20px;
      font-size: 16px;
    }
    p, li {
      font-size: 13px;
    }
    img {
      max-width: 100%;
      height: auto;
      border: 1px solid #d1d5db;
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 6px 8px;
      text-align: left;
    }
    pre, code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    pre {
      white-space: pre-wrap;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 12px;
    }
    a {
      color: #111827;
      text-decoration: underline;
    }
    button {
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      text-align: left;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapePrintHtml(activeDisplayTitle)}</h1>
    ${contentHtml}
  </main>
</body>
</html>`);
  }, [activeManual, activeDisplayTitle, displayMarkdown]);

  const printFullHelpGuide = useCallback(async () => {
    if (fullGuideBusy) return;
    setFullGuideBusy(true);
    try {
      const listRes = await fetch(`${baseUrl}/api/help/manuals`, { headers: apiAuth() });
      if (!listRes.ok) throw new Error(`Help catalog failed: HTTP ${listRes.status}`);
      const listJson = (await listRes.json()) as { manuals?: HelpManualListEntry[] };
      const manuals = orderHelpManuals(listJson.manuals ?? []);
      if (manuals.length === 0) throw new Error("The live Help catalog returned no manuals.");

      const detailRows = await Promise.all(
        manuals.map(async (manual) => {
          const detailRes = await fetch(
            `${baseUrl}/api/help/manuals/${encodeURIComponent(manual.id)}`,
            { headers: apiAuth() },
          );
          if (!detailRes.ok) {
            throw new Error(`${formatHelpDisplayTitle(manual.title)} failed: HTTP ${detailRes.status}`);
          }
          const detail = (await detailRes.json()) as { title?: string; markdown?: string };
          return {
            id: manual.id,
            title: detail.title ?? manual.title,
            markdown: detail.markdown ?? "",
          };
        }),
      );

      const printWindow = window.open("", "_blank", "width=1000,height=1200");
      if (!printWindow) throw new Error("Could not open the print window.");
      writeAndPrintDocumentWindow(printWindow, fullHelpGuideHtml(detailRows));
    } catch (error) {
      setRosieStatus(
        error instanceof Error
          ? error.message
          : "Could not build the full Help Guide for printing.",
      );
    } finally {
      setFullGuideBusy(false);
    }
  }, [apiAuth, fullGuideBusy]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(searchQ.trim()), 320);
    return () => window.clearTimeout(t);
  }, [searchQ]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQ("");
      setDebouncedQ("");
      setResultRows(null);
      setSearchFallbackActive(false);
      setScrollTarget(null);
      setImageLightbox(null);
      return;
    }
    if (debouncedQ.length < 2) {
      setResultRows(null);
      setSearchFallbackActive(false);
      setSearchBusy(false);
      return;
    }

    let cancelled = false;
    setSearchBusy(true);

    const run = async () => {
      let apiHits: ApiHit[] = [];
      let searchUnavailable = false;
      try {
        const res = await fetch(
          `${baseUrl}/api/help/search?q=${encodeURIComponent(debouncedQ)}&limit=12`,
          { headers: apiAuth() },
        );
        if (res.ok) {
          const j = (await res.json()) as HelpSearchResponse;
          apiHits = j.hits ?? [];
          searchUnavailable = j.search_mode === "unavailable";
        } else {
          searchUnavailable = true;
        }
      } catch {
        searchUnavailable = true;
      }
      if (cancelled) return;

      setResultRows(apiHits.map((h) => ({ ...h, source: "api" as const })));
      setSearchFallbackActive(searchUnavailable);
      setSearchBusy(false);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, isOpen, apiAuth]);

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
    const container = activeManualContentRef.current;
    if (el && container) {
      const top =
        container.scrollTop +
        el.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        8;
      container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
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

  const scrollToSource = useCallback(
    (source: RosieHelpGroundingSource) => {
      if (source.kind !== "manual" || !source.manual_id || !source.section_slug) {
        return;
      }
      setDrawerMode("browse");
      scrollToSection(source.manual_id, source.section_slug);
    },
    [scrollToSection],
  );

  const activeRosieMode = drawerMode === "conversation" ? "conversation" : "help";
  const activeRosieMessages =
    activeRosieMode === "conversation" ? rosieConversationMessages : rosieMessages;
  const hasStreamingRosieMessage = activeRosieMessages.some((message) => message.streaming);
  const activeRosieContentLength = activeRosieMessages
    .map((message) => `${message.id}:${message.content.length}`)
    .join("|");
  const activeRosieQuestion =
    activeRosieMode === "conversation" ? rosieConversationQuestion : rosieQuestion;
  const activeRosieInputId =
    activeRosieMode === "conversation"
      ? "help-center-rosie-conversation-input"
      : "help-center-ask-rosie-input";

  const buildRosieClientContext = useCallback(
    (mode: "help" | "conversation") => {
      const sourceMessages = mode === "conversation" ? rosieConversationMessages : rosieMessages;
      const lastUser = [...sourceMessages].reverse().find((message) => message.role === "user");
      const lastAssistant = [...sourceMessages]
        .reverse()
        .find((message) => message.role === "assistant" && message.content.trim());
      const href = typeof window === "undefined" ? "" : window.location.href;
      const uuids = href.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ) ?? [];

      return {
        current_surface:
          mode === "conversation"
            ? "Help Center ROSIE Chat"
            : activeManual
              ? `Help Center: ${activeManual.title}`
              : "Help Center",
        active_manual_id: activeManual?.id,
        active_manual_title: activeManual?.title,
        active_customer_id: href.includes("customer") ? uuids[0] : undefined,
        active_transaction_id:
          href.includes("transaction") || href.includes("order") ? uuids[0] : undefined,
        active_inventory_variant_id:
          href.includes("inventory") || href.includes("variant") || href.includes("sku")
            ? uuids[0]
            : undefined,
        last_user_question: lastUser?.content.slice(0, 240),
        last_assistant_summary: lastAssistant
          ? markdownToSpeechText(lastAssistant.content).slice(0, 320)
          : undefined,
      };
    },
    [activeManual, rosieConversationMessages, rosieMessages],
  );

  useEffect(() => {
    if (!isOpen || drawerMode === "browse") return;
    rosieChatEndRef.current?.scrollIntoView({ block: "end" });
  }, [isOpen, drawerMode, activeRosieMessages.length, activeRosieContentLength, rosieBusy]);

  const handleRosieSuggestedAction = useCallback((action: RosieSuggestedAction) => {
    const prompt = action.target.startsWith("voice:")
      ? `${action.label}: ${action.description}`
      : `Help me with ${action.label}. ${action.description}`;
    setDrawerMode("conversation");
    setRosieConversationQuestion(prompt);
    setRosieStatus(`Ready: ${action.label}`);
  }, []);

  const stopRosieSpeaking = useCallback(() => {
    speechPlaybackRef.current?.stop();
    speechPlaybackRef.current = null;
    stopRosieSpeechPlayback({ headers: apiAuth() as Record<string, string> });
    setRosieSpeaking(false);
  }, [apiAuth]);

  const submitRosieQuestion = useCallback(async (
    questionOverride?: string,
    modeOverride?: "help" | "conversation",
  ) => {
    const mode = modeOverride ?? activeRosieMode;
    const question = (
      questionOverride ??
      (mode === "conversation" ? rosieConversationQuestion : rosieQuestion)
    ).trim();
    if (!question || rosieBusy) return;

    if (!rosieSettings.enabled) {
      setRosieStatus(
        "ROSIE is turned off for this station. Turn it on in Settings.",
      );
      return;
    }

    setRosieBusy(true);
    setRosieStatus(null);
    stopRosieSpeaking();
    const userEntry: RosiChatEntry = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question,
    };
    const assistantId = `assistant-${Date.now() + 1}`;
    const assistantEntry: RosiChatEntry = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
      transparency: mode === "conversation" ? "grounded-conversation" : "grounded-help",
    };
    const setAssistantMessage = (patch: Partial<RosiChatEntry>) => {
      const update = (message: RosiChatEntry) =>
        message.id === assistantId ? { ...message, ...patch } : message;
      if (mode === "conversation") {
        setRosieConversationMessages((prev) => prev.map(update));
      } else {
        setRosieMessages((prev) => prev.map(update));
      }
    };
    if (mode === "conversation") {
      setRosieConversationMessages((prev) => [...prev, userEntry, assistantEntry]);
      setRosieConversationQuestion("");
    } else {
      setRosieMessages((prev) => [...prev, userEntry, assistantEntry]);
      setRosieQuestion("");
    }

    try {
      const groundedRequest: RosieGroundedHelpRequest = {
        question,
        mode,
        settings: {
          enabled: rosieSettings.enabled,
          response_style: rosieSettings.response_style,
          show_citations: rosieSettings.show_citations,
        },
        client_context: buildRosieClientContext(mode),
      };
      const result = await askRosieGroundedHelpStream(groundedRequest, {
        headers: apiAuth() as Record<string, string>,
        on_context: (context) => {
          setAssistantMessage({
            sources: context.sources,
            suggestedActions: context.suggested_actions,
          });
        },
        on_delta: (delta) => {
          const update = (message: RosiChatEntry) =>
            message.id === assistantId
              ? { ...message, content: `${message.content}${delta}` }
              : message;
          if (mode === "conversation") {
            setRosieConversationMessages((prev) => prev.map(update));
          } else {
            setRosieMessages((prev) => prev.map(update));
          }
        },
      });
      const answer = result.answer;
      setAssistantMessage({
        content: result.answer,
        sources: result.sources,
        suggestedActions: result.suggested_actions,
        transparency: mode === "conversation" ? "grounded-conversation" : "grounded-help",
        streaming: false,
      });
      const shouldSpeakResponse =
        rosieSettings.voice_enabled &&
        (mode === "conversation" ? rosieChatSpeechEnabled : rosieSettings.speak_responses);
      if (shouldSpeakResponse) {
        const speechText = markdownToSpeechText(answer);
        const spokenText =
          mode === "conversation" && speechText.length > 700
            ? `${speechText.slice(0, 520).trim()}...`
            : speechText;
        if (spokenText) {
          speechPlaybackRef.current = speakRosieText(spokenText, {
            rate: rosieSettings.speech_rate,
            voice: rosieSettings.selected_voice,
            headers: apiAuth() as Record<string, string>,
            on_start: () => setRosieSpeaking(true),
            on_end: () => {
              speechPlaybackRef.current = null;
              setRosieSpeaking(false);
            },
            on_error: (message) => {
              speechPlaybackRef.current = null;
              setRosieSpeaking(false);
              setRosieStatus(message);
            },
          });
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ROSIE is unavailable right now.";
      const unavailable =
        /Host LLM service could not be reached|upstream request failed|upstream is unavailable/i.test(
          message,
        )
          ? "ROSIE is unavailable right now. The Host LLM service could not be reached."
          : /disabled|not configured|failed to reach local ROSIE runtime/i.test(message)
            ? "ROSIE is unavailable right now. The local ROSIE runtime is not running or is misconfigured."
          : message;
      setRosieStatus(unavailable);
      setAssistantMessage({
        content: unavailable,
        error: true,
        streaming: false,
      });
    } finally {
      setRosieBusy(false);
    }
  }, [
    activeRosieMode,
    apiAuth,
    buildRosieClientContext,
    rosieBusy,
    rosieConversationQuestion,
    rosieQuestion,
    rosieSettings,
    rosieChatSpeechEnabled,
    stopRosieSpeaking,
  ]);

  const startRosieListening = useCallback(() => {
    if (rosieBusy) return;
    if (!rosieSettings.enabled) {
      setRosieStatus(
        "ROSIE is turned off for this station. Turn it on in Settings.",
      );
      return;
    }
    if (!rosieSettings.voice_enabled || !rosieSettings.microphone_enabled) {
      setRosieStatus(
        "Voice is turned off for this station. Turn it on in Settings.",
      );
      return;
    }
    if (activeRosieMode !== "conversation" && !voiceCapabilities.speech_to_text_supported) {
      setRosieStatus(
        "Voice is unavailable on this station. Type your question instead.",
      );
      return;
    }

    voiceCaptureRef.current?.stop();
    voiceCaptureRef.current = null;
    stopRosieSpeaking();
    setRosieStatus(null);
    setRosieTranscriptPreview("");

    try {
      voiceCaptureRef.current = startRosieVoiceCapture({
        on_start: () => {
          setRosieListening(true);
          setRosieStatus("Recording a ROSIE question locally. Press Stop when you are done.");
        },
        on_partial_transcript: (value) => {
          setRosieTranscriptPreview(value);
        },
        on_final_transcript: (value) => {
          setRosieTranscriptPreview(value);
          if (activeRosieMode === "conversation") {
            setRosieConversationQuestion(value);
          } else {
            setRosieQuestion(value);
          }
          void submitRosieQuestion(value, activeRosieMode);
        },
        on_error: (message) => {
          setRosieStatus(message);
        },
        on_end: () => {
          voiceCaptureRef.current = null;
          setRosieListening(false);
        },
      }, {
        headers: apiAuth() as Record<string, string>,
      });
    } catch (error) {
      setRosieListening(false);
      setRosieStatus(
        error instanceof Error
          ? error.message
          : "Voice is unavailable on this station. Type your question instead.",
      );
    }
  }, [
    apiAuth,
    activeRosieMode,
    rosieBusy,
    rosieSettings.enabled,
    rosieSettings.voice_enabled,
    rosieSettings.microphone_enabled,
    stopRosieSpeaking,
    submitRosieQuestion,
    voiceCapabilities.speech_to_text_supported,
  ]);

  const stopRosieListening = useCallback(() => {
    voiceCaptureRef.current?.stop();
    voiceCaptureRef.current = null;
    setRosieListening(false);
    setRosieStatus((current) =>
      current === "Recording a ROSIE question locally. Press Stop when you are done."
        ? "Transcribing your local ROSIE recording…"
        : current,
    );
  }, []);

  const conversationModeActive = activeRosieMode === "conversation";
  const drawerModeCopy = DRAWER_MODE_COPY[drawerMode];
  const drawerTitle =
    drawerMode === "browse" ? (
      drawerModeCopy.title
    ) : (
      <span className="inline-flex items-center gap-3">
        <RosieIcon size={34} alt="" />
        <span>{drawerModeCopy.title}</span>
      </span>
    );

  return (
    <>
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={drawerTitle}
      panelMaxClassName={drawerMode === "conversation" ? "max-w-5xl" : "max-w-3xl"}
      noPadding
      contentContained
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-3 border-b border-app-border bg-app-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerMode("browse")}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-widest transition-colors ${
                drawerMode === "browse"
                  ? "bg-app-accent text-white"
                  : "border border-app-border bg-app-surface-2 text-app-text"
              }`}
            >
              <CircleHelp size={14} aria-hidden />
              Help Library
            </button>
            <button
              type="button"
              onClick={() => setDrawerMode("ask")}
              data-testid="help-center-ask-rosie-tab"
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-widest transition-colors ${
                drawerMode === "ask"
                  ? "bg-app-accent text-white"
                  : "border border-app-border bg-app-surface-2 text-app-text"
              }`}
            >
              <RosieIcon size={14} alt="" />
              Ask ROSIE
            </button>
            <button
              type="button"
              onClick={() => setDrawerMode("conversation")}
              data-testid="help-center-rosie-conversation-tab"
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-widest transition-colors ${
                drawerMode === "conversation"
                  ? "bg-app-accent text-white"
                  : "border border-app-border bg-app-surface-2 text-app-text"
              }`}
            >
              <RosieIcon size={14} alt="" />
              ROSIE Chat
            </button>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-bold text-app-text">{drawerModeCopy.lead}</p>
            <p className="text-xs font-medium leading-relaxed text-app-text-muted">
              {drawerModeCopy.detail}
            </p>
          </div>
          {drawerMode === "browse" ? (
            <>
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
          <div className="flex flex-wrap items-center gap-2">
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
                    {formatHelpDisplayTitle(m.title)}
                  </option>
                ))}
              </select>
            ) : null}
            {(!resultRows || resultRows.length === 0) && activeManual && displayMarkdown ? (
              <button
                type="button"
                data-testid="help-center-print-current"
                onClick={printViewedHelp}
                className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-border/20"
              >
                <Printer size={14} aria-hidden />
                Print This Manual
              </button>
            ) : null}
            {effectiveList.length > 0 ? (
              <button
                type="button"
                data-testid="help-center-print-full-guide"
                onClick={() => void printFullHelpGuide()}
                disabled={fullGuideBusy}
                className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-border/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <BookOpen size={14} aria-hidden />
                {fullGuideBusy ? "Building Guide..." : "Print Full Guide"}
              </button>
            ) : null}
          </div>
          {manualList === null && isOpen ? (
            <p className="text-xs text-app-text-muted">Loading manuals…</p>
          ) : null}
          {helpListSource === "static" && manualList !== null ? (
            <p className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-xs font-medium text-app-warning">
              Using bundled manuals because the live help catalog is unavailable.
            </p>
          ) : null}
          {helpListSource === "api" && detailLoading && !displayMarkdown ? (
            <p className="text-xs text-app-text-muted">Loading article…</p>
          ) : null}
          {searchFallbackActive ? (
            <p className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-xs font-medium text-app-warning">
              Help search is unavailable. Meilisearch should be running on this station before staff use Help search or ROSIE grounding.
            </p>
          ) : null}
            </>
          ) : (
            <div className="space-y-2">
              {!rosieSettings.enabled ? (
                <p className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-xs font-medium text-app-warning">
                  ROSIE is turned off for this station. Turn it on in Settings to use chat or help.
                </p>
              ) : null}
              {drawerMode !== "conversation" &&
              rosieSettings.enabled &&
              !voiceCapabilities.speech_to_text_supported ? (
                <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-medium text-app-text-muted">
                  Voice is only shown when this station can use speech input.
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          {drawerMode !== "browse" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div
                className={`min-h-0 flex-1 overflow-y-auto ${
                  conversationModeActive ? "px-4 py-5 sm:px-8" : "px-4 py-4"
                }`}
                data-testid={
                  conversationModeActive
                    ? "help-center-rosie-conversation-thread"
                    : undefined
                }
              >
                {activeRosieMessages.length === 0 ? (
                  <div
                    className={`border border-app-border bg-app-surface-2 ${
                      conversationModeActive
                        ? "mx-auto mt-6 max-w-2xl rounded-3xl p-6 text-center"
                        : "rounded-2xl p-4"
                    }`}
                  >
                    <span
                      className={`flex h-12 w-12 items-center justify-center rounded-2xl border border-app-border bg-app-surface ${
                        conversationModeActive ? "mx-auto mb-4" : "mb-3"
                      }`}
                    >
                      <RosieIcon size={28} alt="" />
                    </span>
                    <p className="text-sm font-semibold text-app-text">
                      {conversationModeActive
                        ? "Start a ROSIE Chat."
                        : "Ask ROSIE a focused help question."}
                    </p>
                    <p className="mt-2 text-sm text-app-text-muted">
                      {conversationModeActive
                        ? "Use chat for follow-up questions, voice input, and broader Riverside workflow context."
                        : "Use Ask ROSIE for sourced answers from Help Library manuals."}
                    </p>
                  </div>
                ) : (
                  <div
                    className={`space-y-4 ${
                      conversationModeActive ? "mx-auto max-w-4xl" : ""
                    }`}
                  >
                    {activeRosieMessages.map((message) => (
                      <div
                        key={message.id}
                        className={`rounded-2xl border p-4 shadow-sm ${
                          message.role === "user"
                            ? conversationModeActive
                              ? "ml-auto max-w-[82%] border-app-accent/30 bg-app-accent text-white"
                              : "ml-8 border-app-accent/30 bg-app-accent/10"
                            : message.error
                              ? conversationModeActive
                                ? "mr-auto max-w-[88%] border-app-warning/20 bg-app-warning/10"
                                : "mr-8 border-app-warning/20 bg-app-warning/10"
                              : conversationModeActive
                                ? "mr-auto max-w-[88%] border-app-border bg-app-surface-2"
                                : "mr-8 border-app-border bg-app-surface-2"
                        }`}
                      >
                        <p
                          className={`mb-2 text-[10px] font-black uppercase tracking-widest ${
                            conversationModeActive && message.role === "user"
                              ? "text-white/70"
                              : "text-app-text-muted"
                          }`}
                        >
                          {message.role === "user" ? "You" : "ROSIE"}
                        </p>
                        {message.role === "assistant" ? (
                          <div className="help-center-prose text-sm text-app-text">
                            {message.streaming && !message.content ? (
                              <div className="flex items-center gap-2 font-medium">
                                <RosieIcon size={16} alt="" />
                                <span>Thinking{rosieThinkingDots}</span>
                              </div>
                            ) : (
                              <RosieAnswerBody markdown={message.content} />
                            )}
                          </div>
                        ) : (
                          <p
                            className={`text-sm ${
                              conversationModeActive ? "text-white" : "text-app-text"
                            }`}
                          >
                            {message.content}
                          </p>
                        )}
                        {message.role === "assistant" && !message.error && !message.streaming ? (
                          <p className="mt-3 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[11px] font-medium text-app-text-muted">
                            {message.transparency === "grounded-conversation"
                              ? "ROSIE used approved Riverside information when available. Voice follows ROSIE settings."
                              : "ROSIE used Riverside help content when available. Sources show what was used."}
                          </p>
                        ) : null}
                        {message.sources && message.sources.length > 0 && rosieSettings.show_citations ? (
                          <div className="mt-3 space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Sources
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {message.sources.map((source, index) => (
                                source.kind === "manual" ? (
                                  <button
                                    key={`${message.id}-src-${index}`}
                                    type="button"
                                    data-testid="help-center-rosie-source-chip"
                                    onClick={() => scrollToSource(source)}
                                    className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-xs font-medium text-app-text transition-colors hover:bg-app-border/20"
                                  >
                                    {source.title}
                                  </button>
                                ) : (
                                  <span
                                    key={`${message.id}-src-${index}`}
                                    data-testid="help-center-rosie-source-chip"
                                    className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-xs font-medium text-app-text"
                                  >
                                    {source.title}
                                  </span>
                                )
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {message.role === "assistant" &&
                        message.suggestedActions &&
                        message.suggestedActions.length > 0 ? (
                          <div className="mt-3 space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Suggested Actions
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {message.suggestedActions.slice(0, 4).map((action) => (
                                <button
                                  key={`${message.id}-action-${action.id}`}
                                  type="button"
                                  onClick={() => handleRosieSuggestedAction(action)}
                                  className="rounded-full border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-xs font-semibold text-app-accent transition-colors hover:border-app-accent/50 hover:bg-app-accent/15"
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {rosieBusy && !hasStreamingRosieMessage ? (
                      <div
                        className={`rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm ${
                          conversationModeActive ? "mr-auto max-w-[88%]" : "mr-8"
                        }`}
                      >
                        <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          ROSIE
                        </p>
                        <div className="flex items-center gap-2 text-sm font-medium text-app-text">
                          <RosieIcon size={16} alt="" />
                          <span>
                            Thinking{rosieThinkingDots}
                          </span>
                        </div>
                      </div>
                    ) : null}
                    <div ref={rosieChatEndRef} />
                  </div>
                )}
              </div>
              <div
                className={`shrink-0 border-t border-app-border bg-app-surface ${
                  conversationModeActive ? "px-4 py-4 sm:px-8" : "px-4 py-3"
                }`}
              >
                {rosieStatus ? (
                  <p className="ui-panel ui-tint-warning mb-3 px-3 py-2 text-xs font-medium text-app-text">
                    {rosieStatus}
                  </p>
                ) : null}
                {rosieTranscriptPreview ? (
                  <p
                    data-testid="help-center-ask-rosie-transcript-preview"
                    className="mb-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-medium text-app-text-muted"
                  >
                    Captured question: {rosieTranscriptPreview}
                  </p>
                ) : null}
                {rosieBusy ? (
                  <div className="mb-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-2 rounded-full border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-app-accent">
                      <RosieIcon size={12} alt="" />
                      Rosie is thinking{rosieThinkingDots}
                    </span>
                  </div>
                ) : null}
                {(rosieListening || rosieSpeaking) ? (
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {rosieListening ? (
                      <span
                        data-testid="help-center-ask-rosie-listening"
                        className="inline-flex items-center gap-2 rounded-full border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-app-accent"
                      >
                        <Mic size={12} aria-hidden />
                        Listening
                      </span>
                    ) : null}
                    {rosieSpeaking ? (
                      <span
                        data-testid="help-center-ask-rosie-speaking"
                        className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface-2 px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-app-text"
                      >
                        <Volume2 size={12} aria-hidden />
                        Speaking
                      </span>
                    ) : null}
                    <button
                      type="button"
                      data-testid="help-center-ask-rosie-stop-audio"
                      onClick={() => {
                        stopRosieListening();
                        stopRosieSpeaking();
                      }}
                      className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-border/15"
                    >
                      <Square size={12} aria-hidden />
                      Stop
                    </button>
                  </div>
                ) : null}
                {conversationModeActive ? (
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-medium text-app-text-muted">
                      ROSIE can use approved Riverside help, store notes, and available ROS data.
                    </p>
                    {rosieSettings.voice_enabled && voiceCapabilities.text_to_speech_supported ? (
                      <button
                        type="button"
                        onClick={() => {
                          const next = !rosieChatSpeechEnabled;
                          if (!next) stopRosieSpeaking();
                          setRosieChatSpeechEnabled(next);
                        }}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-widest transition-colors ${
                          rosieChatSpeechEnabled
                            ? "border-app-accent/40 bg-app-accent/10 text-app-accent"
                            : "border-app-border bg-app-surface-2 text-app-text-muted hover:text-app-text"
                        }`}
                        aria-pressed={rosieChatSpeechEnabled}
                      >
                        {rosieChatSpeechEnabled ? (
                          <Volume2 size={12} aria-hidden />
                        ) : (
                          <VolumeX size={12} aria-hidden />
                        )}
                        {rosieChatSpeechEnabled ? "Speech On" : "Speech Off"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div
                  className={`flex items-end gap-2 ${
                    conversationModeActive
                      ? "mx-auto max-w-4xl rounded-2xl border border-app-border bg-app-surface-2 p-2 shadow-sm"
                      : ""
                  }`}
                >
                  {rosieSettings.voice_enabled &&
                  rosieSettings.microphone_enabled &&
                  (conversationModeActive || voiceCapabilities.speech_to_text_supported) ? (
                    <button
                      type="button"
                      data-testid="help-center-ask-rosie-mic"
                      onClick={
                        rosieSettings.microphone_mode === "toggle"
                          ? () => {
                              if (rosieListening) {
                                stopRosieListening();
                              } else {
                                startRosieListening();
                              }
                            }
                          : undefined
                      }
                      onMouseDown={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? () => {
                              if (!rosieListening) {
                                startRosieListening();
                              }
                            }
                          : undefined
                      }
                      onMouseUp={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? () => {
                              if (rosieListening) {
                                stopRosieListening();
                              }
                            }
                          : undefined
                      }
                      onMouseLeave={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? () => {
                              if (rosieListening) {
                                stopRosieListening();
                              }
                            }
                          : undefined
                      }
                      onTouchStart={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? () => {
                              if (!rosieListening) {
                                startRosieListening();
                              }
                            }
                          : undefined
                      }
                      onTouchEnd={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? () => {
                              if (rosieListening) {
                                stopRosieListening();
                              }
                            }
                          : undefined
                      }
                      disabled={!rosieSettings.enabled || rosieBusy}
                      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${
                        conversationModeActive
                          ? rosieListening
                            ? "border-app-accent/40 bg-app-accent text-white"
                            : "border-app-border bg-app-surface text-app-text hover:bg-app-border/15"
                          : "border-app-border bg-app-surface-2 text-app-text hover:bg-app-border/15"
                      }`}
                      aria-label={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? "Hold to talk to ROSIE"
                          : rosieListening
                            ? "Stop ROSIE voice input"
                            : "Start ROSIE voice input"
                      }
                      title={
                        rosieSettings.microphone_mode === "push_to_talk"
                          ? "Hold to talk"
                          : rosieListening
                            ? "Stop voice input"
                            : "Start voice input"
                      }
                    >
                      <Mic size={18} aria-hidden />
                    </button>
                  ) : null}
                  <label className="sr-only" htmlFor={activeRosieInputId}>
                    {activeRosieMode === "conversation"
                      ? "ROSIE Chat"
                      : "Ask ROSIE"}
                  </label>
                  <textarea
                    id={activeRosieInputId}
                    data-testid={
                      activeRosieMode === "conversation"
                        ? "help-center-rosie-conversation-input"
                        : "help-center-ask-rosie-input"
                    }
                    value={activeRosieQuestion}
                    onChange={(e) => {
                      if (activeRosieMode === "conversation") {
                        setRosieConversationQuestion(e.target.value);
                      } else {
                        setRosieQuestion(e.target.value);
                      }
                      if (rosieTranscriptPreview) {
                        setRosieTranscriptPreview("");
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void submitRosieQuestion();
                      }
                    }}
                    disabled={!rosieSettings.enabled || rosieBusy}
                    placeholder={
                      rosieListening
                        ? "Listening for your question…"
                        : conversationModeActive
                          ? "Message ROSIE about workflows, reports, customers, inventory, or wedding orders…"
                          : "Ask about a workflow, policy, or how to use this screen…"
                    }
                    className={`ui-input flex-1 resize-none text-sm ${
                      conversationModeActive
                        ? "min-h-12 border-transparent bg-transparent shadow-none focus:border-transparent focus:ring-0"
                        : "min-h-24"
                    }`}
                  />
                  <button
                    type="button"
                    data-testid="help-center-ask-rosie-send"
                    onClick={() => void submitRosieQuestion()}
                    disabled={!rosieSettings.enabled || rosieBusy || activeRosieQuestion.trim().length < 2}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-app-accent text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Send question to ROSIE"
                  >
                    <SendHorizonal size={18} aria-hidden />
                  </button>
                </div>
              </div>
            </div>
          ) : resultRows && resultRows.length > 0 ? (
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
                      <p className="text-xs font-bold text-app-text">
                        {formatHelpDisplayTitle(row.manual_title)}
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-app-accent">
                        {formatHelpDisplayHeading(row.section_heading)}
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
                aria-label="Guide sections"
              >
                <p className="px-3 pb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Guide Sections
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
                        {formatHelpDisplayHeading(e.heading)}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
              <div
                ref={activeManualContentRef}
                className="help-center-prose min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm text-app-text"
              >
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
      aria-label="Open Help Library"
      title="Help Library"
    >
      <CircleHelp size={18} strokeWidth={2} aria-hidden />
    </button>
  );
}

export function RosieTriggerButton({
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
      data-testid="help-center-ask-rosie-trigger"
      className={`relative inline-flex touch-manipulation items-center justify-center rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text shadow-sm transition-colors hover:bg-app-border/20 ${className}`.trim()}
      aria-label="Open ROSIE Chat"
      title="ROSIE Chat"
    >
      <RosieIcon size={18} alt="" />
    </button>
  );
}
