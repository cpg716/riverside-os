/** Minimal RFC-style CSV parser for import UIs (quoted fields, comma-separated). */

export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseCsv(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]!).map((h) =>
    h.replace(/^\uFEFF/, "").trim(),
  );
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]!);
    if (vals.every((v) => v === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = vals[j] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}
