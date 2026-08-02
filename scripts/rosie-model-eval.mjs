#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureUrl = new URL("./fixtures/rosie-model-eval.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));
const endpoint = (process.env.ROSIE_EVAL_BASE_URL ?? "http://127.0.0.1:8080")
  .trim()
  .replace(/\/$/, "");
const model = (process.env.ROSIE_EVAL_MODEL ?? "local").trim();
const minimumPassRate = Number(process.env.ROSIE_EVAL_MIN_PASS_RATE ?? "1");

if (!Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1) {
  throw new Error("ROSIE_EVAL_MIN_PASS_RATE must be between 0 and 1");
}

const results = [];
for (const fixture of fixtures) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      reasoning: false,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: fixture.system },
        { role: "user", content: fixture.user },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const body = await response.json().catch(() => ({}));
  const answer = body?.choices?.[0]?.message?.content?.trim() ?? "";
  const normalized = answer.toLocaleLowerCase();
  const missing = fixture.required_terms.filter(
    (term) => !normalized.includes(term.toLocaleLowerCase()),
  );
  const forbidden = fixture.forbidden_terms.filter((term) =>
    normalized.includes(term.toLocaleLowerCase()),
  );
  results.push({
    id: fixture.id,
    passed: response.ok && answer.length > 0 && missing.length === 0 && forbidden.length === 0,
    status: response.status,
    elapsed_ms: elapsedMs,
    missing_required_terms: missing,
    present_forbidden_terms: forbidden,
    usage: body?.usage ?? null,
    answer,
  });
}

const passed = results.filter((result) => result.passed).length;
const passRate = results.length === 0 ? 0 : passed / results.length;
const summary = {
  endpoint,
  model,
  fixture_path: fileURLToPath(fixtureUrl),
  passed,
  total: results.length,
  pass_rate: passRate,
  average_latency_ms: Math.round(
    results.reduce((total, result) => total + result.elapsed_ms, 0) /
      Math.max(results.length, 1),
  ),
  results,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (passRate < minimumPassRate) {
  process.exitCode = 1;
}
