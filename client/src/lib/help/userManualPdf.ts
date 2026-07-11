import { marked, type Token, type Tokens } from "marked";
import type { Content, ContentText, TDocumentDefinitions } from "pdfmake/interfaces";
import { formatHelpDisplayHeading, formatHelpDisplayTitle } from "./helpDisplay";
import { stripYamlFrontMatter } from "./helpFrontMatter";
import { resolveHelpImageSrc } from "./helpImages";

export const RIVERSIDE_USER_MANUAL_FILENAME = "RiversideOS-User-Manual.pdf";

export type RiversideUserManualProgress = {
  stage: "catalog" | "manuals" | "screenshots" | "pdf";
  completed: number;
  total: number;
  message: string;
};

export type RiversideUserManualBuild = {
  blob: Blob;
  generatedAt: Date;
  manualCount: number;
  screenshotCount: number;
  warningCount: number;
  warnings: string[];
  print: () => Promise<void>;
};

type HelpManualListEntry = {
  id: string;
  title: string;
  summary: string;
  order: number;
};

type HelpManualDetail = {
  id?: string;
  title?: string;
  markdown?: string;
};

type UserManualSource = {
  id: string;
  title: string;
  summary: string;
  order: number;
  markdown: string;
};

type PdfMakeDocument = {
  getBlob: () => Promise<Blob>;
  print: () => Promise<void>;
};

type PdfMakeRuntime = {
  addVirtualFileSystem: (files: Record<string, string>) => void;
  createPdf: (definition: TDocumentDefinitions) => PdfMakeDocument;
};

type InlineStyle = Pick<
  ContentText,
  "bold" | "italics" | "decoration" | "color" | "background" | "link" | "linkToDestination"
>;

type BuildContext = {
  images: Map<string, string>;
  warnings: string[];
};

let pdfRuntimePromise: Promise<PdfMakeRuntime> | null = null;

const PDF_ACRONYMS = new Map<string, string>([
  ["api", "API"],
  ["os", "OS"],
  ["pdf", "PDF"],
  ["pin", "PIN"],
  ["pos", "POS"],
  ["pwa", "PWA"],
  ["qbo", "QBO"],
  ["rms", "RMS"],
  ["rosie", "ROSIE"],
  ["sku", "SKU"],
  ["sop", "SOP"],
  ["sql", "SQL"],
]);

async function loadPdfRuntime(): Promise<PdfMakeRuntime> {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
    ]).then(([pdfModule, fontModule]) => {
      const runtime = ("default" in pdfModule ? pdfModule.default : pdfModule) as unknown as PdfMakeRuntime;
      const fonts = ("default" in fontModule ? fontModule.default : fontModule) as unknown as Record<
        string,
        string
      >;
      runtime.addVirtualFileSystem(fonts);
      return runtime;
    });
  }
  return pdfRuntimePromise;
}

