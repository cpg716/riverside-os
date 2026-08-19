import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const drawerPath = new URL(
  "../src/components/pos/NexoCheckoutDrawer.tsx",
  import.meta.url,
);

test("Check tender requires its number before it can be applied", async () => {
  const source = await readFile(drawerPath, "utf8");

  expect(source).toContain(
    'if (tab === "check" && normalizedCheckNumber.length === 0)',
  );
  expect(source).toContain(
    '(tab === "check" && checkNumber.trim().length === 0)',
  );
  expect(source).toContain("check_number: normalizedCheckNumber");
  expect(source).not.toContain("check_number: checkNumber.trim() || null");
});
