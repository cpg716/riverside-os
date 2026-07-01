#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";

const args = process.argv.slice(2);

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Wedding cutover import preview

Usage:
  node scripts/wedding-cutover-import-preview.mjs --file "/path/Wedding Parties 2026 .xlsx" [--out preview.json] [--match-db]

Options:
  --file <path>   Excel workbook to preview. Required.
  --out <path>    Write full JSON preview report.
  --match-db      Read-only customer matching using DATABASE_URL and psql.
  --help          Show this help.

This script never writes to the ROS database.
`);
  process.exit(exitCode);
}

function takeArg(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

if (args.includes("--help") || args.includes("-h")) usage(0);

const workbookPath = takeArg("--file");
const outputPath = takeArg("--out");
const shouldMatchDb = args.includes("--match-db");

if (!workbookPath) usage(1);

function cleanText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return cleanText(value)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhoneDigits(value) {
  return cleanText(value).replace(/\D/g, "");
}

function phoneMatchKey(value) {
  const digits = normalizePhoneDigits(value);
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length === 7) return digits;
  return digits;
}

function excelDateToIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    date.setUTCHours(date.getUTCHours() + 12);
    return date.toISOString().slice(0, 10);
  }
  const text = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

function cellValue(worksheet, row, col) {
  const raw = worksheet.getCell(row, col).value;
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return raw;
  if (typeof raw === "object") {
    if (Array.isArray(raw.richText)) return raw.richText.map((part) => part.text).join("");
    if (raw.result !== undefined && raw.result !== null) return raw.result;
    if (raw.text !== undefined) return raw.text;
  }
  return raw;
}

function rowValues(worksheet, row, cols = 11) {
  return Array.from({ length: cols }, (_, idx) => cellValue(worksheet, row, idx + 1));
}

const infoRowPatterns = [
  /^\(.+\)$/,
  /^GROOM\s+VESTED\b/i,
  /^DADS?\b/i,
  /^BROTHERS?\b/i,
  /^FATHERS?\b/i,
  /^MOTHERS?\b/i,
  /^COLOR\b/i,
  /^STYLE\b/i,
  /^SUITS?\b/i,
  /^TIES?\b/i,
  /^VESTS?\b/i,
  /^OPTIONAL\b/i,
  /^ONLY\b/i,
  /^NOTES?\b/i,
];

function isFooterLabel(value) {
  return /^(SHIRT|NOTES|BRIDE\s+NAME|BRIDE\s+EMAIL|BRIDE\s+PHONE|Print|Sign|Date):?/i.test(
    cleanText(value),
  );
}

function isInfoRow(name, phone) {
  const n = normalizeName(name);
  if (!n) return false;
  if (cleanText(phone)) return false;
  return infoRowPatterns.some((pattern) => pattern.test(n));
}

function cleanMemberName(value) {
  let name = normalizeName(value);
  const original = name;
  const flags = [];
  if (/\b(OOT|OUT\s*OF\s*TOWN|OUT-OF-TOWN)\b/i.test(name)) flags.push("out_of_town");
  name = name
    .replace(/\(([^)]*\b(?:OOT|OUT\s*OF\s*TOWN|OUT-OF-TOWN)[^)]*)\)/gi, "")
    .replace(/\b(?:OOT|OUT\s*OF\s*TOWN|OUT-OF-TOWN)\b/gi, "")
    .replace(/\s+-\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name: name || original, flags };
}

function inferRole(rowNumber, name) {
  const upper = normalizeName(name).toUpperCase();
  if (rowNumber === 6) return "Groom";
  if (upper.includes("FATHER") || upper.includes("DAD")) return "Father";
  if (upper.includes("RING")) return "Ring Bearer";
  if (upper.includes("USHER")) return "Usher";
  return "Groomsman";
}

function extractBrideField(text, label) {
  const pattern = new RegExp(`${label}:?\\s*(.*)$`, "i");
  const match = cleanText(text).match(pattern);
  return match ? match[1].trim() : "";
}

function parseWorksheet(worksheet) {
  const warnings = [];
  const notes = [];
  const rawPartyName = normalizeName(cellValue(worksheet, 1, 1) || worksheet.name);
  const eventDate = excelDateToIso(cellValue(worksheet, 1, 4));
  const salesperson = normalizeName(cellValue(worksheet, 1, 9));
  const signUpDate = excelDateToIso(cellValue(worksheet, 2, 4) || cellValue(worksheet, 3, 2));
  const styleRef = normalizeName(cellValue(worksheet, 2, 8));
  const styleCode = normalizeName(cellValue(worksheet, 3, 8));
  const priceInfo = normalizeName(cellValue(worksheet, 3, 1));
  const accessories = {};
  const members = [];
  const workflowSignals = [];
  const infoRows = [];
  let brideName = "";
  let brideEmail = "";
  let bridePhone = "";
  let partyNotes = "";
  let groomPhone = "";

  if (!rawPartyName) warnings.push("missing_party_name");
  if (!eventDate) warnings.push("missing_event_date");
  if (!signUpDate) warnings.push("missing_sign_up_date");

  for (let row = 6; row <= Math.min(worksheet.rowCount, 25); row += 1) {
    const values = rowValues(worksheet, row);
    const name = normalizeName(values[0]);
    const phone = normalizeName(values[1]);

    if (name.toUpperCase().startsWith("SHIRT:")) {
      accessories.shirt = name.replace(/^SHIRT:\s*/i, "");
      accessories.shoes = phone.replace(/^SHOES:\s*/i, "");
      accessories.ties = normalizeName(values[3]).replace(/^TIES:\s*/i, "");
      accessories.pocket_square = normalizeName(values[6]).replace(/^POCKET\s+SQ:\s*/i, "");
      accessories.belt = normalizeName(values[9]).replace(/^BELT:\s*/i, "");
      continue;
    }

    if (name.toUpperCase().startsWith("NOTES:")) {
      partyNotes = name.replace(/^NOTES:\s*/i, "");
      if (/BRIDE\s+NAME:/i.test(phone)) brideName = extractBrideField(phone, "BRIDE NAME");
      else if (phone && !isFooterLabel(phone)) brideName = brideName || phone;
      continue;
    }

    if (/BRIDE\s+NAME:/i.test(phone)) {
      brideName = extractBrideField(phone, "BRIDE NAME");
      continue;
    }
    if (/BRIDE\s+EMAIL:/i.test(phone)) {
      brideEmail = extractBrideField(phone, "BRIDE EMAIL");
      continue;
    }
    if (/BRIDE\s+PHONE:/i.test(phone)) {
      bridePhone = extractBrideField(phone, "BRIDE PHONE");
      continue;
    }

    if (!name || isFooterLabel(name)) continue;

    if (isInfoRow(name, phone)) {
      infoRows.push({ row, text: name });
      continue;
    }

    const { name: cleanName, flags } = cleanMemberName(name);
    const role = inferRole(row, cleanName);
    if (role === "Groom") groomPhone = phone;

    const member = {
      source_row: row,
      name: cleanName,
      phone,
      phone_digits: normalizePhoneDigits(phone),
      phone_match_key: phoneMatchKey(phone),
      role,
      flags,
      sizing: {
        suit: normalizeName(values[2]),
        waist: normalizeName(values[3]),
        vest: normalizeName(values[4]),
        shirt: normalizeName(values[5]),
        shoe: normalizeName(values[7]),
      },
      spreadsheet_status: {
        date_received: excelDateToIso(values[8]),
        fitting: normalizeName(values[9]),
        pickup: normalizeName(values[10]),
      },
      warnings: [],
    };

    if (!member.phone_digits) member.warnings.push("missing_phone");
    else if (![7, 10, 11].includes(member.phone_digits.length)) {
      member.warnings.push("unusual_phone_length");
    }
    if (member.spreadsheet_status.date_received) workflowSignals.push(`${cleanName}:date_received`);
    if (member.spreadsheet_status.fitting) workflowSignals.push(`${cleanName}:fitting`);
    if (member.spreadsheet_status.pickup) workflowSignals.push(`${cleanName}:pickup`);
    members.push(member);
  }

  if (!brideName) warnings.push("missing_bride_name");
  if (!members.length) warnings.push("no_members");
  if (workflowSignals.length) warnings.push("spreadsheet_workflow_cells_present_review_only");

  return {
    source_sheet: worksheet.name,
    party_name: rawPartyName.toUpperCase(),
    event_date: eventDate,
    salesperson,
    sign_up_date: signUpDate,
    style_info: [styleRef, styleCode].filter(Boolean).join(" / "),
    price_info: priceInfo,
    groom_phone: groomPhone,
    bride: {
      name: brideName,
      phone: bridePhone,
      phone_digits: normalizePhoneDigits(bridePhone),
      email: brideEmail,
    },
    accessories,
    notes: partyNotes,
    info_rows: infoRows,
    workflow_signals: workflowSignals,
    members,
    warnings,
    import_policy: {
      source: "wedding_excel_cutover_preview",
      cutover_review_status: "needs_review",
      workflow_cells_are_review_only: true,
    },
  };
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function loadCustomerMatches(parties) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required for --match-db");

  const keys = [
    ...new Set(
      parties
        .flatMap((party) => party.members.map((member) => member.phone_match_key))
        .filter((key) => key.length >= 7),
    ),
  ];
  if (!keys.length) return { byKey: new Map(), warnings: ["no_member_phone_keys_to_match"] };

  const values = keys.map((key) => `(${sqlLiteral(key)})`).join(",");
  const sql = `
