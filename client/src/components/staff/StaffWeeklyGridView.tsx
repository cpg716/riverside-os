import { getBaseUrl } from "../../lib/apiConfig";
import { ChangeEvent, useCallback, useMemo, useState, useEffect } from "react";
import {
  CalendarDays,
  CalendarRange,
  FileUp,
  LayoutGrid,
  Loader2,
  Save,
  RotateCcw,
  Printer,
  AlertCircle,
  UserPlus,
  Trash2,
  Highlighter,
  Plus,
  X,
} from "lucide-react";
import ExcelJS from "exceljs";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

interface EligibleStaff {
  id: string;
  full_name: string;
  role: string;
}

interface WeeklyEntry {
  weekday: number;
  works: boolean;
  shift_label: string | null;
  base_works: boolean;
  base_shift_label: string | null;
  is_highlighted: boolean;
}

interface ScheduleEvent {
  id: string;
  event_date: string;
  label: string;
  notes?: string;
  is_all_staff: boolean;
  attendees: string[];
}

interface StaffSchedule {
  staff_id: string;
  full_name: string;
  role: string;
  status: string | null;
  weekdays: WeeklyEntry[];
}

type UnresolvedImportRow = {
  name: string;
  daySchedule: Array<{ weekday: number; shiftVal: string }>;
};

interface WeekException {
  id: string;
  staff_id: string;
  full_name: string;
  exception_date: string;
  kind: string;
  shift_label: string | null;
  notes: string | null;
}

type NameLookup = {
  exact: Map<string, EligibleStaff>;
  byClean: Map<string, EligibleStaff>;
  bySingleToken: Map<string, EligibleStaff[]>;
  bySingleName: Map<string, EligibleStaff[]>;
  byFirstLast: Map<string, EligibleStaff[]>;
  byFirstInitial: Map<string, EligibleStaff[]>;
  byLastToken: Map<string, EligibleStaff[]>;
  byLastInitial: Map<string, EligibleStaff[]>;
  all: EligibleStaff[];
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_TOKENS = new Set([
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
]);

const excludedStaffNames = new Set(["chris garcia"]);

const DAY_LABEL_BLACKLIST = new Set(["master", "note change"]);

const DAY_HEADER_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const NAME_HEADER_KEYS = new Set([
  "name",
  "staffname",
  "staff name",
  "employee",
  "employee name",
  "full name",
]);

const ROLE_GROUP_ORDER: Array<Array<string>> = [
  ["salesperson"],
  ["sales_support", "salesperson_support", "sales support"],
  ["staff_support", "support"],
  ["alterations", "tailor", "tailors"],
  ["admin", "administrator", "owner"],
];

const NATALIE_NEUMANN_ID = "35d6307e-1f2b-4c4f-84ea-f555107353a1";

const roleSortOrder = (role: string, staffId?: string): number => {
  if (staffId === NATALIE_NEUMANN_ID) return 999;
  const normalized = normalizeName(role);
  for (let i = 0; i < ROLE_GROUP_ORDER.length; i += 1) {
    if (ROLE_GROUP_ORDER[i].includes(normalized)) return i;
  }
  return ROLE_GROUP_ORDER.length;
};

const ROLE_GROUP_LABEL: Record<string, string> = {
  admin: "Admin",
  salesperson: "Salesperson",
  sales_support: "Sales Support",
  staff_support: "Staff Support",
  alterations: "Alterations",
};


const roleLabel = (role: string): string => {
  const normalized = normalizeName(role);
  return ROLE_GROUP_LABEL[normalized as keyof typeof ROLE_GROUP_LABEL] ?? role;
};

const normalizeHeader = (v: unknown): string =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const normalizeName = (name: string): string =>
  String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const escapeForPrint = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const isExcludedStaffName = (name: string): boolean =>
  excludedStaffNames.has(normalizeName(name));

const normalizeMonthToken = (name: string): string =>
  normalizeName(name)
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const isMonthHeaderName = (name: string): boolean => {
  const normalized = normalizeMonthToken(name);
  if (!normalized) return false;

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.length === 1) {
    return MONTH_TOKENS.has(tokens[0]) && tokens[0].length <= 10;
  }

  if (tokens.length === 2) {
    return MONTH_TOKENS.has(tokens[0]) && MONTH_TOKENS.has(tokens[1]);
  }

  return false;
};

const isLikelyStaffName = (name: string): boolean => {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  if (DAY_LABEL_BLACKLIST.has(normalized)) return false;
  if (isMonthHeaderName(name)) return false;
  if (!/[a-z]/.test(normalized)) return false;
  if (/\b(vac|off|hsm trunk|bridal show|note change)\b/.test(normalized))
    return false;
  if (normalized.includes("/")) return false;
  if (normalized.length < 2) return false;

  const words = cleanName(name).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  if (words.length > 4) return false;
  if (words.every((word) => word.length <= 1)) return false;
  if (words.length === 1 && words[0].length <= 1) return false;
  return true;
};

