function trimmed(value) {
  return value == null ? "" : String(value).trim();
}

function isoDate(value) {
  const raw = trimmed(value);
  if (!raw) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
      ? `${raw}Z`
      : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function counterpointGiftCardReason(row) {
  const explicit = trimmed(row.reason_cod ?? row.reas_cod);
  if (explicit) return explicit;

  const program = trimmed(row.gfc_cod).toUpperCase();
  const description = trimmed(row.description ?? row.descr).toUpperCase();
  if (program === "PROMO GC" && description.includes("LOYALTY")) {
    return "LOYALTY";
  }
  return program || undefined;
}

export function mapCounterpointGiftCardRow(row, historyRows = []) {
  const issueDate = row.issue_dat ?? row.issued_at ?? row.orig_dat;
  return {
    cert_no: trimmed(row.cert_no ?? row.gft_cert_no ?? row.gift_cert_no),
    balance: String(row.balance ?? row.bal ?? row.bal_amt ?? "0"),
    original_value:
      row.original_value ??
      (row.orig_amt != null ? String(row.orig_amt) : undefined),
    reason_cod: counterpointGiftCardReason(row),
    expires_at: row.expires_at ?? undefined,
    issued_at: isoDate(issueDate),
    events: historyRows.map((history) => ({
      event_kind: String(history.action ?? history.event_kind ?? "adjustment").toLowerCase(),
      amount: String(history.amt ?? history.amount ?? "0"),
      balance_after:
        history.balance_after != null ? String(history.balance_after) : undefined,
      notes: history.tkt_no ? `Ticket ${history.tkt_no}` : undefined,
      created_at: history.trx_dat ?? history.created_at ?? undefined,
    })),
  };
}
