/** Strip optional YAML front matter (--- … ---) from help manual markdown before render/parse. */
export function stripYamlFrontMatter(raw: string): string {
  const t = raw.replace(/^\uFEFF/, "");
  if (!t.startsWith("---")) return raw;
  const nl = t.indexOf("\n");
  if (nl < 0) return raw;
  const rest = t.slice(nl + 1);
  const end = rest.search(/\n---\s*(?:\r?\n|$)/);
  if (end < 0) return raw;
  return rest
    .slice(end + 1)
    .replace(/^---\s*\r?\n?/, "")
    .replace(/^\s+/, "");
}
