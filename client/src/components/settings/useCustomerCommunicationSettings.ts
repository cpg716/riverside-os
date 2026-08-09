import { useCallback, useEffect, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

export type SmsFeatureSettings = {
  staff_messages: boolean;
  receipts: boolean;
  ready_for_pickup: boolean;
  alteration_ready: boolean;
  appointment_confirmation: boolean;
  appointment_reminder: boolean;
  unknown_sender_welcome: boolean;
};

export type SmsTemplates = {
  ready_for_pickup: string;
  alteration_ready: string;
  unknown_sender_welcome: string;
  appointment_confirmation: string;
  appointment_reminder: string;
};

export type OperationalEmailTemplates = {
  ready_for_pickup_subject: string;
  ready_for_pickup_html: string;
  alteration_ready_subject: string;
  alteration_ready_html: string;
  appointment_confirmation_subject: string;
  appointment_confirmation_html: string;
  appointment_reminder_subject: string;
  appointment_reminder_html: string;
};

export type ReviewMessageTemplates = {
  sms_body: string;
  email_subject: string;
  email_body: string;
};

export type ReceiptMessageTemplates = {
  sms_caption: string;
  gift_sms_caption: string;
  email_subject: string;
  gift_email_subject: string;
};

export type CustomerCommunicationSettings = {
  sms_send_enabled: boolean;
  sms_features: SmsFeatureSettings;
  location_uid: string;
  templates: SmsTemplates;
  templates_effective: SmsTemplates;
  email_templates: OperationalEmailTemplates;
  email_templates_effective: OperationalEmailTemplates;
  review_templates: ReviewMessageTemplates;
  review_templates_effective: ReviewMessageTemplates;
  receipt_templates: ReceiptMessageTemplates;
  receipt_templates_effective: ReceiptMessageTemplates;
  widget_embed_enabled: boolean;
  widget_snippet_html: string;
  credentials_configured: boolean;
  oauth_authorize_url: string;
  oauth_token_url_hint: string;
};

export type CustomerCommunicationPatch = {
  sms_features?: Partial<SmsFeatureSettings>;
  location_uid?: string;
  templates?: Partial<SmsTemplates>;
  email_templates?: Partial<OperationalEmailTemplates>;
  review_templates?: Partial<ReviewMessageTemplates>;
  receipt_templates?: Partial<ReceiptMessageTemplates>;
  widget_embed_enabled?: boolean;
  widget_snippet_html?: string;
};

export function effectiveTemplateValue(
  stored: string,
  effective: string,
): string {
  return stored.trim() ? stored : effective;
}

export function useCustomerCommunicationSettings(baseUrl: string) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [settings, setSettings] =
    useState<CustomerCommunicationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${baseUrl}/api/settings/customer-communications`,
        { headers: backofficeHeaders() as Record<string, string> },
      );
      if (!response.ok) throw new Error("customer-communications");
      setSettings((await response.json()) as CustomerCommunicationSettings);
    } catch {
      toast("Customer communication settings could not be loaded.", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, baseUrl, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePatch = useCallback(
    async (patch: CustomerCommunicationPatch, successMessage: string) => {
      if (saving) return false;
      setSaving(true);
      try {
        const response = await fetch(
          `${baseUrl}/api/settings/customer-communications`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...(backofficeHeaders() as Record<string, string>),
            },
            body: JSON.stringify(patch),
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          toast(
            body.error ?? "Customer communication settings could not be saved.",
            "error",
          );
          return false;
        }
        setSettings(
          (await response.json()) as CustomerCommunicationSettings,
        );
        toast(successMessage, "success");
        return true;
      } catch {
        toast("Customer communication settings could not be saved.", "error");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [backofficeHeaders, baseUrl, saving, toast],
  );

  return { settings, setSettings, loading, saving, load, savePatch };
}
