import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useCallback, useEffect, useMemo } from "react";
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

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
      if (!res.ok) throw new Error("Could not load eligible staff");
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

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setParseResults(null);
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const worksheet = workbook.getWorksheet(1);
      if (!worksheet) throw new Error("No worksheet found in Excel file");

      const nextSchedules = [...schedules];
      const missingNames: string[] = [];
      let successCount = 0;

      // Map Excel column names to weekdays
      // Excel likely has Name, Mon, Tue, Wed, Thu, Fri, Sat
      // Weekday index in ROS: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
      const colToWeekday: Record<string, number> = {
        "Mon": 1, "Monday": 1,
        "Tue": 2, "Tuesday": 2,
        "Wed": 3, "Wednesday": 3,
        "Thu": 4, "Thursday": 4,
        "Fri": 5, "Friday": 5,
        "Sat": 6, "Saturday": 6,
        "Sun": 0, "Sunday": 0,
      };

      const headerRow = worksheet.getRow(1);
      const colMap: Record<number, number> = {}; // Excel col index -> Weekday
      headerRow.eachCell((cell, colNumber) => {
        const val = String(cell.value).trim();
        if (colToWeekday[val] !== undefined) {
          colMap[colNumber] = colToWeekday[val];
        }
      });

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header

        const name = String(row.getCell(1).value).trim();
        if (!name) return;

        const staff = eligible.find(e => e.full_name.toLowerCase().includes(name.toLowerCase()));
        if (!staff) {
          missingNames.push(name);
          return;
        }

        let existingIdx = nextSchedules.findIndex(s => s.staff_id === staff.id);
        if (existingIdx === -1) {
          nextSchedules.push({
            staff_id: staff.id,
            staff_name: staff.full_name,
            weekdays: Array.from({ length: 7 }, (_, i) => ({ weekday: i, works: false, shift_label: null }))
          });
          existingIdx = nextSchedules.length - 1;
        }

        const staffSched = nextSchedules[existingIdx];
        Object.entries(colMap).forEach(([colInx, weekday]) => {
          const shiftVal = String(row.getCell(Number(colInx)).value).trim();
          if (shiftVal) {
            const works = shiftVal.toUpperCase() !== "OFF";
            staffSched.weekdays[weekday] = {
              weekday,
              works,
              shift_label: shiftVal === "OFF" ? null : shiftVal
            };
          }
        });
        successCount++;
      });

      setSchedules(nextSchedules);
      setParseResults({ success: successCount, missing: Array.from(new Set(missingNames)) });
      toast(`Imported ${successCount} schedules. Check summary for details.`, "success");
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
          <label className="ui-btn-secondary flex cursor-pointer items-center gap-2 px-4 py-2">
            <FileUp size={16} />
            Upload Excel
            <input type="file" accept=".xlsx" className="hidden" onChange={handleFileUpload} />
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
