import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type RmsPaymentLineMeta } from "../components/pos/types";
import { type SearchResult } from "../components/pos/cart/PosSearchResultList";

const POS_SEARCH_RESULT_CAP = 200;

function shouldAttemptExactSkuScan(query: string): boolean {
  return /\d/.test(query) || /^[a-z]{1,6}[-_/]/i.test(query);
}

export function safeSearchResultLabel(item: Partial<SearchResult> | undefined | null): string {
  if (!item) return "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (name) return name;
  const sku = typeof item.sku === "string" ? item.sku.trim() : "";
  if (sku) return sku;
  return "";
}

interface UsePosSearchProps {
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  rmsPaymentMeta: RmsPaymentLineMeta | null;
  setRmsPaymentMeta: (meta: RmsPaymentLineMeta) => void;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}

export function usePosSearch({
  baseUrl,
  apiAuth,
  rmsPaymentMeta,
  setRmsPaymentMeta,
  toast,
}: UsePosSearchProps) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return [];
    }

    if (q.toLowerCase() === "payment") {
      try {
        let meta = rmsPaymentMeta;
        if (!meta) {
          const res = await fetch(`${baseUrl}/api/pos/rms-payment-line-meta`, {
            headers: apiAuth(),
          });
          if (!res.ok) {
            setSearchResults([]);
            toast(
              "RMS payment line is not available. Sign in or run migrations.",
              "error",
            );
            return;
          }
          const payload = (await res.json()) as RmsPaymentLineMeta | null;
          if (!payload) {
            setSearchResults([]);
            toast(
              "RMS payment line is not available. Ensure layout POS products are created.",
              "error",
            );
            return;
          }
          meta = payload;
          setRmsPaymentMeta(meta);
        }
        const results = [
          {
            product_id: meta.product_id,
            variant_id: meta.variant_id,
            sku: meta.sku,
            name: meta.name,
            standard_retail_price: 0,
            unit_cost: 0,
            state_tax: 0,
            local_tax: 0,
            stock_on_hand: 0,
            vendor_sku: "",
          },
        ];
        setSearchResults(results);
        return results;
      } catch {
        setSearchResults([]);
        toast("Could not load RMS payment line.", "error");
      }
      return [];
    }

    const requests: Promise<void>[] = [];
    const collected: SearchResult[] = [];

    // 1. Direct SKU/Scan resolution. Skip plain name searches so expected misses do not
    // surface as noisy 404s while staff are searching customers or product names.
    if (shouldAttemptExactSkuScan(q)) {
      requests.push(
        fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
          headers: apiAuth(),
        }).then(async (res) => {
          if (res.ok) {
            const r = (await res.json()) as Partial<SearchResult>;
            const sku = typeof r.sku === "string" ? r.sku : String(r.sku ?? "");
            const name = safeSearchResultLabel({ ...r, sku }) || sku;
            collected.push({
              ...(r as SearchResult),
              product_id:
                typeof r.product_id === "string"
                  ? r.product_id
                  : String(r.product_id ?? ""),
              variant_id:
                typeof r.variant_id === "string"
                  ? r.variant_id
                  : String(r.variant_id ?? ""),
              sku,
              name,
            });
          }
        }),
      );
    }

    // 2. Control Board Fuzzy Search
    requests.push(
      fetch(
        `${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&limit=${POS_SEARCH_RESULT_CAP}`,
        {
          headers: apiAuth(),
        },
      ).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as {
            rows: Array<Record<string, unknown>>;
          };
          const mapped = (data.rows || []).map((r) => {
            const sku = String(r.sku ?? "");
            const name = String(r.product_name ?? r.name ?? sku).trim() || sku;
            return {
              product_id: String(r.product_id ?? ""),
              variant_id: String(r.variant_id ?? ""),
              sku,
              name,
              variation_label:
                typeof r.variation_label === "string" ? r.variation_label : null,
              standard_retail_price: r.retail_price || 0,
              unit_cost: r.cost_price || 0,
              stock_on_hand: r.stock_on_hand || 0,
              state_tax: r.state_tax || 0,
              local_tax: r.local_tax || 0,
              tax_category: r.tax_category as "clothing" | "footwear" | "other",
              vendor_sku: (r.vendor_sku as string) || "",
            };
          });
          collected.push(...(mapped as SearchResult[]));
        }
      }),
    );

    try {
      await Promise.all(requests);
      const seen = new Set<string>();
      const finalResults = collected.filter((it) => {
        if (seen.has(it.variant_id)) return false;
        seen.add(it.variant_id);
        return true;
      });
      setSearchResults(finalResults);
      return finalResults;
    } catch (e) {
      console.error("POS Search Error", e);
      return [];
    }
  }, [baseUrl, apiAuth, rmsPaymentMeta, setRmsPaymentMeta, toast]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults([]);
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
      return;
    }
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      void runSearch(search);
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [search, runSearch]);

  const groupedSearchResults = useMemo(() => {
    const groups: Record<string, SearchResult[]> = {};
    searchResults.forEach((r) => {
      if (!groups[r.product_id]) groups[r.product_id] = [];
      groups[r.product_id].push(r);
    });
    return Object.values(groups).sort((a, b) => {
      const q = search.trim().toLowerCase();
      const aExact = a.some((v) => String(v.sku ?? "").toLowerCase() === q);
      const bExact = b.some((v) => String(v.sku ?? "").toLowerCase() === q);
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return safeSearchResultLabel(a[0]).localeCompare(
        safeSearchResultLabel(b[0]),
        undefined,
        { sensitivity: "base" },
      );
    });
  }, [searchResults, search]);

  return {
    search,
    setSearch,
    searchResults,
    setSearchResults,
    groupedSearchResults,
    runSearch,
  };
}
