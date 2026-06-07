#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const catalog = read("client/src/lib/reportsCatalog.ts");
const workspace = read("client/src/components/reports/ReportsWorkspace.tsx");
const apiMod = read("server/src/api/mod.rs");
const insights = read("server/src/api/insights.rs");
const customers = read("server/src/api/customers.rs");

const responseKindsMatch = catalog.match(/export type ReportResponseKind =([\s\S]*?);/);
if (!responseKindsMatch) {
  throw new Error("Unable to locate ReportResponseKind union.");
}

const responseKinds = new Set(
  [...responseKindsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
);

const catalogStart = catalog.indexOf("export const REPORTS_CATALOG");
if (catalogStart === -1) {
  throw new Error("Unable to locate REPORTS_CATALOG.");
}

const catalogBody = catalog.slice(catalogStart);
const idMatches = [...catalogBody.matchAll(/\n\s+id: "([^"]+)"/g)];
const catalogBlocks = idMatches.map((match, index) => {
  const next = idMatches[index + 1];
  return [
    match[0],
    match[1],
    catalogBody.slice(match.index ?? 0, next?.index ?? catalogBody.length),
  ];
});
const availableReports = catalogBlocks
  .map((match) => {
    const [, id, body] = match;
    const planned = /status:\s*"planned"/.test(body);
    const responseKind = body.match(/responseKind:\s*"([^"]+)"/)?.[1] ?? null;
    const buildPath = body.match(/buildPath:[\s\S]*?=>\s+`([^`]+)`/)?.[1] ?? null;
    const chartConfigs = body.includes("chartConfigs:");
    return { id, planned, responseKind, buildPath, chartConfigs };
  })
  .filter((report) => !report.planned);

const failures = [];
const notes = [];

for (const report of availableReports) {
  if (!report.responseKind) {
    failures.push(`${report.id}: available report is missing responseKind`);
  } else if (!responseKinds.has(report.responseKind)) {
    failures.push(`${report.id}: unknown responseKind ${report.responseKind}`);
  } else if (!workspace.includes(`"${report.responseKind}"`)) {
    failures.push(`${report.id}: responseKind ${report.responseKind} is not handled in ReportsWorkspace`);
  }

  if (!report.buildPath) {
    failures.push(`${report.id}: available report is missing buildPath`);
    continue;
  }

  const concretePath = report.buildPath.replace(/\$\{[^}]+}/g, "x").split("?")[0];
  if (concretePath.startsWith("/api/insights/")) {
    const route = concretePath.replace("/api/insights", "");
    if (!insights.includes(`"${route}"`)) {
      failures.push(`${report.id}: missing insights route ${route}`);
    }
    continue;
  }

  if (concretePath.startsWith("/api/order-lifecycle/")) {
    if (!apiMod.includes('.nest("/api/order-lifecycle"')) {
      failures.push(`${report.id}: /api/order-lifecycle is not mounted`);
    }
    continue;
  }

  if (concretePath.startsWith("/api/customers/rms-charge/records")) {
    if (
      !apiMod.includes('.nest("/api/customers"') ||
      !customers.includes('"/rms-charge/records"')
    ) {
      failures.push(`${report.id}: /api/customers/rms-charge/records is not mounted`);
    }
    continue;
  }

  failures.push(`${report.id}: unverified report route ${concretePath}`);
}

if (!workspace.includes("reportPrintSubtitle(selected, ctx)")) {
  failures.push("ReportsWorkspace print path is not using reportPrintSubtitle");
}

if (!workspace.includes("salesByDayDailyRows(tableRows)")) {
  failures.push("Sales By Day daily normalization is missing");
}

if (!workspace.includes("salesByDayHourlyRows(tableRows)")) {
  failures.push("Sales By Day hourly chart aggregation is missing");
}

if (failures.length > 0) {
  console.error("Reports catalog check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (notes.length > 0) {
  for (const note of notes) console.log(note);
}

console.log(
  `Reports catalog check passed: ${availableReports.length} available reports verified.`,
);
