import { expect, test, type Page } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import { enterPosShell } from "./helpers/openPosRegister";
import { ensureSessionAuth } from "./helpers/rmsCharge";

type QueueStatus = "pending" | "blocked";

type QueueItem = {
  id: string;
  payload: Record<string, unknown>;
  timestamp: number;
  status: QueueStatus;
  attemptCount?: number;
  lastErrorStatus?: number;
  lastErrorMessage?: string;
};

async function withCheckoutQueueStore<T>(
  page: Page,
  callback: string,
  arg?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ callbackSource, callbackArg }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("RiversideOS");
        request.onupgradeneeded = () => {
          const dbRef = request.result;
          if (!dbRef.objectStoreNames.contains("checkout_queue")) {
            dbRef.createObjectStore("checkout_queue");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const fn = new Function("db", "arg", callbackSource) as (
          db: IDBDatabase,
          arg: unknown,
        ) => Promise<unknown>;
        return await fn(db, callbackArg);
      } finally {
        db.close();
      }
    },
    { callbackSource: callback, callbackArg: arg },
  ) as Promise<T>;
}

async function clearCheckoutQueue(page: Page): Promise<void> {
  await withCheckoutQueueStore(
    page,
    `
      return new Promise((resolve, reject) => {
        const tx = db.transaction("checkout_queue", "readwrite");
        tx.objectStore("checkout_queue").clear();
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
      });
    `,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("queue_changed")));
}

async function putCheckoutQueueItem(page: Page, item: QueueItem): Promise<void> {
  await withCheckoutQueueStore(
    page,
    `
      return new Promise((resolve, reject) => {
        const tx = db.transaction("checkout_queue", "readwrite");
        tx.objectStore("checkout_queue").put(arg, arg.id);
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
      });
    `,
    item,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("queue_changed")));
}

async function getCheckoutQueueItem(page: Page, id: string): Promise<QueueItem | null> {
  return withCheckoutQueueStore<QueueItem | null>(
    page,
    `
      return new Promise((resolve, reject) => {
        const tx = db.transaction("checkout_queue", "readonly");
        const req = tx.objectStore("checkout_queue").get(arg);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    `,
    id,
  );
}

test.describe("offline checkout recovery contract", () => {
  test.afterEach(async ({ page }) => {
    await clearCheckoutQueue(page).catch(() => {});
  });

  test("4xx replay blocks a queued checkout for manager recovery instead of deleting it", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);

    const id = crypto.randomUUID();
    await putCheckoutQueueItem(page, {
      id,
      timestamp: Date.now(),
      status: "pending",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: "not-a-uuid",
        operator_staff_id: "not-a-uuid",
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    });

    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect
      .poll(async () => await getCheckoutQueueItem(page, id), {
        timeout: 15_000,
        message: "Queued checkout was not retained and blocked after replay 4xx.",
      })
      .toMatchObject({
        id,
        status: "blocked",
      });

    const item = await getCheckoutQueueItem(page, id);
    expect(item?.attemptCount).toBe(1);
    expect(item?.lastErrorStatus).toBeGreaterThanOrEqual(400);
    expect(item?.lastErrorStatus).toBeLessThan(500);
    expect(item?.lastErrorMessage).toBeTruthy();
  });

  test("register close modal blocks Z-close while checkout recovery queue has pending or blocked rows", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await ensureSessionAuth(request);
    await signInToBackOffice(page);
    await enterPosShell(page);
    await clearCheckoutQueue(page);

    await putCheckoutQueueItem(page, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      status: "blocked",
      attemptCount: 1,
      lastErrorStatus: 400,
      lastErrorMessage: "E2E blocked checkout recovery item",
      payload: {
        checkout_client_id: crypto.randomUUID(),
      },
    });

    const closeButton = page.getByRole("button", { name: /close register/i });
    await expect(closeButton).toBeVisible({ timeout: 30_000 });
    await closeButton.click({ force: true });
    const dialog = page.getByRole("dialog").filter({
      hasText: /checkout recovery required|resolve pending or blocked checkout recovery/i,
    }).first();
    await expect(dialog.getByText(/checkout recovery required/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByText(/need manager recovery/i)).toBeVisible();
    await expect(
      dialog.getByText(/resolve checkout recovery before closing the shared drawer/i),
    ).toBeVisible();
  });
});
