import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type RmsPaymentLineMeta } from "../components/pos/types";
import { type SearchResult } from "../components/pos/cart/PosSearchResultList";

const POS_SEARCH_RESULT_CAP = 200;

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
      return;
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
        setSearchResults([
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
          },
        ]);
      } catch {
        setSearchResults([]);
        toast("Could not load RMS payment line.", "error");
      }
      return;
    }

    const requests: Promise<void>[] = [];
    const collected: SearchResult[] = [];

    // 1. Direct SKU/Scan resolution
    requests.push(
      fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
        headers: apiAuth(),
      }).then(async (res) => {
        if (res.ok) {
          const r = (await res.json()) as SearchResult;
          collected.push(r);
        }
      })
    );

    // 2. Control Board Fuzzy Search
    requests.push(
      fetch(
        `${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&limit=${POS_SEARCH_RESULT_CAP}`,
        {
          headers: apiAuth(),
        },
      ).then(async (res) => {
        if (res.ok) {
          const data = await res.json() as { rows: Array<Record<string, unknown>> };
          const mapped = (data.rows || []).map((r) => ({
            product_id: r.product_id,
            variant_id: r.variant_id,
            sku: r.sku,
            name: r.product_name,
            variation_label: r.variation_label,
            standard_retail_price: r.retail_price || 0,
            unit_cost: r.cost_price || 0,
            stock_on_hand: r.stock_on_hand || 0,
            state_tax: r.state_tax || 0,
            local_tax: r.local_tax || 0,
            tax_category: r.tax_category as "clothing" | "footwear" | "other",
          }));
          collected.push(...(mapped as SearchResult[]));
        }
      }),
    );

    try {
      await Promise.all(requests);
      const seen = new Set<string>();
      const finalResults = collected.filter(it => {
        if (seen.has(it.variant_id)) return false;
        seen.add(it.variant_id);
        return true;
      });
      setSearchResults(finalResults);
    } catch (e) {
      console.error("POS Search Error", e);
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
    searchResults.forEach(r => {
      if (!groups[r.product_id]) groups[r.product_id] = [];
      groups[r.product_id].push(r);
    });
    return Object.values(groups).sort((a,b) => a[0].name.localeCompare(b[0].name));
  }, [searchResults]);

  return useMemo(() => ({
    search,
    setSearch,
    searchResults,
    setSearchResults,
    groupedSearchResults,
    runSearch,
  }), [
    search,
    searchResults,
    groupedSearchResults,
    runSearch,
  ]);
}
