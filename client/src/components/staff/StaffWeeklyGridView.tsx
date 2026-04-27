import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useCallback, useEffect, useMemo, type ChangeEvent } from "react";
import { 
  FileUp, 
  Printer, 
  Save, 
  Loader2, 
  AlertCircle,
  LayoutGrid
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
}

interface StaffSchedule {
  staff_id: string;
  staff_name: string;
  weekdays: WeeklyEntry[];
}

type UnresolvedImportRow = {
  name: string;
  daySchedule: Array<{ weekday: number; shiftVal: string }>;
};

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

const DAY_HEADER_MAP: Record<string, number> = {
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
  sun: 0,
  sunday: 0,
};

const NAME_HEADER_KEYS = new Set([
  "name",
  "staffname",
  "staff name",
  "employee",
  "employee name",
  "full name",
]);

const normalizeHeader = (v: unknown): string =>
  String(v ?? "")
    .toString()
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

const cleanName = (name: string): string =>
  normalizeName(name).replace(/[^a-z0-9]+/g, " ").trim();

const levenshteinDistance = (a: string, b: string): number => {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const matrix = Array.from({ length: aa.length + 1 }, (_, i) =>
    Array.from({ length: bb.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
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
  const bonusFirstToken = tokensA[0] && tokensB[0] && tokensA[0] === tokensB[0] ? -1 : 0;
  const bonusLastToken =
    tokensA.length > 1 && tokensB.length > 1 && tokensA[tokensA.length - 1] === tokensB[tokensB.length - 1]
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

      const lastInitial = `${last[0]} ${first}`;
      const lastTokenBucket = byLastToken.get(last) ?? [];
      lastTokenBucket.push(staff);
      byLastToken.set(last, lastTokenBucket);
      const lastInitialBucket = byLastInitial.get(lastInitial) ?? [];
      lastInitialBucket.push(staff);
      byLastInitial.set(lastInitial, lastInitialBucket);
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
  disambiguateSingleToken = false,
  disallowedStaffIds = new Set<string>(),
): EligibleStaff | null => {
  const normalized = normalizeName(rawName);
  if (!normalized) return null;
  const tokens = cleanName(rawName).split(/\s+/).filter(Boolean);
  const firstToken = tokens[0];

  const exact = rowsByName.exact.get(normalized);
  if (exact) return exact;

  const cleaned = cleanName(rawName);
  if (cleaned) {
    const byClean = rowsByName.byClean.get(cleaned);
    if (byClean) return byClean;
  }

  const firstTokenCandidates = firstToken
    ? rowsByName.bySingleToken.get(firstToken) ?? []
    : [];
  const singleNameCandidates = rowsByName.bySingleName.get(normalized) ?? [];
  const lastToken = tokens[tokens.length - 1];
  const lastTokenCandidates = lastToken ? rowsByName.byLastToken.get(lastToken) ?? [] : [];
  const lastInitialCandidates =
    tokens.length >= 2 && lastToken
      ? rowsByName.byLastInitial.get(`${lastToken[0]} ${tokens[0]}`) ?? []
      : [];

  const eligibleSingleNameCandidates = singleNameCandidates.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  if (eligibleSingleNameCandidates.length === 1) {
    return eligibleSingleNameCandidates[0];
  }

  const eligibleFirstTokenCandidates = disambiguateSingleToken
    ? firstTokenCandidates.filter((s) => !disallowedStaffIds.has(s.id))
    : firstTokenCandidates;
  if (eligibleFirstTokenCandidates.length === 1) return eligibleFirstTokenCandidates[0];

  if (disambiguateSingleToken && firstTokenCandidates.length > 1 && firstToken) {
    const eligible = eligibleFirstTokenCandidates;
    if (eligible.length === 1) return eligible[0];
    if (eligible.length > 1) {
      return [...eligible]
        .filter((candidate) => candidate.full_name.trim().toLowerCase().split(/\s+/).length === 1)
        .sort((a, b) =>
          a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" }),
        )[0];
    }
  }

  const eligibleLastTokenCandidates = lastTokenCandidates.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  if (eligibleLastTokenCandidates.length === 1) return eligibleLastTokenCandidates[0];

  const eligibleLastInitialCandidates = lastInitialCandidates.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  if (eligibleLastInitialCandidates.length === 1) return eligibleLastInitialCandidates[0];

  if (tokens.length >= 2) {
    const firstLast = `${tokens[0]} ${tokens[1]}`;
    const firstLastMatches = rowsByName.byFirstLast.get(firstLast) ?? [];
    const eligibleFirstLastMatches = firstLastMatches.filter((s) => !disallowedStaffIds.has(s.id));
    if (eligibleFirstLastMatches.length === 1) return eligibleFirstLastMatches[0];

    const firstInitial = `${tokens[0]} ${tokens[1][0]}`;
    const firstInitialMatches = rowsByName.byFirstInitial.get(firstInitial) ?? [];
    const eligibleFirstInitialMatches = firstInitialMatches.filter(
      (s) => !disallowedStaffIds.has(s.id),
    );
    if (eligibleFirstInitialMatches.length === 1) return eligibleFirstInitialMatches[0];
  }

  const fuzzyCandidates = rowsByName.all.filter((s) => !disallowedStaffIds.has(s.id));
  let best: { score: number; staff: EligibleStaff } | null = null;
  for (const candidate of fuzzyCandidates) {
    const score = fuzzyNameScore(rawName, candidate.full_name);
    if (score <= 3) {
      if (!best || score < best.score) {
        best = { score, staff: candidate };
      }
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
  for (let rowIdx = 1; rowIdx <= headerScanLimit; rowIdx++) {
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
      const weekday = DAY_HEADER_MAP[norm] ?? DAY_HEADER_MAP[norm.replace(".", "")];
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
      for (const k of Object.keys(bestColMap)) {
        delete bestColMap[Number(k)];
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
  recognizedRows: UnresolvedImportRow[];
  unrecognizedRows: UnresolvedImportRow[];
} => {
  const scan = scanWorksheetForSchedule(worksheet);
  if (!scan) {
    return { totalRows: 0, recognizedRows: [], unrecognizedRows: [] };
  }

  const recognizedRows: UnresolvedImportRow[] = [];
  const unrecognizedRows: UnresolvedImportRow[] = [];
  const { headerRowIndex, staffNameCol, colMap } = scan;
  let totalRows = 0;

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowIndex) return;

    const name = cellText(row.getCell(staffNameCol));
    if (!name) return;

    const daySchedule = Object.entries(colMap).map(([colInx, weekday]) => ({
      weekday,
      shiftVal: cellText(row.getCell(Number(colInx))),
    }));
    const hasAnyScheduleCell = daySchedule.some(({ shiftVal }) => shiftVal !== "");
    if (!hasAnyScheduleCell) return;

    totalRows += 1;
    const rowData = { name, daySchedule };
    const staff = resolveStaffByName(nameLookup, name, false);
    if (staff) {
      recognizedRows.push(rowData);
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

export default function StaffWeeklyGridView() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("tasks.manage") || hasPermission("staff.manage_access");

  const [eligible, setEligible] = useState<EligibleStaff[]>([]);
  const [schedules, setSchedules] = useState<StaffSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [parseResults, setParseResults] = useState<{ success: number; missing: string[] } | null>(null);

  const headers = useMemo(() => backofficeHeaders(), [backofficeHeaders]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/schedule/eligible`, { headers });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Session expired. Sign in again to access staff schedules.");
        }
        throw new Error("Could not load eligible staff");
      }
      const staffList = (await res.json()) as EligibleStaff[];
      setEligible(staffList);

      const scheduleData: StaffSchedule[] = [];
      for (const s of staffList) {
        const sRes = await fetch(`${baseUrl}/api/staff/schedule/weekly/${s.id}`, { headers });
        if (sRes.ok) {
          const rows = (await sRes.json()) as { weekday: number; works: boolean; shift_label: string | null }[];
          const weekdays = Array.from({ length: 7 }, (_, i) => {
            const row = rows.find(r => r.weekday === i);
            return row ? { ...row, shift_label: row.shift_label || null } : { weekday: i, works: false, shift_label: null };
          });
          scheduleData.push({ staff_id: s.id, staff_name: s.full_name, weekdays });
        }
      }
      setSchedules(scheduleData);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Load failed", "error");
    } finally {
      setLoading(false);
    }
  }, [headers, toast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleShiftChange = (staffId: string, weekday: number, val: string) => {
    setSchedules(prev => prev.map(s => {
      if (s.staff_id !== staffId) return s;
      const nextWeekdays = [...s.weekdays];
      const normalized = val.trim();
      const works = normalized.toUpperCase() !== "OFF" && normalized !== "";
      nextWeekdays[weekday] = { ...nextWeekdays[weekday], shift_label: normalized || null, works };
      return { ...s, weekdays: nextWeekdays };
    }));
  };

  const handleSaveAll = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const payload = {
        schedules: schedules.map(s => ({
          staff_id: s.staff_id,
          weekdays: s.weekdays.map(w => ({
            weekday: w.weekday,
            works: w.works,
            shift_label: w.shift_label
          }))
        }))
      };

      const res = await fetch(`${baseUrl}/api/staff/schedule/weekly/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Session expired. Re-enter your staff code and Access PIN, then try again.");
        }
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Bulk save failed");
      }

      toast("Weekly schedules saved successfully", "success");
      void loadData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!canEdit) {
      toast("You need tasks.manage or staff.manage_access to import schedules.", "error");
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
        let existingIdx = currentSchedules.findIndex((s) => s.staff_id === staff.id);
        if (existingIdx === -1) {
          currentSchedules.push({
            staff_id: staff.id,
            staff_name: staff.full_name,
            weekdays: Array.from({ length: 7 }, (_, i) => ({
              weekday: i,
              works: false,
              shift_label: null,
            })),
          });
          existingIdx = currentSchedules.length - 1;
        }

        const staffSched = {
          ...currentSchedules[existingIdx],
          weekdays: [...currentSchedules[existingIdx].weekdays],
        };
        parsedDays.forEach(({ weekday, shiftVal }) => {
          const hasShift = shiftVal !== "";
          const normalized = normalizeHeader(shiftVal);
          const works = hasShift && normalized !== "off";
          staffSched.weekdays[weekday] = {
            weekday,
            works,
            shift_label: hasShift && works ? shiftVal : null,
          };
        });
        currentSchedules[existingIdx] = staffSched;
      };

      for (const worksheet of workbook.worksheets) {
        const parseResult = parseWeekScheduleSheet(worksheet, nameLookup);
        if (parseResult.totalRows === 0) continue;

        seenSheets += 1;
        totalParsedRows += parseResult.totalRows;
        unresolvedRows.push(...parseResult.unrecognizedRows);

        for (const row of parseResult.recognizedRows) {
          const staff = resolveStaffByName(nameLookup, row.name, false, matchedStaffIds);
          if (!staff) {
            continue;
          }
          matchedStaffIds.add(staff.id);
          applyImportRow(nextSchedules, staff, row.daySchedule);
          appliedStaffIds.add(staff.id);
        }
      }

      for (const unresolved of unresolvedRows) {
        const resolved = resolveStaffByName(nameLookup, unresolved.name, true, matchedStaffIds);
        if (!resolved) {
          missingNames.add(unresolved.name);
          continue;
        }
        applyImportRow(nextSchedules, resolved, unresolved.daySchedule);
        matchedStaffIds.add(resolved.id);
        appliedStaffIds.add(resolved.id);
      }

      if (totalParsedRows === 0) {
        throw new Error(`No schedule rows were found across "${file.name}".`);
      }

      setSchedules(nextSchedules);
      setParseResults({
        success: appliedStaffIds.size,
        missing: Array.from(missingNames),
      });
      if (appliedStaffIds.size === 0) {
        if (missingNames.size > 0) {
          toast(
            `No names from "${file.name}" matched active schedule staff. Save was not run.`,
            "error",
          );
        } else {
          toast(`No schedule rows found in "${file.name}".`, "error");
        }
        return;
      } else {
        toast(
          `Imported ${appliedStaffIds.size} staff from ${seenSheets} sheet(s) in ${file.name}. Click Save All Changes to persist.`,
          "success",
        );
      }

      if (missingNames.size > 0) {
        const preview = Array.from(missingNames).slice(0, 20);
        toast(
          `${preview.length} names need manual matching from "${file.name}". First: ${preview.join(", ")}`,
          "error",
        );
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Excel parse failed", "error");
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (loading && schedules.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
        <span className="ml-3 font-bold text-app-text-muted">Loading schedule grid…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-4 print:hidden">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent shadow-sm">
            <LayoutGrid className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-xl font-black tracking-tight text-app-text">Weekly Master Grid</h3>
            <p className="text-xs font-bold text-app-text-muted">
              Configure standard weekly shifts for the entire team. Labels like &quot;9:30-6&quot; will show in the scheduler.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
            <label
              className={`ui-btn-secondary flex cursor-pointer items-center gap-2 px-4 py-2 ${
                !canEdit ? "pointer-events-none cursor-not-allowed opacity-50" : ""
              }`}
            >
              <FileUp size={16} />
              Upload Excel
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                disabled={!canEdit}
                onChange={handleFileUpload}
              />
            </label>
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
            disabled={saving || !canEdit}
            onClick={handleSaveAll}
            className="ui-btn-primary flex items-center gap-2 px-6 py-2 shadow-lg shadow-app-accent/20"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save All Changes
          </button>
        </div>
      </div>

      {parseResults && parseResults.missing.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20 print:hidden">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <AlertCircle size={18} />
            <h4 className="text-sm font-black uppercase">Import Warnings</h4>
          </div>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            The following names in the Excel file did not exactly match active staff in ROS. Please check spelling or add them to the system first:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {parseResults.missing.map(name => (
              <span key={name} className="rounded-lg bg-amber-200/50 px-2 py-1 text-[10px] font-black dark:bg-amber-900/50">
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
                <th className="w-48 px-4 py-4 sticky left-0 bg-app-surface z-10 border-r border-app-border">Staff Member</th>
                {WEEKDAY_LABELS.map((day, i) => (
                  <th key={day} className={`px-4 py-4 text-center ${i === 0 ? "text-red-500/70" : ""}`}>
                    {day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {schedules.map((s) => (
                <tr key={s.staff_id} className="group hover:bg-app-surface-2 transition-colors">
                  <td className="sticky left-0 bg-app-surface group-hover:bg-app-surface-2 z-10 border-r border-app-border px-4 py-3 align-middle font-black text-app-text">
                    <div className="truncate" title={s.staff_name}>{s.staff_name}</div>
                  </td>
                  {s.weekdays.map((w, i) => (
                    <td key={i} className="px-1 py-1 align-middle">
                      <input
                        type="text"
                        disabled={!canEdit}
                        className={`w-full rounded-xl border border-transparent bg-transparent px-2 py-3 text-center text-xs font-bold transition-all focus:border-app-accent focus:bg-white focus:ring-4 focus:ring-app-accent/5 dark:focus:bg-app-surface-3 ${!w.works ? "text-app-text-muted opacity-40 italic" : "text-app-text"}`}
                        value={w.shift_label || (w.works ? "" : "OFF")}
                        onChange={(e) => handleShiftChange(s.staff_id, w.weekday, e.target.value)}
                        placeholder="OFF"
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {schedules.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-app-text-muted italic">
                    No eligible staff found for scheduling. Add staff with salesperson, support, or alterations roles first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: landscape; margin: 1cm; }
          body * { visibility: hidden; }
          .print\\:hidden { display: none !important; }
          .print\\:border-none { border: none !important; }
          .print\\:shadow-none { shadow: none !important; }
          .ui-card { border: none !important; box-shadow: none !important; }
          table { width: 100% !important; border: 1px solid #eee !important; }
          th, td { border: 1px solid #eee !important; visibility: visible !important; }
          input { visibility: visible !important; border: none !important; background: transparent !important; }
          .workspace-snap { visibility: visible !important; position: absolute; left: 0; top: 0; width: 100%; }
          .workspace-snap * { visibility: visible !important; }
          .sticky { position: static !important; }
        }
      `}</style>
    </div>
  );
}
