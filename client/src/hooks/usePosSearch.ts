import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type RmsPaymentLineMeta } from "../components/pos/types";
import { type SearchResult } from "../components/pos/cart/PosSearchResultList";
import { fetchWithTimeout } from "../lib/api";

function shouldAttemptExactSkuScan(query: string): boolean {
  return /\d/.test(query) || /^[a-z]{1,6}[-_/]/i.test(query);
}

function isExactSkuLookup(query: string): boolean {
  const normalized = query.trim();
  if (!normalized || /\s/.test(normalized)) return false;
  if (/^(B|I)-\d+$/i.test(normalized)) return true;
  if (/^CP-[a-z0-9]+$/i.test(normalized)) return true;
  if (/^ROS-[a-z0-9]+$/i.test(normalized)) return true;
  return false;
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
  const searchRequestRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    const requestId = ++searchRequestRef.current;
    const isCurrent = () => requestId === searchRequestRef.current;
    searchAbortRef.current?.abort();
    const abortController = new AbortController();
    searchAbortRef.current = abortController;
    if (q.length < 2) {
      setSearchResults([]);
      return [];
    }

    const feeShortcut = q.toUpperCase();
    if (feeShortcut === "ALTERATION" || feeShortcut === "ALTERATIONS") {
      const results: SearchResult[] = [{
        product_id: "b7c0a006-0006-4006-8006-000000000006",
        variant_id: "b7c0a007-0007-4007-8007-000000000007",
        sku: "ROS-ALTERATION-FEE",
        name: "ALTERATIONS FEE — ENTER AMOUNT",
        standard_retail_price: 0,
        unit_cost: 0,
        state_tax: 0,
        local_tax: 0,
        tax_category: "service",
        stock_on_hand: 0,
        vendor_sku: "",
      }];
      setSearchResults(results);
      return results;
    }

    if (feeShortcut === "SHIPPING") {
      const results: SearchResult[] = [{
        product_id: "pos-shipping-fee",
        variant_id: "pos-shipping-fee",
        sku: "ROS-SHIPPING-FEE",
        name: "SHIPPING FEE — ENTER AMOUNT",
        standard_retail_price: 0,
        unit_cost: 0,
        state_tax: 0,
        local_tax: 0,
        tax_category: "service",
        stock_on_hand: 0,
        vendor_sku: "",
      }];
      setSearchResults(results);
      return results;
    }

    if (q.toLowerCase() === "payment") {
      try {
        let meta = rmsPaymentMeta;
        if (!meta) {
          const res = await fetchWithTimeout(`${baseUrl}/api/pos/rms-payment-line-meta`, {
            headers: apiAuth(),
            signal: abortController.signal,
          });
          if (!isCurrent()) return [];
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
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return [];
        setSearchResults([]);
        toast("Could not load RMS payment line.", "error");
      }
      return [];
    }

    const requests: Promise<void>[] = [];
    const collected: SearchResult[] = [];
    const exactSkuOnly = isExactSkuLookup(q);

    // 1. Direct SKU/Scan resolution. Skip plain name searches so expected misses do not
    // surface as noisy 404s while staff are searching customers or product names.
    if (shouldAttemptExactSkuScan(q)) {
      requests.push(
        fetchWithTimeout(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
          headers: apiAuth(),
          signal: abortController.signal,
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
          } else if (exactSkuOnly && res.status === 404) {
            toast(`SKU NOT FOUND: ${q}`, "error");
          }
        }),
      );
    }

    if (exactSkuOnly) {
      try {
        await Promise.all(requests);
        setSearchResults(collected);
        return collected;
      } catch (e) {
        console.error("POS SKU Scan Error", e);
        setSearchResults([]);
        toast(`SKU NOT FOUND: ${q}`, "error");
        return [];
      }
    }

    // 2. Parent Product Fuzzy Search
    requests.push(
      fetchWithTimeout(
        `${baseUrl}/api/products/pos-parent-search?search=${encodeURIComponent(q)}&limit=100`,
        {
          headers: apiAuth(),
          signal: abortController.signal,
        },
      ).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as Array<Record<string, unknown>>;
          const mapped = (data || []).map((r) => {
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
              primary_vendor_name:
                typeof r.primary_vendor_name === "string"
                  ? r.primary_vendor_name
                  : null,
              total_variant_count: Number(r.total_variant_count ?? 1),
            };
          });
          collected.push(...(mapped as SearchResult[]));
        }
      }),
    );

    try {
      await Promise.all(requests);
      if (!isCurrent()) return [];
      const seen = new Set<string>();
      const finalResults = collected.filter((it) => {
        if (seen.has(it.variant_id)) return false;
        seen.add(it.variant_id);
        return true;
      });
      setSearchResults(finalResults);
      return finalResults;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return [];
      console.error("POS Search Error", e);
      setSearchResults([]);
      toast("Product search failed. Check the Main Hub connection and try again.", "error");
      return [];
    } finally {
      if (searchAbortRef.current === abortController) searchAbortRef.current = null;
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
