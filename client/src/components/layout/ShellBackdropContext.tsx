import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ShellBackdropContextValue = {
  depth: number;
  push: () => void;
  pop: () => void;
};

const ShellBackdropContext = createContext<ShellBackdropContextValue | null>(
  null,
);

export function ShellBackdropProvider({ children }: { children: ReactNode }) {
  const [depth, setDepth] = useState(0);
  const push = useCallback(() => setDepth((d) => d + 1), []);
  const pop = useCallback(() => setDepth((d) => Math.max(0, d - 1)), []);
  const value = useMemo(
    () => ({ depth, push, pop }),
    [depth, push, pop],
  );
  return (
    <ShellBackdropContext.Provider value={value}>
      {children}
    </ShellBackdropContext.Provider>
  );
}

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
