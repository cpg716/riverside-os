/** Typings for `api.js` — TS callers (e.g. auth bridge) only need the header provider. */
export function setWeddingManagerAuthHeadersProvider(
  fn: null | (() => HeadersInit),
): void;
