import { createContext, useContext, ReactNode } from "react";

export interface TopBarContextType {
  slotContent: ReactNode | null;
  setSlotContent: (content: ReactNode | null) => void;
}

export const TopBarContext = createContext<TopBarContextType | undefined>(undefined);

export function useTopBar() {
  const context = useContext(TopBarContext);
  if (context === undefined) {
    throw new Error("useTopBar must be used within a TopBarProvider");
  }
  return context;
}
