const ACRONYM_WORDS = new Map<string, string>([
  ["api", "API"],
  ["bo", "Back Office"],
  ["csv", "CSV"],
  ["e2e", "E2E"],
  ["id", "ID"],
  ["llm", "LLM"],
  ["mtm", "MTM"],
  ["os", "OS"],
  ["pdf", "PDF"],
  ["pin", "PIN"],
  ["pos", "POS"],
  ["po", "PO"],
  ["pwa", "PWA"],
  ["qbo", "QBO"],
  ["rbac", "RBAC"],
  ["rms", "RMS"],
  ["ros", "ROS"],
  ["rosie", "ROSIE"],
  ["riversideos", "RiversideOS"],
  ["sku", "SKU"],
  ["sop", "SOP"],
  ["sql", "SQL"],
  ["stt", "STT"],
  ["tts", "TTS"],
  ["ui", "UI"],
  ["url", "URL"],
  ["z", "Z"],
]);

const LOWERCASE_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "via",
  "with",
]);

function titleCaseWord(word: string, index: number, total: number): string {
  const lower = word.toLowerCase();
  const acronym = ACRONYM_WORDS.get(lower);
  if (acronym) return acronym;
  if (index > 0 && index < total - 1 && LOWERCASE_TITLE_WORDS.has(lower)) {
    return lower;
  }
  return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
}

function titleCasePhrase(value: string): string {
  return value
    .split(/(\s+|[-/])/)
    .map((part, index, parts) => {
      if (/^\s+$/.test(part) || part === "-" || part === "/") return part;
      const wordParts = parts.filter((p) => !/^\s+$/.test(p) && p !== "-" && p !== "/");
      const wordIndex = wordParts.indexOf(part);
      return titleCaseWord(part, wordIndex === -1 ? index : wordIndex, wordParts.length);
    })
    .join("");
}

function cleanSpacing(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1").trim();
}

export function formatHelpDisplayTitle(value: string): string {
  const cleaned = cleanSpacing(value);
  return cleaned.replace(/\(([^)]+)\)/g, (_, inner: string) => {
    return `(${titleCasePhrase(inner)})`;
  }).split(/(:\s*)/).map((part) => {
    if (part === ": ") return part;
    return titleCasePhrase(part);
  }).join("");
}

export function formatHelpDisplayHeading(value: string): string {
  return formatHelpDisplayTitle(value.replace(/:$/, ""));
}
