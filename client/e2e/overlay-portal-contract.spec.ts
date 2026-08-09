import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const componentsRoot = fileURLToPath(new URL("../src/components", import.meta.url));

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return extname(entry.name) === ".tsx" ? [path] : [];
  });
}

test("component overlays render through the shared portal root", () => {
  const offenders = componentFiles(componentsRoot)
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("ui-overlay-backdrop") && !/createPortal\s*\(/.test(source);
    })
    .map((path) => relative(componentsRoot, path));

  expect(offenders).toEqual([]);
});
