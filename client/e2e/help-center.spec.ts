/**
 * Smoke + manager coverage: Help slideout from Back Office/POS and
 * Help Center Manager settings workflows (navigation + admin ops calls).
 *
 * Run:
 *   cd client
 *   E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e -- e2e/help-center.spec.ts --workers=1
 */
import { expect, test } from "@playwright/test";
import {
  ensureMainNavigationVisible,
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  enterPosShell,
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

async function openSettingsHelpCenterManager(
  page: Parameters<typeof test>[0]["page"],
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openBackofficeSidebarTab(page, "settings");
    const mainNav = await ensureMainNavigationVisible(page);
    const helpCenterButton = mainNav.getByRole("button", {
      name: /^help center$/i,
    });
    await helpCenterButton.scrollIntoViewIfNeeded();
    await expect(helpCenterButton).toBeVisible({ timeout: 15_000 });
    await expect(helpCenterButton).toBeEnabled();
    await helpCenterButton.click();

    const managerHeading = page.getByRole("heading", {
      name: /help center manager/i,
    });
    if (await managerHeading.isVisible().catch(() => false)) {
      return;
    }
    await managerHeading.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await managerHeading.isVisible().catch(() => false)) {
      return;
    }
  }

  await expect(
    page.getByRole("heading", { name: /help center manager/i }),
  ).toBeVisible({ timeout: 20_000 });
}

async function openSettingsRosiePanel(
  page: Parameters<typeof test>[0]["page"],
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openBackofficeSidebarTab(page, "settings");
    const mainNav = await ensureMainNavigationVisible(page);
    const rosieButton = mainNav.getByRole("button", {
      name: /^rosie$/i,
    });
    await rosieButton.scrollIntoViewIfNeeded();
    await expect(rosieButton).toBeVisible({ timeout: 15_000 });
    await expect(rosieButton).toBeEnabled();
    await rosieButton.click();

    const rosiePanel = page.getByTestId("rosie-settings-panel");
    if (await rosiePanel.isVisible().catch(() => false)) {
      return;
    }
    await rosiePanel.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await rosiePanel.isVisible().catch(() => false)) {
      return;
    }
  }

  await expect(page.getByTestId("rosie-settings-panel")).toBeVisible({
    timeout: 20_000,
  });
}

test("opens Help from Back Office header", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await expect(page.getByRole("dialog", { name: /help/i })).toBeVisible();
  await expect(page.getByTestId("help-center-search")).toBeVisible();
  await expect(page.getByPlaceholder("Search manuals…")).toBeVisible();
});

test("prints the currently viewed Help section", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await expect(page.getByRole("dialog", { name: /help/i })).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("help-center-print-current").click();
  const printPage = await popupPromise;

  await expect(printPage.locator("body")).toContainText("Register (POS)");
  await expect(printPage.locator("body")).toContainText(/staff guide/i);
  await expect(printPage.getByTestId("help-center-search")).toHaveCount(0);
});

test("opens Help from POS top bar", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await enterPosShell(page);
  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);
  await page.getByTestId("help-center-trigger").click();
  await expect(page.getByRole("dialog", { name: /help/i })).toBeVisible();
  await expect(page.getByTestId("help-center-search")).toBeVisible();
});

