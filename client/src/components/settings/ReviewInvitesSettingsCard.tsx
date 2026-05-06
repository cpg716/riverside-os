import { useCallback, useEffect, useState } from "react";
import { Star } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

type ReviewPolicy = {
  review_invites_enabled: boolean;
  send_review_invite_by_default: boolean;
};

type ReviewInvitesSettingsCardProps = {
  baseUrl: string;
};

export default function ReviewInvitesSettingsCard({
  baseUrl,
}: ReviewInvitesSettingsCardProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [reviewPolicy, setReviewPolicy] = useState<ReviewPolicy | null>(null);
  const [reviewPolicyLoaded, setReviewPolicyLoaded] = useState(false);
  const [reviewPolicyBusy, setReviewPolicyBusy] = useState(false);

  const loadReviewPolicy = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setReviewPolicyLoaded(false);
    try {
      const res = await fetch(`${baseUrl}/api/settings/review-policy`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as {
          review_invites_enabled?: boolean;
          send_review_invite_by_default?: boolean;
        };
        setReviewPolicy({
          review_invites_enabled: j.review_invites_enabled !== false,
          send_review_invite_by_default:
            j.send_review_invite_by_default !== false,
        });
      } else {
        setReviewPolicy({
          review_invites_enabled: true,
          send_review_invite_by_default: true,
        });
      }
    } catch {
      setReviewPolicy({
        review_invites_enabled: true,
        send_review_invite_by_default: true,
      });
    } finally {
      setReviewPolicyLoaded(true);
    }
  }, [backofficeHeaders, baseUrl, hasPermission]);

  useEffect(() => {
    void loadReviewPolicy();
  }, [loadReviewPolicy]);

  const saveReviewPolicy = async () => {
    if (!reviewPolicy || !hasPermission("settings.admin")) return;
    setReviewPolicyBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/review-policy`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          review_invites_enabled: reviewPolicy.review_invites_enabled,
          send_review_invite_by_default:
            reviewPolicy.send_review_invite_by_default,
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as {
          review_invites_enabled?: boolean;
          send_review_invite_by_default?: boolean;
        };
        setReviewPolicy({
          review_invites_enabled: j.review_invites_enabled !== false,
          send_review_invite_by_default:
            j.send_review_invite_by_default !== false,
        });
        toast("Review invite policy saved", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save review policy", "error");
      }
    } catch {
      toast("Could not save review policy", "error");
    } finally {
      setReviewPolicyBusy(false);
    }
  };

  if (!hasPermission("settings.admin")) return null;

  return (
    <section className="ui-card max-w-4xl p-4 sm:p-6 lg:p-8">
      <div className="mb-4 flex items-start gap-3">
        <Star className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Post-sale review invites
          </h3>
          <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
            Store-wide defaults for Podium review flows. The receipt summary
            still lets cashiers opt out per sale when invites are enabled.
          </p>
        </div>
      </div>
      {!reviewPolicyLoaded || !reviewPolicy ? (
        <p className="text-sm font-medium text-app-text-muted">Loading...</p>
      ) : (
        <div className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-app-border"
              checked={reviewPolicy.review_invites_enabled}
              onChange={(event) =>
                setReviewPolicy((current) =>
                  current
                    ? {
                        ...current,
                        review_invites_enabled: event.target.checked,
                      }
                    : current,
                )
              }
            />
            <span className="text-sm font-medium text-app-text">
              Enable post-sale review invites when Podium is configured.
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-3 ${
              !reviewPolicy.review_invites_enabled ? "opacity-50" : ""
            }`}
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-app-border"
              disabled={!reviewPolicy.review_invites_enabled}
              checked={reviewPolicy.send_review_invite_by_default}
              onChange={(event) =>
                setReviewPolicy((current) =>
                  current
                    ? {
                        ...current,
                        send_review_invite_by_default: event.target.checked,
                      }
                    : current,
                )
              }
            />
            <span className="text-sm font-medium text-app-text">
              Default receipt summary to send a review invite.
            </span>
          </label>
          <button
            type="button"
            disabled={reviewPolicyBusy}
            onClick={() => void saveReviewPolicy()}
            className="ui-btn-primary h-11 px-6 text-sm font-black disabled:opacity-50"
          >
            {reviewPolicyBusy ? "Saving..." : "Save review policy"}
          </button>
        </div>
      )}
    </section>
  );
}
