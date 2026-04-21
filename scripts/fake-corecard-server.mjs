import http from "node:http";

const port = Number.parseInt(process.env.E2E_CORECARD_PORT || "43400", 10);

const defaultAccounts = {
  "CC-E2E-STANDARD": {
    status: "active",
    masked: "••••1001",
    available_credit: "1800.00",
    current_balance: "225.00",
    programs: [{ program_code: "standard", program_label: "Standard", eligible: true, disclosure: "Primary revolving RMS Charge program." }],
  },
  "CC-E2E-STANDARD-ONLY": {
    status: "active",
    masked: "••••1002",
    available_credit: "1600.00",
    current_balance: "110.00",
    programs: [{ program_code: "standard", program_label: "Standard", eligible: true, disclosure: "Primary revolving RMS Charge program." }],
  },
  "CC-E2E-RMS90": {
    status: "active",
    masked: "••••9090",
    available_credit: "2400.00",
    current_balance: "90.00",
    programs: [
      { program_code: "standard", program_label: "Standard", eligible: true, disclosure: "Primary revolving RMS Charge program." },
      { program_code: "rms90", program_label: "RMS 90", eligible: true, disclosure: "Promotional 90-day financing." },
    ],
  },
  "CC-E2E-MULTI-A": {
    status: "active",
    masked: "••••3001",
    available_credit: "1200.00",
    current_balance: "300.00",
    programs: [{ program_code: "standard", program_label: "Standard", eligible: true, disclosure: "Primary revolving RMS Charge program." }],
  },
  "CC-E2E-MULTI-B": {
    status: "active",
    masked: "••••3090",
    available_credit: "2200.00",
    current_balance: "450.00",
    programs: [
      { program_code: "standard", program_label: "Standard", eligible: true, disclosure: "Primary revolving RMS Charge program." },
      { program_code: "rms90", program_label: "RMS 90", eligible: true, disclosure: "Promotional 90-day financing." },
    ],
  },
  "CC-E2E-RESTRICTED": {
    status: "restricted",
    masked: "••••4004",
    available_credit: "0.00",
    current_balance: "800.00",
    programs: [{ program_code: "standard", program_label: "Standard", eligible: false, disclosure: "Account restricted." }],
  },
};

let callLog = [];
let scenarios = {};
let accountTransactions = {};
let seq = 1;

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function accountFor(accountId) {
  return defaultAccounts[accountId] || {
    status: "active",
    masked: "••••9999",
    available_credit: "1500.00",
    current_balance: "0.00",
    programs: [{ program_code: "standard", program_label: "Standard", eligible: true, disclosure: "Default E2E program." }],
  };
}

function scenarioFor(operation, accountId) {
  return scenarios[`${operation}:${accountId}`] || scenarios[`${operation}:*`] || scenarios[`*:${accountId}`] || scenarios["*:*"] || "success";
}

function appendTransaction(accountId, operation, payload, result) {
  const account = accountFor(accountId);
  const row = {
    occurred_at: new Date().toISOString(),
    kind: operation,
    amount: String(payload.amount ?? "0.00"),
    status: result.posting_status ?? "posted",
    program_label:
      payload.program_code === "rms90"
        ? "RMS 90"
        : payload.program_code === "standard"
        ? "Standard"
        : null,
    masked_account: account.masked,
    order_short_ref: payload.reference_hint || null,
    external_reference: result.host_reference || result.external_transaction_id || null,
  };
  accountTransactions[accountId] = [row, ...(accountTransactions[accountId] || [])].slice(0, 25);
}

function mutationSuccess(operation, accountId, payload) {
  const account = accountFor(accountId);
  const suffix = String(seq++).padStart(4, "0");
  const result = {
    success: true,
    posting_status: operation === "refund" ? "refunded" : operation === "reversal" ? "reversed" : "posted",
    external_transaction_id: `${operation.toUpperCase()}-${accountId}-${suffix}`,
    external_auth_code: `AUTH${suffix}`,
    external_transaction_type: operation,
    host_reference: `HOST-${account.masked.slice(-4)}-${suffix}`,
    posted_at: new Date().toISOString(),
  };
  appendTransaction(accountId, operation, payload, result);
  return result;
}