test("help search lists Results after query (Meilisearch or local fallback)", async ({
  page,
}) => {
  await signInToBackOffice(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-search").fill("checkout");
  await expect(page.getByText("Results").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("Ask ROSIE sends Help request and renders sources", async ({
  page,
}) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    const body = route.request().postDataJSON() as {
      mode?: string;
      question?: string;
      settings?: { enabled?: boolean; response_style?: string; show_citations?: boolean };
    };
    expect(body.mode).toBe("help");
    expect(body.question).toBe("how do I close the register");
    expect(body.settings?.enabled).toBe(true);
    expect(body.settings?.response_style).toBe("concise");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: body.question,
        settings: body.settings,
        sources: [
          {
            kind: "manual",
            title: "POS Manual — Register Closing",
            excerpt: "Close the register from the register reports workflow.",
            content: "Close the register from the register reports workflow.",
            manual_id: "pos",
            manual_title: "POS Manual",
            section_slug: "register-closing",
            section_heading: "Register Closing",
            anchor_id: "help-pos-register-closing",
          },
        ],
        tool_results: [
          {
            tool_name: "help_search",
            args: { q: body.question, limit: 6 },
            result: {
              hits: [
                {
                  manual_id: "pos",
                  manual_title: "POS Manual",
                  section_slug: "register-closing",
                  section_heading: "Register Closing",
                },
              ],
            },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    const body = route.request().postDataJSON() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(userPrompt).toContain("User question: how do I close the register");
    expect(userPrompt).toContain("Structured tool results:");
    expect(userPrompt).toContain("Tool 1: help_search");
    expect(userPrompt).toContain("Grounding sources:");
    expect(userPrompt).toMatch(/Source 1:/);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: "local",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content:
                "Open the register reports workflow and complete the close sequence from the register tools.",
            },
          },
        ],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page.getByTestId("help-center-ask-rosie-input").fill("how do I close the register");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(
    page.getByText(/^sources$/i).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("help-center-rosie-source-chip").first(),
  ).toBeVisible({ timeout: 15_000 });
  expect(completionCalled).toBe(true);
});

test("Top Bar ROSIE opens voice-first chat with Riverside context", async ({
  page,
}) => {
  await signInToBackOffice(page);
  let toolContextCalled = false;
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    toolContextCalled = true;
    const body = route.request().postDataJSON() as {
      mode?: string;
      question?: string;
      settings?: { response_style?: string; show_citations?: boolean };
    };
    expect(body.mode).toBe("conversation");
    expect(body.question).toBe("show me today’s sales");
    expect(body.settings?.response_style).toBe("concise");
    expect(body.settings?.show_citations).toBe(false);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: body.question,
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: true,
        },
        sources: [
          {
            kind: "report",
            title: "Report — sales today",
            excerpt: "today sales via approved reporting path",
            content: "{\"total_sales\":\"1250.00\"}",
            report_spec_id: "sales_today",
          },
        ],
        tool_results: [
          {
            tool_name: "reporting_run",
            args: { spec_id: "sales_today" },
            result: { data: { total_sales: "1250.00" } },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    const body = route.request().postDataJSON() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(systemPrompt).toContain("full conversational assistant for Riverside OS staff");
    expect(systemPrompt).toContain("approved operational tool results");
    expect(systemPrompt).toContain("A reporting_run result is present");
    expect(userPrompt).toContain("User question: show me today’s sales");
    expect(userPrompt).toContain("Tool 1: reporting_run");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Today’s approved sales report shows $1,250.00 in sales.",
            },
          },
        ],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-ask-rosie-trigger").click();
  await expect(page.getByTestId("help-center-rosie-conversation-tab")).toBeVisible();
  await expect(page.getByText(/ROSIE can use approved Riverside help/i)).toHaveCount(0);
  await page
    .getByTestId("help-center-rosie-conversation-input")
    .fill("show me today’s sales");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(page.getByText(/Total Sales:\s*1250\.00/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText(/ROSIE used approved Riverside information/i),
  ).toHaveCount(0);
  await expect(page.getByText(/Report — sales today/i)).toHaveCount(0);
  expect(toolContextCalled).toBe(true);
});

test("Ask ROSIE voice input reuses the normal text flow and plays speech on the workstation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      window as typeof window & { __ROSIE_TEST_HOST_WAV_BASE64__?: string }
    ).__ROSIE_TEST_HOST_WAV_BASE64__ = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";

    window.localStorage.setItem(
      "ros.rosie.settings.v1",
      JSON.stringify({
        enabled: true,
        local_first: false,
        response_style: "concise",
        show_citations: true,
        voice_enabled: true,
        speak_responses: true,
        selected_voice: "adam",
        microphone_enabled: true,
        microphone_mode: "push_to_talk",
        speech_rate: 1,
      }),
    );

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function playRosieTestAudio() {
      (window as typeof window & { __rosieSatelliteAudioPlayed?: boolean }).__rosieSatelliteAudioPlayed =
        true;
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pauseRosieTestAudio() {
      (window as typeof window & { __rosieSatelliteAudioStopped?: boolean }).__rosieSatelliteAudioStopped =
        true;
    };
    void originalPlay;
  });

  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/runtime-status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        llm: {
          runtime_name: "Host llama-server upstream",
          provider: "llama.cpp",
          base_url: "http://127.0.0.1:8080",
          host: "127.0.0.1",
          port: "8080",
          model_name: "Gemma 4 E4B",
          model_path: "/host/models/gemma.gguf",
          model_present: true,
          sidecar_binary_present: true,
          running: true,
        },
        stt: {
          engine_name: "SenseVoice Small via Sherpa-ONNX",
          provider: "cpu",
          active_engine: "sensevoice",
          cli_path: "/host/bin/python",
          cli_present: true,
          model_name: "SenseVoice Small",
          model_path: "/host/stt/model.int8.onnx",
          model_present: true,
          fallback_engine_name: "whisper.cpp",
          fallback_cli_path: "/host/bin/whisper-cli",
          fallback_cli_present: true,
          fallback_model_path: "/host/stt/ggml-small.en.bin",
          fallback_model_present: true,
        },
        tts: {
          engine_name: "Kokoro-82M via Sherpa-ONNX",
          provider: "cpu",
          active_engine: "kokoro",
          command_path: "/host/bin/python",
          command_present: true,
          model_name: "Kokoro-82M",
          model_path: "/host/tts/model.onnx",
          model_present: true,
          fallback_engine_name: "Host speech command",
          fallback_command_path: "/usr/bin/say",
          fallback_command_present: true,
          speaking: false,
        },
      }),
    });
  });
  await page.route("**/api/help/rosie/v1/voice/transcribe", async (route) => {
    const body = route.request().postDataJSON() as { audio_base64?: string };
    expect(typeof body.audio_base64).toBe("string");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        transcript: "how do I close the register",
      }),
    });
  });
  await page.route("**/api/help/rosie/v1/voice/synthesize", async (route) => {
    const body = route.request().postDataJSON() as {
      text?: string;
      voice?: string;
    };
    expect(body.text).toContain("Open the register reports workflow");
    expect(body.voice).toBe("5");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        audio_base64: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=",
        mime_type: "audio/wav",
      }),
    });
  });
  await page.route("**/api/help/rosie/v1/voice/stop", async (route) => {
    await page.evaluate(() => {
      (window as typeof window & { __rosieSpeechCancelled?: boolean }).__rosieSpeechCancelled =
        true;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "ROSIE TTS stopped" }),
    });
  });
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    const body = route.request().postDataJSON() as {
      question?: string;
    };
    expect(body.question).toBe("how do I close the register");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: body.question,
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: true,
        },
        sources: [
          {
            kind: "manual",
            title: "POS Manual — Register Closing",
            excerpt: "Close the register from the register reports workflow.",
            content: "Close the register from the register reports workflow.",
            manual_id: "pos",
            manual_title: "POS Manual",
            section_slug: "register-closing",
            section_heading: "Register Closing",
            anchor_id: "help-pos-register-closing",
          },
        ],
        tool_results: [
          {
            tool_name: "help_search",
            args: { q: body.question, limit: 6 },
            result: { hits: [] },
          },
        ],
      }),
    });
  });
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "chatcmpl-voice-test",
        object: "chat.completion",
        created: Date.now(),
        model: "local",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content:
                "Open the register reports workflow and complete the close sequence from the register tools.",
            },
          },
        ],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page.getByTestId("help-center-ask-rosie-mic").click();

  await expect(
    page.getByTestId("help-center-ask-rosie-transcript-preview"),
  ).toContainText(/how do I close the register/i, { timeout: 15_000 });
  await expect(
    page.getByTestId("help-center-ask-rosie-speaking"),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __rosieSatelliteAudioPlayed?: boolean }).__rosieSatelliteAudioPlayed === true))
    .toBe(true);
  await expect(
    page.getByText(/^sources$/i).first(),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("help-center-ask-rosie-stop-audio").click();
  await expect(page.getByTestId("help-center-ask-rosie-speaking")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __rosieSpeechCancelled?: boolean }).__rosieSpeechCancelled === true))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __rosieSatelliteAudioStopped?: boolean }).__rosieSatelliteAudioStopped === true))
    .toBe(true);
});

