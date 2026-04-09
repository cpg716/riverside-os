import { useCallback } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import CustomerAlterationsPanel from "../customers/CustomerAlterationsPanel";

type AlterationsWorkspaceProps = {
  highlightAlterationId?: string | null;
  onHighlightConsumed?: () => void;
};

/** Tailoring / alteration work queue (main module shell). */
export default function AlterationsWorkspace({
  highlightAlterationId,
  onHighlightConsumed,
}: AlterationsWorkspaceProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  return (
    <CustomerAlterationsPanel
      apiAuth={apiAuth}
      highlightAlterationId={highlightAlterationId ?? null}
      onHighlightConsumed={onHighlightConsumed}
    />
  );
}
