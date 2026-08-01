import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const componentsRoot = fileURLToPath(
  new URL("../src/components", import.meta.url),
);

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

test("full-screen component overlays are portaled above shell chrome", () => {
  const violations: string[] = [];

  for (const path of componentFiles(componentsRoot)) {
    const source = readFileSync(path, "utf8");
    if (!source.includes("fixed inset-0")) continue;

    if (!source.includes("createPortal")) {
      violations.push(`${path}: full-screen overlay is not portaled`);
    }
    if (/fixed inset-0 z-(?:[1-9]|[1-9][0-9])(?:\s|\")/.test(source)) {
      violations.push(
        `${path}: full-screen overlay uses a shell-level z-index`,
      );
    }
    if (/fixed inset-0 z-\[(?:[1-9]|[1-9][0-9])\]/.test(source)) {
      violations.push(
        `${path}: full-screen overlay uses a shell-level z-index`,
      );
    }
  }

  expect(violations).toEqual([]);
});

test("known nested workflows declare layers above their parents", () => {
  const orderModal = readFileSync(
    join(componentsRoot, "pos/OrderLoadModal.tsx"),
    "utf8",
  );
  const customerHub = readFileSync(
    join(componentsRoot, "customers/CustomerRelationshipHubDrawer.tsx"),
    "utf8",
  );

  expect(orderModal).toContain('layerClassName="z-[220]"');
  expect(customerHub).toContain('layerClassName="z-[110]"');
});