test("Ask ROSIE narrates approved reporting tool results", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: "show me best sellers for last week",
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: true,
        },
        sources: [
          {
            kind: "report",
            title: "Report — best sellers",
            excerpt: "best_sellers via /api/insights/best-sellers",
            content: "{\"rows\":[{\"product_name\":\"Navy Suit\",\"units_sold\":4}]}",
            report_spec_id: "best_sellers",
            report_route: "/api/insights/best-sellers",
          },
        ],
        tool_results: [
          {
            tool_name: "reporting_run",
            args: {
              spec_id: "best_sellers",
              params: {
                from: "2026-04-15",
                to: "2026-04-21",
                basis: "booked",
                limit: 100,
              },
            },
            result: {
              route: "/api/insights/best-sellers",
              required_permission: "insights.view",
              data: {
                reporting_basis: "booked",
                rows: [{ product_name: "Navy Suit", units_sold: 4 }],
              },
            },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    const body = route.request().postDataJSON() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(systemPrompt).toContain("A reporting_run result is present");
    expect(userPrompt).toContain("Tool 1: reporting_run");
    expect(userPrompt).toContain("\"spec_id\":\"best_sellers\"");
    expect(userPrompt).toContain("\"product_name\":\"Navy Suit\"");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Navy Suit is the top best seller for the selected window.",
            },
          },
        ],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page.getByTestId("help-center-ask-rosie-input").fill("show me best sellers for last week");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(
    page.getByText(/Navy Suit was the best-selling item/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/4 units sold/i)).toBeVisible();
  await expect(
    page.getByText(/Report — best sellers/i),
  ).toBeVisible({ timeout: 15_000 });
  expect(completionCalled).toBe(false);
});

