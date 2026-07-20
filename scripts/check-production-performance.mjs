const baseUrl = (
  process.env.RIVERSIDE_PERF_BASE_URL?.trim() || "https://ros.riversidemens.com"
).replace(/\/$/, "");

if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl) && process.env.ALLOW_LOCAL_PERF !== "1") {
  throw new Error("Production performance checks refuse localhost; set RIVERSIDE_PERF_BASE_URL to the Main Hub URL.");
}

const budgets = {
  healthMs: Number(process.env.RIVERSIDE_PERF_HEALTH_BUDGET_MS || 1000),
  searchMs: Number(process.env.RIVERSIDE_PERF_SEARCH_BUDGET_MS || 1500),
  reportMs: Number(process.env.RIVERSIDE_PERF_REPORT_BUDGET_MS || 3000),
};

const headers = process.env.RIVERSIDE_PERF_HEADERS_JSON
  ? JSON.parse(process.env.RIVERSIDE_PERF_HEADERS_JSON)
  : {};

async function measure(path, budgetMs) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  if (elapsedMs > budgetMs) {
    throw new Error(`${path} exceeded ${budgetMs}ms budget (${elapsedMs.toFixed(0)}ms)`);
  }
  console.log(`${path}: ${response.status} in ${elapsedMs.toFixed(0)}ms`);
  return response;
}

await measure("/api/live", budgets.healthMs);
const readyResponse = await measure("/api/ready", budgets.healthMs);
await measure("/api/health", budgets.healthMs);

const ready = await readyResponse.json();
const workers = ready.background_workers ?? {};
console.log(
  `dependencies: redis=${workers.redis_connected ? "connected" : workers.redis_configured ? "configured but unavailable" : "not configured"}, ` +
    `job_queue=${workers.job_queue_worker ? "running" : workers.job_queue_enabled ? "enabled but not healthy" : "disabled"}`,
);

const searchPath = process.env.RIVERSIDE_PERF_SEARCH_PATH?.trim();
const reportPath = process.env.RIVERSIDE_PERF_REPORT_PATH?.trim();
if (searchPath) await measure(searchPath, budgets.searchMs);
else console.log("search: skipped (set RIVERSIDE_PERF_SEARCH_PATH for an authenticated read-only query)");
if (reportPath) await measure(reportPath, budgets.reportMs);
else console.log("report: skipped (set RIVERSIDE_PERF_REPORT_PATH for an authenticated read-only query)");
