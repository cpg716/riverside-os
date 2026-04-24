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
import { enterPosShell } from "./helpers/openPosRegister";

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

test("opens Help from POS top bar", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await enterPosShell(page);
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

test("Ask ROSIE sends grounded Help request and renders source chips", async ({
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
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
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
    page.getByText(/grounded sources/i).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("help-center-rosie-source-chip").first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("Top Bar ROSIE opens voice-first Conversation Mode with grounded context", async ({
  page,
}) => {
  await signInToBackOffice(page);
  let toolContextCalled = false;
  await page.route("**/api/help/rosie/v1/tool-context", async (route) => {
    toolContextCalled = true;
    const body = route.request().postDataJSON() as {
      mode?: string;
      question?: string;
    };
    expect(body.mode).toBe("conversation");
    expect(body.question).toBe("show me today’s sales");
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
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
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
  await expect(page.getByText(/Mode: Conversation/i)).toBeVisible();
  await page
    .getByTestId("help-center-rosie-conversation-input")
    .fill("show me today’s sales");
  await page.getByTestId("help-center-ask-rosie-send").click();

  await expect(page.getByText(/1,250\.00 in sales/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText(/Grounding: governed RiversideOS context/i),
  ).toBeVisible();
  await expect(page.getByText(/Report — sales today/i)).toBeVisible();
  expect(toolContextCalled).toBe(true);
});

test("Ask ROSIE voice input reuses the normal text flow and can stop host voice output", async ({
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
  });

  await signInToBackOffice(page);
  let hostSpeaking = false;
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
          speaking: hostSpeaking,
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
  await page.route("**/api/help/rosie/v1/voice/speak", async (route) => {
    const body = route.request().postDataJSON() as {
      text?: string;
      voice?: string;
    };
    expect(body.text).toContain("Open the register reports workflow");
    expect(body.voice).toBe("5");
    hostSpeaking = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "ROSIE TTS started" }),
    });
  });
  await page.route("**/api/help/rosie/v1/voice/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ speaking: hostSpeaking }),
    });
  });
  await page.route("**/api/help/rosie/v1/voice/stop", async (route) => {
    hostSpeaking = false;
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
  await expect(
    page.getByText(/grounded sources/i).first(),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("help-center-ask-rosie-stop-audio").click();
  await expect(page.getByTestId("help-center-ask-rosie-speaking")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __rosieSpeechCancelled?: boolean }).__rosieSpeechCancelled === true))
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
  await page.route("**/api/help/rosie/v1/chat/completions", async (route) => {
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
    page.getByText(/Navy Suit is the top best seller/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Report — best sellers/i),
  ).toBeVisible({ timeout: 15_000 });
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
    expect(systemPrompt).toContain("Approved operational tool results are present");
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
