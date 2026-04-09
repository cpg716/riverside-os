import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

type RegisterGateContextValue = {
  /** Switch to POS and Register tab so staff can open or join a till. */
  goToOpenRegister: () => void;
};

const RegisterGateContext = createContext<RegisterGateContextValue | null>(null);

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
