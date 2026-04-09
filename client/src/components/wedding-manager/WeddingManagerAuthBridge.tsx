import { useEffect } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { setWeddingManagerAuthHeadersProvider } from "./lib/api";

/** Wires Back Office staff headers into embedded wedding-manager `api.js` (REST + SSE). */
export default function WeddingManagerAuthBridge() {
  const { backofficeHeaders } = useBackofficeAuth();
  useEffect(() => {
    setWeddingManagerAuthHeadersProvider(() => backofficeHeaders());
    return () => setWeddingManagerAuthHeadersProvider(null);
  }, [backofficeHeaders]);
  return null;
}