test("Ask ROSIE asks for details when a data question has no matched tool", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: "How many loyalty points does Sarah have?",
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: false,
        },
        sources: [],
        tool_results: [
          {
            tool_name: "rosie_knowledge_retrieval",
            args: { question: "How many loyalty points does Sarah have?" },
            result: { sections: [] },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "wrong path" } }],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page
    .getByTestId("help-center-ask-rosie-input")
    .fill("How many loyalty points does Sarah have?");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(
    page.getByText(/Which customer record should I use/i),
  ).toBeVisible({ timeout: 15_000 });
  expect(completionCalled).toBe(false);
});

test("Ask ROSIE answers open orders from approved order tool", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: "Do we have any open orders right now?",
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: false,
        },
        sources: [],
        tool_results: [
          {
            tool_name: "rosie_read_tool",
            args: {
              tool_name: "get_open_orders",
              arguments: { limit: 25 },
            },
            result: {
              tool_name: "get_open_orders",
              basis: "open_order_lines",
              filters_applied: { limit: 25 },
              row_count: 2,
              limited: false,
              warnings: [],
              data_freshness: "live",
              generated_at: "2026-06-14T20:25:00Z",
              data: [
                {
                  transaction_display_id: "TXN-1001",
                  customer_name: "Sarah Rivera",
                  product_name: "Navy Suit",
                  quantity: 1,
                  order_lifecycle_status: "ntbo",
                },
                {
                  transaction_display_id: "TXN-1002",
                  customer_name: "Luis Garcia",
                  product_name: "Black Tux",
                  quantity: 2,
                  order_lifecycle_status: "ready_for_pickup",
                },
              ],
            },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "wrong path" } }] }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page.getByTestId("help-center-ask-rosie-input").fill("Do we have any open orders right now?");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(page.getByText(/I found 2 open order lines right now/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Navy Suit/i)).toBeVisible();
  expect(completionCalled).toBe(false);
});

test("Ask ROSIE refuses wrong-domain inventory result for order question", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: "Do we have any open orders right now?",
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: false,
        },
        sources: [],
        tool_results: [
          {
            tool_name: "rosie_read_tool",
            args: {
              tool_name: "get_inventory_availability",
              arguments: { query: "open orders", limit: 25 },
            },
            result: {
              tool_name: "get_inventory_availability",
              basis: "available_inventory",
              filters_applied: { query: "open orders", limit: 25 },
              row_count: 0,
              limited: false,
              warnings: [],
              data_freshness: "live",
              generated_at: "2026-06-14T20:25:00Z",
              data: [],
            },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "wrong path" } }] }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page.getByTestId("help-center-ask-rosie-input").fill("Do we have any open orders right now?");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(page.getByText(/I found an inventory result, but your question appears to be about open orders/i)).toBeVisible({
    timeout: 15_000,
  });
  expect(completionCalled).toBe(false);
});

