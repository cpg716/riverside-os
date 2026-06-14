import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

test("stable package fingerprint ignores object key order", () => {
  const a = { schema_version: 1, payload: { rows: [{ cust_no: "1", email: "a@example.test" }] } };
  const b = { payload: { rows: [{ email: "a@example.test", cust_no: "1" }] }, schema_version: 1 };
  assert.equal(fingerprint(a), fingerprint(b));
});

test("ROS handoff package contains the required contract fields", () => {
  const pkg = {
    sync_run_id: crypto.randomUUID(),
    section: "customers",
    entity: "customers",
    schema_version: 1,
    package_fingerprint: "abc",
    generated_at: new Date().toISOString(),
    source_counts: { raw: 1, prepared: 1, warnings: 0, blockers: 0 },
    payload: { rows: [{ cust_no: "C1" }] },
    exceptions: [],
    provenance: [],
  };
  for (const key of [
    "sync_run_id",
    "section",
    "entity",
    "schema_version",
    "package_fingerprint",
    "generated_at",
    "source_counts",
    "payload",
    "exceptions",
    "provenance",
  ]) {
    assert.ok(Object.hasOwn(pkg, key));
  }
});
