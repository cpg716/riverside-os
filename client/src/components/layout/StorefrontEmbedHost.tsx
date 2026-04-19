import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useRef } from "react";

/**
 * When `VITE_STOREFRONT_EMBEDS=true`, loads `/api/public/storefront-embeds` once and injects
 * the configured Podium widget snippet. Use only on public storefront builds — not the staff shell.
 */
export default function StorefrontEmbedHost() {
  const done = useRef(false);

  useEffect(() => {
    const enabled = import.meta.env.VITE_STOREFRONT_EMBEDS === "true";
    if (!enabled || done.current) return;

    const baseUrl = getBaseUrl();

    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/public/storefront-embeds`);
        if (!res.ok) return;
        const j = (await res.json()) as {
          podium_widget?: { enabled: boolean; snippet_html: string };
        };
        const w = j.podium_widget;
        if (!w?.enabled || !w.snippet_html.trim()) return;

        const wrap = document.createElement("div");
        wrap.setAttribute("data-ros-storefront-embed", "podium");
        wrap.innerHTML = w.snippet_html;
        document.body.appendChild(wrap);

        wrap.querySelectorAll("script").forEach((oldScript) => {
          const s = document.createElement("script");
          for (const attr of oldScript.attributes) {
            s.setAttribute(attr.name, attr.value);
          }
          s.textContent = oldScript.textContent;
          oldScript.replaceWith(s);
        });

        done.current = true;
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return null;
}
