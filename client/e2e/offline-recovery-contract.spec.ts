import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  enterPosShell,
  ensurePosRegisterSessionOpen,
} from "./helpers/openPosRegister";
import { apiBase, ensureSessionAuth } from "./helpers/rmsCharge";

type QueueStatus = "pending" | "blocked";

type QueueItem = {
  id: string;
  payload: Record<string, unknown>;
  timestamp: number;
  status: QueueStatus;
  attemptCount?: number;
  lastErrorStatus?: number;
  lastErrorMessage?: string;
  recoveryKind?: "offline_replay" | "online_unconfirmed" | "pickup_after_payment";
  recoveryKey?: string;
  recoveryTransactionId?: string;
};

type RecoveryPostBody = {
  client_job_key: string;
  kind: "checkout_offline" | "checkout_unconfirmed" | "pickup_after_payment";
  status: QueueStatus;
  payload: unknown;
  attempt_count?: number;
  register_session_id?: string;
  transaction_id?: string;
  checkout_client_id?: string;
  label?: string;
  last_error?: string;
};

type OfflineRecoveryHarness = {
  dequeueCheckout: (id: string) => Promise<void>;
  flushCheckoutQueue: (baseUrl: string) => Promise<void>;
  syncCheckoutRecoveryWithServer: (
    getLiveAuthHeaders?: () => Record<string, string>,
  ) => Promise<void>;
  updateQueuedCheckout: (item: QueueItem) => Promise<void>;
};

declare global {
  interface Window {
    __RIVERSIDE_E2E_QUEUE_HARNESS__?: OfflineRecoveryHarness;
  }
}

async function loadOfflineRecoveryHarness(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (window.__RIVERSIDE_E2E_QUEUE_HARNESS__) return;
    const response = await fetch("/e2e-harness.html", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`E2E queue harness returned HTTP ${response.status}`);
    }
    const html = await response.text();
    if (!html.includes('name="riverside-e2e-queue-harness"')) {
      throw new Error("E2E queue harness is missing from the built SPA");
    }
    const source = Array.from(
      html.matchAll(/<script[^>]*src="([^"]+)"/g),
      (match) => match[1],
    ).find(
      (candidate) =>
        candidate.includes("queueRecoveryHarness") ||
        candidate.includes("e2e-queue-harness"),
    );
    if (!source) {
      throw new Error("E2E queue harness module is missing from its page");
    }
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<unknown>;
    await dynamicImport(new URL(source, window.location.origin).href);
    if (!window.__RIVERSIDE_E2E_QUEUE_HARNESS__) {
      throw new Error("E2E queue harness did not initialize");
    }
  });
}

function mirroredRecoveryJob(
  request: RecoveryPostBody,
  status: QueueStatus | "resolved" | "dismissed" = request.status,
): Record<string, unknown> {
  return {
    ...request,
    status,
    attempt_count: request.attempt_count ?? 0,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
}

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

async function putCheckoutQueueItem(
  page: Page,
  item: QueueItem,
): Promise<void> {
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

async function getCheckoutQueueItem(
  page: Page,
  id: string,
): Promise<QueueItem | null> {
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

async function setRecoveryPosAuth(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.sessionStorage.setItem(
      "ros.posRegisterAuth.v1",
      JSON.stringify({
        sessionId: "11111111-1111-4111-8111-111111111111",
        token: "offline-recovery-contract-token",
        stationKey: "offline-recovery-contract-station",
      }),
    );
  });
}

async function closeRegisterSession(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const auth = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem("ros.posRegisterAuth.v1");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as {
        sessionId?: string;
        token?: string;
        stationKey?: string;
      };
    } catch {
      return null;
    }
  });
  if (!auth?.sessionId || !auth.token || !auth.stationKey) return;
  const headers = {
    "Content-Type": "application/json",
    "x-riverside-pos-session-id": auth.sessionId,
    "x-riverside-pos-session-token": auth.token,
    "x-riverside-station-key": auth.stationKey,
  };
  const begin = await request.post(
    `${apiBase()}/api/sessions/${auth.sessionId}/begin-reconcile`,
    {
      headers,
      data: { active: true },
      failOnStatusCode: false,
    },
  );
  if (begin.status() !== 200) return;
  const acknowledgement = await request.post(
    `${apiBase()}/api/recovery/station-close-status`,
    {
      headers,
      data: { pending_checkout_count: 0, blocked_checkout_count: 0 },
      failOnStatusCode: false,
    },
  );
  if (acknowledgement.status() !== 200) return;
  const reconciliation = await request.get(
    `${apiBase()}/api/sessions/${auth.sessionId}/reconciliation`,
    { headers, failOnStatusCode: false },
  );
  if (reconciliation.status() !== 200) return;
  const { expected_cash: expectedCash } = (await reconciliation.json()) as {
    expected_cash?: string;
  };
  if (!expectedCash) return;
  await request.post(`${apiBase()}/api/sessions/${auth.sessionId}/close`, {
    headers: {
      ...headers,
    },
    data: {
      actual_cash: expectedCash,
      closing_notes: "E2E offline recovery fixture cleanup",
      closing_comments: null,
    },
    failOnStatusCode: false,
  });
}

