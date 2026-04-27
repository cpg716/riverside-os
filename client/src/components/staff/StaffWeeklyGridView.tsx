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
  base_works?: boolean;
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

const DAY_LABEL_BLACKLIST = new Set(["master", "note change"]);

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

const ROLE_GROUP_ORDER: Array<Array<string>> = [
  ["salesperson"],
  ["sales_support", "salesperson_support", "sales support"],
  ["staff_support", "support"],
  ["alterations", "tailor", "tailors"],
  ["admin", "administrator", "owner"],
];

const ROLE_GROUP_LABEL: Record<string, string> = {
  admin: "Executive / Owner",
  salesperson: "Sales Persons",
  sales_support: "Support",
  staff_support: "Support",
  alterations: "Tailors",
};

const roleSortOrder = (role: string): number => {
  const normalized = normalizeName(role);
  for (let i = 0; i < ROLE_GROUP_ORDER.length; i += 1) {
    if (ROLE_GROUP_ORDER[i].includes(normalized)) return i;
  }
  return ROLE_GROUP_ORDER.length;
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
  if (/\b(vac|off|hsm trunk|bridal show|note change)\b/.test(normalized)) return false;
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

  const firstTokenCandidates = firstToken ? rowsByName.bySingleToken.get(firstToken) ?? [] : [];
  const singleNameCandidates = rowsByName.bySingleName.get(normalized) ?? [];

  const eligibleSingleNameCandidates = singleNameCandidates.filter(
    (s) => !disallowedStaffIds.has(s.id),
  );
  if (eligibleSingleNameCandidates.length === 1) return eligibleSingleNameCandidates[0];

  if (tokens.length >= 2) {
    const firstInitial = `${tokens[0]} ${tokens[1][0]}`;
    const firstInitialMatches = rowsByName.byFirstInitial.get(firstInitial) ?? [];
    const eligibleFirstInitialMatches = firstInitialMatches.filter(
      (s) => !disallowedStaffIds.has(s.id),
    );
    if (eligibleFirstInitialMatches.length === 1) return eligibleFirstInitialMatches[0];

    const firstLast = `${tokens[0]} ${tokens[1]}`;
    const firstLastMatches = rowsByName.byFirstLast.get(firstLast) ?? [];
    const eligibleFirstLastMatches = firstLastMatches.filter((s) => !disallowedStaffIds.has(s.id));
    if (eligibleFirstLastMatches.length === 1) return eligibleFirstLastMatches[0];
  }

  const eligibleFirstTokenCandidates = firstTokenCandidates.filter((s) => !disallowedStaffIds.has(s.id));
  if (eligibleFirstTokenCandidates.length === 1) return eligibleFirstTokenCandidates[0];
  if (eligibleFirstTokenCandidates.length > 1) {
    // If multiple "Tom"s, pick the first one alphabetically by default
    return [...eligibleFirstTokenCandidates].sort((a, b) =>
      a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" }),
    )[0];
  }

  // FALLBACK: "Starts With" for nicknames like Sam -> Samantha
  if (normalized.length >= 2) {
    const startsWithCandidates = rowsByName.all.filter((s) => {
      const first = normalizeName(s.full_name).split(/\s+/)[0];
      return first.startsWith(normalized) && !disallowedStaffIds.has(s.id);
    });
    if (startsWithCandidates.length === 1) return startsWithCandidates[0];
  }

  const fuzzyCandidates = rowsByName.all.filter((s) => !disallowedStaffIds.has(s.id));
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
    return asObj.richText.map((r) => r.text).join("").trim();
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
    if (!name || !isLikelyStaffName(name)) return;

    const daySchedule = Object.entries(colMap).map(([colIndex, weekday]) => ({
      weekday,
      shiftVal: cellText(row.getCell(Number(colIndex))),
    }));
    const hasAnyScheduleCell = daySchedule.some(({ shiftVal }) => shiftVal !== "");
    if (!hasAnyScheduleCell) return;

    totalRows += 1;
    const rowData = { name, daySchedule };
    const staff = resolveStaffByName(nameLookup, name);
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

const toYmdLocal = (d: Date): string => {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const sundayStart = (date: Date): Date => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
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

export default function StaffWeeklyGridView() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("tasks.manage") || hasPermission("staff.manage_access");

  const [eligible, setEligible] = useState<EligibleStaff[]>([]);
  const [schedules, setSchedules] = useState<StaffSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [parseResults, setParseResults] = useState<{ success: number; missing: string[] } | null>(null);
  const [dirtyStaff, setDirtyStaff] = useState<Set<string>>(new Set());
  const [weekExceptions, setWeekExceptions] = useState<WeekException[]>([]);
  const [planningMode, setPlanningMode] = useState<"week" | "template">("week");
  const [weekCursor, setWeekCursor] = useState(defaultWeekStart);

  const headers = useMemo(() => backofficeHeaders(), [backofficeHeaders]);
  const weekStart = useMemo(() => sundayStart(weekCursor), [weekCursor]);
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const weekStartParam = toYmdLocal(weekStart);
  const weekLabel = useMemo(
    () => formatWeekLabel(weekStart, weekEnd),
    [weekStart, weekEnd],
  );

  const hasDraft = useMemo(() => planningMode === "week" && schedules.some((s) => s.status === "draft"), [schedules, planningMode]);
  const hasPublished = useMemo(() => planningMode === "week" && schedules.some((s) => s.status === "published"), [schedules, planningMode]);
  const unsaved = useMemo(() => dirtyStaff.size > 0, [dirtyStaff]);

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

  const setStaffDirty = useCallback((staffId: string, isDirty: boolean) => {
    setDirtyStaff((prev) => {
      const next = new Set(prev);
      if (isDirty) {
        next.add(staffId);
      } else {
        next.delete(staffId);
      }
      return next;
    });
  }, []);

  const setScheduleRows = (rows: StaffSchedule[]) => {
    const sorted = [...rows].sort((a, b) => {
      const order = roleSortOrder(a.role) - roleSortOrder(b.role);
      if (order !== 0) return order;
      return a.full_name.localeCompare(b.full_name);
    });
    setSchedules(sorted);
    setDirtyStaff(new Set());
  };

    const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const endpoints = planningMode === "template" 
        ? [`${baseUrl}/api/staff/schedule/eligible`, `${baseUrl}/api/staff/schedule/weekly/template`]
        : [`${baseUrl}/api/staff/schedule/eligible`, `${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}`];

      const [eligRes, weekRes, excRes] = await Promise.all([
        fetch(endpoints[0], { headers }),
        fetch(endpoints[1], { headers }),
        planningMode === "week"
          ? fetch(`${baseUrl}/api/staff/schedule/exceptions?from=${weekStartParam}&to=${toYmdLocal(weekEnd)}`, { headers })
          : Promise.resolve(null)
      ]);

      if (!eligRes.ok) {
        throw new Error("Could not load eligible staff.");
      }
      const staffList = (await eligRes.json()) as EligibleStaff[];
      setEligible(staffList);

      if (!weekRes.ok) {
        if (weekRes.status === 401) {
          throw new Error("Session expired. Sign in again to edit schedules.");
        }
        throw new Error("Could not load weekly schedules.");
      }
      const rows = (await weekRes.json()) as Array<
        Omit<StaffSchedule, "weekdays"> & { weekdays: WeeklyEntry[] }
      >;
      const normalizedRows: StaffSchedule[] = rows.map((row) => ({
        ...row,
        weekdays: WEEKDAY_LABELS.map((_, weekday) => {
          const match = row.weekdays.find((w) => w.weekday === weekday);
          return match ?? { weekday, works: false, shift_label: null };
        }),
      }));
      setScheduleRows(normalizedRows);

      if (excRes && excRes.ok) {
        setWeekExceptions(await excRes.json());
      } else {
        setWeekExceptions([]);
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
      toast(`${staff.full_name} is already in the schedule for this week.`, "info");
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
      })),
    };

    setSchedules((prev) => {
      const next = [...prev, newRow].sort((a, b) => {
        const order = roleSortOrder(a.role) - roleSortOrder(b.role);
        if (order !== 0) return order;
        return a.full_name.localeCompare(b.full_name);
      });
      return next;
    });
    setStaffDirty(staffId, true);
    toast(`${staff.full_name} added to schedule.`, "success");
  };

  const handleRemoveStaff = (staffId: string) => {
    if (!canEdit) return;
    const staff = schedules.find((s) => s.staff_id === staffId);
    if (!staff) return;

    setSchedules((prev) => prev.filter((s) => s.staff_id !== staffId));
    setDirtyStaff((prev) => {
      const next = new Set(prev);
      next.add("reconcile"); // Ensure unsaved is true
      return next;
    });
    toast(`${staff.full_name} removed from this week's schedule.`, "info");
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
          })),
        })),
      };

      const url = planningMode === "template"
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

      toast(planningMode === "template" ? "Master template saved." : "Weekly draft saved for selected week.", "success");
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
      const res = await fetch(`${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}/clone`, {
        method: "POST",
        headers,
      });
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
        throw new Error((b as { error?: string }).error ?? "Could not publish week.");
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
      const res = await fetch(`${baseUrl}/api/staff/schedule/weeks/${encodeURIComponent(weekStartParam)}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error("No draft found for this week.");
        }
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? "Could not clear draft.");
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
        const existingIdx = currentSchedules.findIndex((s) => s.staff_id === staff.id);
        if (existingIdx === -1) {
          return;
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
        staffSched.status = "draft";
        currentSchedules[existingIdx] = staffSched;
        setStaffDirty(staff.id, true);
      };

      for (const worksheet of workbook.worksheets) {
        const parseResult = parseWeekScheduleSheet(worksheet, nameLookup);
        if (parseResult.totalRows === 0) continue;

        seenSheets += 1;
        totalParsedRows += parseResult.totalRows;
        unresolvedRows.push(...parseResult.unrecognizedRows);

        for (const row of parseResult.recognizedRows) {
          const staff = resolveStaffByName(nameLookup, row.name, matchedStaffIds);
          if (!staff) continue;
          matchedStaffIds.add(staff.id);
          applyImportRow(nextSchedules, staff, row.daySchedule);
          appliedStaffIds.add(staff.id);
        }
      }

      for (const unresolved of unresolvedRows) {
        const resolved = resolveStaffByName(nameLookup, unresolved.name, matchedStaffIds);
        if (!resolved) {
          missingNames.add(unresolved.name);
          continue;
        }
        matchedStaffIds.add(resolved.id);
        applyImportRow(nextSchedules, resolved, unresolved.daySchedule);
        appliedStaffIds.add(resolved.id);
      }

      if (totalParsedRows === 0) {
        throw new Error(`No schedule rows were found across "${file.name}".`);
      }

      setSchedules([...nextSchedules]);
      setParseResults({
        success: appliedStaffIds.size,
        missing: Array.from(missingNames),
      });
      if (appliedStaffIds.size === 0) {
        if (missingNames.size > 0) {
          toast(
            `No names from "${file.name}" matched active floor staff. Save was not run.`,
            "error",
          );
        } else {
          toast(`No schedule rows found in "${file.name}".`, "error");
        }
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
    window.print();
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
              {planningMode === "template" ? "Master Template Editor" : "Scheduler"}
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
            className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
              planningMode === "template"
                ? "bg-white text-app-text shadow-sm"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            Master Template
          </button>
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
              <span className="text-xs font-black uppercase tracking-wider text-app-text">{weekLabel}</span>
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
                !canEdit ? "pointer-events-none cursor-not-allowed opacity-50" : ""
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
                !canEdit ? "pointer-events-none cursor-not-allowed opacity-50" : ""
              }`}
              disabled={!canEdit || (!hasDraft && !hasPublished)}
              onClick={handleDiscardDraft}
            >
              {discarding ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Clear Overrides
            </button>
          )}
          <button
            type="button"
            className={`ui-btn-secondary flex items-center gap-2 px-3 py-2 text-xs ${
              !canEdit ? "pointer-events-none cursor-not-allowed opacity-50" : ""
            }`}
            disabled={!canEdit || publishing || unsaved || !hasDraft}
            onClick={handlePublish}
          >
            {publishing ? <Loader2 size={14} className="animate-spin" /> : <CalendarDays size={14} />}
            Publish Week
          </button>
          <label
            className={`ui-btn-secondary flex cursor-pointer items-center gap-2 px-4 py-2 text-sm ${
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
            disabled={saving || !canEdit || !unsaved}
            onClick={handleSaveAll}
            className="ui-btn-primary flex items-center gap-2 px-6 py-2 shadow-lg shadow-app-accent/20"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save All Changes
          </button>
        </div>
      </div>

      {planningMode === "week" && weekExceptions.length > 0 && (
        <div className="rounded-2xl border border-app-accent/20 bg-app-accent/5 p-4 print:hidden">
          <div className="flex items-center gap-2 text-app-accent">
            <CalendarDays size={18} />
            <h4 className="text-sm font-black uppercase">Time Off Requests This Week</h4>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {weekExceptions
              .filter((ex) => ex.kind !== "extra_shift")
              .map((ex) => (
                <div key={ex.id} className="flex items-center gap-2 rounded-xl bg-white p-2 shadow-sm dark:bg-app-surface-3">
                  <div className="h-2 w-2 rounded-full bg-app-accent" />
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black uppercase text-app-text">
                      {ex.full_name || "Unknown"} — {ex.exception_date}
                    </span>
                    <span className="text-[10px] font-bold text-app-text-muted">
                      {ex.kind.replace("_", " ").toUpperCase()}: {ex.notes || "No notes"}
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
            The following names in the Excel file did not exactly match active floor staff. Add them to
            Staff / roles in ROS first if needed.
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
              {schedules.map((s) => (
                <tr key={s.staff_id} className="group hover:bg-app-surface-2 transition-colors">
                  <td className="sticky left-0 bg-app-surface group-hover:bg-app-surface-2 z-10 border-r border-app-border px-4 py-3 align-middle font-black text-app-text">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col truncate">
                        <div className="truncate" title={s.full_name}>
                          {s.full_name}
                        </div>
                        <div className="text-[10px] uppercase text-app-text-muted">{roleLabel(s.role)}</div>
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
                      (ex) => ex.staff_id === s.staff_id && ex.exception_date === ymd && ex.kind !== "extra_shift"
                    );
                    const isOverride = w.works && !w.base_works;

                    return (
                      <td key={i} className="px-1 py-1 align-middle">
                        <div className="relative group/cell">
                          <input
                            type="text"
                            disabled={!canEdit}
                            className={`w-full rounded-xl border-2 px-2 py-3 text-center text-xs font-black transition-all focus:border-app-accent focus:bg-white focus:ring-4 focus:ring-app-accent/5 dark:focus:bg-app-surface-3 ${
                              !w.works 
                                ? "border-transparent text-app-text-muted opacity-40 italic bg-transparent" 
                                : conflict
                                  ? "border-red-500/50 bg-red-500/5 text-red-700 dark:text-red-300"
                                  : isOverride
                                    ? "border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                                    : "border-transparent bg-transparent text-app-text"
                            }`}
                            value={w.shift_label || (w.works ? "" : "OFF")}
                            onChange={(ev) => handleShiftChange(s.staff_id, w.weekday, ev.target.value)}
                            placeholder="OFF"
                          />
                          {conflict && (
                            <div className="absolute -top-1 -right-1 z-20 rounded-full bg-red-500 p-0.5 text-white shadow-sm opacity-0 group-hover/cell:opacity-100 transition-opacity">
                              <AlertCircle size={10} />
                            </div>
                          )}
                          {isOverride && !conflict && (
                            <div className="absolute -top-1 -right-1 z-20 rounded-full bg-amber-500 p-0.5 text-white shadow-sm opacity-0 group-hover/cell:opacity-100 transition-opacity">
                              <AlertCircle size={10} />
                            </div>
                          )}
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
                  <td key={i} className="px-4 py-4 text-center border-r border-app-border last:border-r-0">
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between gap-2">
                        <span className="text-app-text-muted">Sales:</span>
                        <span className={stat.sales > 0 ? "text-app-accent" : "text-app-text-muted/30"}>
                          {stat.sales}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2 border-t border-app-border/10 pt-1">
                        <span className="text-app-text-muted">Support:</span>
                        <span className={stat.support > 0 ? "text-app-accent-blue" : "text-app-text-muted/30"}>
                          {stat.support}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2 border-t border-app-border/10 pt-1">
                        <span className="text-app-text-muted">Tailors:</span>
                        <span className={stat.tailors > 0 ? "text-app-accent-green" : "text-app-text-muted/30"}>
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
                  <td colSpan={9} className="px-4 py-12 text-center text-app-text-muted italic">
                    No eligible staff found for scheduling. Add staff with salesperson, support, or
                    alterations roles first.
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
                    <option value="" disabled>Add staff member to week...</option>
                    {eligible
                      .filter(e => !schedules.some(s => s.staff_id === e.id))
                      .sort((a, b) => a.full_name.localeCompare(b.full_name))
                      .map(e => (
                        <option key={e.id} value={e.id}>{e.full_name} ({roleLabel(e.role)})</option>
                      ))
                    }
                  </select>
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted">
                    <UserPlus size={14} />
                  </div>
                </div>
                <p className="text-[10px] text-app-text-muted uppercase font-black tracking-widest">
                  {eligible.filter(e => !schedules.some(s => s.staff_id === e.id)).length} Available
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <SchedulePrintView 
        schedules={schedules} 
        weekLabel={weekLabel} 
      />

      <style>{`
        @media screen {
          .print-only { display: none !important; }
        }
        @media print {
          @page { size: landscape; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; height: 100vh !important; overflow: hidden !important; }
          body * { visibility: hidden; }
          .print-only, .print-only * { visibility: visible !important; }
          .print-only { 
            display: block !important; 
            position: fixed !important; 
            left: 0 !important; 
            top: 0 !important; 
            width: 100% !important;
            height: 100% !important;
            background: white !important;
            color: black !important;
            padding: 0.5cm !important;
            padding-top: 0 !important;
            margin: 0 !important;
            overflow: hidden !important;
          }
          .no-print { display: none !important; }
          
          /* Force page break behavior */
          table { page-break-inside: avoid; width: 100% !important; border: 2px solid black !important; }
          tr { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

/**
 * High-fidelity print view that mimics the RMS Schedules 2026 Excel layout.
 * Designed to fit on a single landscape page for store posting.
 */
function SchedulePrintView({ 
  schedules, 
  weekLabel 
}: { 
  schedules: StaffSchedule[], 
  weekLabel: string 
}) {
  const printDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const sundayShifts = schedules
    .filter(s => s.weekdays[0].works)
    .map(s => ({ name: s.full_name, shift: s.weekdays[0].shift_label || "Working" }));

  return (
    <div className="print-only font-sans text-black">
      <div className="text-center mb-4">
        <h1 className="text-3xl font-black uppercase tracking-[0.15em] leading-tight">
          Riverside Men's Shop
        </h1>
        <div className="mt-1 h-0.5 w-48 bg-black mx-auto" />
        <p className="text-lg font-black mt-2 uppercase tracking-widest">
          Store Schedule: {weekLabel}
        </p>
      </div>

      <table className="w-full border-collapse border-[2.5px] border-black">
        <thead>
          <tr className="bg-gray-100">
            <th className="border-[1.5px] border-black p-2 text-left text-xs font-black uppercase bg-gray-200/50">
              Staff Member
            </th>
            {printDays.map((day) => (
              <th 
                key={day} 
                className="border-[1.5px] border-black p-2 text-center text-xs font-black uppercase"
              >
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.staff_id}>
              <td className="border-[1.5px] border-black px-3 py-1.5 font-black text-xs uppercase bg-gray-50/50 whitespace-nowrap">
                {s.full_name}
                <div className="text-[8px] font-bold text-gray-500 leading-tight">
                  {s.role.replace("_", " ")}
                </div>
              </td>
              {s.weekdays.slice(1).map((w, i) => (
                <td 
                  key={i} 
                  className={`border-[1.5px] border-black px-2 py-1.5 text-center text-[11px] font-black ${
                    !w.works ? "bg-gray-100 text-gray-400 italic" : "text-black"
                  }`}
                >
                  {w.works ? (w.shift_label || "Working") : "OFF"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex justify-between items-start gap-8">
        <div className="flex-1">
          {sundayShifts.length > 0 && (
            <div className="border-[2px] border-red-600 p-2 rounded-sm bg-red-50/30">
              <h4 className="text-[10px] font-black uppercase text-red-600 tracking-widest mb-1">
                Sunday Exception Hours / Events
              </h4>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {sundayShifts.map(ss => (
                  <div key={ss.name} className="text-[11px] font-black text-red-700">
                    {ss.name}: <span className="uppercase">{ss.shift}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="text-right text-[9px] font-black uppercase tracking-widest text-gray-400 whitespace-nowrap pt-1">
          <div>Riverside OS • Staff Scheduler</div>
          <div>Authorized Week: {weekLabel}</div>
          <div className="mt-1">Printed {new Date().toLocaleDateString()}</div>
        </div>
      </div>
    </div>
  );
}
