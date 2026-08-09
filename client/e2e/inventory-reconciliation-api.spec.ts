import { expect, test } from "@playwright/test";

import { apiBase, staffHeaders } from "./helpers/rmsCharge";

type ReconciliationResponse = {
  total_findings: number;
  filtered_findings: number;
  issue_counts: Record<string, number>;
  limit: number;
  offset: number;
  findings: Array<{ issue_kind: string }>;
};

test("inventory reconciliation API returns truthful totals and filtered paging", async ({
  request,
}) => {
  const allRes = await request.get(
    `${apiBase()}/api/products/reconciliation?limit=1&offset=0`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const allText = await allRes.text();
  expect(allRes.status(), allText.slice(0, 1000)).toBe(200);
  const all = JSON.parse(allText) as ReconciliationResponse;
  const countedTotal = Object.values(all.issue_counts).reduce(
    (sum, count) => sum + count,
    0,
  );

  expect(all.total_findings).toBe(countedTotal);
  expect(all.filtered_findings).toBe(all.total_findings);
  expect(all.limit).toBe(1);
  expect(all.offset).toBe(0);
  expect(all.findings.length).toBeLessThanOrEqual(1);

  const issueKind = "negative_available_stock";
  const filteredRes = await request.get(
    `${apiBase()}/api/products/reconciliation?issue_kind=${issueKind}&limit=1&offset=1`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const filteredText = await filteredRes.text();
  expect(filteredRes.status(), filteredText.slice(0, 1000)).toBe(200);
  const filtered = JSON.parse(filteredText) as ReconciliationResponse;

  expect(filtered.total_findings).toBe(all.total_findings);
  expect(filtered.filtered_findings).toBe(filtered.issue_counts[issueKind]);
  expect(filtered.limit).toBe(1);
  expect(filtered.offset).toBe(1);
  expect(filtered.findings.every((finding) => finding.issue_kind === issueKind)).toBe(
    true,
  );

  const invalidRes = await request.get(
    `${apiBase()}/api/products/reconciliation?issue_kind=not-a-real-finding`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(invalidRes.status()).toBe(400);
});
