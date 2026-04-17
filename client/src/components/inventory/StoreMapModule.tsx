import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Map as MapIcon, 
  MapPin, 
  Trash2, 
  Settings, 
  CheckCircle,
  Edit3,
  Box
} from 'lucide-react';
import { useBackofficeAuth } from '../../context/BackofficeAuthContextLogic';
import DashboardGridCard from '../ui/DashboardGridCard';

const BASE_URL = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface MapLayout {
  id: string;
  name: string;
  layout_data: Record<string, unknown>;
  is_active: boolean;
}

interface MapLocation {
  id: string;
  layout_id: string;
  name: string;
  zone_type: string;
  geometry: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export const StoreMapModule: React.FC = () => {
  const { backofficeHeaders } = useBackofficeAuth();
  const [layouts, setLayouts] = useState<MapLayout[]>([]);
  const [locations, setLocations] = useState<MapLocation[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  // Drawing state
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const [lRes, locRes] = await Promise.all([
        fetch(`${BASE_URL}/api/inventory/map/layouts`, { headers }),
        fetch(`${BASE_URL}/api/inventory/map/locations`, { headers })
      ]);
      
      if (lRes.ok && locRes.ok) {
        const lData = await lRes.json();
        const locData = await locRes.json();
        setLayouts(lData);
        setLocations(locData);
        if (lData.length > 0 && !activeLayoutId) {
          setActiveLayoutId(lData[0].id);
        }
      }
    } catch (err) {
      console.error("Failed to load map data", err);
    } finally {
      // Data loaded
    }
  }, [activeLayoutId, backofficeHeaders]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (!editMode || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    
    setIsDrawing(true);
    setDrawStart({ x, y });
    setCurrentRect({ x, y, width: 0, height: 0 });
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !currentRect || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const currentX = ((e.clientX - rect.left) / rect.width) * 100;
    const currentY = ((e.clientY - rect.top) / rect.height) * 100;
    
    setCurrentRect({
      x: Math.min(drawStart.x, currentX),
      y: Math.min(drawStart.y, currentY),
      width: Math.abs(currentX - drawStart.x),
      height: Math.abs(currentY - drawStart.y)
    });
  };