const cleanName = (name: string): string =>
  normalizeName(name)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const levenshteinDistance = (a: string, b: string): number => {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const matrix = Array.from({ length: aa.length + 1 }, (_, i) =>
    Array.from({ length: bb.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );

  for (let i = 1; i <= aa.length; i += 1) {
    for (let j = 1; j <= bb.length; j += 1) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[aa.length][bb.length] ?? 0;
};

const fuzzyNameScore = (a: string, b: string): number => {
  const na = cleanName(a);
  const nb = cleanName(b);
  if (!na || !nb) return Number.POSITIVE_INFINITY;

  if (na === nb) return 0;

  const tokensA = na.split(" ").filter(Boolean);
  const tokensB = nb.split(" ").filter(Boolean);
  const baseDistance = levenshteinDistance(na, nb);
  const bonusFirstToken =
    tokensA[0] && tokensB[0] && tokensA[0] === tokensB[0] ? -1 : 0;
  const bonusLastToken =
    tokensA.length > 1 &&
    tokensB.length > 1 &&
    tokensA[tokensA.length - 1] === tokensB[tokensB.length - 1]
      ? -1
      : 0;

  return Math.max(0, baseDistance + bonusFirstToken + bonusLastToken);
};

const buildNameLookup = (rows: EligibleStaff[]): NameLookup => {
  const exact = new Map<string, EligibleStaff>();
  const byClean = new Map<string, EligibleStaff>();
  const bySingleToken = new Map<string, EligibleStaff[]>();
  const bySingleName = new Map<string, EligibleStaff[]>();
  const byFirstLast = new Map<string, EligibleStaff[]>();
  const byFirstInitial = new Map<string, EligibleStaff[]>();
  const byLastToken = new Map<string, EligibleStaff[]>();
  const byLastInitial = new Map<string, EligibleStaff[]>();

  for (const staff of rows) {
    const normalized = normalizeName(staff.full_name);
    const cleaned = cleanName(staff.full_name);
    if (!normalized) {
      continue;
    }

    exact.set(normalized, staff);
    if (!byClean.has(cleaned)) {
      byClean.set(cleaned, staff);
    }

    const parts = normalized.split(/\s+/).filter(Boolean);
    const firstToken = parts[0];
    if (firstToken) {
      const current = bySingleToken.get(firstToken) ?? [];
      current.push(staff);
      bySingleToken.set(firstToken, current);
    }

    if (parts.length === 1) {
      const current = bySingleName.get(firstToken) ?? [];
      current.push(staff);
      bySingleName.set(firstToken, current);
    }

    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      const firstLast = `${first} ${last}`;
      const firstInitial = `${first} ${last[0]}`;
      const firstLastBucket = byFirstLast.get(firstLast) ?? [];
      firstLastBucket.push(staff);
      byFirstLast.set(firstLast, firstLastBucket);
      const firstInitialBucket = byFirstInitial.get(firstInitial) ?? [];
      firstInitialBucket.push(staff);
      byFirstInitial.set(firstInitial, firstInitialBucket);
      const lastTokenBucket = byLastToken.get(last) ?? [];
      lastTokenBucket.push(staff);
      byLastToken.set(last, lastTokenBucket);
      const lastInitialBucket = byLastInitial.get(`${last[0]} ${first}`) ?? [];
      lastInitialBucket.push(staff);
      byLastInitial.set(`${last[0]} ${first}`, lastInitialBucket);
    }

    const reversed = parts.slice().reverse().join(" ");
    if (reversed && !byClean.has(reversed)) {
      byClean.set(reversed, staff);
    }
  }

  return {
    exact,
    byClean,
    bySingleToken,
    bySingleName,
    byFirstLast,
    byFirstInitial,
    byLastToken,
    byLastInitial,
    all: rows,
  };
};

const resolveStaffByName = (
  rowsByName: NameLookup,
  rawName: string,
  disallowedStaffIds = new Set<string>(),
): EligibleStaff | null => {
  const normalized = normalizeName(rawName);
  if (!normalized) return null;
  const tokens = cleanName(rawName).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const firstToken = tokens[0];

  const exact = rowsByName.exact.get(normalized);
  if (exact) return exact;

  const cleaned = cleanName(rawName);
  if (cleaned) {
    const byClean = rowsByName.byClean.get(cleaned);
    if (byClean) return byClean;
  }

  const firstTokenCandidates = firstToken
    ? (rowsByName.bySingleToken.get(firstToken) ?? [])
    : [];
  const singleNameCandidates = rowsByName.bySingleName.get(normalized) ?? [];

  const eligibleSingleNameCandidates = singleNameCandidates.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  if (eligibleSingleNameCandidates.length === 1)
    return eligibleSingleNameCandidates[0];

  if (tokens.length >= 2) {
    const firstInitial = `${tokens[0]} ${tokens[1][0]}`;
    const firstInitialMatches =
      rowsByName.byFirstInitial.get(firstInitial) ?? [];
    const eligibleFirstInitialMatches = firstInitialMatches.filter(
      (s) => !disallowedStaffIds.has(s.id),
    );
    if (eligibleFirstInitialMatches.length === 1)
      return eligibleFirstInitialMatches[0];

    const firstLast = `${tokens[0]} ${tokens[1]}`;
    const firstLastMatches = rowsByName.byFirstLast.get(firstLast) ?? [];
    const eligibleFirstLastMatches = firstLastMatches.filter(
      (s) => !disallowedStaffIds.has(s.id),
    );
    if (eligibleFirstLastMatches.length === 1)
      return eligibleFirstLastMatches[0];
  }

  const eligibleFirstTokenCandidates = firstTokenCandidates.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  if (eligibleFirstTokenCandidates.length === 1)
    return eligibleFirstTokenCandidates[0];
  if (eligibleFirstTokenCandidates.length > 1) {
    return [...eligibleFirstTokenCandidates].sort((a, b) => {
      const orderA = roleSortOrder(a.role, a.id);
      const orderB = roleSortOrder(b.role, b.id);
      if (orderA !== orderB) return orderA - orderB;
      return (a.full_name || "").localeCompare(
        b.full_name || "",
        undefined,
        { sensitivity: "base" },
      );
    })[0];
  }

  // FALLBACK: "Starts With" for nicknames like Sam -> Samantha
  if (normalized.length >= 2) {
    const startsWithCandidates = rowsByName.all.filter((s) => {
      const first = normalizeName(s.full_name).split(/\s+/)[0];
      return first.startsWith(normalized) && !disallowedStaffIds.has(s.id);
    });
    if (startsWithCandidates.length === 1) return startsWithCandidates[0];
  }

  // LAST RESORT: Search full eligible list for any match including Admins
  const fallback = rowsByName.all.find((s) => {
    const fn = normalizeName(s.full_name);
    const sn = normalized;
    return (
      fn === sn ||
      fn.includes(sn) ||
      sn.includes(fn) ||
      fn.split(" ")[0] === sn ||
      sn.startsWith(fn.split(" ")[0]) ||
      fn.startsWith(sn)
    );
  });
  if (fallback && !disallowedStaffIds.has(fallback.id)) return fallback;

  const fuzzyCandidates = rowsByName.all.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  let best: { score: number; staff: EligibleStaff } | null = null;
  for (const candidate of fuzzyCandidates) {
    const score = fuzzyNameScore(rawName, candidate.full_name);
    if (score <= 3 && (!best || score < best.score)) {
      best = { score, staff: candidate };
    }
  }
  return best?.staff ?? null;
};

const scanWorksheetForSchedule = (
  worksheet: ExcelJS.Worksheet,
): {
  headerRowIndex: number;
  staffNameCol: number;
  colMap: Record<number, number>;
} | null => {
  let staffNameCol = 1;
  let headerRowIndex = 1;
  const bestColMap: Record<number, number> = {};
  let bestScore = -1;

  const headerScanLimit = Math.min(worksheet.rowCount, 12);
  for (let rowIdx = 1; rowIdx <= headerScanLimit; rowIdx += 1) {
    const row = worksheet.getRow(rowIdx);
    const rowColMap: Record<number, number> = {};
    let foundNameHeaderInRow = false;
    let nameColForRow = 1;

    row.eachCell((cell, colNumber) => {
      const norm = normalizeHeader(cellText(cell));
      if (!norm) return;
      if (NAME_HEADER_KEYS.has(norm)) {
        foundNameHeaderInRow = true;
        nameColForRow = colNumber;
      }
      const weekday =
        DAY_HEADER_MAP[norm] ?? DAY_HEADER_MAP[norm.replace(".", "")];
      if (weekday !== undefined) {
        rowColMap[colNumber] = weekday;
      }
    });

    const dayCount = Object.keys(rowColMap).length;
    const score = dayCount + (foundNameHeaderInRow ? 0.5 : 0);
    if (score > bestScore && score > 1) {
      bestScore = score;
      headerRowIndex = rowIdx;
      staffNameCol = foundNameHeaderInRow ? nameColForRow : staffNameCol;
      for (const key of Object.keys(bestColMap)) {
        delete bestColMap[Number(key)];
      }
      Object.assign(bestColMap, rowColMap);
    }
  }

  if (bestScore <= 1 || Object.keys(bestColMap).length === 0) {
    return null;
  }

  return { headerRowIndex, staffNameCol, colMap: bestColMap };
};

const cellText = (cell: ExcelJS.Cell): string => {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (v instanceof Date) return v.toLocaleDateString();
  const asObj = v as {
    text?: string;
    result?: string;
    richText?: Array<{ text: string }>;
    formula?: string;
  };
  if (asObj.text) return asObj.text.trim();
  if (asObj.result) return String(asObj.result).trim();
  if (Array.isArray(asObj.richText) && asObj.richText.length > 0) {
    return asObj.richText
      .map((r) => r.text)
      .join("")
      .trim();
  }
  return String(v).trim();
};

const parseWeekScheduleSheet = (
  worksheet: ExcelJS.Worksheet,
  nameLookup: NameLookup,
): {
  totalRows: number;
  recognizedRows: Array<UnresolvedImportRow & { staff: EligibleStaff }>;
  unrecognizedRows: UnresolvedImportRow[];
} => {
  const scan = scanWorksheetForSchedule(worksheet);
  if (!scan) {
    return { totalRows: 0, recognizedRows: [], unrecognizedRows: [] };
  }

  const recognizedRows: Array<UnresolvedImportRow & { staff: EligibleStaff }> = [];
  const unrecognizedRows: UnresolvedImportRow[] = [];
  const { headerRowIndex, staffNameCol, colMap } = scan;
  let totalRows = 0;

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowIndex) return;

    const name = cellText(row.getCell(staffNameCol));
    if (!name || !isLikelyStaffName(name)) return;

    const daySchedule = Object.entries(colMap).map(([colIndex, weekday]) => ({
      weekday,
      shiftVal: cellText(row.getCell(Number(colIndex))),
    }));
    const hasAnyScheduleCell = daySchedule.some(
      ({ shiftVal }) => shiftVal !== "",
    );
    if (!hasAnyScheduleCell) return;

    totalRows += 1;
    const rowData = { name, daySchedule };
    const staff = resolveStaffByName(nameLookup, name);
    if (staff) {
      recognizedRows.push({ ...rowData, staff });
    } else {
      unrecognizedRows.push(rowData);
    }
  });

  return {
    recognizedRows,
    unrecognizedRows,
    totalRows,
  };
};

