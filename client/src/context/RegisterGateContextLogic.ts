import { createContext, useContext } from "react";

export type RegisterGateContextValue = {
  /** Switch to POS and Register tab so staff can open or join a till. */
  goToOpenRegister: () => void;
};

export const RegisterGateContext = createContext<RegisterGateContextValue | null>(null);

export function useRegisterGate(): RegisterGateContextValue {
  const v = useContext(RegisterGateContext);
  if (!v) {
    return {
      goToOpenRegister: () => {
        /* no-op if provider missing */
      },
    };
  }
  return v;
}
