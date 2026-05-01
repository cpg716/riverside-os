import { useCallback, useMemo } from "react";
import type { Editor } from "grapesjs";
import StudioEditor from "@grapesjs/studio-sdk/react";
import "@grapesjs/studio-sdk/style";

type ProjectShape = Record<string, unknown> & {
  pages?: unknown[];
};

function normalizeStudioProject(
  raw: unknown,
  fallbackComponent?: string,
): ProjectShape {
  const p = raw as ProjectShape | null;
  if (p && Array.isArray(p.pages) && p.pages.length > 0) {
    return p;
  }
  const component =
    typeof fallbackComponent === "string" && fallbackComponent.trim()
      ? fallbackComponent
      : '<section class="gjs-section" style="padding:48px 24px"><h1>Welcome</h1><p>Edit in Studio, then export HTML to your draft.</p></section>';
  return {
    pages: [
      {
        name: "Home",
        component,
      },
    ],
  };
}

export type StoreStudioApi = {
  exportHtml: () => Promise<string | null>;
};

function fileToBase64Data(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

type Props = {
  licenseKey: string;
  projectJson: unknown;
  fallbackHtml?: string;
  containerClassName?: string;
  editorClassName?: string;
  onSaveProject: (project: unknown) => Promise<void>;
  onEditorReady?: (api: StoreStudioApi) => void;
  /** When set, Studio image uploads go to `POST /api/admin/store/assets` (returns `/api/store/media/{id}` URLs). */
  studioAssetUpload?: {
    apiBaseUrl: string;
    headers: () => Record<string, string>;
  };
};

function addRosSafeBlocks(ed: Editor) {
  const blockManager = ed.BlockManager;
  if (!blockManager || blockManager.get("ros-featured-products")) return;
  blockManager.add("ros-featured-products", {
    label: "Featured products",
    category: "ROS Store",
    content:
      '<section data-ros-block="featured-products" style="padding:32px 20px;border:1px solid #e5e7eb;border-radius:12px"><h2>Featured products</h2><p>Links shoppers to the ROS-native product catalog.</p><p><a href="/shop/products">View products</a></p></section>',
  });
  blockManager.add("ros-campaign-banner", {
    label: "Campaign banner",
    category: "ROS Store",
    content:
      '<section data-ros-block="campaign-banner" style="padding:24px 20px;border:1px solid #c084fc;border-radius:12px"><h2>Campaign banner</h2><p>Add campaign copy here. Coupons, cart, checkout, tax, and inventory stay ROS-native.</p><p><a href="/shop/products">Shop now</a></p></section>',
  });
  blockManager.add("ros-store-faq", {
    label: "Store FAQ",
    category: "ROS Store",
    content:
      '<section data-ros-block="store-faq" style="padding:32px 20px"><h2>Store FAQ</h2><h3>Can I shop online?</h3><p>Yes. Product availability, cart, checkout, tax, and fulfillment are controlled by ROS.</p></section>',
  });
}

export default function StorePageStudioEditor({
  licenseKey,
  projectJson,
  fallbackHtml,
  containerClassName,
  editorClassName,
  onSaveProject,
  onEditorReady,
  studioAssetUpload,
}: Props) {
  const project = useMemo(
    () => normalizeStudioProject(projectJson, fallbackHtml),
    [fallbackHtml, projectJson],
  );

  const saveProject = useCallback(
    async (proj: unknown) => {
      await onSaveProject(proj);
    },
    [onSaveProject],
  );

  const attachApi = useCallback(
    (ed: Editor) => {
      addRosSafeBlocks(ed);
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
    <div
      className={
        containerClassName ??
        "min-h-[560px] w-full overflow-hidden rounded-xl border border-app-border bg-app-surface"
      }
    >
      <StudioEditor
        className={editorClassName ?? "h-[560px] w-full"}
        onEditor={(ed) => {
          attachApi(ed);
        }}
        options={{
          licenseKey,
          project: {
            type: "web",
            default: {
              pages: [
                {
                  name: "Home",
                  component:
                    "<h1>Fallback</h1><p>Reload if the editor fails to load.</p>",
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
          ...(studioAssetUpload
            ? {
                assets: {
                  storageType: "self" as const,
                  onUpload: async ({ files }: { files: File[] }) => {
                    const { apiBaseUrl, headers } = studioAssetUpload;
                    const out: Array<{
                      src: string;
                      name?: string;
                      mimeType?: string;
                    }> = [];
                    for (const file of files) {
                      const file_base64 = await fileToBase64Data(file);
                      const mime_type =
                        file.type && file.type.startsWith("image/")
                          ? file.type
                          : "image/png";
                      const res = await fetch(
                        `${apiBaseUrl.replace(/\/+$/, "")}/api/admin/store/assets`,
                        {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            ...headers(),
                          },
                          body: JSON.stringify({
                            file_base64,
                            mime_type,
                            filename: file.name || undefined,
                          }),
                        },
                      );
                      if (!res.ok) {
                        throw new Error("Asset upload failed");
                      }
                      const j = (await res.json()) as { src?: string };
                      const rel = typeof j.src === "string" ? j.src : "";
                      const src = rel.startsWith("http")
                        ? rel
                        : `${apiBaseUrl.replace(/\/+$/, "")}${rel}`;
                      out.push({
                        src,
                        name: file.name,
                        mimeType: mime_type,
                      });
                    }
                    return out;
                  },
                },
              }
            : {}),
        }}
      />
    </div>
  );
}
