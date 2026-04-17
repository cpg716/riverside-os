import { useState, ReactNode } from "react";
import { TopBarContext } from "./TopBarContextLogic";

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [slotContent, setSlotContent] = useState<ReactNode | null>(null);

  return (
    <TopBarContext.Provider value={{ slotContent, setSlotContent }}>
      {children}
    </TopBarContext.Provider>
  );
}
