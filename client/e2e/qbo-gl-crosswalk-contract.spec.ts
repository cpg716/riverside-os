import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repoFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("ROS GL catalog is complete and remains separate from QBO posting identity", async () => {
  const [migration, api, journal] = await Promise.all([
    repoFile("migrations/195_ros_qbo_gl_crosswalk.sql"),
    repoFile("server/src/api/qbo.rs"),
    repoFile("server/src/logic/qbo_journal.rs"),
  ]);

  const catalogValues = migration
    .split("INSERT INTO ros_gl_accounts")[1]
    ?.split("ON CONFLICT (account_number)")[0];
  expect(catalogValues).toBeTruthy();
  expect(catalogValues?.match(/^    \('/gm)).toHaveLength(387);
  expect(migration).toContain("ADD COLUMN IF NOT EXISTS ros_gl_account_number text");
  expect(migration).toContain("QBO account ids remain the posting destination");
  expect(api).toContain('.route("/ros-gl-accounts", get(list_ros_gl_accounts))');
  expect(api).toContain("ros_gl_account_number must be a postable account in the Riverside GL catalog");
  expect(api).toContain("SELECT name FROM qbo_accounts_cache WHERE id = $1 AND is_active = true");
  expect(journal).toContain("AND qbo_account_id IS NOT NULL");
  expect(journal).toContain("AND qbo_account_name IS NOT NULL");
});

test("mapping UI shows both GL numbers and preserves ROS references during inline fixes", async () => {
  const [matrix, settings, workspace, manual] = await Promise.all([
    repoFile("client/src/components/qbo/QboMappingMatrix.tsx"),
    repoFile("client/src/components/settings/QuickBooksSettingsPanel.tsx"),
    repoFile("client/src/components/qbo/QboWorkspace.tsx"),
    repoFile("client/src/assets/docs/qbo-mapping-matrix-manual.md"),
  ]);

  expect(matrix).toContain("ROS GL# ↔ QBO GL# review");
  expect(matrix).toContain("GL# match ·");
  expect(matrix).toContain("QBO account has no GL#");
  expect(settings).toContain("/api/qbo/ros-gl-accounts");
  expect(settings).toContain("ros_gl_account_number: rosGlAccountNumber || null");
  expect(workspace).toContain("existingRosGlAccountNumber");
  expect(workspace).toContain("GL# match / review");
  expect(manual).toContain("QBO account remains the actual posting destination");
});