test("Ask ROSIE displays planner clarification, refusal, and safe gap messages", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    const request = route.request().postDataJSON() as { question?: string };
    const question = request.question ?? "";
    const lower = question.toLowerCase();
    let result: Record<string, unknown>;
    if (lower.includes("store credit")) {
      result = {
        decision: "ask_clarifying_question",
        confidence: "medium",
        domain: "store_credit",
        arguments: {},
        warnings: [],
        reason: "customer_identity_required",
        clarifying_question: "Which customer record should I use for the store credit check?",
      };
    } else if (lower.includes("adjust")) {
      result = {
        decision: "refuse_mutation",
        confidence: "high",
        domain: "operations",
        arguments: {},
        warnings: ["ROSIE can explain or summarize this, but cannot change Riverside OS data."],
        reason: "mutation_like_request",
      };
    } else {
      result = {
        decision: "unsupported_safe_gap",
        confidence: "high",
        domain: "vendors",
        arguments: {},
        warnings: [],
        reason: "No approved read-only tool currently answers vendor return history.",
        suggested_tool: "get_vendor_return_history",
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question,
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: false,
        },
        sources: [],
        tool_results: [
          {
            tool_name: "rosie_tool_planner",
            args: { question },
            result,
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "wrong path" } }] }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();

  await page.getByTestId("help-center-ask-rosie-input").fill("Does John have store credit?");
  await page.getByTestId("help-center-ask-rosie-send").click();
  await expect(page.getByText(/Which customer record should I use for the store credit check/i)).toBeVisible({
    timeout: 15_000,
  });

  await page.getByTestId("help-center-ask-rosie-input").fill("Adjust inventory for navy suits.");
  await page.getByTestId("help-center-ask-rosie-send").click();
  await expect(page.getByText(/cannot change Riverside OS data/i)).toBeVisible({
    timeout: 15_000,
  });

  await page.getByTestId("help-center-ask-rosie-input").fill("Show vendor return history.");
  await page.getByTestId("help-center-ask-rosie-send").click();
  await expect(page.getByText(/No approved read-only tool currently answers vendor return history/i)).toBeVisible({
    timeout: 15_000,
  });
  expect(completionCalled).toBe(false);
});

test("Ask ROSIE displays customer candidates before sensitive customer answers", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: "Does John have store credit?",
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: false,
        },
        sources: [],
        tool_results: [
          {
            tool_name: "rosie_read_tool",
            args: {
              tool_name: "search_customers_for_rosie",
              arguments: { query: "john", limit: 10 },
            },
            result: {
              tool_name: "search_customers_for_rosie",
              basis: "customer_search",
              filters_applied: { query: "john", limit: 10 },
              row_count: 2,
              limited: false,
              warnings: ["Contact values are minimized to presence flags."],
              data_freshness: "live",
              generated_at: "2026-06-14T21:25:00Z",
              data: [
                {
                  first_name: "John",
                  last_name: "Smith",
                  customer_code: "C-1001",
                  email_present: true,
                  phone_present: false,
                },
                {
                  first_name: "John",
                  last_name: "Garcia",
                  customer_code: "C-1002",
                  email_present: false,
                  phone_present: true,
                },
              ],
            },
          },
        ],
      }),
    });
  });
  let completionCalled = false;
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    completionCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "wrong path" } }] }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page.getByTestId("help-center-ask-rosie-input").fill("Does John have store credit?");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(page.getByText(/I found 2 matching customers for “john”/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Select the correct record/i)).toBeVisible();
  expect(completionCalled).toBe(false);
});

test("Ask ROSIE narrates approved operational tool results", async ({ page }) => {
  await signInToBackOffice(page);
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        question: "show inventory intelligence for variant 11111111-1111-1111-1111-111111111111",
        settings: {
          enabled: true,
          response_style: "concise",
          show_citations: true,
        },
        sources: [
          {
            kind: "inventory",
            title: "Inventory Intelligence — MTX-42R",
            excerpt: "Read from /api/inventory/intelligence/11111111-1111-1111-1111-111111111111",
            content: "{\"sku\":\"MTX-42R\",\"available_stock\":4,\"qty_on_order\":0}",
            route: "/api/inventory/intelligence/11111111-1111-1111-1111-111111111111",
            entity_id: "11111111-1111-1111-1111-111111111111",
          },
        ],
        tool_results: [
          {
            tool_name: "inventory_variant_intelligence",
            args: {
              variant_id: "11111111-1111-1111-1111-111111111111",
            },
            result: {
              sku: "MTX-42R",
              name: "Midnight Tux",
              available_stock: 4,
              qty_on_order: 0,
            },
          },
        ],
      }),
    });
  });
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
    const body = route.request().postDataJSON() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(systemPrompt).toContain("Approved operational/read-only tool results are present");
    expect(userPrompt).toContain("Tool 1: inventory_variant_intelligence");
    expect(userPrompt).toContain("\"sku\":\"MTX-42R\"");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "Variant `MTX-42R` currently shows 4 available units and no open PO quantity in the approved inventory intelligence result.",
            },
          },
        ],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-ask-rosie-tab").click();
  await page
    .getByTestId("help-center-ask-rosie-input")
    .fill("show inventory intelligence for variant 11111111-1111-1111-1111-111111111111");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(
    page.getByText(/4 available units/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Inventory Intelligence — MTX-42R/i),
  ).toBeVisible({ timeout: 15_000 });
});

