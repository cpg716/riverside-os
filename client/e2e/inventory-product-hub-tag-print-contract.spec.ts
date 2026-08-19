import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const variationsWorkspace = readFileSync(
  fileURLToPath(
    new URL(
      "../src/components/inventory/VariationsWorkspace.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

test("Product Hub prints one or many copies from the same variation control", () => {
  expect(variationsWorkspace).toContain('const [quantityDraft, setQuantityDraft] = useState("1")');
  expect(variationsWorkspace).toContain("Print tag x {quantity");
  expect(variationsWorkspace).toContain("Array.from({ length: copiesPerVariant }");
  expect(variationsWorkspace).toContain('event.key === "Enter"');
  expect(variationsWorkspace).toContain(
    "Array.from(new Set(variantsToPrint.map((variant) => variant.id)))",
  );
});
