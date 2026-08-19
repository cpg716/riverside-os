#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbName = `ros_pre_retag_migration_${process.pid}_${Date.now()}`;
const appRole = `ros_migration_app_${process.pid}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    input: options.input,
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }
  return result;
}

function psql(database, sql, options = {}) {
  return run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      ...(options.tuplesOnly ? ["-tA"] : []),
    ],
    { input: sql, capture: options.capture, allowFailure: options.allowFailure },
  );
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  let lastError = "";

  while (Date.now() < deadline) {
    const result = psql("postgres", "SELECT 1;", {
      allowFailure: true,
      capture: true,
      tuplesOnly: true,
    });

    if (result.status === 0) {
      return;
    }

    lastError = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    sleep(500);
  }

  throw new Error(`Postgres container did not become ready within 60 seconds.${lastError ? `\n${lastError}` : ""}`);
}

function isTransientPostgresStartupError(result) {
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
  return (
    output.includes("the database system is starting up") ||
    output.includes("the database system is shutting down") ||
    output.includes("could not connect to server") ||
    output.includes("connection to server")
  );
}

function runPostgresAdminCommandWithRetry(sql, options = {}) {
  const deadline = Date.now() + 60_000;
  let lastResult;

  while (Date.now() < deadline) {
    lastResult = run(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { allowFailure: true, capture: true },
    );

    if (lastResult.status === 0) {
      if (!options.quiet) {
        process.stdout.write(lastResult.stdout);
        process.stderr.write(lastResult.stderr);
      }
      return lastResult;
    }

    if (!isTransientPostgresStartupError(lastResult)) {
      const detail = [lastResult.stderr, lastResult.stdout].filter(Boolean).join("\n").trim();
      throw new Error(`docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c ${sql} failed with exit code ${lastResult.status}${detail ? `\n${detail}` : ""}`);
    }

    sleep(500);
  }

  const detail = [lastResult?.stderr, lastResult?.stdout].filter(Boolean).join("\n").trim();
  throw new Error(`Postgres admin command did not succeed within 60 seconds: ${sql}${detail ? `\n${detail}` : ""}`);
}

const repairSerialSequencesSql = `
DO $$
DECLARE
  rec record;
  max_value bigint;
BEGIN
  FOR rec IN
    SELECT
      n.nspname AS table_schema,
      c.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = 'public'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT COALESCE(MAX(%I), 0) FROM %I.%I',
      rec.column_name,
      rec.table_schema,
      rec.table_name
    )
    INTO max_value;

    EXECUTE format(
      'SELECT setval(%L::regclass, GREATEST(%s + 1, 1), false)',
      rec.sequence_name,
      max_value
    );
  END LOOP;
END $$;
`;

function dropDatabase() {
  runPostgresAdminCommandWithRetry(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`, { quiet: true });
}

function dropAppRole() {
  runPostgresAdminCommandWithRetry(`DROP ROLE IF EXISTS ${appRole};`, {
    quiet: true,
  });
}

console.log("[pre-retag] Starting dirty migration rehearsal...");
run("docker", ["compose", "up", "-d", "db"]);
waitForPostgres();

