const helpImageUrls = import.meta.glob<string>(
  "../../assets/images/help/**/*.{png,jpg,jpeg,gif,webp,svg}",
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;

/**
 * Map markdown paths like `../images/help/pos/foo.png` to Vite-resolved asset URLs.
 */
export function resolveHelpImageSrc(src: string): string {
  const t = src.trim();
  const m = t.match(/images\/help\/(.+)$/i);
  if (!m) return t;
  const suffix = m[1].replace(/^\//, "");
  const hit = Object.keys(helpImageUrls).find((k) => k.endsWith(suffix));
  return hit ? helpImageUrls[hit] : t;
}