function cleanMarkdown(markdown: string): string {
  return stripYamlFrontMatter(markdown)
    .replace(/<!--\s*help:component-source\s*-->[\s\S]*?<!--\s*\/help:component-source\s*-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

function normalizePdfSymbols(value: string): string {
  return value
    .replace(/→/g, "->")
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/✨/g, "")
    .replace(/[★☆]/g, "star");
}

function normalizePdfText(value: string): string {
  return normalizePdfSymbols(value)
    .replace(/\bRiversideos\b/gi, "RiversideOS")
    .replace(/\bRiverside Os\b/gi, "Riverside OS")
    .replace(/\b(api|os|pdf|pin|pos|pwa|qbo|rms|rosie|sku|sop|sql)\b/gi, (word) =>
      PDF_ACRONYMS.get(word.toLowerCase()) ?? word,
    );
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadCurrentManuals(
  baseUrl: string,
  headers: Record<string, string>,
  onProgress?: (progress: RiversideUserManualProgress) => void,
): Promise<UserManualSource[]> {
  onProgress?.({
    stage: "catalog",
    completed: 0,
    total: 1,
    message: "Loading the current Help catalog...",
  });
  const catalog = await fetchJson<{ manuals?: HelpManualListEntry[] }>(
    `${baseUrl}/api/help/manuals`,
    headers,
  );
  const manuals = [...(catalog.manuals ?? [])].sort(
    (left, right) => left.order - right.order || left.title.localeCompare(right.title),
  );
  if (manuals.length === 0) {
    throw new Error("The current Help catalog returned no printable manuals.");
  }

  let completed = 0;
  const details = await mapWithConcurrency(manuals, 6, async (manual) => {
    const detail = await fetchJson<HelpManualDetail>(
      `${baseUrl}/api/help/manuals/${encodeURIComponent(manual.id)}`,
      headers,
    );
    completed += 1;
    onProgress?.({
      stage: "manuals",
      completed,
      total: manuals.length,
      message: `Loading manuals ${completed} of ${manuals.length}...`,
    });
    return {
      ...manual,
      title: detail.title?.trim() || manual.title,
      markdown: detail.markdown ?? "",
    };
  });
  return details;
}

function collectImageUrls(tokens: Token[], output: Set<string>): void {
  for (const token of tokens) {
    if (token.type === "image") {
      output.add(resolveHelpImageSrc(token.href));
      continue;
    }
    if (token.type === "list") {
      for (const item of token.items) collectImageUrls(item.tokens, output);
      continue;
    }
    if (token.type === "table") {
      for (const cell of [...token.header, ...token.rows.flat()]) {
        collectImageUrls(cell.tokens, output);
      }
      continue;
    }
    if ("tokens" in token && Array.isArray(token.tokens)) {
      collectImageUrls(token.tokens, output);
    }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read screenshot data."));
    reader.readAsDataURL(blob);
  });
}

async function loadScreenshots(
  manuals: UserManualSource[],
  warnings: string[],
  onProgress?: (progress: RiversideUserManualProgress) => void,
): Promise<Map<string, string>> {
  const urls = new Set<string>();
  for (const manual of manuals) {
    collectImageUrls(marked.lexer(cleanMarkdown(manual.markdown), { gfm: true }), urls);
  }
  const list = [...urls];
  let completed = 0;
  const entries = await mapWithConcurrency(list, 4, async (url) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const dataUrl = await blobToDataUrl(await response.blob());
      return [url, dataUrl] as const;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown image error";
      warnings.push(`Screenshot could not be included (${url}): ${reason}`);
      return [url, ""] as const;
    } finally {
      completed += 1;
      onProgress?.({
        stage: "screenshots",
        completed,
        total: list.length,
        message: `Preparing screenshots ${completed} of ${list.length}...`,
      });
    }
  });
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== ""));
}

function inlineFragments(tokens: Token[] | undefined, inherited: InlineStyle = {}): Content[] {
  if (!tokens) return [];
  return tokens.flatMap((token): Content[] => {
    switch (token.type) {
      case "strong":
        return inlineFragments(token.tokens, { ...inherited, bold: true });
      case "em":
        return inlineFragments(token.tokens, { ...inherited, italics: true });
      case "del":
        return inlineFragments(token.tokens, { ...inherited, decoration: "lineThrough" });
      case "codespan":
        return [
          {
            text: normalizePdfSymbols(token.text),
            ...inherited,
            font: "Roboto",
            background: "#eef2f7",
          },
        ];
      case "link": {
        const destination = token.href.startsWith("manual:")
          ? `manual-${token.href.slice("manual:".length)}`
          : null;
        return inlineFragments(token.tokens, {
          ...inherited,
          color: "#0f4f9f",
          ...(destination
            ? { linkToDestination: destination }
            : { link: token.href }),
        });
      }
      case "br":
        return ["\n"];
      case "image":
        return [{ text: token.text || "Screenshot", ...inherited, italics: true }];
      case "text":
        return token.tokens?.length
          ? inlineFragments(token.tokens, inherited)
          : [{ text: normalizePdfText(token.text), ...inherited }];
      case "escape":
        return [{ text: normalizePdfText(token.text), ...inherited }];
      default:
        if ("text" in token && typeof token.text === "string") {
          return [{ text: normalizePdfText(token.text), ...inherited }];
        }
        return [];
    }
  });
}

function imageContent(token: Tokens.Image, context: BuildContext): Content[] {
  const url = resolveHelpImageSrc(token.href);
  const dataUrl = context.images.get(url);
  if (!dataUrl) {
    return [
      {
        text: `Screenshot unavailable: ${normalizePdfText(token.text || token.href).trim()}`,
        style: "imageWarning",
      },
    ];
  }
  return [
    {
      image: dataUrl,
      fit: [468, 315],
      alignment: "center",
      margin: [0, 8, 0, 3],
    },
    ...(token.text
      ? [
          {
            text: normalizePdfText(token.text).trim(),
            style: "caption",
            alignment: "center" as const,
          },
        ]
      : []),
  ];
}

function listItemContent(item: Tokens.ListItem, context: BuildContext): Content {
  const content = tokensToContent(item.tokens, context, true);
  if (content.length === 1) return content[0];
  return { stack: content, margin: [0, 0, 0, 2] };
}