  const handleCanvasMouseUp = async () => {
    if (!isDrawing || !currentRect || !activeLayoutId) return;
    setIsDrawing(false);

    if (currentRect.width < 1 || currentRect.height < 1) {
      setCurrentRect(null);
      return;
    }

    const name = prompt("Zone Name (e.g. 'Rack A1', 'Shoes-01')");
    if (!name) {
      setCurrentRect(null);
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/inventory/map/locations`, {
        method: 'POST',
        headers: { ...backofficeHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout_id: activeLayoutId,
          name,
          zone_type: 'sales_floor',
          geometry: currentRect
        })
      });

      if (res.ok) {
        const newLoc = await res.json();
        setLocations(prev => [...prev, newLoc]);
      }
    } catch (err) {
      console.error("Failed to save location", err);
    } finally {
      setCurrentRect(null);
    }
  };

  const deleteLocation = async (id: string) => {
    if (!confirm("Remove this zone?")) return;
    try {
      const res = await fetch(`${BASE_URL}/api/inventory/map/locations/${id}`, {
        method: 'DELETE',
        headers: backofficeHeaders()
      });
      if (res.ok) {
        setLocations(prev => prev.filter(l => l.id !== id));
      }
    } catch (err) {
      console.error("Delete failed", err);
    }
  };

  const activeLayout = layouts.find(l => l.id === activeLayoutId);
  const layoutLocations = locations.filter(l => l.layout_id === activeLayoutId);

  return (
    <div className="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
      <div className="flex flex-wrap items-center justify-between gap-6 px-2">
        <div>
          <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Visual Logistics</h3>
          <h2 className="text-2xl font-black tracking-tight text-app-text">Store Floorplan · <span className="text-app-accent">{activeLayout?.name || 'Loading...'}</span></h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setEditMode(!editMode)}
            className={`flex items-center gap-2 h-12 px-6 rounded-[20px] text-[10px] font-black uppercase tracking-widest transition-all ${
              editMode 
              ? 'bg-app-accent text-white shadow-xl shadow-app-accent/30' 
              : 'bg-app-surface border border-app-border/40 text-app-text-muted hover:bg-app-surface-2'
            }`}
          >
            {editMode ? <CheckCircle size={14} /> : <Edit3 size={14} />}
            {editMode ? 'Exit Architect Mode' : 'Architect Mode'}
          </button>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_350px]">
        {/* Map Canvas */}
        <DashboardGridCard
          title="Floorplan Visualization"
          subtitle={editMode ? "Drag to define rectangular zones" : "Interactive asset mapping"}
          icon={MapIcon}
        >
          <div 
            ref={canvasRef}
            className={`relative w-full aspect-[16/9] bg-app-bg/10 rounded-[2.5rem] border-2 border-dashed transition-all overflow-hidden ${
              editMode ? 'border-app-accent/40 cursor-crosshair' : 'border-app-border/20'
            }`}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
          >
            {/* Background Grid */}
            <div className="absolute inset-0 opacity-[0.03]" style={{ 
              backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', 
              backgroundSize: '40px 40px' 
            }} />

            {/* Existing Locations */}
            {layoutLocations.map(loc => (
              <div
                key={loc.id}
                className={`absolute group border-2 rounded-xl transition-all flex flex-col items-center justify-center p-2 text-center overflow-hidden ${
                  editMode 
                  ? 'border-app-accent/40 bg-app-accent/5 hover:bg-app-accent/10' 
                  : 'border-white/10 bg-white/5 backdrop-blur-sm'
                }`}
                style={{
                  left: `${loc.geometry.x}%`,
                  top: `${loc.geometry.y}%`,
                  width: `${loc.geometry.width}%`,
                  height: `${loc.geometry.height}%`
                }}
              >
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text leading-tight">{loc.name}</p>
                {editMode && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); deleteLocation(loc.id); }}
                    className="mt-2 p-1.5 rounded-lg bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}

            {/* Current Drawing Shape */}
            {currentRect && (
              <div 
                className="absolute border-2 border-app-accent bg-app-accent/10 rounded-xl pointer-events-none"
                style={{
                  left: `${currentRect.x}%`,
                  top: `${currentRect.y}%`,
                  width: `${currentRect.width}%`,
                  height: `${currentRect.height}%`
                }}
              />
            )}

            {!editMode && layoutLocations.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-12 opacity-40">
                <MapPin size={48} className="mb-4 text-app-accent" />
                <p className="text-sm font-black uppercase tracking-[0.3em]">No Zones Defined</p>
                <p className="text-xs font-bold mt-2">Enter Architect Mode to begin mapping your store layout.</p>
              </div>
            )}
          </div>
        </DashboardGridCard>

        {/* Sidebar */}
        <div className="space-y-8">
            <DashboardGridCard
              title="Zone Ledger"
              subtitle="Physical hierarchy"
              icon={MapIcon}
            >
              <div className="space-y-4 max-h-[500px] overflow-y-auto no-scrollbar">
                {layoutLocations.length === 0 ? (
                  <div className="py-20 text-center opacity-20">
                    <Box size={32} className="mx-auto mb-3" />
                    <p className="text-[10px] font-black uppercase tracking-widest">Empty Registry</p>
                  </div>
                ) : (
                  layoutLocations.map(loc => (
                    <div key={loc.id} className="flex items-center gap-4 p-4 rounded-2xl bg-app-surface border border-app-border/40 group hover:border-app-accent/40 transition-all">
                      <div className="h-10 w-10 shrink-0 rounded-xl bg-app-surface-2 flex items-center justify-center text-app-text-muted group-hover:text-app-accent transition-colors">
                        <MapPin size={18} />
                      </div>
                      <div className="flex-1 min-w-0">
                         <p className="text-xs font-black text-app-text truncate">{loc.name}</p>
                         <p className="text-[10px] font-bold text-app-text-muted opacity-60 uppercase">{loc.zone_type}</p>
                      </div>
                      {editMode && (
                        <button 
                          onClick={() => deleteLocation(loc.id)}
                          className="h-8 w-8 flex items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </DashboardGridCard>

            <div className="p-6 rounded-[2.5rem] bg-indigo-600/10 border border-indigo-600/20">
               <div className="flex items-center gap-3 mb-3">
                 <div className="p-2 rounded-xl bg-indigo-600/20 text-indigo-500">
                    <Settings size={18} />
                 </div>
                 <h4 className="text-[10px] font-black uppercase tracking-widest text-indigo-400">Pro Tip</h4>
               </div>
               <p className="text-[11px] font-bold text-app-text leading-relaxed opacity-80">
                 Zones created here can be assigned to individual products in the <span className="text-app-accent">Product Profile</span> under the "Logistics" tab. This enables "Find in Store" functionality for POS staff.
               </p>
            </div>
        </div>
      </div>
    </div>
  );
};