const toYmdLocal = (d: Date): string => {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const formatStaffName = (fullName: string): string => {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return fullName;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}.`;
};

const sundayStart = (date: Date): Date => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun, 1=Mon...
  d.setDate(d.getDate() - day);
  return d;
};

const addDays = (date: Date, count: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);

const formatWeekLabel = (from: Date, to: Date): string => {
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = from.getMonth() === to.getMonth();
  if (sameYear && sameMonth) {
    return `${from.toLocaleString(undefined, { month: "short", day: "numeric" })} – ${to.getDate()}, ${from.getFullYear()}`;
  }
  if (sameYear) {
    return `${from.toLocaleString(undefined, { month: "short", day: "numeric" })} – ${to.toLocaleString(
      undefined,
      { month: "short", day: "numeric" },
    )}, ${from.getFullYear()}`;
  }
  return `${from.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${to.toLocaleString(
    undefined,
    { month: "short", day: "numeric", year: "numeric" },
  )}`;
};

const defaultWeekStart = (): Date => sundayStart(new Date());

const tryParseDateFromSheetName = (name: string): Date | null => {
  const norm = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm === "master" || norm.includes("template")) return null;

  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"
  ];
  
  // Try "April 26", "Apr 26", "April26", "Apr26", "4/26", "4-26"
  // Month Match: optionally followed by space or just the number
  const monthMatch = norm.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d+)/);
  if (monthMatch) {
    const monthIdx = monthNames.indexOf(monthMatch[1]);
    const day = parseInt(monthMatch[2], 10);
    const d = new Date(new Date().getFullYear(), monthIdx, day);
    if (!isNaN(d.getTime())) return sundayStart(d);
  }

  const numericMatch = norm.match(/^(\d+)[/-](\d+)/);
  if (numericMatch) {
    const month = parseInt(numericMatch[1], 10);
    const day = parseInt(numericMatch[2], 10);
    const d = new Date(new Date().getFullYear(), month - 1, day);
    if (!isNaN(d.getTime())) return sundayStart(d);
  }

  // Handle "MASTER JAN26" style - ignore these as they are likely templates
  if (norm.startsWith("master")) return null;

  return null;
};

const buildStaffPrintDocument = (
  schedules: StaffSchedule[],
  weekLabel: string,
  events: ScheduleEvent[],
  weekStart: Date,
): string => {
  const printDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const printableSchedules = schedules.filter((s) => {
    if (isExcludedStaffName(s.full_name)) return false;
    // If they have 0 working days this week (Mon-Sat AND Sun), don't show them in the printout
    const hasAnyWork = s.weekdays?.some((w) => w.works);
    return hasAnyWork;
  });
  const rowCount = Math.max(printableSchedules.length, 1);
  const compactMode = rowCount > 18;

  const sundayShifts = printableSchedules
    .filter((s) => s.weekdays?.[0]?.works)
    .map((s) => ({
      name: escapeForPrint(formatStaffName(s.full_name)),
      shift: escapeForPrint(s.weekdays?.[0]?.shift_label || "Working"),
    }));

  const sundayYmd = toYmdLocal(weekStart);
  const sundayEvents = events.filter(e => e.event_date === sundayYmd);

  let lastGroup = "";
  let rowsHtml = "";

  // 1. Store Events Row in Print
  const monToSat = [1, 2, 3, 4, 5, 6];
  const eventsHtml = `
    <tr style="background: #fff8e1">
      <td class="staff" style="font-size: 9px; font-weight: 900; background: #fff8e1">STORE EVENTS / MEETINGS</td>
      ${monToSat.map(wd => {
        const ymd = toYmdLocal(addDays(weekStart, wd));
        const dayEvents = events.filter(e => e.event_date === ymd);
        return `<td style="font-size: 8px; font-weight: 800; color: #795548; vertical-align: top; padding: 2px">
          ${dayEvents.map(e => `<div>• ${escapeForPrint(e.label)}</div>`).join("")}
        </td>`;
      }).join("")}
    </tr>
  `;
  
  rowsHtml += eventsHtml;
  
  for (const s of printableSchedules) {
    // Coarse grouping for separators: group all 'support' roles together
    const currentGroup = s.role.toLowerCase().includes("support") ? "support" : s.role.toLowerCase();
    
    if (lastGroup && currentGroup !== lastGroup) {
      rowsHtml += `
        <tr class="group-separator">
          <td colspan="7"></td>
        </tr>
      `;
    }
    lastGroup = currentGroup;

    rowsHtml += `
      <tr>
        <td class="staff">
          <div class="staff-name">${escapeForPrint(formatStaffName(s.full_name)).toUpperCase()}</div>
          <div class="staff-role">${escapeForPrint(roleLabel(s.role).toUpperCase())}</div>
        </td>
        ${printDays
          .map((_, index) => {
            const w = s.weekdays[index + 1];
            const ymd = toYmdLocal(addDays(weekStart, index + 1));
            const hasMeeting = events.some(e => e.event_date === ymd && (e.is_all_staff || e.attendees.includes(s.staff_id)));
            
            const text = escapeForPrint(
              w?.works ? w.shift_label || "Working" : "OFF",
            );
            return `
              <td class="${w?.works ? "work-cell" : "off-cell"} ${w?.is_highlighted ? "highlighted-cell" : ""}">
                ${text.toUpperCase()}
                ${hasMeeting ? `<div style="font-size: 7px; color: #795548; font-weight: 900; margin-top: 1px">[MEETING]</div>` : ""}
              </td>
            `;
          })
          .join("")}
      </tr>
    `;
  }

  const now = new Date().toLocaleString();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Staff Schedule</title>
  <style>
    @page { size: letter landscape; margin: 0; }
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100vh;
      background: #fff;
      color: #000;
    }
    body { font-family: Arial, Helvetica, sans-serif; }
    .print-page {
      width: 100%;
      height: 100vh;
      padding: 0 10mm 4mm 10mm;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .print-header {
      text-align: center;
      padding-top: 2mm;
      flex-shrink: 0;
    }
    h1 { 
      margin: 0; 
      font-size: ${compactMode ? "42px" : "52px"}; 
      font-weight: 900; 
      letter-spacing: 0.12em; 
      text-transform: uppercase; 
      line-height: 1;
    }
    .week-label { 
      margin: 0; 
      font-size: 18px; 
      font-weight: 800; 
      text-transform: uppercase; 
      color: #333;
    }
    .print-table-wrap { 
      flex-grow: 1;
      min-height: 0;
      margin: 2mm 0;
    }
    .schedule-table { 
      width: 100%; 
      height: 100%;
      border-collapse: collapse; 
      table-layout: fixed; 
      border: 2pt solid #000; 
    }
    .schedule-table th,
    .schedule-table td {
      border: 1pt solid #000;
      text-align: center;
      vertical-align: middle;
      padding: ${compactMode ? "1px" : "3px"} 2px;
    }
    .schedule-table th { 
      background: #f0f0f0; 
      color: #000; 
      font-size: 10px; 
      font-weight: 900; 
      text-transform: uppercase;
      height: ${compactMode ? "6mm" : "8mm"};
    }
    .staff { text-align: left !important; padding-left: 8px !important; width: 20%; }
    .staff-name { font-size: ${compactMode ? "13px" : "15px"}; font-weight: 900; text-transform: uppercase; line-height: 1; }
    .staff-role { font-size: 7px; color: #666; font-weight: 700; text-transform: uppercase; }
    .work-cell { font-size: ${compactMode ? "12px" : "14px"}; font-weight: 900; }
    .off-cell { color: #999; font-size: 11px; font-style: italic; font-weight: 400; text-transform: uppercase; }
    .highlighted-cell { background: #fff176 !important; border: 2pt solid #000 !important; color: #000 !important; }
    .group-separator td {
      height: ${compactMode ? "2mm" : "3mm"};
      background: #444 !important;
      border: 1pt solid #000 !important;
    }
    
    .print-footer-row { 
      display: flex; 
      justify-content: space-between; 
      align-items: flex-end; 
      flex-shrink: 0;
      padding-top: 1mm;
    }
    .print-footer-left {
      width: 50%;
      border: 2pt solid #d32f2f;
      padding: 3px 8px;
      background: #fff;
    }
    .print-footer-left h4 { 
      margin: 0 0 2px; 
      font-size: 10px; 
      font-weight: 900; 
      text-transform: uppercase; 
      border-bottom: 1pt solid #d32f2f;
      padding-bottom: 1px;
      color: #d32f2f;
    }
    .print-sunday-entry { 
      display: flex;
      flex-direction: column;
      margin-bottom: 2px;
    }
    .sun-staff-name {
      font-size: 11px;
      font-weight: 900;
      color: #000;
      text-transform: uppercase;
      line-height: 1;
    }
    .sun-staff-shift {
      font-size: 11px;
      font-weight: 900;
      color: #d32f2f;
      text-transform: uppercase;
      line-height: 1;
    }
    
    .print-footer-right { 
      width: 30%; 
      text-align: right; 
      font-size: 9px; 
      font-weight: 800; 
      text-transform: uppercase; 
      color: #666; 
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="print-page">
    <div class="print-header">
      <h1>Riverside Men's Shop</h1>
      <div class="week-label">Store Schedule: ${escapeForPrint(weekLabel)}</div>
    </div>
    
    <div class="print-table-wrap">
      <table class="schedule-table">
        <thead>
          <tr>
            <th>Staff Member</th>
            ${printDays.map((day) => `<th>${day}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div class="print-footer-row">
      <div class="print-footer-left">
        <h4>Sunday Exception Hours / Events</h4>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${
            sundayShifts.length || sundayEvents.length
              ? `
                ${sundayShifts
                  .map(
                    (s) =>
                      `<div class="print-sunday-entry">
                        <div class="sun-staff-name">${s.name}</div>
                        <div class="sun-staff-shift">${s.shift}</div>
                      </div>`,
                  )
                  .join("")}
                ${sundayEvents
                  .map(
                    (e) =>
                      `<div class="print-sunday-entry">
                        <div class="sun-staff-name" style="color: #795548">EVENT / MEETING</div>
                        <div class="sun-staff-shift" style="color: #795548">${escapeForPrint(e.label)}</div>
                      </div>`,
                  )
                  .join("")}
              `
              : `<div class="print-sunday-entry" style="color:#999; font-style:italic; font-size: 14px;">No Sunday shifts or events scheduled</div>`
          }
        </div>
      </div>
      
      <div class="print-footer-right">
        <div>Riverside OS • Staff Scheduler</div>
        <div>Authorized Week: ${escapeForPrint(weekLabel)}</div>
        <div style="margin-top: 2px; font-weight: 900; color: #000">Printed on ${now}</div>
      </div>
    </div>
  </div>
  
  <script>
    window.onload = () => {
      setTimeout(() => {
        window.print();
        // Optional: window.close(); 
      }, 250);
    };
  </script>
</body>
</html>`;
};

export default function StaffWeeklyGridView() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const canEdit =
    hasPermission("tasks.manage") || hasPermission("staff.manage_access");

  const printStyle = `
    @page {
      size: letter landscape;
      margin: 5mm;
    }
    .print-container {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .print-table {
      width: 100%;
      border-collapse: collapse;
    }
    .print-table td {
      border: 1px solid #000;
      padding: 5px;
    }
    .work-cell {
      background-color: #d9edf7;
    }
    .off-cell {
      background-color: #f2dede;
    }
    .print-footer-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
      margin-top: 20px;
    }
    .print-footer-left, .print-footer-right {
      width: 50%;
    }
    .print-sunday-entry {
      margin-bottom: 5px;
    }
  `;

  const [eligible, setEligible] = useState<EligibleStaff[]>([]);
  const [schedules, setSchedules] = useState<StaffSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [highlighterActive, setHighlighterActive] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [parseResults, setParseResults] = useState<{
    success: number;
    missing: string[];
  } | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [importedThisSession, setImportedThisSession] = useState(false);
  const [weekExceptions, setWeekExceptions] = useState<WeekException[]>([]);
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [planningMode, setPlanningMode] = useState<"week" | "template">("week");
  const [showEventModal, setShowEventModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduleEvent | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.type = "text/css";
    style.innerHTML = printStyle;
    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, [printStyle]);
  const [weekCursor, setWeekCursor] = useState(defaultWeekStart);

  const headers = useMemo(() => backofficeHeaders(), [backofficeHeaders]);
  const weekStart = useMemo(() => sundayStart(weekCursor), [weekCursor]);
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const weekStartParam = toYmdLocal(weekStart);
  const weekLabel = useMemo(
    () => formatWeekLabel(weekStart, weekEnd),
    [weekStart, weekEnd],
  );

  const hasDraft = useMemo(
    () =>
      planningMode === "week" && schedules.some((s) => s.status === "draft"),
    [schedules, planningMode],
  );
  const hasPublished = useMemo(
    () =>
      planningMode === "week" &&
      schedules.some((s) => s.status === "published"),
    [schedules, planningMode],
  );


  const coverageStats = useMemo(() => {
    const stats = Array.from({ length: 7 }, () => ({
      sales: 0,
      support: 0,
      tailors: 0,
    }));

    schedules.forEach((s) => {
      const label = roleLabel(s.role);
      s.weekdays.forEach((day, idx) => {
        if (day.works) {
          if (label === "Sales Persons") stats[idx].sales++;
          else if (label === "Support") stats[idx].support++;
          else if (label === "Tailors") stats[idx].tailors++;
        }
      });
    });

    return stats;
  }, [schedules]);

  const sortedSchedules = useMemo(() => {
    return [...schedules].sort((a, b) => {
      // Sort Natalie Neumann to the bottom as per user preference (case-insensitive)
      const nameA = normalizeName(a.full_name);
      const nameB = normalizeName(b.full_name);
      if (nameA === "natalie neumann") return 1;
      if (nameB === "natalie neumann") return -1;
      const order = roleSortOrder(a.role, a.staff_id) - roleSortOrder(b.role, b.staff_id);
      if (order !== 0) return order;
      return (a.full_name || "").localeCompare(b.full_name || "");
    });
  }, [schedules]);

  const setStaffDirty = useCallback((_staffId: string, isDirty: boolean) => {
    if (isDirty) setUnsaved(true);
  }, []);

  const updateScheduleRows = (rows: StaffSchedule[]) => {
    const sorted = [...rows].sort((a, b) => {
      const order = roleSortOrder(a.role, a.staff_id) - roleSortOrder(b.role, b.staff_id);
      if (order !== 0) return order;
      return (a.full_name || "").localeCompare(b.full_name || "");
    });
    setSchedules(sorted);
    setUnsaved(false);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const endpoints =
        planningMode === "template"
          ? [
              `${baseUrl}/api/staff/schedule/eligible`,
              `${baseUrl}/api/staff/schedule/weekly/template`,
            ]
          : [
              `${baseUrl}/api/staff/schedule/eligible`,
              `${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}`,
            ];

      const [eligRes, weekRes, excRes, eventRes] = await Promise.all([
        fetch(endpoints[0], { headers }),
        fetch(endpoints[1], { headers }),
        planningMode === "week"
          ? fetch(
              `${baseUrl}/api/staff/schedule/exceptions?from=${weekStartParam}&to=${toYmdLocal(weekEnd)}`,
              { headers },
            )
          : Promise.resolve(null),
        planningMode === "week"
          ? fetch(
              `${baseUrl}/api/staff/schedule/events?from=${weekStartParam}&to=${toYmdLocal(weekEnd)}`,
              { headers },
            )
          : Promise.resolve(null),
      ]);

      if (!eligRes.ok || !weekRes.ok) {
        throw new Error("Could not load schedule data.");
      }
      const staffList = (await eligRes.json()) as EligibleStaff[];
      const rows = (await weekRes.json()) as Array<
        Omit<StaffSchedule, "weekdays"> & { weekdays: WeeklyEntry[] }
      >;
      const visibleEligible = staffList.filter(
        (staff) => !isExcludedStaffName(staff.full_name),
      );
      setEligible(visibleEligible);

      const normalizedRows: StaffSchedule[] = rows
        .map((row) => ({
          ...row,
          weekdays: WEEKDAY_LABELS.map((_, weekday) => {
            const match = row.weekdays.find((w) => w.weekday === weekday);
            return (
              match ?? {
                weekday,
                works: false,
                shift_label: null,
                base_works: false,
                base_shift_label: null,
                is_highlighted: false,
              }
            );
          }),
        }))
        .filter((schedule) => !isExcludedStaffName(schedule.full_name));

      updateScheduleRows(normalizedRows);

      if (excRes && excRes.ok) {
        const exceptionRows = (await excRes.json()) as WeekException[];
        setWeekExceptions(
          exceptionRows.filter((ex) => !isExcludedStaffName(ex.full_name)),
        );
      } else {
        setWeekExceptions([]);
      }
      if (eventRes && eventRes.ok) {
        setEvents(await eventRes.json());
      } else {
        setEvents([]);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Load failed", "error");
    } finally {
      setLoading(false);
    }
  }, [headers, toast, weekStartParam, weekEnd, planningMode]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const toggleHighlight = (staffId: string, weekday: number) => {
    if (!canEdit) return;
    setSchedules((current) =>
      current.map((s) => {
        if (s.staff_id !== staffId) return s;
        return {
          ...s,
          weekdays: s.weekdays.map((w) => {
            if (w.weekday !== weekday) return w;
            return { ...w, is_highlighted: !w.is_highlighted };
          }),
        };
      }),
    );
    setUnsaved(true);
  };

  const handleShiftChange = (staffId: string, weekday: number, val: string) => {
    setSchedules((prev) =>
      prev.map((s) => {
        if (s.staff_id !== staffId) return s;
        const nextWeekdays = [...s.weekdays];
        const normalized = val.trim();
        const works = normalized.toUpperCase() !== "OFF" && normalized !== "";
        nextWeekdays[weekday] = {
          ...nextWeekdays[weekday],
          shift_label: works ? normalized || null : null,
          works,
        };
        return { ...s, status: s.status, weekdays: nextWeekdays };
      }),
    );
    setStaffDirty(staffId, true);
  };

  const handleAddStaff = (staffId: string) => {
    if (!canEdit) return;
    const staff = eligible.find((e) => e.id === staffId);
    if (!staff) return;

    if (schedules.some((s) => s.staff_id === staffId)) {
      toast(
        `${formatStaffName(staff.full_name)} is already in the schedule for this week.`,
        "error",
      );
      return;
    }

    const newRow: StaffSchedule = {
      staff_id: staffId,
      full_name: staff.full_name,
      role: staff.role,
      status: "draft",
      weekdays: WEEKDAY_LABELS.map((_, weekday) => ({
        weekday,
        works: false,
        shift_label: null,
        base_works: false,
        base_shift_label: null,
        is_highlighted: false,
      })),
    };

    setSchedules((prev) => {
      const next = [...prev, newRow].sort((a, b) => {
        const order = roleSortOrder(a.role, a.staff_id) - roleSortOrder(b.role, b.staff_id);
        if (order !== 0) return order;
        return (a.full_name || "").localeCompare(b.full_name || "");
      });
      return next;
    });
    setStaffDirty(staffId, true);
    toast(`${formatStaffName(staff.full_name)} added to schedule.`, "success");
  };

  const handleRemoveStaff = (staffId: string) => {
    if (!canEdit) return;
    const staff = schedules.find((s) => s.staff_id === staffId);
    if (!staff) return;

    setSchedules((prev) => prev.filter((s) => s.staff_id !== staffId));
    setUnsaved(true);
    toast(`${formatStaffName(staff.full_name)} removed from this week's schedule.`, "info");
  };

  const handleSaveAll = async () => {
    if (!canEdit) return;
    if (!unsaved) {
      toast("No changes to save for this week.", "success");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        schedules: schedules.map((s) => ({
          staff_id: s.staff_id,
          weekdays: s.weekdays.map((w) => ({
            weekday: w.weekday,
            works: w.works,
            shift_label: w.shift_label,
            is_highlighted: w.is_highlighted,
          })),
        })),
        status: planningMode === "week" && importedThisSession ? "published" : undefined,
      };

      const url =
        planningMode === "template"
          ? `${baseUrl}/api/staff/schedule/weekly/bulk`
          : `${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}`;

      const res = await fetch(url, {
        method: planningMode === "template" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(
            "Session expired. Re-enter your staff code and Access PIN, then try again.",
          );
        }
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? "Save failed");
      }

      toast(
        planningMode === "template"
          ? "Master template saved."
          : `Weekly ${importedThisSession ? "published schedule" : "draft"} saved.`,
        "success",
      );
      setImportedThisSession(false);
      await loadData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleCloneWeek = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}/clone`,
        {
          method: "POST",
          headers,
        },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? "Clone failed");
      }
      toast("Cloned previous week's published schedule.", "success");
      await loadData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Clone failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!canEdit) return;
    setPublishing(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}/publish`,
        { method: "POST", headers },
      );
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Session expired. Re-enter credentials and retry.");
        }
        const b = await res.json().catch(() => ({}));
        throw new Error(
          (b as { error?: string }).error ?? "Could not publish week.",
        );
      }
      toast("Week published. Published schedules are now active.", "success");
      await loadData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Publish failed", "error");
    } finally {
      setPublishing(false);
    }
  };

  const handleDiscardDraft = async () => {
    if (!canEdit || !hasDraft) return;
    setDiscarding(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}`,
        {
          method: "DELETE",
          headers,
        },
      );
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error("No draft found for this week.");
        }
        const b = await res.json().catch(() => ({}));
        throw new Error(
          (b as { error?: string }).error ?? "Could not clear draft.",
        );
      }
      toast("Weekly draft cleared. Template values restored.", "success");
      await loadData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Discard failed", "error");
    } finally {
      setDiscarding(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!canEdit) {
      toast(
        "You need tasks.manage or staff.manage_access to import schedules.",
        "error",
      );
      e.target.value = "";
      return;
    }

    setLoading(true);
    setParseResults(null);
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      if (workbook.worksheets.length === 0) {
        throw new Error("No worksheet found in Excel file.");
      }

      const nameLookup = buildNameLookup(eligible);
      const nextSchedules = [...schedules];
      const missingNames = new Set<string>();
      const unresolvedRows: UnresolvedImportRow[] = [];
      const matchedStaffIds = new Set<string>();
      const appliedStaffIds = new Set<string>();
      let seenSheets = 0;
      let totalParsedRows = 0;

      const applyImportRow = (
        currentSchedules: StaffSchedule[],
        staff: EligibleStaff,
        parsedDays: UnresolvedImportRow["daySchedule"],
      ) => {
        const existingIdx = currentSchedules.findIndex(
          (s) => s.staff_id === staff.id,
        );
        
        // Prepare a full 7-day schedule, defaulting to OFF for all days.
        // This ensures that days missing from the Excel sheet (like Sunday in some sheets)
        // are explicitly marked as OFF rather than falling back to the template.
        const fullWeekdays: WeeklyEntry[] = WEEKDAY_LABELS.map((_, i) => ({
          weekday: i,
          works: false,
          shift_label: null,
          base_works: false,
          base_shift_label: null,
          is_highlighted: false,
        }));

        // Apply parsed shifts from Excel
        parsedDays.forEach(({ weekday, shiftVal }) => {
          const hasShift = shiftVal !== "";
          const normalized = normalizeHeader(shiftVal);
          const works = hasShift && normalized !== "off";
          if (weekday >= 0 && weekday <= 6) {
            fullWeekdays[weekday] = {
              weekday,
              works,
              shift_label: hasShift && works ? shiftVal : null,
              base_works: false,
              base_shift_label: null,
              is_highlighted: false,
            };
          }
        });

        if (existingIdx === -1) {
          const newRow: StaffSchedule = {
            staff_id: staff.id,
            full_name: staff.full_name,
            role: staff.role,
            status: "draft",
            weekdays: fullWeekdays,
          };
          currentSchedules.push(newRow);
          setStaffDirty(staff.id, true);
        } else {
          // If we already have a row, preserve the 'base' info but update the overrides
          const existing = currentSchedules[existingIdx];
          const updatedWeekdays = fullWeekdays.map((newDay: WeeklyEntry, i: number) => ({
            ...newDay,
            base_works: existing.weekdays[i]?.base_works ?? false,
            base_shift_label: existing.weekdays[i]?.base_shift_label ?? null,
            is_highlighted: existing.weekdays[i]?.is_highlighted ?? false,
          }));

          currentSchedules[existingIdx] = {
            ...existing,
            weekdays: updatedWeekdays,
            status: "draft",
          };
          setStaffDirty(staff.id, true);
        }
      };

      // Sort worksheets to process MASTER first if it exists
      const sortedWorksheets = [...workbook.worksheets].sort((a, b) => {
        const aName = a.name.trim().toLowerCase();
        const bName = b.name.trim().toLowerCase();
        if (aName === "master") return -1;
        if (bName === "master") return 1;
        return 0;
      });

      for (const worksheet of sortedWorksheets) {
        const wsName = worksheet.name.trim().toLowerCase();
        
        let targetWeekStart: Date | null = null;
        if (planningMode === "template") {
          if (wsName !== "master") continue;
        } else {
          targetWeekStart = tryParseDateFromSheetName(worksheet.name);
          if (!targetWeekStart && wsName !== "master") continue;
          
          // If it's a MASTER sheet and we are in week mode, we can use it as a baseline if we have nothing else,
          // but usually we skip it or use it to populate the current week.
          if (wsName === "master" && seenSheets === 0) {
            targetWeekStart = weekStart;
          }
          
          if (!targetWeekStart) continue;

          // Limit to April - July for safety (Months 3 to 6)
          const m = targetWeekStart.getMonth();
          if (m < 3 || m > 6) continue;
        }

        const isCurrentWeek = planningMode === "template" 
          ? wsName === "master"
          : (targetWeekStart && targetWeekStart.getTime() === weekStart.getTime());

        const parseResult = parseWeekScheduleSheet(worksheet, nameLookup);
        if (parseResult.totalRows === 0) continue;

        // If it's for a DIFFERENT week, we save it directly to DB
        if (planningMode === "week" && targetWeekStart && !isCurrentWeek) {
          const bulkSchedules: StaffSchedule[] = [];
          for (const row of parseResult.recognizedRows) {
            // Build a full 7-day schedule for the background week
            const fullWeekdays = WEEKDAY_LABELS.map((_, i) => {
              const ds = row.daySchedule.find(d => d.weekday === i);
              const hasShift = ds && ds.shiftVal !== "";
              const normalized = ds ? normalizeHeader(ds.shiftVal) : "";
              const works = hasShift && normalized !== "off";
              return {
                weekday: i,
                works,
                shift_label: hasShift && works ? ds.shiftVal : null,
                is_highlighted: false,
              };
            });

            const entry: any = {
              staff_id: row.staff.id,
              weekdays: fullWeekdays,
            };
            bulkSchedules.push(entry);
          }
          
          if (bulkSchedules.length > 0) {
            const weekStr = toYmdLocal(sundayStart(targetWeekStart));
            await fetch(`${baseUrl}/api/staff/schedule/weeks/${weekStr}`, {
              method: "PUT",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({
                schedules: bulkSchedules,
                status: "published"
              }),
            });
            toast(`Automatically published schedule for week of ${weekStr}`, "info");
          }
          continue;
        }
        if (isCurrentWeek) {
          seenSheets += 1;
          totalParsedRows += parseResult.totalRows;
          unresolvedRows.push(...parseResult.unrecognizedRows);
          for (const row of parseResult.recognizedRows) {
            applyImportRow(nextSchedules, row.staff, row.daySchedule);
            appliedStaffIds.add(row.staff.id);
            matchedStaffIds.add(row.staff.id);
          }
        }
      }

      for (const unresolved of unresolvedRows) {
        const resolved = resolveStaffByName(
          nameLookup,
          unresolved.name,
          matchedStaffIds,
        );
        if (resolved) {
          matchedStaffIds.add(resolved.id);
          applyImportRow(nextSchedules, resolved, unresolved.daySchedule);
          appliedStaffIds.add(resolved.id);
        } else {
          missingNames.add(unresolved.name);
        }
      }

      if (appliedStaffIds.size === 0 && totalParsedRows > 0) {
        throw new Error(
          `No staff members matched the names in the Excel file. Found: ${Array.from(
            new Set(unresolvedRows.map((r) => r.name)),
          ).join(", ")}`,
        );
      }

      if (totalParsedRows === 0) {
        throw new Error(`No schedule rows were found across "${file.name}".`);
      }

      // Sort final results to ensure Natalie is at bottom
      const sortedSchedules = [...nextSchedules].sort((a, b) => {
        const nameA = normalizeName(a.full_name);
        const nameB = normalizeName(b.full_name);
        if (nameA === "natalie neumann") return 1;
        if (nameB === "natalie neumann") return -1;
        const order =
          roleSortOrder(a.role, a.staff_id) - roleSortOrder(b.role, b.staff_id);
        if (order !== 0) return order;
        return (a.full_name || "").localeCompare(b.full_name || "");
      });

      console.log("Import process complete. Applied:", appliedStaffIds.size, "Missing:", missingNames.size);
      setSchedules(sortedSchedules);
      setImportedThisSession(true);
      setUnsaved(true);
      setParseResults({
        success: appliedStaffIds.size,
        missing: Array.from(missingNames),
      });

      if (appliedStaffIds.size > 0) {
        toast(
          `Imported ${appliedStaffIds.size} staff from ${seenSheets} sheet(s) in ${file.name}. ${
            missingNames.size > 0
              ? `${missingNames.size} names were not recognized.`
              : ""
          } Click Save All Changes to persist.`,
          missingNames.size > 0 ? "info" : "success"
        );
      }

      if (missingNames.size > 0) {
        const preview = Array.from(missingNames).slice(0, 15);
        toast(
          `Unrecognized names from "${file.name}": ${preview.join(", ")}${
            missingNames.size > 15 ? "..." : ""
          }`,
          "error"
        );
      } else if (appliedStaffIds.size === 0) {
        toast(`No schedule rows found in "${file.name}".`, "error");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Excel parse failed", "error");
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  };

  if (loading && schedules.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
        <span className="ml-3 text-sm font-black text-app-text-muted">
          Loading weekly master schedule…
        </span>
      </div>
    );
  }

  const handlePrint = () => {
    const doc = buildStaffPrintDocument(sortedSchedules, weekLabel, events, sundayStart(weekCursor));
    const printWindow = window.open("", "_blank", "width=1400,height=900");
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(doc);
    printWindow.document.close();
    printWindow.focus();
    printWindow.onafterprint = () => printWindow.close();
  };

  const statusText = hasPublished
    ? "Published week"
    : hasDraft
      ? "Draft week"
      : "Template week (no per-week override)";

  return (
    <div className="flex flex-1 flex-col gap-6 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-4 print:hidden">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent shadow-sm">
            <LayoutGrid className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-xl font-black tracking-tight text-app-text">
              {planningMode === "template"
                ? "Master Template Editor"
                : "Scheduler"}
            </h3>
            <p className="text-xs font-bold text-app-text-muted">
              {planningMode === "template"
                ? "Editing the default recurring availability for all floor staff."
                : "Plan specific weeks, clone from previous, or import from Excel. Published weeks override the template."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-2xl bg-app-surface-2 p-1 border border-app-border">
          <button
            type="button"
            onClick={() => setPlanningMode("week")}
            className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
              planningMode === "week"
                ? "bg-white text-app-text shadow-sm"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            Weekly Planning
          </button>
          <button
            type="button"
            onClick={() => setPlanningMode("template")}
            className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
              planningMode === "template"
                ? "bg-white text-app-text shadow-sm"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            Master Template
          </button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 px-4 py-1.5 rounded-2xl bg-app-surface-2/40 border border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted">
          <div className="flex items-center gap-1.5" title="Request Off Conflict (PTO, Sick, etc.)">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span>Conflict</span>
          </div>
          <div className="flex items-center gap-1.5" title="Scheduled on a standard day off">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <span>Override</span>
          </div>
          <div className="flex items-center gap-1.5" title="Store Meeting or Event">
            <div className="w-4 h-4 rounded-full bg-amber-500 border border-white flex items-center justify-center text-[7px] text-white">M</div>
            <span>Meeting</span>
          </div>
          <div className="flex items-center gap-1.5" title="Manual Highlighter for Print">
            <div className="w-3 h-2 rounded-sm bg-amber-300 border border-amber-500" />
            <span>Highlight</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {planningMode === "week" && (
            <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 py-1">
              <button
                type="button"
                className="ui-btn-secondary px-3 py-1 text-xs"
                onClick={() =>
                  setWeekCursor((current) => {
                    const next = new Date(current);
                    next.setDate(next.getDate() - 7);
                    return next;
                  })
                }
              >
                Prev week
              </button>
              <CalendarRange size={14} className="text-app-text-muted" />
              <span className="text-xs font-black uppercase tracking-wider text-app-text">
                {weekLabel}
              </span>
              <button
                type="button"
                className="ui-btn-secondary px-3 py-1 text-xs"
                onClick={() =>
                  setWeekCursor((current) => {
                    const next = new Date(current);
                    next.setDate(next.getDate() + 7);
                    return next;
                  })
                }
              >
                Next week
              </button>
              <input
                type="date"
                className="ui-input h-8 w-36 px-2 text-xs"
                value={weekStartParam}
                onChange={(e) => {
                  const next = new Date(`${e.target.value}T12:00:00`);
                  if (!Number.isNaN(next.getTime())) {
                    setWeekCursor(next);
                  }
                }}
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-app-border px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            {planningMode === "template" ? "Store-wide Template" : statusText}
          </span>
          {planningMode === "week" && (
            <button
              type="button"
              className={`ui-btn-secondary flex items-center gap-2 px-3 py-2 text-xs ${
                !canEdit
                  ? "pointer-events-none cursor-not-allowed opacity-50"
                  : ""
              }`}
              disabled={!canEdit || loading}
              onClick={handleCloneWeek}
            >
              <RotateCcw size={14} />
              Copy Previous Week
            </button>
          )}
          {planningMode === "week" && (
            <button
              type="button"
              className={`ui-btn-secondary flex items-center gap-2 px-3 py-2 text-xs ${
                !canEdit
                  ? "pointer-events-none cursor-not-allowed opacity-50"
                  : ""
              }`}
              disabled={!canEdit || (!hasDraft && !hasPublished)}
              onClick={handleDiscardDraft}
            >
              {discarding ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RotateCcw size={14} />
              )}
              Clear Overrides
            </button>
          )}
          <button
            type="button"
            className={`ui-btn-secondary flex items-center gap-2 px-3 py-2 text-xs ${
              !canEdit
                ? "pointer-events-none cursor-not-allowed opacity-50"
                : ""
            }`}
            disabled={!canEdit || publishing || unsaved || !hasDraft}
            onClick={handlePublish}
          >
            {publishing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CalendarDays size={14} />
            )}
            Publish Week
          </button>
          <label
            className={`ui-btn-secondary flex cursor-pointer items-center gap-2 px-4 py-2 text-sm ${
              !canEdit
                ? "pointer-events-none cursor-not-allowed opacity-50"
                : ""
            }`}
          >
            <FileUp size={16} />
            Upload Excel
            <input
              type="file"
              accept=".xlsx"
              className="hidden"
              disabled={!canEdit || loading}
              onChange={handleFileUpload}
            />
          </label>
          <button
            type="button"
            onClick={() => setHighlighterActive(!highlighterActive)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black transition-all ${
              highlighterActive
                ? "bg-amber-400 text-black shadow-lg shadow-amber-400/20"
                : "ui-btn-secondary"
            }`}
          >
            <Highlighter size={16} />
            Highlighter
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="ui-btn-secondary flex items-center gap-2 px-4 py-2"
          >
            <Printer size={16} />
            Print
          </button>
          <button
            type="button"
            disabled={saving || !canEdit || !unsaved}
            onClick={handleSaveAll}
            className="ui-btn-primary flex items-center gap-2 px-6 py-2 shadow-lg shadow-app-accent/20"
          >
            {saving ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
            Save All Changes
          </button>
        </div>
      </div>

      {planningMode === "template" && (
        <div className="rounded-2xl border border-app-accent/20 bg-app-accent/5 p-4 print:hidden">
          <div className="flex items-center gap-2 text-app-accent">
            <AlertCircle size={18} />
            <h4 className="text-sm font-black uppercase">
              Master Template Sync
            </h4>
          </div>
          <p className="mt-1 text-xs text-app-text-muted">
            The Master Template defines the standard shifts. To sync this from your Excel file:
            <br />
            1. Ensure the first tab is named <strong>MASTER</strong>.
            <br />
            2. Click <strong>Upload Excel</strong> above.
            <br />
            3. Click <strong>Save All Changes</strong> to update the database.
          </p>
        </div>
      )}

      {planningMode === "week" && weekExceptions.length > 0 && (
        <div className="rounded-2xl border border-app-accent/20 bg-app-accent/5 p-4 print:hidden">
          <div className="flex items-center gap-2 text-app-accent">
            <CalendarDays size={18} />
            <h4 className="text-sm font-black uppercase">
              Time Off Requests This Week
            </h4>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {weekExceptions
              .filter((ex) => ex.kind !== "extra_shift")
              .map((ex) => (
                <div
                  key={ex.id}
                  className="flex items-center gap-2 rounded-xl bg-white p-2 shadow-sm dark:bg-app-surface-3"
                >
                  <div className="h-2 w-2 rounded-full bg-app-accent" />
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black uppercase text-app-text">
                      {ex.full_name || "Unknown"} — {ex.exception_date}
                    </span>
                    <span className="text-[10px] font-bold text-app-text-muted">
                      {ex.kind.replace("_", " ").toUpperCase()}:{" "}
                      {ex.notes || "No notes"}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {parseResults && parseResults.missing.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20 print:hidden">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <AlertCircle size={18} />
            <h4 className="text-sm font-black uppercase">Import Warnings</h4>
          </div>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            The following names in the Excel file did not exactly match active
            floor staff. Add them to Staff / roles in ROS first if needed.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {parseResults.missing.map((name) => (
              <span
                key={name}
                className="rounded-lg bg-amber-200/50 px-2 py-1 text-[10px] font-black dark:bg-amber-900/50"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="ui-card overflow-hidden shadow-2xl shadow-black/5 print:border-none print:shadow-none">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm table-fixed">
            <thead className="border-b border-app-border bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="w-44 px-4 py-3 sticky left-0 bg-app-surface z-10 border-r border-app-border">
                  Staff Member
                </th>
                {WEEKDAY_LABELS.map((day, i) => (
                  <th
                    key={day}
                    className={`px-4 py-3 text-center ${i === 0 ? "text-red-500/70" : ""}`}
                  >
                    {day}
                  </th>
                ))}
                <th className="w-28 px-3 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {/* Store Events Row */}
              <tr className="bg-amber-500/5 border-b-2 border-amber-500/20">
                <td className="sticky left-0 bg-amber-500/5 z-10 border-r border-app-border px-4 py-2 font-black text-amber-700 text-[11px] uppercase tracking-wider">
                  <div className="flex items-center gap-2">
                    <CalendarDays size={14} />
                    Store Events
                  </div>
                </td>
                {WEEKDAY_LABELS.map((_, i) => {
                  const ymd = toYmdLocal(addDays(sundayStart(weekCursor), i));
                  const dayEvents = events.filter((e) => e.event_date === ymd);
                  return (
                    <td key={i} className="px-2 py-1 align-top">
                      <div className="flex flex-col gap-1">
                        {dayEvents.map((e) => (
                          <div
                            key={e.id}
                            onClick={() => {
                              setEditingEvent(e);
                              setShowEventModal(true);
                            }}
                            className="group/evt relative rounded-md bg-amber-100 border border-amber-200 p-1 cursor-pointer hover:bg-amber-200 transition-colors"
                          >
                            <p className="text-[9px] font-black leading-tight text-amber-900 line-clamp-2">
                              {e.label}
                            </p>
                          </div>
                        ))}
                        {canEdit && (
                          <button
                            onClick={() => {
                              setEditingEvent({
                                id: "",
                                event_date: ymd,
                                label: "",
                                is_all_staff: true,
                                attendees: [],
                              });
                              setShowEventModal(true);
                            }}
                            className="mt-1 flex items-center justify-center gap-1 py-1 rounded-md border border-dashed border-amber-300 text-amber-600 hover:bg-amber-100 hover:border-amber-400 text-[9px] font-bold transition-all"
                          >
                            <Plus size={10} />
                            Add Event
                          </button>
                        )}
                      </div>
                    </td>
                  );
                })}
                <td className="bg-amber-500/5" />
              </tr>

              {sortedSchedules.map((s) => (
                <tr
                  key={s.staff_id}
                  className="group hover:bg-app-surface-2 transition-colors"
                >
                  <td className="sticky left-0 bg-app-surface group-hover:bg-app-surface-2 z-10 border-r border-app-border px-4 py-3 align-middle font-black text-app-text">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col truncate">
                        <div className="truncate" title={s.full_name}>
                          {formatStaffName(s.full_name)}
                        </div>
                        <div className="text-[10px] uppercase text-app-text-muted">
                          {roleLabel(s.role)}
                        </div>
                      </div>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => handleRemoveStaff(s.staff_id)}
                          className="p-1.5 rounded-lg text-app-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                          title="Remove from week"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                  {s.weekdays.map((w, i) => {
                    const ymd = toYmdLocal(addDays(sundayStart(weekCursor), i));
                    const conflict = weekExceptions.find(
                      (ex) =>
                        ex.staff_id === s.staff_id &&
                        ex.exception_date === ymd &&
                        ex.kind !== "extra_shift",
                    );
                    const isOverride = w.works && !w.base_works;
                    const isRemoved = !w.works && w.base_works;
                    
                    return (
                      <td key={i} className="px-1 py-1 align-middle">
                        <div className="relative group/cell">
                          <input
                            type="text"
                            disabled={!canEdit}
                            className={`w-full rounded-xl border-2 px-2 py-3 text-center text-xs font-black transition-all focus:border-app-accent focus:bg-white focus:ring-4 focus:ring-app-accent/5 dark:focus:bg-app-surface-3 ${
                              w.is_highlighted
                                ? "border-amber-500 bg-[#fff176] text-black shadow-lg shadow-amber-400/20"
                                : !w.works
                                  ? "border-transparent text-app-text-muted opacity-40 italic bg-transparent"
                                  : conflict
                                    ? "border-red-500 bg-red-500/5 text-red-700 dark:text-red-300 ring-2 ring-red-500/20"
                                    : "border-transparent bg-transparent text-app-text"
                            }`}
                            value={w.works ? (w.shift_label || "") : "OFF"}
                            readOnly={highlighterActive}
                            onClick={() => {
                              if (highlighterActive) {
                                toggleHighlight(s.staff_id, i);
                                return;
                              }
                            }}
                            onChange={(e) =>
                              handleShiftChange(s.staff_id, i, e.target.value)
                            }
                            placeholder="OFF"
                          />
                          {/* Conflict / Request Off Indicator */}
                          {conflict && (
                            <div 
                              className="absolute -top-1 -left-1 z-30 rounded-full bg-red-600 border-2 border-white p-0.5 text-white shadow-md animate-pulse"
                              title={`${conflict.kind.replace("_", " ")}: ${conflict.notes || "No notes"}`}
                            >
                              <AlertCircle size={10} />
                            </div>
                          )}

                           {/* Override Warning Indicator (Extra Shift: Scheduled on day off) */}
                           {isOverride && !conflict && (
                             <div 
                               className="absolute -top-1 -left-1 z-20 rounded-full bg-amber-500 border-2 border-white p-0.5 text-white shadow-sm cursor-help"
                               title={`Extra Shift: This day is normally OFF in the Master Template${w.base_shift_label ? ` (${w.base_shift_label})` : ""}`} 
                             >
                               <AlertCircle size={10} />
                             </div>
                           )}

                           {/* Removed Warning Indicator (Normally works, but marked OFF) */}
                           {isRemoved && !conflict && (
                             <div 
                               className="absolute -top-1 -left-1 z-20 rounded-full bg-slate-400 border-2 border-white p-0.5 text-white shadow-sm cursor-help"
                               title={`Removed: Normally works ${w.base_shift_label || "this day"} in Master Template`} 
                             >
                               <AlertCircle size={10} />
                             </div>
                           )}

                          {/* Event / Meeting Indicator */}
                          {planningMode === "week" && (() => {
                            const ymd = toYmdLocal(addDays(sundayStart(weekCursor), i));
                            const myEvents = events.filter(e => 
                              e.event_date === ymd && (e.is_all_staff || e.attendees.includes(s.staff_id))
                            );
                            if (myEvents.length === 0) return null;
                            return (
                              <div className="absolute -top-1 -right-1 flex gap-0.5 z-20">
                                {myEvents.map(e => (
                                  <div 
                                    key={e.id}
                                    title={`Meeting: ${e.label}${e.notes ? ` (${e.notes})` : ""}`}
                                    className="w-4 h-4 rounded-full bg-amber-500 border-2 border-white shadow-sm flex items-center justify-center text-[8px] text-white font-black"
                                  >
                                    M
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-3 py-3 text-center text-[10px] font-black">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${
                        s.status === "published"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
                          : s.status === "draft"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
                            : "bg-app-surface-2 text-app-text-muted"
                      }`}
                    >
                      {s.status ?? "Template"}
                    </span>
                  </td>
                </tr>
              ))}

              {/* Coverage Summary Row */}
              <tr className="bg-app-surface-3/50 font-black text-[10px] uppercase tracking-widest print:bg-white">
                <td className="sticky left-0 bg-app-surface-3/50 z-10 border-r border-app-border px-4 py-4 align-middle text-app-text-muted print:bg-white">
                  Daily Coverage Summary
                </td>
                {coverageStats.map((stat, i) => (
                  <td
                    key={i}
                    className="px-4 py-4 text-center border-r border-app-border last:border-r-0"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between gap-2">
                        <span className="text-app-text-muted">Sales:</span>
                        <span
                          className={
                            stat.sales > 0
                              ? "text-app-accent"
                              : "text-app-text-muted/30"
                          }
                        >
                          {stat.sales}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2 border-t border-app-border/10 pt-1">
                        <span className="text-app-text-muted">Support:</span>
                        <span
                          className={
                            stat.support > 0
                              ? "text-app-accent-blue"
                              : "text-app-text-muted/30"
                          }
                        >
                          {stat.support}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2 border-t border-app-border/10 pt-1">
                        <span className="text-app-text-muted">Tailors:</span>
                        <span
                          className={
                            stat.tailors > 0
                              ? "text-app-accent-green"
                              : "text-app-text-muted/30"
                          }
                        >
                          {stat.tailors}
                        </span>
                      </div>
                    </div>
                  </td>
                ))}
                <td className="bg-app-surface-3/50 print:bg-white"></td>
              </tr>
              {schedules.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-12 text-center text-app-text-muted italic"
                  >
                    No eligible staff found for scheduling. Add staff with
                    salesperson, support, or alterations roles first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {canEdit && (
            <div className="p-4 border-t border-app-border bg-app-surface-2/30">
              <div className="flex items-center gap-4 max-w-sm">
                <div className="relative flex-1">
                  <select
                    className="ui-input w-full pl-9 pr-4 text-xs appearance-none"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) {
                        handleAddStaff(e.target.value);
                        e.target.value = "";
                      }
                    }}
                  >
                    <option value="" disabled>
                      Add staff member to week...
                    </option>
                    {eligible
                      .filter(
                        (e) => !schedules.some((s) => s.staff_id === e.id),
                      )
                      .sort((a, b) => {
                        const orderA = roleSortOrder(a.role, a.id);
                        const orderB = roleSortOrder(b.role, b.id);
                        if (orderA !== orderB) return orderA - orderB;
                        return (a.full_name || "").localeCompare(b.full_name || "");
                      })
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {formatStaffName(e.full_name)} ({roleLabel(e.role)})
                        </option>
                      ))}
                  </select>
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted">
                    <UserPlus size={14} />
                  </div>
                </div>
                <p className="text-[10px] text-app-text-muted uppercase font-black tracking-widest">
                  {
                    eligible.filter(
                      (e) => !schedules.some((s) => s.staff_id === e.id),
                    ).length
                  }{" "}
                  Available
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <StaffEventModal
        open={showEventModal}
        onClose={() => {
          setShowEventModal(false);
          setEditingEvent(null);
        }}
        event={editingEvent}
        staffList={eligible}
        onSave={() => void loadData()}
      />
    </div>
  );
}

interface StaffEventModalProps {
  open: boolean;
  onClose: () => void;
  event: ScheduleEvent | null;
  staffList: { id: string; full_name: string; role: string }[];
  onSave: () => void;
}

function StaffEventModal({ open, onClose, event, staffList, onSave }: StaffEventModalProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [allStaff, setAllStaff] = useState(true);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (event) {
      setLabel(event.label || "");
      setNotes(event.notes || "");
      setAllStaff(event.is_all_staff);
      setAttendees(event.attendees || []);
    }
  }, [event, open]);

  const save = async () => {
    if (!label.trim()) {
      toast("Event label is required", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/staff/schedule/events`, {
        method: "POST",
        headers: { ...backofficeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          id: event?.id || null,
          event_date: event?.event_date,
          label,
          notes,
          is_all_staff: allStaff,
          attendees,
        }),
      });
      if (!res.ok) throw new Error("Failed to save event");
      toast("Event saved", "success");
      onSave();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!event?.id) return;
    if (!confirm("Are you sure you want to delete this event?")) return;
    setBusy(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/staff/schedule/events?id=${event.id}`, {
        method: "DELETE",
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete event");
      toast("Event deleted", "success");
      onSave();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!open || !event) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-3xl bg-app-surface border border-app-border shadow-2xl p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black tracking-tight text-app-text">
            {event.id ? "Edit Event" : "Add Store Event"}
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-app-surface-2">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="text-[10px] font-black uppercase text-app-text-muted mb-1 block">Label</span>
            <input 
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="ui-input w-full"
              placeholder="e.g. Monthly Store Meeting"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-black uppercase text-app-text-muted mb-1 block">Notes (Optional)</span>
            <textarea 
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="ui-input w-full h-20 py-2"
              placeholder="Meeting agenda, details..."
            />
          </label>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase text-app-text-muted">Attendance</span>
              <button 
                onClick={() => setAllStaff(!allStaff)}
                className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest transition-all ${
                  allStaff ? "bg-amber-500 text-white" : "bg-app-surface-2 text-app-text-muted"
                }`}
              >
                {allStaff ? "All Staff" : "Selected Staff Only"}
              </button>
            </div>

            {!allStaff && (
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto p-2 rounded-xl bg-app-surface-2/40 border border-app-border">
                {staffList.map(s => (
                  <label key={s.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-app-surface-2 cursor-pointer transition-colors">
                    <input 
                      type="checkbox"
                      checked={attendees.includes(s.id)}
                      onChange={e => {
                        if (e.target.checked) setAttendees([...attendees, s.id]);
                        else setAttendees(attendees.filter(id => id !== s.id));
                      }}
                      className="h-3.5 w-3.5 rounded border-app-border text-amber-500 focus:ring-amber-500/20"
                    />
                    <span className="text-[10px] font-bold text-app-text truncate">{formatStaffName(s.full_name)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          {event.id && (
            <button 
              onClick={() => void remove()}
              disabled={busy}
              className="flex items-center justify-center gap-2 p-3 rounded-2xl border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={18} />
            </button>
          )}
          <button 
            onClick={onClose}
            className="flex-1 p-3 rounded-2xl border border-app-border font-black text-[11px] uppercase tracking-widest hover:bg-app-surface-2 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={() => void save()}
            disabled={busy}
            className="flex-1 p-3 rounded-2xl bg-app-accent text-white font-black text-[11px] uppercase tracking-widest shadow-lg shadow-app-accent/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save Event"}
          </button>
        </div>
      </div>
    </div>
  );
}