function tableCellContent(cell: Tokens.TableCell, header: boolean): Content {
  return {
    text: inlineFragments(cell.tokens),
    bold: header,
    fillColor: header ? "#e9eef5" : undefined,
    color: "#172033",
    margin: [3, 3, 3, 3],
  };
}

function tokensToContent(tokens: Token[], context: BuildContext, insideList = false): Content[] {
  return tokens.flatMap((token): Content[] => {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "heading":
        if (token.depth === 1) return [];
        return [
          {
            text: normalizePdfText(formatHelpDisplayHeading(token.text)).trim(),
            style: token.depth === 2 ? "sectionHeading" : "subsectionHeading",
          },
        ];
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        if (paragraph.tokens.length === 1 && paragraph.tokens[0].type === "image") {
          return imageContent(paragraph.tokens[0] as Tokens.Image, context);
        }
        return [{ text: inlineFragments(paragraph.tokens), style: "body" }];
      }
      case "text":
        return [{ text: inlineFragments(token.tokens ?? [token]), style: "body" }];
      case "image":
        return imageContent(token as Tokens.Image, context);
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item) => listItemContent(item, context));
        return [
          list.ordered
            ? { ol: items, start: typeof list.start === "number" ? list.start : 1, style: "list" }
            : { ul: items, style: "list" },
        ];
      }
      case "table": {
        const table = token as Tokens.Table;
        const body = [
          table.header.map((cell) => tableCellContent(cell, true)),
          ...table.rows.map((row) => row.map((cell) => tableCellContent(cell, false))),
        ];
        return [
          {
            table: {
              headerRows: 1,
              widths: table.header.map(() => "*"),
              body,
              dontBreakRows: true,
            },
            layout: "lightHorizontalLines",
            margin: [0, 6, 0, 10],
          },
        ];
      }
      case "code":
        return [{ text: normalizePdfSymbols(token.text), style: "code" }];
      case "blockquote":
        return [
          {
            stack: tokensToContent((token as Tokens.Blockquote).tokens, context),
            style: "quote",
          },
        ];
      case "hr":
        return [
          {
            canvas: [
              { type: "line", x1: 0, y1: 2, x2: 468, y2: 2, lineWidth: 0.7, lineColor: "#cbd5e1" },
            ],
            margin: [0, 5, 0, 8],
          },
        ];
      case "html":
        return [];
      default:
        if (insideList && "tokens" in token && Array.isArray(token.tokens)) {
          return tokensToContent(token.tokens, context, true);
        }
        return [];
    }
  });
}

