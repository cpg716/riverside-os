import { useCallback, useMemo } from "react";
import type { Editor } from "grapesjs";
import StudioEditor from "@grapesjs/studio-sdk/react";
import "@grapesjs/studio-sdk/style";
import { registerReceiptStudioBlocks } from "./receiptGrapesBlocks";

type ProjectShape = Record<string, unknown> & {
  pages?: unknown[];
};

function normalizeStudioProject(raw: unknown): ProjectShape {
  const p = raw as ProjectShape | null;
  if (p && Array.isArray(p.pages) && p.pages.length > 0) {
    return p;
  }
  return {
    pages: [
      {
        name: "Receipt",
        component: DEFAULT_RECEIPT_DOCUMENT_HTML,
      },
    ],
  };
}

/** Placeholders are merged server-side (see `receipt_studio_html.rs`). */
const DEFAULT_RECEIPT_DOCUMENT_HTML = `<div class="ros-receipt-root" style="box-sizing:border-box;max-width:576px;font-family:system-ui,-apple-system,sans-serif;padding:16px;font-size:12px;line-height:1.35;color:#111">
  <h1 style="margin:0 0 8px;font-size:16px;font-weight:800;text-align:center">{{ROS_STORE_NAME}}</h1>
  <p style="margin:0 0 4px;text-align:center">{{ROS_ORDER_DATE}}</p>
  <p style="margin:0 0 4px;text-align:center;font-weight:700">Order {{ROS_ORDER_ID}}</p>
  <p style="margin:0 0 8px;text-align:center">{{ROS_CUSTOMER_NAME}}</p>
  <div style="margin:8px 0">{{ROS_ITEMS_TABLE}}</div>
  <p style="margin:8px 0 0"><strong>Payment</strong> {{ROS_PAYMENT_SUMMARY}}</p>
  <p style="margin:4px 0">Total {{ROS_TOTAL}} · Paid {{ROS_AMOUNT_PAID}} · Due {{ROS_BALANCE_DUE}}</p>
  <p style="margin:4px 0 0;font-size:11px">Status {{ROS_STATUS}}</p>
  <div style="margin-top:12px;padding-top:8px;border-top:1px dashed #ccc;font-size:10px;color:#444;text-align:center">{{ROS_FOOTER_LINES}}</div>
</div>`;

/** Epson TM-m30III ~80 mm printable column ≈ 576 dots at 203 dpi — canvas device for WYSIWYG. */
const RECEIPT_DEVICE_ID = "epson-tm-m30-80mm";

export type ReceiptStudioApi = {
  exportHtml: () => Promise<string | null>;
};

type Props = {
  licenseKey: string;
  projectJson: unknown;
  onSaveProject: (project: unknown) => Promise<void>;
  onEditorReady?: (api: ReceiptStudioApi) => void;
};

export function defaultReceiptStudioProjectPages() {
  return normalizeStudioProject(null);
}

export default function ReceiptStudioEditor({
  licenseKey,
  projectJson,
  onSaveProject,
  onEditorReady,
}: Props) {
  const project = useMemo(
    () => normalizeStudioProject(projectJson),
    [projectJson],
  );

  const saveProject = useCallback(
    async (proj: unknown) => {
      await onSaveProject(proj);
    },
    [onSaveProject],
  );

  const attachApi = useCallback(
    (ed: Editor) => {
      registerReceiptStudioBlocks(ed);
      onEditorReady?.({
        exportHtml: async () => {
          try {
            const files = (await ed.runCommand("studio:projectFiles", {
              styles: "inline",
            })) as Array<{ mimeType?: string; content?: string }> | null;
            if (!files || !Array.isArray(files)) return null;
            const html = files.find((f) => f.mimeType === "text/html")?.content;
            return typeof html === "string" ? html : null;
          } catch {
            return null;
          }
        },
      });
    },
    [onEditorReady],
  );

  return (
    <div className="min-h-[560px] w-full overflow-hidden rounded-xl border border-app-border bg-app-surface">
      <StudioEditor
        className="h-[560px] w-full"
        onEditor={(ed) => {
          attachApi(ed);
        }}
        options={{
          licenseKey,
          devices: {
            selected: RECEIPT_DEVICE_ID,
            default: [
              {
                id: RECEIPT_DEVICE_ID,
                name: "Epson TM-m30III (80mm)",
                width: "576px",
                widthMedia: "576px",
              },
            ],
          },
          plugins: [
            {
              id: "grapesjs-preset-printable",
              src: "https://cdn.jsdelivr.net/npm/grapesjs-preset-printable@1.0.6/dist/index.min.js",
              options: {
                fileType: "html",
              },
            },
          ],
          project: {
            type: "document",
            default: {
              pages: [
                {
                  name: "Receipt",
                  component:
                    "<p>Fallback — reload if the editor fails to load.</p>",
                },
              ],
            },
          },
          storage: {
            type: "self",
            autosaveChanges: 8,
            project,
            onSave: async ({ project: proj }) => {
              await saveProject(proj);
            },
          },
        }}
      />
    </div>
  );
}
