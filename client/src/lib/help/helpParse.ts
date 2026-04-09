import { slugifyHeading, uniqueSlug } from "./helpSlug";

export type TocEntry = { level: 2 | 3; heading: string; slug: string };

export type HelpSearchChunk = {
  manualId: string;
  manualTitle: string;
  sectionSlug: string;
  sectionHeading: string;
  body: string;
};

/** Slugs for `##` / `###` in document order (matches server chunking, excluding intro). */
export function orderedSectionSlugs(markdown: string): string[] {
  const lines = markdown.split("\n");
  const counts = new Map<string, number>();
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("### ") && !line.startsWith("#### ")) {
      const h = line.slice(4).trim();
      const base = slugifyHeading(h) || `section-${out.length}`;
      out.push(uniqueSlug(base, counts));
    } else if (line.startsWith("## ") && !line.startsWith("### ")) {
      const h = line.slice(3).trim();
      const base = slugifyHeading(h) || `section-${out.length}`;
      out.push(uniqueSlug(base, counts));
    }
  }
  return out;
}

function manualTitleFromH1(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ") && !t.startsWith("## ")) {
      const s = t.slice(2).trim();
      if (s) return s;
    }
  }
  return null;
}

export function parseHelpToc(markdown: string, manualTitleFallback: string): TocEntry[] {
  const h1 = manualTitleFromH1(markdown);
  const lines = markdown.split("\n");
  let i = 0;
  if (lines[0]?.trim().startsWith("# ") && !lines[0].trim().startsWith("## ")) {
    i = 1;
  }
  while (i < lines.length && lines[i].trim() === "") i += 1;

  let introEnd = lines.length;
  for (let j = i; j < lines.length; j += 1) {
    const l = lines[j];
    if ((l.startsWith("## ") && !l.startsWith("### ")) || l.startsWith("### ")) {
      introEnd = j;
      break;
    }
  }
  const intro = lines
    .slice(i, introEnd)
    .filter((l) => l.trim() !== "---")
    .join("\n")
    .trim();

  const out: TocEntry[] = [];
  const counts = new Map<string, number>();
  if (intro.length > 0) {
    counts.set("overview", 1);
    out.push({
      level: 2,
      heading: h1 ?? manualTitleFallback,
      slug: "overview",
    });
  }
  for (const line of lines) {
    if (line.startsWith("### ") && !line.startsWith("#### ")) {
      const h = line.slice(4).trim();
      const base = slugifyHeading(h) || `section-${out.length}`;
      out.push({ level: 3, heading: h, slug: uniqueSlug(base, counts) });
    } else if (line.startsWith("## ") && !line.startsWith("### ")) {
      const h = line.slice(3).trim();
      const base = slugifyHeading(h) || `section-${out.length}`;
      out.push({ level: 2, heading: h, slug: uniqueSlug(base, counts) });
    }
  }
  return out;
}

/** In-memory chunks for client-side fallback search (mirrors server sections). */
export function buildLocalSearchChunks(
  manualId: string,
  manualTitleFallback: string,
  markdown: string,
): HelpSearchChunk[] {
  const h1 = manualTitleFromH1(markdown);
  const manualTitle = h1 ?? manualTitleFallback;
  const lines = markdown.split("\n");
  let i = 0;
  if (lines[0]?.trim().startsWith("# ") && !lines[0].trim().startsWith("## ")) {
    i = 1;
  }
  while (i < lines.length && lines[i].trim() === "") i += 1;

  let introEnd = lines.length;
  for (let j = i; j < lines.length; j += 1) {
    const l = lines[j];
    if ((l.startsWith("## ") && !l.startsWith("### ")) || l.startsWith("### ")) {
      introEnd = j;
      break;
    }
  }
  const intro = lines
    .slice(i, introEnd)
    .filter((l) => l.trim() !== "---")
    .join("\n")
    .trim();

  const chunks: HelpSearchChunk[] = [];
  const slugCounts = new Map<string, number>();

  if (intro.length > 0) {
    chunks.push({
      manualId,
      manualTitle,
      sectionSlug: uniqueSlug("overview", slugCounts),
      sectionHeading: h1 ?? "Overview",
      body: intro,
    });
  }

  let rank = 1;
  let pos = introEnd;
  while (pos < lines.length) {
    const line = lines[pos];
    let heading: string;
    if (line.startsWith("### ") && !line.startsWith("#### ")) {
      heading = line.slice(4).trim();
    } else if (line.startsWith("## ") && !line.startsWith("### ")) {
      heading = line.slice(3).trim();
    } else {
      pos += 1;
      continue;
    }
    pos += 1;
    const bodyStart = pos;
    while (pos < lines.length) {
      const l = lines[pos];
      if ((l.startsWith("## ") && !l.startsWith("### ")) || l.startsWith("### ")) {
        break;
      }
      pos += 1;
    }
    const body = lines.slice(bodyStart, pos).join("\n").trim();
    const base = slugifyHeading(heading) || `section-${rank}`;
    const sectionSlug = uniqueSlug(base, slugCounts);
    chunks.push({
      manualId,
      manualTitle,
      sectionSlug,
      sectionHeading: heading,
      body,
    });
    rank += 1;
  }

  return chunks;
}

function scoreChunk(qLower: string, chunk: HelpSearchChunk): number {
  const hay = `${chunk.sectionHeading} ${chunk.body}`.toLowerCase();
  if (!hay.includes(qLower)) return 0;
  let s = 0;
  if (chunk.sectionHeading.toLowerCase().includes(qLower)) s += 10;
  const n = hay.split(qLower).length - 1;
  s += Math.min(n, 5) * 2;
  return s;
}

export function localHelpSearch(
  query: string,
  allChunks: HelpSearchChunk[],
  limit: number,
): Array<HelpSearchChunk & { excerpt: string }> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored = allChunks
    .map((c) => ({ c, score: scoreChunk(q, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ c }) => ({
      ...c,
      excerpt: excerptFromBody(c.body, 200),
    }));
  return scored;
}

function excerptFromBody(body: string, max: number): string {
  const t = body.split(/\s+/).join(" ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}
