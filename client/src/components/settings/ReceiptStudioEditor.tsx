import { useCallback, useMemo } from "react";
import type { Editor } from "grapesjs";
import StudioEditor from "@grapesjs/studio-sdk/react";
import "@grapesjs/studio-sdk/style";
import { registerReceiptStudioBlocks } from "./receiptGrapesBlocks";
import {
  normalizeStudioProject,
  RECEIPT_DEVICE_ID,
} from "./ReceiptStudioLogic";

export type ReceiptStudioApi = {
  exportHtml: () => Promise<string | null>;
};

type Props = {
  licenseKey: string;
  projectJson: unknown;
  onSaveProject: (project: unknown) => Promise<void>;
  onEditorReady?: (api: ReceiptStudioApi) => void;
};

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
