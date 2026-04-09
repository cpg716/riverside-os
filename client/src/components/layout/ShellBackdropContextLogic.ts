import { createContext, useContext, useEffect } from "react";

export type ShellBackdropContextValue = {
  depth: number;
  push: () => void;
  pop: () => void;
};

export const ShellBackdropContext = createContext<ShellBackdropContextValue | null>(
  null,
);

/** Register an open overlay (drawer/modal) so the shell canvas can recess. */
export function useShellBackdropLayer(isOpen: boolean) {
  const ctx = useContext(ShellBackdropContext);
  useEffect(() => {
    if (!ctx || !isOpen) return;
    ctx.push();
    return () => ctx.pop();
  }, [ctx, isOpen]);
}

export function useShellBackdropDepth(): number {
  return useContext(ShellBackdropContext)?.depth ?? 0;
}