try {
  dropDatabase();
  dropAppRole();
  runPostgresAdminCommandWithRetry(`CREATE ROLE ${appRole};`);
  runPostgresAdminCommandWithRetry(`CREATE DATABASE ${dbName};`);

  psql(
    dbName,
    `
CREATE TABLE public.counterpoint_payment_method_map (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cp_pmt_typ text UNIQUE NOT NULL,
  ros_method text NOT NULL
);

CREATE TABLE public.ros_schema_migrations (
  version text PRIMARY KEY,
  file_sha256 text,
  applied_at timestamptz DEFAULT now()
);

INSERT INTO public.counterpoint_payment_method_map (id, cp_pmt_typ, ros_method)
VALUES (8, 'EXISTING', 'cash');

SELECT setval(
  pg_get_serial_sequence('public.counterpoint_payment_method_map', 'id'),
  8,
  false
);
`,
  );

  const preRepair = psql(
    dbName,
    "INSERT INTO public.counterpoint_payment_method_map (cp_pmt_typ, ros_method) VALUES ('PRE_REPAIR_SHOULD_FAIL', 'cash');",
    { allowFailure: true, capture: true },
  );
  if (preRepair.status === 0) {
    throw new Error("Dirty migration rehearsal did not reproduce the stale sequence duplicate-key failure.");
  }

  psql(dbName, repairSerialSequencesSql);

  const migrationPath = path.join(root, "migrations", "080_counterpoint_payment_method_aliases.sql");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  psql(dbName, migrationSql);

  const result = psql(
    dbName,
    "SELECT id::text || ':' || cp_pmt_typ FROM public.counterpoint_payment_method_map WHERE cp_pmt_typ = 'CREDITCARD';",
    { capture: true, tuplesOnly: true },
  );
  const landed = result.stdout.trim();
  if (landed !== "9:CREDITCARD") {
    throw new Error(`Dirty migration rehearsal landed unexpected row ${JSON.stringify(landed)}; expected 9:CREDITCARD.`);
  }

  psql(
    dbName,
    `
ALTER SCHEMA public OWNER TO ${appRole};

CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  base_cost numeric(12, 2)
);
ALTER TABLE public.products OWNER TO ${appRole};

CREATE TABLE public.product_variants (
  id uuid PRIMARY KEY,
  cost_override numeric(12, 2)
);
ALTER TABLE public.product_variants OWNER TO ${appRole};

CREATE TABLE public.inventory_transactions (
  id uuid PRIMARY KEY,
  variant_id uuid,
  tx_type text NOT NULL,
  unit_cost numeric(12, 2),
  created_at timestamptz NOT NULL
);
ALTER TABLE public.inventory_transactions OWNER TO ${appRole};

CREATE TABLE public.inventory_average_cost_line_repair_audit (
  id uuid PRIMARY KEY
);
`,
  );

  const averageCostMigrationPath = path.join(
    root,
    "migrations",
    "207_inventory_average_and_last_cost.sql",
  );
  const averageCostMigrationSql = fs.readFileSync(
    averageCostMigrationPath,
    "utf8",
  );
  const ownershipFailure = psql(
    dbName,
    `BEGIN; SET ROLE ${appRole};\n${averageCostMigrationSql}\nCOMMIT;`,
    { allowFailure: true, capture: true },
  );
  const ownershipFailureOutput = [
    ownershipFailure.stderr,
    ownershipFailure.stdout,
  ]
    .filter(Boolean)
    .join("\n");
  if (
    ownershipFailure.status === 0 ||
    !ownershipFailureOutput.includes(
      "must be owner of table inventory_average_cost_line_repair_audit",
    )
  ) {
    throw new Error(
      `Dirty migration rehearsal did not reproduce the production average-cost audit ownership failure.\n${ownershipFailureOutput.trim()}`,
    );
  }

  psql(
    dbName,
    `ALTER TABLE public.inventory_average_cost_line_repair_audit OWNER TO ${appRole};`,
  );
  psql(
    dbName,
    `BEGIN; SET ROLE ${appRole};\n${averageCostMigrationSql}\nCOMMIT;`,
  );

  const averageCostResult = psql(
    dbName,
    `
SELECT pg_get_userbyid(c.relowner)
  || ':' || (to_regclass('public.inventory_average_cost_line_repair_audit') IS NOT NULL)::text
  || ':' || EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'last_cost'
  )::text
FROM pg_class c
WHERE c.oid = 'public.inventory_average_cost_line_repair_audit'::regclass;
`,
    { capture: true, tuplesOnly: true },
  );
  const averageCostLanded = averageCostResult.stdout.trim();
  if (averageCostLanded !== `${appRole}:true:true`) {
    throw new Error(
      `Average-cost ownership rehearsal landed unexpected state ${JSON.stringify(averageCostLanded)}.`,
    );
  }

  console.log("[pre-retag] Dirty migration rehearsal passed.");
} finally {
  dropDatabase();
  dropAppRole();
}
