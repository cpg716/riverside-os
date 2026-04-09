import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { RegisterGateContext } from "./RegisterGateContextLogic";

export function RegisterGateProvider({
  children,
  goToOpenRegister,
}: {
  children: ReactNode;
  goToOpenRegister: () => void;
}) {
  const stable = useCallback(() => {
    goToOpenRegister();
  }, [goToOpenRegister]);
  const v = useMemo(
    () => ({
      goToOpenRegister: stable,
    }),
    [stable],
  );
  return (
    <RegisterGateContext.Provider value={v}>{children}</RegisterGateContext.Provider>
  );
}
