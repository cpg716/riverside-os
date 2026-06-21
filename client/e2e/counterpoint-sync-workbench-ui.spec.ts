import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workbenchRoot = path.join(repoRoot, "counterpoint-sync");
const workbenchEntrypoint = path.join(workbenchRoot, "index.mjs");
const token = "playwright-sync-token";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 7_500) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry while the local Workbench starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Counterpoint SYNC Workbench did not start");
}

function runNodeScript(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output));
    });
  });
}

test.describe("Counterpoint SYNC Workbench UI", () => {
  test.skip(
    !fs.existsSync(workbenchEntrypoint),
    "Retired standalone SYNC Workbench server is not present in the current direct-ROS Counterpoint flow.",
  );

  let child: ChildProcessWithoutNullStreams;
  let tmpDir: string;
  let baseUrl: string;

  test.beforeAll(async () => {
    const port = await freePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sync-ui-"));
    const storePath = path.join(tmpDir, "store.json");
    baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      COUNTERPOINT_SYNC_WORKBENCH_HOST: "127.0.0.1",
      COUNTERPOINT_SYNC_WORKBENCH_PORT: String(port),
      COUNTERPOINT_SYNC_WORKBENCH_TOKEN: token,
      COUNTERPOINT_SYNC_WORKBENCH_STORE: storePath,
      COUNTERPOINT_SYNC_WORKBENCH_URL: baseUrl,
    };
    child = spawn(process.execPath, [workbenchEntrypoint], {
      cwd: workbenchRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHealth(baseUrl);
    await runNodeScript(process.execPath, ["scripts/simulate-counterpoint.mjs"], workbenchRoot, env);
  });

  test.afterAll(() => {
    child?.kill("SIGTERM");
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("shows simulated run status, blockers, package preview, and AI review placeholder", async ({ page }) => {
    await page.goto(baseUrl);
    await page.getByPlaceholder("SYNC token").fill(token);
    await page.getByRole("button", { name: "Save Token" }).click();

    await expect(page.getByText("Counterpoint SYNC Workbench", { exact: true })).toBeVisible();
    await expect(page.getByText("Bridge heartbeat")).toBeVisible();
    await expect(page.getByText("Store size")).toBeVisible();
    await expect(page.getByText("Ready / Blocked")).toBeVisible();
    await expect(page.getByRole("button", { name: /Counterpoint transition/ })).toBeVisible();
    await expect(page.getByText("Inventory Counts")).toBeVisible();
    await expect(page.getByText("blocked", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("No records are changed automatically.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export AI Review Package" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Import AI Suggestions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "View AI Suggestions" })).toBeVisible();

    await page.getByRole("button", { name: "Preview package" }).first().click();
    await expect(page.getByText("Package Preview")).toBeVisible();
    await expect(page.getByText("Fingerprint")).toBeVisible();
    await expect(page.getByText("Payload rows")).toBeVisible();
    await expect(page.getByText("View raw JSON")).toBeVisible();
  });
});