test.describe("Help Center Manager (settings)", () => {
  test("navigates to Help Center Manager and shows key tabs", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openSettingsHelpCenterManager(page);

    const managerPanel = page.locator("main, section, div").filter({
      has: page.getByRole("heading", { name: /help center manager/i }),
    }).first();
    await expect(
      managerPanel.getByRole("button", { name: /library/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /editor/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /automation/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /search & index/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /rosie readiness/i }).first(),
    ).toBeVisible();
  });

  test("automation tab triggers generate-manifest admin op request", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openSettingsHelpCenterManager(page);

    await page.getByRole("button", { name: /automation/i }).click();

    const reqPromise = page.waitForRequest(
      (r) =>
        r.url().includes("/api/help/admin/ops/generate-manifest") &&
        r.method() === "POST",
      { timeout: 20_000 },
    );

    await page
      .getByRole("button", { name: /run help manifest workflow/i })
      .click();

    const req = await reqPromise;
    const body = req.postDataJSON() as {
      dry_run?: boolean;
      include_shadcn?: boolean;
      rescan_components?: boolean;
      cleanup_orphans?: boolean;
    };

    expect(typeof body).toBe("object");
    expect(typeof body.dry_run).toBe("boolean");
    expect(typeof body.include_shadcn).toBe("boolean");
    expect(typeof body.rescan_components).toBe("boolean");
    expect(typeof body.cleanup_orphans).toBe("boolean");
  });

  test("search & index tab triggers reindex-search admin op request", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openSettingsHelpCenterManager(page);

    await page.getByRole("button", { name: /search & index/i }).click();

    const reqPromise = page.waitForRequest(
      (r) =>
        r.url().includes("/api/help/admin/ops/reindex-search") &&
        r.method() === "POST",
      { timeout: 20_000 },
    );

    await page.getByRole("button", { name: /reindex help search/i }).click();

    const req = await reqPromise;
    const body = req.postDataJSON() as {
      full_reindex_fallback?: boolean;
    };

    expect(typeof body).toBe("object");
    expect(typeof body.full_reindex_fallback).toBe("boolean");
  });
});