function createDocumentDefinition(
  manuals: UserManualSource[],
  generatedAt: Date,
  images: Map<string, string>,
  warnings: string[],
): TDocumentDefinitions {
  const context: BuildContext = { images, warnings };
  const generatedLabel = generatedAt.toLocaleString();
  const content: Content[] = [
    {
      stack: [
        { text: "RIVERSIDE OS", style: "coverEyebrow" },
        { text: "User Manual", style: "coverTitle" },
        {
          text: "Complete staff guide to RiversideOS workflows, screens, safeguards, and daily operations.",
          style: "coverLead",
        },
        {
          text: `${manuals.length} current Help manuals with screenshots`,
          style: "coverMeta",
        },
        { text: `Generated ${generatedLabel}`, style: "coverMeta" },
        {
          text: "This document is generated from the live Help Center. Rebuild it after Help changes to receive the latest version.",
          style: "coverNote",
        },
      ],
      margin: [24, 155, 24, 0],
      pageBreak: "after",
    },
    { text: "Table of Contents", style: "tocTitle" },
    {
      text: "Select a title in a PDF viewer to jump directly to that manual.",
      style: "tocLead",
    },
    {
      toc: {
        title: { text: "" },
        textMargin: [0, 2, 0, 2],
      },
      pageBreak: "after",
    },
  ];

  manuals.forEach((manual, index) => {
    content.push({
      text: normalizePdfText(formatHelpDisplayTitle(manual.title)).trim(),
      style: "manualTitle",
      id: `manual-${manual.id}`,
      tocItem: true,
      outline: true,
      pageBreak: index === 0 ? undefined : "before",
    });
    if (manual.summary.trim()) {
      content.push({ text: normalizePdfText(manual.summary).trim(), style: "manualSummary" });
    }
    content.push(...tokensToContent(marked.lexer(cleanMarkdown(manual.markdown), { gfm: true }), context));
  });

  return {
    info: {
      title: "RiversideOS User Manual",
      author: "Riverside OS",
      subject: "Current RiversideOS staff Help manuals",
      keywords: "RiversideOS, user manual, help, staff, register, operations",
      creationDate: generatedAt,
      modDate: generatedAt,
    },
    pageSize: "LETTER",
    pageMargins: [54, 62, 54, 54],
    defaultStyle: {
      font: "Roboto",
      fontSize: 10.2,
      lineHeight: 1.28,
      color: "#172033",
    },
    header: (currentPage) =>
      currentPage <= 1
        ? null
        : {
            columns: [
              { text: "RiversideOS User Manual", style: "headerText", width: "*" },
              {
                text: `Generated ${generatedAt.toLocaleDateString()}`,
                style: "headerText",
                alignment: "right",
                width: 130,
              },
            ],
            margin: [54, 24, 54, 0],
          },
    footer: (currentPage, pageCount) => ({
      columns: [
        {
          text: "Riverside OS - Staff Quick Reference",
          style: "footerText",
          width: "*",
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          style: "footerText",
          alignment: "center",
          width: 110,
        },
      ],
      margin: [54, 0, 54, 24],
    }),
    content,
    styles: {
      coverEyebrow: {
        fontSize: 13,
        bold: true,
        color: "#5b21b6",
        characterSpacing: 2.2,
        margin: [0, 0, 0, 12],
      },
      coverTitle: { fontSize: 40, bold: true, color: "#111827", margin: [0, 0, 0, 18] },
      coverLead: { fontSize: 15, color: "#334155", lineHeight: 1.35, margin: [0, 0, 0, 28] },
      coverMeta: { fontSize: 10.5, bold: true, color: "#475569", margin: [0, 0, 0, 5] },
      coverNote: { fontSize: 9.5, color: "#64748b", margin: [0, 28, 0, 0] },
      tocTitle: { fontSize: 25, bold: true, color: "#111827", margin: [0, 0, 0, 8] },
      tocLead: { fontSize: 10, color: "#64748b", margin: [0, 0, 0, 12] },
      manualTitle: { fontSize: 23, bold: true, color: "#111827", margin: [0, 0, 0, 8] },
      manualSummary: {
        fontSize: 11,
        italics: true,
        color: "#475569",
        fillColor: "#f1f5f9",
        margin: [0, 0, 0, 12],
      },
      sectionHeading: { fontSize: 15, bold: true, color: "#312e81", margin: [0, 12, 0, 5] },
      subsectionHeading: { fontSize: 12, bold: true, color: "#4338ca", margin: [0, 9, 0, 4] },
      body: { fontSize: 10.2, margin: [0, 0, 0, 7] },
      list: { fontSize: 10.2, margin: [10, 0, 0, 8] },
      code: {
        font: "Roboto",
        fontSize: 8.6,
        color: "#1e293b",
        fillColor: "#f1f5f9",
        margin: [6, 5, 6, 8],
      },
      quote: { italics: true, color: "#475569", margin: [12, 4, 0, 8] },
      caption: { fontSize: 8.5, italics: true, color: "#64748b", margin: [0, 0, 0, 9] },
      imageWarning: { fontSize: 9, italics: true, color: "#b45309", margin: [0, 4, 0, 7] },
      headerText: { fontSize: 8.5, color: "#64748b" },
      footerText: { fontSize: 8, color: "#64748b" },
    },
  };
}

export async function buildCurrentRiversideUserManual(options: {
  baseUrl: string;
  headers: Record<string, string>;
  onProgress?: (progress: RiversideUserManualProgress) => void;
}): Promise<RiversideUserManualBuild> {
  const manuals = await loadCurrentManuals(options.baseUrl, options.headers, options.onProgress);
  const warnings: string[] = [];
  const images = await loadScreenshots(manuals, warnings, options.onProgress);
  const generatedAt = new Date();
  const definition = createDocumentDefinition(manuals, generatedAt, images, warnings);
  options.onProgress?.({
    stage: "pdf",
    completed: 0,
    total: 1,
    message: "Laying out the printable PDF...",
  });
  const runtime = await loadPdfRuntime();
  const pdf = runtime.createPdf(definition);
  const blob = await pdf.getBlob();
  options.onProgress?.({
    stage: "pdf",
    completed: 1,
    total: 1,
    message: "RiversideOS User Manual is ready.",
  });
  return {
    blob,
    generatedAt,
    manualCount: manuals.length,
    screenshotCount: images.size,
    warningCount: warnings.length,
    warnings,
    print: async () => {
      await runtime.createPdf(definition).print();
    },
  };
}
