/** Kept in sync with `server/src/logic/help_corpus.rs` `slugify_heading`. */
export function slugifyHeading(raw: string): string {
  let out = "";
  let lastWasHyphen = true;
  for (const c of raw.trim()) {
    const code = c.charCodeAt(0);
    const isAlnum =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    const mapped = isAlnum
      ? c.toLowerCase()
      : /\s/.test(c) || c === "-" || c === "_" || c === "—" || c === "–"
        ? "-"
        : "-";
    if (mapped === "-") {
      if (!lastWasHyphen) {
        out += "-";
        lastWasHyphen = true;
      }
    } else {
      out += mapped;
      lastWasHyphen = false;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

export function uniqueSlug(base: string, counts: Map<string, number>): string {
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}