test.describe("ROSIE settings governance", () => {
  test("shows governed intelligence pack status and triggers refresh request", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);

    await page.route("**/api/settings/rosie", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            enabled: true,
            local_first: true,
            response_style: "concise",
            show_citations: true,
            voice_enabled: true,
            speak_responses: false,
            selected_voice: "adam",
            speech_rate: 1,
            microphone_enabled: true,
            microphone_mode: "push_to_talk",
          }),
        });
        return;
      }

      await route.continue();
    });

    await page.route("**/api/help/rosie/v1/intelligence/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          pack: {
            policy_pack_version: "rosie-policy-pack-2026-04-22-v1",
            intelligence_pack_version: "rosie-intelligence-pack-2026-04-22-v1",
            approved_source_groups: [
              {
                key: "help_manuals",
                label: "Help manuals",
                description: "Bundled in-app Help Center manuals.",
                source_count: 160,
                source_paths: ["client/src/assets/docs/pos-manual.md"],
              },
              {
                key: "policy_contracts",
                label: "ROSIE contract docs",
                description: "Versioned contract docs.",
                source_count: 3,
                source_paths: ["docs/AI_CONTEXT_FOR_ASSISTANTS.md"],
              },
            ],
            excluded_source_rules: [
              "raw live customer, order, payment, and catalog database content",
              "unrestricted conversation history or chat transcripts",
            ],
            issues_detected: [],
            last_generated_at: "2026-04-22T12:00:00Z",
          },
          last_reindex_at: "2026-04-22T12:05:00Z",
          meilisearch_configured: true,
          node_available: true,
          refresh_capabilities: {
            generate_help_manifest: true,
            reindex_search: true,
          },
        }),
      });
    });
    await page.route("**/api/help/rosie/v1/runtime-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          llm: {
            runtime_name: "Remote LM Studio OpenAI-compatible endpoint",
            provider: "remote_lmstudio",
            deployment_kind: "private_remote",
            base_url: "http://127.0.0.1:1234/v1",
            host: "127.0.0.1",
            port: "1234",
            model_name: "gemma-4-12B-it-q5_k_m.gguf",
            model_path: null,
            model_present: true,
            sidecar_binary_present: false,
            running: false,
            available: false,
            unavailable_reason: "Remote LM Studio OpenAI-compatible endpoint is not reachable",
            context_hint: "ROSIE does not start LM Studio",
            api_key_configured: null,
          },
          stt: {
            engine_name: "SenseVoice Small via Sherpa-ONNX",
            provider: "local",
            deployment_kind: "local",
            active_engine: "sensevoice",
            cli_path: "/host/bin/sherpa-onnx-offline",
            cli_present: true,
            model_name: "SenseVoice Small",
            model_path: "/host/stt/model.int8.onnx",
            model_present: true,
            available: true,
            unavailable_reason: null,
            api_key_configured: null,
          },
          tts: {
            engine_name: "Kokoro-82M via Sherpa-ONNX",
            provider: "local",
            deployment_kind: "local",
            active_engine: "kokoro",
            command_path: "/host/bin/sherpa-onnx-offline-tts",
            command_present: true,
            model_name: "Kokoro-82M",
            model_path: "/host/tts/model.onnx",
            model_present: true,
            speaking: false,
            available: true,
            unavailable_reason: null,
            api_key_configured: null,
          },
        }),
      });
    });

    const refreshRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/help/rosie/v1/intelligence/refresh") &&
        request.method() === "POST",
      { timeout: 20_000 },
    );
    await page.route("**/api/help/rosie/v1/intelligence/refresh", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: {
            pack: {
              policy_pack_version: "rosie-policy-pack-2026-04-22-v1",
              intelligence_pack_version: "rosie-intelligence-pack-2026-04-22-v1",
              approved_source_groups: [
                {
                  key: "help_manuals",
                  label: "Help manuals",
                  description: "Bundled in-app Help Center manuals.",
                  source_count: 160,
                  source_paths: ["client/src/assets/docs/pos-manual.md"],
                },
              ],
              excluded_source_rules: [
                "raw live customer, order, payment, and catalog database content",
              ],
              issues_detected: [],
              last_generated_at: "2026-04-22T12:10:00Z",
            },
            last_reindex_at: "2026-04-22T12:11:00Z",
            meilisearch_configured: true,
            node_available: true,
            refresh_capabilities: {
              generate_help_manifest: true,
              reindex_search: true,
            },
          },
          generate_manifest: {
            ok: true,
            exit_code: 0,
            stdout: "manifest refreshed",
            stderr: "",
          },
          reindex_search: {
            ok: true,
            exit_code: 0,
            stdout: "help search reindex completed",
            stderr: "",
          },
          dry_run: false,
        }),
      });
    });

    await openSettingsRosiePanel(page);

    await expect(page.getByText("Local Gemma").first()).toBeVisible();
    await expect(page.getByText("Remote LM Studio").first()).toBeVisible();
    await expect(page.getByText("OpenAI").first()).toBeVisible();
    await expect(page.getByText("Gemini").first()).toBeVisible();
    await expect(
      page.getByText(/Remote LM Studio OpenAI-compatible endpoint is not reachable/i),
    ).toBeVisible();
    await expect(page.getByText(/governed intelligence pack/i)).toBeVisible();
    await expect(
      page.getByText(/rosie-policy-pack-2026-04-22-v1/i),
    ).toBeVisible();
    await expect(
      page.getByText(/unrestricted conversation history or chat transcripts/i),
    ).toBeVisible();

    await page.getByTestId("rosie-intelligence-refresh-reindex").click();
    const request = await refreshRequest;
    const body = request.postDataJSON() as {
      reindex_search?: boolean;
      dry_run?: boolean;
    };
    expect(body.reindex_search).toBe(true);
    expect(body.dry_run).toBe(false);
  });
});
