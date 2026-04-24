import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Bot, CircleHelp, MessagesSquare, Mic, SendHorizonal, Square, Volume2, X } from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
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
import {
  askRosieGroundedHelp,
  getRosieVoiceCapabilities,
  loadLocalRosieSettings,
  speakRosieText,
  startRosieVoiceCapture,
  stopRosieSpeechPlayback,
  type RosieGroundedHelpRequest,
  type RosieHelpGroundingSource,
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
  transparency?: "grounded-help" | "grounded-conversation";
  error?: boolean;
};

type DrawerMode = "browse" | "ask" | "conversation";

export type HelpCenterDrawerMode = DrawerMode;

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
    .replace(/^[>*-]\s+/gm, "")
    .replace(/#+\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
}: {
  isOpen: boolean;
  onClose: () => void;
  openMode?: HelpCenterDrawerMode;
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
  const [rosieTranscriptPreview, setRosieTranscriptPreview] = useState("");
  const [voiceCapabilities, setVoiceCapabilities] = useState<RosieVoiceCapabilities>({
    speech_to_text_supported: false,
    text_to_speech_supported: false,
  });
  const voiceCaptureRef = useRef<RosieVoiceCaptureSession | null>(null);
  const speechPlaybackRef = useRef<RosieSpeechPlayback | null>(null);
  const rosieChatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setManualList(null);
      setMarkdownById({});
      setHelpListSource("static");
      setDrawerMode("browse");
      setRosieSettings(loadLocalRosieSettings());
      setRosieMessages([]);
      setRosieConversationMessages([]);
      setRosieQuestion("");
      setRosieConversationQuestion("");
      setRosieBusy(false);
      setRosieStatus(null);
      setRosieThinkingDots(".");
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
  }, [isOpen, apiAuth, openMode]);

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
  }, [isOpen, helpListSource, activeManualId, apiAuth, markdownById]);

  useEffect(() => {
    if (!isOpen) return;
    setRosieSettings(loadLocalRosieSettings());
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

  const { activeManual, toc } = useMemo(() => {
    const manual =
      activeManualId !== ""
        ? { id: activeManualId, title: activeTitle, markdown: displayMarkdown }
        : null;
    const tableOfContents =
      manual && displayMarkdown ? parseHelpToc(displayMarkdown, manual.title) : [];
    return { activeManual: manual, toc: tableOfContents };
  }, [activeManualId, activeTitle, displayMarkdown]);

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
      let serverSearchMode: HelpSearchResponse["search_mode"] = "meilisearch";
      try {
        const res = await fetch(
          `${baseUrl}/api/help/search?q=${encodeURIComponent(debouncedQ)}&limit=12`,
          { headers: apiAuth() },
        );
        if (res.ok) {
          const j = (await res.json()) as HelpSearchResponse;
          apiHits = j.hits ?? [];
          serverSearchMode = j.search_mode ?? "meilisearch";
        }
      } catch {
        serverSearchMode = "unavailable";
      }
      if (cancelled) return;

      if (apiHits.length > 0) {
        setResultRows(apiHits.map((h) => ({ ...h, source: "api" as const })));
        setSearchFallbackActive(false);
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
      setSearchFallbackActive(serverSearchMode === "unavailable" && local.length > 0);
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
  const activeRosieQuestion =
    activeRosieMode === "conversation" ? rosieConversationQuestion : rosieQuestion;
  const activeRosieInputId =
    activeRosieMode === "conversation"
      ? "help-center-rosie-conversation-input"
      : "help-center-ask-rosie-input";

  useEffect(() => {
    if (!isOpen || drawerMode === "browse") return;
    rosieChatEndRef.current?.scrollIntoView({ block: "end" });
  }, [isOpen, drawerMode, activeRosieMessages.length, rosieBusy]);

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
        "ROSIE is disabled for this workstation. Turn it on in Settings -> ROSIE.",
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
    if (mode === "conversation") {
      setRosieConversationMessages((prev) => [...prev, userEntry]);
      setRosieConversationQuestion("");
    } else {
      setRosieMessages((prev) => [...prev, userEntry]);
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
      };
      const result = await askRosieGroundedHelp(groundedRequest, {
        headers: apiAuth() as Record<string, string>,
      });
      const answer = result.answer;
      if (mode === "conversation") {
        setRosieConversationMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: result.answer,
            sources: result.sources,
            transparency: "grounded-conversation",
          },
        ]);
      } else {
        setRosieMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: result.answer,
            sources: result.sources,
            transparency: "grounded-help",
          },
        ]);
      }
      const shouldSpeakResponse =
        rosieSettings.voice_enabled &&
        (mode === "conversation" || rosieSettings.speak_responses);
      if (shouldSpeakResponse) {
        const speechText = markdownToSpeechText(answer);
        const spokenText =
          mode === "conversation" && speechText.length > 700
            ? `${speechText.slice(0, 700).trim()}...`
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
      if (mode === "conversation") {
        setRosieConversationMessages((prev) => [
          ...prev,
          {
            id: `assistant-error-${Date.now()}`,
            role: "assistant",
            content: unavailable,
            error: true,
          },
        ]);
      } else {
        setRosieMessages((prev) => [
          ...prev,
          {
            id: `assistant-error-${Date.now()}`,
            role: "assistant",
            content: unavailable,
            error: true,
          },
        ]);
      }
    } finally {
      setRosieBusy(false);
    }
  }, [
    activeRosieMode,
    apiAuth,
    rosieBusy,
    rosieConversationQuestion,
    rosieQuestion,
    rosieSettings,
    stopRosieSpeaking,
  ]);

  const startRosieListening = useCallback(() => {
    if (rosieBusy) return;
    if (!rosieSettings.enabled) {
      setRosieStatus(
        "ROSIE is disabled for this workstation. Turn it on in Settings -> ROSIE.",
      );
      return;
    }
    if (!rosieSettings.voice_enabled || !rosieSettings.microphone_enabled) {
      setRosieStatus(
        "Voice input is turned off for this workstation. Enable it in Settings -> ROSIE.",
      );
      return;
    }
    if (activeRosieMode !== "conversation" && !voiceCapabilities.speech_to_text_supported) {
      setRosieStatus(
        "Voice input is unavailable because this workstation could not reach the host ROSIE speech stack. Use the text box to ask ROSIE.",
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
          : "Voice input is unavailable because this workstation could not reach the host ROSIE speech stack.",
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

  return (
    <>
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={drawerMode === "conversation" ? "ROSIE Chat" : "Help"}
      panelMaxClassName={drawerMode === "conversation" ? "max-w-5xl" : "max-w-3xl"}
      noPadding
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-3 border-b border-app-border bg-app-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerMode("browse")}
              className={`rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-widest transition-colors ${
                drawerMode === "browse"
                  ? "bg-app-text text-white"
                  : "border border-app-border bg-app-surface-2 text-app-text"
              }`}
            >
              Browse
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
              <Bot size={14} aria-hidden />
              Help Mode
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
              <MessagesSquare size={14} aria-hidden />
              Conversation (voice)
            </button>
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
          {helpListSource === "static" ? (
            <p className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-xs font-medium text-app-warning">
              Using bundled manuals because the live help catalog is unavailable.
            </p>
          ) : null}
          {helpListSource === "api" && detailLoading && !displayMarkdown ? (
            <p className="text-xs text-app-text-muted">Loading article…</p>
          ) : null}
          {searchFallbackActive ? (
            <p className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-xs font-medium text-app-warning">
              Server search is unavailable, so results are coming from bundled manual content on this station.
            </p>
          ) : null}
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-app-text-muted">
                {drawerMode === "conversation"
                  ? "Talk with ROSIE using the same governed RiversideOS intelligence, store context, and approved tools."
                  : "Ask ROSIE for grounded Help Center guidance using visible manuals and your store playbook when available."}
              </p>
              <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-medium text-app-text-muted">
                {drawerMode === "conversation"
                  ? "Mode: Conversation. Grounding: RiversideOS Help, store playbook, and approved operational tool results when available. Voice input and speech output follow ROSIE settings."
                  : "Mode: Help. Grounding: Help Center, store playbook, and approved operational tool results when available. Source chips show what ROSIE used."}
              </p>
              {!rosieSettings.enabled ? (
                <p className="rounded-xl border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-xs font-medium text-app-warning">
                  ROSIE is disabled for this workstation. Turn it on in Settings
                  -&gt; ROSIE to use Help Mode or Conversation Mode.
                </p>
              ) : null}
              {drawerMode !== "conversation" &&
              rosieSettings.enabled &&
              !voiceCapabilities.speech_to_text_supported ? (
                <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-medium text-app-text-muted">
                  Voice input is only shown when this workstation can reach the host ROSIE speech stack.
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
                    {conversationModeActive ? (
                      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-app-accent/30 bg-app-accent/10 text-app-accent">
                        <MessagesSquare size={22} aria-hidden />
                      </span>
                    ) : null}
                    <p className="text-sm font-semibold text-app-text">
                      {conversationModeActive
                        ? "Chat or speak with ROSIE."
                        : "Ask ROSIE about Help Center procedures."}
                    </p>
                    <p className="mt-2 text-sm text-app-text-muted">
                      {conversationModeActive
                        ? "Use ROSIE like a staff assistant for RiversideOS workflows and accessible store data. Responses stay on governed paths and show sources or tool context when available."
                        : "ROSIE is grounded to Help search results, manual sections, and your store playbook when available. Ask the question the way an operator would, then use source chips to open the referenced guidance."}
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
                            <RosieAnswerBody markdown={message.content} />
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
                        {message.role === "assistant" && !message.error ? (
                          <p className="mt-3 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[11px] font-medium text-app-text-muted">
                            {message.transparency === "grounded-conversation"
                              ? "Grounding: governed RiversideOS context. Tools: approved ROSIE context only when returned below. Voice behavior follows ROSIE settings."
                              : "Grounding: governed Help context. Tools: approved ROSIE context only when returned below. Source chips show what was used."}
                          </p>
                        ) : null}
                        {message.sources && message.sources.length > 0 && rosieSettings.show_citations ? (
                          <div className="mt-3 space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Grounded Sources
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
                      </div>
                    ))}
                    {rosieBusy ? (
                      <div
                        className={`rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm ${
                          conversationModeActive ? "mr-auto max-w-[88%]" : "mr-8"
                        }`}
                      >
                        <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          ROSIE
                        </p>
                        <div className="flex items-center gap-2 text-sm font-medium text-app-text">
                          <Bot size={16} className="text-app-accent" aria-hidden />
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
                  <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-100">
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
                      <Bot size={12} aria-hidden />
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
                  <p className="mb-2 text-[11px] font-medium text-app-text-muted">
                    Governed chat: ROSIE can use approved RiversideOS context and will show grounding when it is returned.
                  </p>
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
                      ? "Talk with ROSIE"
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
      aria-label="Open ROSIE Conversation"
      title="ROSIE Conversation"
    >
      <Bot size={18} strokeWidth={2} aria-hidden />
    </button>
  );
}
