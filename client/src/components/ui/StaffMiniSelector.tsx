import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useRef, useEffect } from "react";
import { ChevronDown, User } from "lucide-react";

interface StaffRow {
  id: string;
  full_name: string;
}

interface StaffMiniSelectorProps {
  staff: StaffRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
  showAvatar?: boolean;
}

const baseUrl = getBaseUrl();

const AvatarIcon = ({ 
  id, 
  name, 
  showAvatar, 
  avatarSize, 
  iconSize, 
  baseUrl 
}: { 
  id?: string; 
  name?: string; 
  showAvatar: boolean; 
  avatarSize: string; 
  iconSize: number; 
  baseUrl: string; 
}) => {
  if (!showAvatar) return null;
  if (!id) return (
    <div className={`${avatarSize} shrink-0 flex items-center justify-center rounded-full bg-app-border text-app-text-muted`}>
      <User size={iconSize} />
    </div>
  );
  return (
    <img
      src={`${baseUrl}/api/staff/avatar/${id}`}
      alt={name}
      className={`${avatarSize} shrink-0 rounded-full border border-app-border object-cover bg-app-surface`}
      onError={(e) => {
        const target = e.target as HTMLImageElement;
        const fallbackUrl = `${baseUrl}/api/staff/avatar/ros_default`;
        if (target.src !== fallbackUrl) {
          target.src = fallbackUrl;
        }
      }}
    />
  );
};

export default function StaffMiniSelector({
  staff,
  selectedId,
  onSelect,
  placeholder = "Select...",
  className = "",
  size = "md",
  showAvatar = true,
}: StaffMiniSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedStaff = staff.find((s) => s.id === selectedId);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const avatarSize = size === "sm" ? "h-5 w-5" : size === "lg" ? "h-10 w-10" : "h-6 w-6";
  const dropdownWidth = size === "lg" ? "w-96" : size === "sm" ? "w-44" : "w-56";
  const containerWidth = size === "lg" ? "w-96" : size === "sm" ? "w-44" : "w-56";
  const iconSize = size === "sm" ? 12 : size === "lg" ? 20 : 14;
  const buttonPadding = size === "lg" ? "px-6 py-3" : size === "sm" ? "px-2 py-1" : "px-4 py-2";
  const buttonText = size === "lg" ? "text-base" : size === "sm" ? "text-[10px]" : "text-sm";
  const dropdownItemPadding = size === "lg" ? "px-4 py-3 text-sm" : "px-2 py-2 text-xs";

  return (
    <div ref={containerRef} className={`relative flex justify-center ${className}`}>
      <div className={`${containerWidth} flex flex-col items-center`}>
        <button
          type="button"
          data-testid="staff-selector-button"
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-3 w-full rounded-xl border-2 border-app-border bg-app-surface-2 transition-all hover:border-app-accent/60 hover:bg-app-surface active:scale-[0.98] ${buttonPadding} ${buttonText} font-bold text-app-text focus:outline-none focus:ring-2 focus:ring-app-accent/20`}
        >
          <AvatarIcon 
            id={selectedStaff?.id} 
            name={selectedStaff?.full_name} 
            showAvatar={showAvatar}
            avatarSize={avatarSize}
            iconSize={iconSize}
            baseUrl={baseUrl}
          />
          <span className="flex-1 truncate text-left">
            {selectedStaff ? selectedStaff.full_name : placeholder}
          </span>
          <ChevronDown size={iconSize} className={`shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>

        {isOpen && (
          <div 
            data-testid="staff-selector-dropdown"
            className={`absolute top-full left-0 right-0 mx-auto z-[100] mt-1 ${dropdownWidth} max-h-[15rem] overflow-y-auto rounded-xl border border-app-border bg-app-surface p-1 shadow-2xl animate-in fade-in zoom-in-95 duration-150`}
          >
            <button
              type="button"
              onClick={() => {
                onSelect("");
                setIsOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-lg transition-colors hover:bg-app-surface-2 ${dropdownItemPadding} font-bold text-app-text-muted text-left`}
            >
              <AvatarIcon 
                showAvatar={showAvatar}
                avatarSize={avatarSize}
                iconSize={iconSize}
                baseUrl={baseUrl}
              />
              {placeholder}
            </button>
            <div className="my-1 h-px bg-app-border/40" />
            {staff.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                data-testid={`staff-identity-selector-${idx + 1}`}
                data-staff-id={s.id}
                onClick={() => {
                  onSelect(s.id);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg transition-colors ${
                  selectedId === s.id
                    ? "bg-app-accent/10 text-app-accent"
                    : "text-app-text hover:bg-app-surface-2"
                } ${dropdownItemPadding} font-bold`}
              >
                <AvatarIcon 
                  id={s.id} 
                  name={s.full_name} 
                  showAvatar={showAvatar}
                  avatarSize={avatarSize}
                  iconSize={iconSize}
                  baseUrl={baseUrl}
                />
                <span className="truncate">{s.full_name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}