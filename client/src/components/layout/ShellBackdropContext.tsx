import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ShellBackdropContext } from "./ShellBackdropContextLogic";

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
