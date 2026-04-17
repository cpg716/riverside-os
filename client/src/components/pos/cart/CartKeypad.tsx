import React from "react";
import { Delete, Eraser } from "lucide-react";

interface CartKeypadProps {
  keypadMode: "qty" | "price";
  setKeypadMode: (mode: "qty" | "price") => void;
  keypadBuffer: string;
  onKeypadKey: (key: string) => void;
}

export const CartKeypad: React.FC<CartKeypadProps> = ({
  keypadMode,
  setKeypadMode,
  keypadBuffer,
  onKeypadKey,
}) => {
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00", "."];

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <button
          onClick={() => setKeypadMode("qty")}
          className={`flex h-10 items-center justify-center rounded-xl border-2 text-[10px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 ${
            keypadMode === "qty"
              ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20"
              : "border-app-border bg-app-surface text-app-text-muted hover:border-app-accent/40"
          }`}
        >
          Qty
        </button>
        <button
          onClick={() => setKeypadMode("price")}
          className={`flex h-10 items-center justify-center rounded-xl border-2 text-[10px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 ${
            keypadMode === "price"
              ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20"
              : "border-app-border bg-app-surface text-app-text-muted hover:border-app-accent/40"
          }`}
        >
          Price
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
        {keys.map((key) => (
          <button
            key={key}
            onClick={() => onKeypadKey(key)}
            className="flex h-full min-h-[50px] items-center justify-center rounded-2xl border-2 border-app-border bg-app-surface text-[1.35rem] font-black text-app-text shadow-sm transition-all hover:border-app-accent/40 hover:bg-app-accent/5 active:scale-[0.92] active:bg-app-accent active:text-white"
          >
            {key}
          </button>
        ))}
        <button
          onClick={() => onKeypadKey("CLEAR")}
          className="flex h-full min-h-[50px] items-center justify-center rounded-2xl border-2 border-orange-200 bg-orange-50 text-orange-600 transition-all hover:bg-orange-600 hover:text-white active:scale-95"
          title="Clear Buffer"
        >
          <Eraser size={22} />
        </button>
        <button
          onClick={() => onKeypadKey("BACKSPACE")}
          className="flex h-full min-h-[50px] items-center justify-center rounded-2xl border-2 border-app-border bg-app-surface text-app-text-muted transition-all hover:bg-app-text-muted hover:text-white active:scale-95"
          title="Backspace"
        >
          <Delete size={22} />
        </button>
        <button
          onClick={() => onKeypadKey("ENTER")}
          className="flex h-full min-h-[50px] items-center justify-center rounded-2xl border-2 border-app-accent bg-app-accent text-base font-black uppercase italic tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95"
        >
          Apply
        </button>
      </div>

      {keypadBuffer && (
        <div className="mt-2 rounded-xl bg-app-accent/10 px-3 py-1.5 text-center animate-in fade-in zoom-in duration-200">
          <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">
            Entry:{" "}
          </span>
          <span className="font-mono text-base font-bold text-app-accent">
            {keypadBuffer}
          </span>
        </div>
      )}
    </div>
  );
};