WITH input(phone_key) AS (VALUES ${values}),
customers_clean AS (
  SELECT
    id::text,
    customer_code,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), company_name, '') AS name,
    phone,
    REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') AS phone_digits,
    customer_created_source
  FROM customers
  WHERE COALESCE(phone, '') <> ''
)
SELECT COALESCE(json_agg(row_to_json(matches)), '[]'::json)::text
FROM (
  SELECT
    input.phone_key,
    c.id,
    c.customer_code,
    c.name,
    c.phone,
    c.phone_digits,
    c.customer_created_source,
    CASE
      WHEN c.phone_digits = input.phone_key THEN 'exact_digits'
      WHEN RIGHT(c.phone_digits, 10) = input.phone_key AND LENGTH(input.phone_key) = 10 THEN 'last_10_digits'
      WHEN RIGHT(c.phone_digits, 7) = input.phone_key AND LENGTH(input.phone_key) = 7 THEN 'last_7_digits'
      ELSE 'unknown'
    END AS match_type
  FROM input
  JOIN customers_clean c
    ON c.phone_digits = input.phone_key
    OR (LENGTH(input.phone_key) = 10 AND RIGHT(c.phone_digits, 10) = input.phone_key)
    OR (LENGTH(input.phone_key) = 7 AND RIGHT(c.phone_digits, 7) = input.phone_key)
  ORDER BY input.phone_key, match_type, c.name
) matches;
`;

  let parsed;
  try {
    const stdout = execFileSync("psql", ["-d", dbUrl, "-X", "-q", "-t", "-A", "-c", sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    parsed = JSON.parse(stdout || "[]");
  } catch (error) {
    throw new Error(`psql customer match query failed: ${error.message}`);
  }

  const byKey = new Map();
  for (const match of parsed) {
    if (!byKey.has(match.phone_key)) byKey.set(match.phone_key, []);
    byKey.get(match.phone_key).push(match);
  }
  return { byKey, warnings: [] };
}

function applyMatches(parties, byKey) {
  for (const party of parties) {
    for (const member of party.members) {
      const matches = byKey.get(member.phone_match_key) ?? [];
      member.customer_matches = matches.map((match) => ({
        customer_id: match.id,
        customer_code: match.customer_code,
        name: match.name,
        phone: match.phone,
        match_type: match.match_type,
        source: match.customer_created_source,
      }));
      if (matches.length === 1) {
        member.match_confidence = member.phone_match_key.length >= 10 ? "high" : "medium";
      } else if (matches.length > 1) {
        member.match_confidence = "ambiguous";
        member.warnings.push("multiple_customer_phone_matches");
      } else {
        member.match_confidence = "none";
      }
    }
  }
}

function summarize(parties, dbWarnings = []) {
  const memberCount = parties.reduce((sum, party) => sum + party.members.length, 0);
  const warningCounts = new Map();
  const memberWarningCounts = new Map();
  let matched = 0;
  let ambiguous = 0;
  let noMatch = 0;
  let workflowSignals = 0;

  for (const warning of dbWarnings) {
    warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
  }
  for (const party of parties) {
    workflowSignals += party.workflow_signals.length;
    for (const warning of party.warnings) {
      warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
    }
    for (const member of party.members) {
      for (const warning of member.warnings) {
        memberWarningCounts.set(warning, (memberWarningCounts.get(warning) ?? 0) + 1);
      }
      if (member.match_confidence === "ambiguous") ambiguous += 1;
      else if (member.match_confidence === "none") noMatch += 1;
      else if (member.match_confidence) matched += 1;
    }
  }

  return {
    party_count: parties.length,
    member_count: memberCount,
    member_count_min: Math.min(...parties.map((party) => party.members.length)),
    member_count_max: Math.max(...parties.map((party) => party.members.length)),
    workflow_signal_count: workflowSignals,
    customer_match_counts: {
      matched,
      ambiguous,
      no_match: noMatch,
    },
    party_warning_counts: Object.fromEntries([...warningCounts.entries()].sort()),
    member_warning_counts: Object.fromEntries([...memberWarningCounts.entries()].sort()),
  };
}

async function main() {
  const absoluteWorkbookPath = path.resolve(workbookPath);
  if (!fs.existsSync(absoluteWorkbookPath)) {
    throw new Error(`Workbook not found: ${absoluteWorkbookPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absoluteWorkbookPath);

  const parties = workbook.worksheets
    .filter((worksheet) => !["MASTER", "Sheet1"].includes(worksheet.name))
    .map(parseWorksheet)
    .filter((party) => party.party_name || party.members.length);

  const seenPartyKeys = new Map();
  for (const party of parties) {
    const key = `${party.party_name}|${party.event_date}`;
    if (seenPartyKeys.has(key)) {
      party.warnings.push("duplicate_party_name_event_date");
      seenPartyKeys.get(key).warnings.push("duplicate_party_name_event_date");
    } else {
      seenPartyKeys.set(key, party);
    }
  }

  const dbWarnings = [];
  if (shouldMatchDb) {
    const { byKey, warnings } = loadCustomerMatches(parties);
    dbWarnings.push(...warnings);
    applyMatches(parties, byKey);
  }

  const report = {
    generated_at: new Date().toISOString(),
    source_file: absoluteWorkbookPath,
    mode: shouldMatchDb ? "preview_with_db_customer_matching" : "preview_only_no_db",
    summary: summarize(parties, dbWarnings),
    parties,
  };

  if (outputPath) {
    const absoluteOutputPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    fs.writeFileSync(absoluteOutputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const s = report.summary;
  console.log("Wedding cutover import preview complete.");
  console.log(`- Source: ${absoluteWorkbookPath}`);
  console.log(`- Parties: ${s.party_count}`);
  console.log(`- Members: ${s.member_count} (${s.member_count_min}-${s.member_count_max} per party)`);
  console.log(`- Workflow cells found, review-only: ${s.workflow_signal_count}`);
  if (shouldMatchDb) {
    console.log(
      `- Customer matches: ${s.customer_match_counts.matched} matched, ${s.customer_match_counts.ambiguous} ambiguous, ${s.customer_match_counts.no_match} no match`,
    );
  } else {
    console.log("- Customer matches: skipped; pass --match-db with DATABASE_URL for read-only matching");
  }
  console.log(`- Party warnings: ${JSON.stringify(s.party_warning_counts)}`);
  console.log(`- Member warnings: ${JSON.stringify(s.member_warning_counts)}`);
  if (outputPath) console.log(`- Report: ${path.resolve(outputPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
