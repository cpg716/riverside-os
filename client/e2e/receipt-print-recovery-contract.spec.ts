import { expect, test, type Page } from "@playwright/test";

type PrintRemovalResult = { ok: true } | { ok: false; error: string };

async function preparePrintQueue(page: Page): Promise<void> {
  // Keep the page same-origin for Vite module imports without mounting App.
  // RegisterSessionBootstrap intentionally clears fabricated Register auth.
  await page.goto("/manifest.json");
  await page.evaluate(() => {
    window.sessionStorage.setItem(
      "ros.posRegisterAuth.v1",
      JSON.stringify({
        sessionId: "11111111-1111-4111-8111-111111111111",
        token: "receipt-recovery-contract-token",
        stationKey: "receipt-recovery-contract-station",
      }),
    );
  });
}

async function enqueuePrint(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<{
      enqueueFailedPrint: (job: {
        transactionId: string;
        label: string;
        printableBase64: string;
      }) => Promise<string>;
    }>;
    const queue = await dynamicImport("/src/lib/printRetryQueue.ts");
    return queue.enqueueFailedPrint({
      transactionId: "22222222-2222-4222-8222-222222222222",
      label: "Receipt print recovery contract",
      printableBase64: "UkVDRUlQVA==",
    });
  });
}

async function startPrintRemoval(page: Page, id: string): Promise<void> {
  await page.evaluate(async (printId) => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<{
      removeFailedPrintJob: (id: string) => Promise<void>;
    }>;
    const queue = await dynamicImport("/src/lib/printRetryQueue.ts");
    const removal = queue
      .removeFailedPrintJob(printId)
      .then<PrintRemovalResult>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error: String(error) }),
      );
    Object.assign(window, { __receiptPrintRemoval: removal });
  }, id);
}

async function finishPrintRemoval(page: Page): Promise<PrintRemovalResult> {
  return page.evaluate(async () => {
    const removal = (
      window as typeof window & {
        __receiptPrintRemoval?: Promise<PrintRemovalResult>;
      }
    ).__receiptPrintRemoval;
    if (!removal) throw new Error("Receipt removal was not started");
    return removal;
  });
}

async function queuedPrintIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<{
      getFailedPrintJobs: () => Promise<Array<{ id: string }>>;
    }>;
    const queue = await dynamicImport("/src/lib/printRetryQueue.ts");
    return (await queue.getFailedPrintJobs()).map((job) => job.id);
  });
}

test("receipt recovery serializes its final mirror before resolution", async ({
  page,
}) => {
  let releaseFirstMirror: (() => void) | undefined;
  const firstMirrorGate = new Promise<void>((resolve) => {
    releaseFirstMirror = resolve;
  });
  const methods: string[] = [];
  let postCount = 0;

  await page.route("**/api/recovery**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }
    methods.push(method);
    if (method === "POST") {
      postCount += 1;
      if (postCount === 1) await firstMirrorGate;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...body,
          attempt_count: body.attempt_count ?? 0,
        }),
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });

  await preparePrintQueue(page);
  const id = await enqueuePrint(page);
  await startPrintRemoval(page, id);

  await expect.poll(() => methods).toEqual(["POST"]);
  releaseFirstMirror?.();

  await expect(finishPrintRemoval(page)).resolves.toEqual({ ok: true });
  expect(methods).toEqual(["POST", "POST", "PATCH"]);
  await expect(queuedPrintIds(page)).resolves.toEqual([]);
});

test("a missing server recovery keeps the local receipt retry visible", async ({
  page,
}) => {
  const methods: string[] = [];
  await page.route("**/api/recovery**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }
    methods.push(method);
    if (method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...body,
          attempt_count: body.attempt_count ?? 0,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Recovery job not found" }),
    });
  });

  await preparePrintQueue(page);
  const id = await enqueuePrint(page);
  await startPrintRemoval(page, id);

  await expect(finishPrintRemoval(page)).resolves.toEqual({
    ok: false,
    error: expect.stringContaining("remains in Retry Failed Prints"),
  });
  expect(methods.at(-1)).toBe("PATCH");
  await expect(queuedPrintIds(page)).resolves.toEqual([id]);
});