test.describe("offline checkout recovery contract", () => {
  test.afterEach(async ({ page, request }) => {
    await clearCheckoutQueue(page).catch(() => {});
    await closeRegisterSession(page, request).catch(() => {});
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
  });

  test("successful checkout waits for its recovery mirror before audited resolution", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);

    const id = crypto.randomUUID();
    const calls: string[] = [];
    let releasePost!: () => void;
    let markPostStarted!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    await page.route("**/api/recovery**", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        calls.push("post-started");
        markPostStarted();
        await postGate;
        calls.push("post-completed");
        const body = route.request().postDataJSON() as RecoveryPostBody;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mirroredRecoveryJob(body)),
        });
        return;
      }
      if (method === "PATCH") {
        calls.push("patch-resolved");
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      await route.continue();
    });

    const item: QueueItem = {
      id,
      timestamp: Date.now(),
      status: "pending",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        operator_staff_id: crypto.randomUUID(),
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    };
    await loadOfflineRecoveryHarness(page);
    const completion = page.evaluate(async (queuedItem) => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.updateQueuedCheckout(queuedItem);
      await queue.dequeueCheckout(queuedItem.id);
    }, item);

    await postStarted;
    await page.waitForTimeout(100);
    expect(calls).toEqual(["post-started"]);
    releasePost();
    await completion;
    expect(calls).toEqual(["post-started", "post-completed", "patch-resolved"]);
    expect(await getCheckoutQueueItem(page, id)).toBeNull();
  });

  test("failed recovery mirror leaves a visible retry task and never sends PATCH", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);

    const id = crypto.randomUUID();
    const methods: string[] = [];
    await page.route("**/api/recovery**", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        methods.push(method);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "E2E mirror unavailable" }),
        });
        return;
      }
      if (method === "PATCH") {
        methods.push(method);
        await route.fulfill({ status: 500, body: "unexpected resolution" });
        return;
      }
      await route.continue();
    });

    const item: QueueItem = {
      id,
      timestamp: Date.now(),
      status: "pending",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        operator_staff_id: crypto.randomUUID(),
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    };
    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async (queuedItem) => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.updateQueuedCheckout(queuedItem);
      await queue.dequeueCheckout(queuedItem.id);
    }, item);

    expect(methods).toEqual(["POST"]);
    expect(await getCheckoutQueueItem(page, id)).toMatchObject({
      id,
      status: "pending",
      lastErrorMessage: expect.stringContaining("recovery audit sync"),
    });
  });

  test("checkout mirrors preserve trailing blocked state after an in-flight pending POST", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);
    const statuses: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    await page.route("**/api/recovery", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
      const body = route.request().postDataJSON() as RecoveryPostBody;
      statuses.push(body.status);
      if (statuses.length === 1) {
        firstStarted();
        await firstGate;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mirroredRecoveryJob(body)),
      });
    });
    const item: QueueItem = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      status: "pending",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        operator_staff_id: crypto.randomUUID(),
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    };
    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async (queuedItem) => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.updateQueuedCheckout(queuedItem);
    }, item);
    await started;
    await page.evaluate(async (queuedItem) => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.updateQueuedCheckout({
        ...queuedItem,
        status: "blocked",
        lastErrorMessage: "Manager review required",
      });
    }, item);
    releaseFirst();
    await expect.poll(() => statuses).toEqual(["pending", "blocked"]);
  });

  test("authoritative blocked state overrides a frozen pending payload and never auto-replays", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);
    await setRecoveryPosAuth(page);
    const id = crypto.randomUUID();
    const item: QueueItem = {
      id,
      timestamp: Date.now(),
      status: "pending",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: "11111111-1111-4111-8111-111111111111",
        operator_staff_id: crypto.randomUUID(),
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    };
    const serverJob = mirroredRecoveryJob(
      {
        client_job_key: `checkout:${id}`,
        kind: "checkout_offline",
        status: "pending",
        payload: item,
        attempt_count: 1,
      },
      "blocked",
    );
    let checkoutPosts = 0;
    await page.route("**/api/recovery", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([serverJob]),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(serverJob),
      });
    });
    await page.route("**/api/transactions/checkout", async (route) => {
      checkoutPosts += 1;
      await route.fulfill({ status: 500, body: "unexpected replay" });
    });
    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.syncCheckoutRecoveryWithServer();
    });
    await expect
      .poll(() => getCheckoutQueueItem(page, id))
      .toMatchObject({
        status: "blocked",
      });
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.flushCheckoutQueue(window.location.origin);
    });
    expect(checkoutPosts).toBe(0);
  });

  test("an authoritative resolved mirror clears crash-left local evidence", async ({
    page,
  }) => {
    await page.goto("/e2e-harness.html");
    await clearCheckoutQueue(page);
    await setRecoveryPosAuth(page);
    const checkoutClientId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const item: QueueItem = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      status: "blocked",
      payload: {
        checkout_client_id: checkoutClientId,
        session_id: "11111111-1111-4111-8111-111111111111",
        operator_staff_id: crypto.randomUUID(),
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    };
    await putCheckoutQueueItem(page, item);
    let includeTransactionEvidence = false;
    await page.route("**/api/recovery", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
      const body = route.request().postDataJSON() as RecoveryPostBody;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...mirroredRecoveryJob(body, "resolved"),
          ...(includeTransactionEvidence
            ? { transaction_id: transactionId }
            : {}),
        }),
      });
    });
    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.syncCheckoutRecoveryWithServer();
    });
    await expect
      .poll(() => getCheckoutQueueItem(page, item.id))
      .toMatchObject({
        id: item.id,
        status: "blocked",
      });

    includeTransactionEvidence = true;
    const resolvedEvent = page.evaluate(
      (eventName) =>
        new Promise<Record<string, string>>((resolve) => {
          window.addEventListener(
            eventName,
            (event) =>
              resolve((event as CustomEvent<Record<string, string>>).detail),
            { once: true },
          );
        }),
      "riverside:checkout-recovery-resolved",
    );
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.syncCheckoutRecoveryWithServer();
    });
    await expect.poll(() => getCheckoutQueueItem(page, item.id)).toBeNull();
    await expect(resolvedEvent).resolves.toMatchObject({
      checkoutClientId,
      recoveryKey: `checkout:${item.id}`,
      transactionId,
    });
  });

  test("exact Staff proof clears a resolved prior-session local mirror", async ({
    page,
  }) => {
    await page.goto("/e2e-harness.html");
    await clearCheckoutQueue(page);
    await setRecoveryPosAuth(page);
    const checkoutClientId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const recoveryKey = crypto.randomUUID();
    const item: QueueItem = {
      id: `recovery:online_unconfirmed:${recoveryKey}`,
      timestamp: Date.now(),
      status: "blocked",
      recoveryKind: "online_unconfirmed",
      recoveryKey,
      lastErrorMessage: "Checkout outcome is still unknown",
      payload: {
        checkout_client_id: checkoutClientId,
        session_id: "22222222-2222-4222-8222-222222222222",
        operator_staff_id: crypto.randomUUID(),
        payment_method: "card_terminal",
        total_price: "141.38",
        amount_paid: "141.38",
        items: [],
      },
    };
    const serverKey = `checkout:${item.id}`;
    await putCheckoutQueueItem(page, item);

    let exactReadHeaders: Record<string, string> | null = null;
    await page.route("**/api/recovery**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "register session does not match authenticated session",
          }),
        });
        return;
      }
      if (
        request.method() === "GET" &&
        request.url().includes("/api/recovery/")
      ) {
        exactReadHeaders = request.headers();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            client_job_key: serverKey,
            kind: "checkout_unconfirmed",
            status: "resolved",
            register_session_id: "22222222-2222-4222-8222-222222222222",
            transaction_id: transactionId,
            checkout_client_id: checkoutClientId,
            payload: item,
            attempt_count: 1,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    });

    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.syncCheckoutRecoveryWithServer(() => ({
        "x-riverside-staff-session": "staff-session",
        "x-riverside-connection-key": "connection-key",
        "x-riverside-station-key": "station-key",
        "x-riverside-pos-session-id": "11111111-1111-4111-8111-111111111111",
        "x-riverside-pos-session-token": "current-pos-session-token",
      }));
    });

    await expect.poll(() => getCheckoutQueueItem(page, item.id)).toBeNull();
    expect(exactReadHeaders).toMatchObject({
      "x-riverside-staff-session": "staff-session",
      "x-riverside-connection-key": "connection-key",
      "x-riverside-station-key": "station-key",
    });
    expect(exactReadHeaders).not.toHaveProperty("x-riverside-pos-session-id");
    expect(exactReadHeaders).not.toHaveProperty(
      "x-riverside-pos-session-token",
    );
  });

  test("an empty open list never erases an unconfirmed checkout whose mirror failed", async ({
    page,
  }) => {
    await page.goto("/e2e-harness.html");
    await clearCheckoutQueue(page);
    await setRecoveryPosAuth(page);
    const item = {
      id: `recovery:online_unconfirmed:${crypto.randomUUID()}`,
      timestamp: Date.now(),
      status: "blocked" as const,
      recoveryKind: "online_unconfirmed",
      recoveryKey: crypto.randomUUID(),
      lastErrorMessage: "Checkout outcome is still unknown",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: "11111111-1111-4111-8111-111111111111",
        operator_staff_id: crypto.randomUUID(),
        payment_method: "card_terminal",
        total_price: "141.38",
        amount_paid: "141.38",
        items: [],
      },
    };
    await putCheckoutQueueItem(page, item);
    await page.route("**/api/recovery", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Recovery identity was not accepted" }),
      });
    });
    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await queue.syncCheckoutRecoveryWithServer();
    });
    await expect
      .poll(() => getCheckoutQueueItem(page, item.id))
      .toMatchObject({
        id: item.id,
        status: "blocked",
        recoveryKind: "online_unconfirmed",
        lastErrorMessage: "Checkout outcome is still unknown",
      });
  });

  test("concurrent flush triggers share one checkout replay", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);
    const item: QueueItem = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      status: "pending",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        operator_staff_id: crypto.randomUUID(),
        payment_method: "cash",
        total_price: "1.00",
        amount_paid: "1.00",
        items: [],
      },
    };
    await putCheckoutQueueItem(page, item);
    let checkoutPosts = 0;
    await page.route("**/api/transactions/checkout", async (route) => {
      checkoutPosts += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ transaction_id: crypto.randomUUID() }),
      });
    });
    await page.route("**/api/recovery**", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
      const body = route.request().postDataJSON() as RecoveryPostBody;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mirroredRecoveryJob(body)),
      });
    });
    await loadOfflineRecoveryHarness(page);
    await page.evaluate(async () => {
      const queue = window.__RIVERSIDE_E2E_QUEUE_HARNESS__;
      if (!queue) throw new Error("E2E queue harness is unavailable");
      await Promise.all([
        queue.flushCheckoutQueue(window.location.origin),
        queue.flushCheckoutQueue(window.location.origin),
      ]);
    });
    expect(checkoutPosts).toBe(1);
    expect(await getCheckoutQueueItem(page, item.id)).toBeNull();
  });

  test("4xx replay blocks a queued checkout for manager recovery instead of deleting it", async ({
    page,
  }) => {
    await signInToBackOffice(page);
    await clearCheckoutQueue(page);

    const id = crypto.randomUUID();
    const recoveryServerKey = `checkout:${id}`;
    await page.route("**/api/recovery", async (route) => {
      const intercepted = route.request();
      if (intercepted.method() === "POST") {
        const body = intercepted.postDataJSON() as RecoveryPostBody | null;
        if (body?.client_job_key === recoveryServerKey) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mirroredRecoveryJob(body)),
          });
          return;
        }
      }
      await route.continue();
    });
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
        message:
          "Queued checkout was not retained and blocked after replay 4xx.",
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

  test("register close keeps recovery visible and uses dedicated close approval", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await ensureSessionAuth(request);
    await signInToBackOffice(page);
    await enterPosShell(page);
    await ensurePosRegisterSessionOpen(page);
    const cashierOverlay = page.getByTestId("pos-sale-cashier-overlay");
    if (await cashierOverlay.isVisible().catch(() => false)) {
      await cashierOverlay.getByRole("button", { name: /^cancel$/i }).click();
      await expect(cashierOverlay).toBeHidden({ timeout: 10_000 });
    }
    await clearCheckoutQueue(page);
    const registerSessionId = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem("ros.posRegisterAuth.v1");
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { sessionId?: unknown };
        return typeof parsed.sessionId === "string" ? parsed.sessionId : null;
      } catch {
        return null;
      }
    });
    expect(registerSessionId).toBeTruthy();

    const recoveryId = crypto.randomUUID();
    const recoveryServerKey = `checkout:${recoveryId}`;
    await page.route("**/api/recovery", async (route) => {
      const intercepted = route.request();
      if (intercepted.method() === "POST") {
        const body = intercepted.postDataJSON() as RecoveryPostBody | null;
        if (body?.client_job_key === recoveryServerKey) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mirroredRecoveryJob(body)),
          });
          return;
        }
      }
      await route.continue();
    });

    await putCheckoutQueueItem(page, {
      id: recoveryId,
      timestamp: Date.now(),
      status: "blocked",
      attemptCount: 1,
      lastErrorStatus: 400,
      lastErrorMessage: "E2E blocked checkout recovery item",
      recoveryKind: "online_unconfirmed",
      recoveryKey: "e2e-unconfirmed-checkout",
      payload: {
        checkout_client_id: crypto.randomUUID(),
        session_id: registerSessionId,
      },
    });

    const closeButton = page.getByRole("button", { name: /close register/i });
    await expect(closeButton).toBeVisible({ timeout: 30_000 });
    await closeButton.click({ force: true });
    const dialogs = page.getByRole("dialog", { name: /end of shift/i });
    await expect(dialogs).toHaveCount(1, { timeout: 15_000 });
    const dialog = dialogs.first();
    await expect(
      dialog.getByText(/current till-group follow-up/i),
    ).toBeVisible();
    await expect(dialog.getByText(/1 need recovery/i)).toBeVisible();
    await expect(dialog.getByText(/resolve before close/i)).toBeVisible();
    await expect(dialog.getByText(/Z-close can continue/i)).toBeVisible();

    await dialog.locator('input[placeholder="---"]').fill("0.00");
    await dialog.getByRole("button", { name: /next: checks/i }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /next: z-report/i })
      .click();

    const reportDialog = page.getByRole("dialog").first();
    await reportDialog
      .locator('textarea[placeholder^="Explain any discrepancy"]')
      .fill("Recovery remains listed for follow-up after ordinary close.");
    const closeAndPrint = reportDialog.getByRole("button", {
      name: /close & print z-report/i,
    });
    await expect(closeAndPrint).toBeEnabled();
    await expect(
      reportDialog.getByRole("button", { name: /manager force z-close/i }),
    ).toHaveCount(0);
    await closeAndPrint.click();
    const managerClose = page.getByRole("dialog", {
      name: /close register with unresolved issues/i,
    });
    await expect(
      managerClose.getByText(/preserving every unresolved checkout/i),
    ).toBeVisible();
    await expect(
      managerClose.getByText(/does not replay a checkout/i),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: /recover checkout sales/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: /close and print/i }),
    ).toHaveCount(0);

    await managerClose.getByRole("button", { name: /^cancel$/i }).click();
    await reportDialog.getByRole("button", { name: /^cancel$/i }).click();
    await expect(reportDialog).toBeHidden();
  });
});