function mutationFailure(kind) {
  switch (kind) {
    case "insufficient_credit":
      return [402, { success: false, error_code: "insufficient_credit", message: "Insufficient available credit." }];
    case "restricted":
      return [403, { success: false, error_code: "account_restricted", message: "Account is inactive or restricted." }];
    case "invalid_program":
      return [422, { success: false, error_code: "invalid_program", message: "Program is not eligible for this account." }];
    case "account_program_mismatch":
      return [422, { success: false, error_code: "account_program_mismatch", message: "Account and program do not match." }];
    case "duplicate":
      return [409, { success: false, error_code: "duplicate_submission", message: "Duplicate submission." }];
    case "timeout":
      return [504, { success: false, error_code: "timeout", message: "CoreCard host timed out." }];
    case "retryable":
      return [503, { success: false, error_code: "host_unavailable", message: "CoreCard host unavailable." }];
    default:
      return [500, { success: false, error_code: "unknown_host_failure", message: "Unknown fake host failure." }];
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/__admin/reset") {
    callLog = [];
    scenarios = {};
    accountTransactions = {};
    seq = 1;
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/__admin/scenario") {
    const body = await readJson(req).catch(() => ({}));
    const operation = String(body.operation || "*").trim();
    const accountId = String(body.account_id || "*").trim();
    const response = String(body.response || "success").trim();
    scenarios[`${operation}:${accountId}`] = response;
    writeJson(res, 200, { ok: true, key: `${operation}:${accountId}`, response });
    return;
  }

  if (req.method === "GET" && pathname === "/__admin/calls") {
    writeJson(res, 200, { calls: callLog });
    return;
  }

  if (req.method === "POST" && pathname === "/oauth/token") {
    writeJson(res, 200, { access_token: "fake-corecard-token", token_type: "bearer", expires_in: 3600 });
    return;
  }

  const summaryMatch = pathname.match(/^\/accounts\/([^/]+)\/summary$/);
  if (req.method === "GET" && summaryMatch) {
    const accountId = decodeURIComponent(summaryMatch[1]);
    const account = accountFor(accountId);
    writeJson(res, 200, {
      masked_account: account.masked,
      available_credit: account.available_credit,
      current_balance: account.current_balance,
      account_status: account.status,
      resolution_status: "host_verified",
    });
    return;
  }

  const balancesMatch = pathname.match(/^\/accounts\/([^/]+)\/balances$/);
  if (req.method === "GET" && balancesMatch) {
    const accountId = decodeURIComponent(balancesMatch[1]);
    const account = accountFor(accountId);
    writeJson(res, 200, {
      account_id: accountId,
      masked_account: account.masked,
      account_status: account.status,
      available_credit: account.available_credit,
      current_balance: account.current_balance,
      source: "fake_corecard",
    });
    return;
  }

  const programsMatch = pathname.match(/^\/accounts\/([^/]+)\/programs$/);
  if (req.method === "GET" && programsMatch) {
    const accountId = decodeURIComponent(programsMatch[1]);
    writeJson(res, 200, { programs: accountFor(accountId).programs });
    return;
  }

  const transactionsMatch = pathname.match(/^\/accounts\/([^/]+)\/transactions$/);
  if (req.method === "GET" && transactionsMatch) {
    const accountId = decodeURIComponent(transactionsMatch[1]);
    writeJson(res, 200, { rows: accountTransactions[accountId] || [] });
    return;
  }

  const mutationMatch = pathname.match(/^\/transactions\/(purchase|payment|refund|reversal)$/);
  if (req.method === "POST" && mutationMatch) {
    const operation = mutationMatch[1];
    const payload = await readJson(req).catch(() => ({}));
    const accountId = String(payload.corecredit_account_id || "").trim();
    callLog.push({
      operation,
      account_id: accountId,
      idempotency_key: req.headers["x-riverside-idempotency-key"] || null,
      payload,
      received_at: new Date().toISOString(),
    });

    const scenario = scenarioFor(operation, accountId);
    if (scenario !== "success") {
      const [status, body] = mutationFailure(scenario);
      writeJson(res, status, body);
      return;
    }

    writeJson(res, 200, mutationSuccess(operation, accountId, payload));
    return;
  }

  writeJson(res, 404, { error: "not_found", path: pathname });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-corecard-server listening on http://127.0.0.1:${port}`);
});
