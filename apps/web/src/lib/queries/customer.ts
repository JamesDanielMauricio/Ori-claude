import { orderableCatalogInputSchema, toOrderableCatalogRpcArgs } from "@ori/domain/customer";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { CatalogRow } from "@/components/customer/catalog-grouping";
import { growersByVariety } from "@/components/customer/preferred-grower";
import { createClient } from "@/lib/supabase/client";

import type { TradingDayPhase } from "./trading-day";

// Server reads behind the customer's own screens (order + history), each
// defined once — key + fetch together; see lib/queries/trading-day.ts for
// why the keys matter. The backoffice's on-behalf-of order editor reuses
// customerQueries.catalog with an explicit company.

export const customerKeys = {
  // Every order catalog, any day and company — what a price save made on a
  // backoffice screen invalidates: product_varieties is out of live updates
  // (migration 0061), so an open catalog would otherwise keep the old price
  // for up to the 30 s staleTime.
  catalogAll: ["customer", "catalog"] as const,
};

export interface CustomerHistoryDay {
  id: string;
  trade_date: string;
  phase: TradingDayPhase;
  // Reverse relation (trading_days -> daily_orders): RLS
  // (daily_orders_select_own) already scopes this to the caller's own
  // company, and the table's `unique(trading_day_id, customer_company_id)`
  // means there is at most one entry here — an array only because that's
  // how PostgREST shapes a one-to-many embed.
  daily_orders: Array<{ id: string; status: "open" | "submitted"; submitted_at: string | null }>;
}

// Days per "הצג עוד" batch — same paging as the grower's pick history
// (growerQueries.pickHistory explains why the list isn't loaded whole).
const HISTORY_PAGE_SIZE = 60;

export interface SpecificOrder {
  id: string;
  status: "open" | "submitted";
  submitted_at: string | null;
  trading_day_id: string;
  trading_days: { trade_date: string; phase: TradingDayPhase } | null;
}

export interface EmptyTradingDay {
  trade_date: string;
  phase: TradingDayPhase;
}

// One row of get_customer_order_lines (migration 0056) — the order's lines
// with their names, read through that function because customers can't read
// product_varieties (and its prices) directly.
export interface HistoricalLineRow {
  id: string;
  pallets_ordered: number;
  comment: string | null;
  variety_name: string;
  family_id: string;
  family_name: string;
  image_url: string | null;
  pack_type: "pallets" | "crates" | null;
}

export const customerQueries = {
  // One customer's orderable catalog for a trading day, with their current
  // order quantities — get_orderable_catalog_for_customer. `customerCompanyId`
  // is only passed on the backoffice's on-behalf-of path; a customer's own
  // session reads its own company ("self" in the key).
  catalog(tradingDayId: string, customerCompanyId?: string) {
    return queryOptions({
      queryKey: [...customerKeys.catalogAll, tradingDayId, customerCompanyId ?? "self"],
      queryFn: async (): Promise<CatalogRow[]> => {
        const input = orderableCatalogInputSchema.parse({ tradingDayId, customerCompanyId });
        const { data, error } = await createClient().rpc(
          "get_orderable_catalog_for_customer",
          toOrderableCatalogRpcArgs(input),
        );
        if (error) throw error;
        return data;
      },
    });
  },

  // Which growers each variety of that catalog can come from today, for the
  // order editor's "מגדל מועדף" button (workbook Task 36) —
  // get_variety_growers_for_customer, migration 0095: grower names only, and
  // only for varieties two or more growers have in stock. Keyed by variety id.
  // The same day and company as the catalog, and the same two arguments: the
  // function takes them, and refuses them, exactly as the catalog does, so the
  // catalog's schema builds them.
  //
  // Nothing but that button reads this, and the editor treats a failed read
  // as "no growers": until 0095 has run on the database the app talks to,
  // the call fails and the button simply does not appear (see
  // OrderLinesEditor). Its refusal carries a PostgREST code, so it is not
  // retried either (lib/providers.tsx).
  varietyGrowers(tradingDayId: string, customerCompanyId?: string) {
    return queryOptions({
      queryKey: ["customer", "variety-growers", tradingDayId, customerCompanyId ?? "self"],
      queryFn: async (): Promise<Map<string, string[]>> => {
        const input = orderableCatalogInputSchema.parse({ tradingDayId, customerCompanyId });
        const { data, error } = await createClient().rpc(
          "get_variety_growers_for_customer",
          toOrderableCatalogRpcArgs(input),
        );
        if (error) throw error;
        return growersByVariety(data);
      },
    });
  },

  // The comment on the whole order, "הערה כללית" (migration 0093), for the
  // order editor. A customer's own session needs no filter: the daily_orders
  // rule already lets a customer read only their own company's orders, and
  // there is one per day. The backoffice path filters to the customer being
  // edited. Null when there is no order header for the day yet.
  orderComment(tradingDayId: string, customerCompanyId?: string) {
    return queryOptions({
      queryKey: ["customer", "order-comment", tradingDayId, customerCompanyId ?? "self"],
      queryFn: async (): Promise<{ id: string; comment: string | null } | null> => {
        let query = createClient().from("daily_orders").select("id, comment").eq("trading_day_id", tradingDayId);
        if (customerCompanyId) query = query.eq("customer_company_id", customerCompanyId);
        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        return data;
      },
    });
  },

  // Every trading day, newest first, with this company's order (if any)
  // embedded — see routes/customer/history.tsx for why it starts from
  // trading_days rather than daily_orders.
  orderHistory() {
    return infiniteQueryOptions({
      queryKey: ["customer", "order-history"],
      initialPageParam: 0,
      queryFn: async ({ pageParam }): Promise<CustomerHistoryDay[]> => {
        const { data, error } = await createClient()
          .from("trading_days")
          .select("id, trade_date, phase, daily_orders(id, status, submitted_at)")
          .order("trade_date", { ascending: false })
          // Unique tie-breaker so same-date rows keep one position across pages.
          .order("id")
          .range(pageParam, pageParam + HISTORY_PAGE_SIZE - 1);
        if (error) throw error;
        return data;
      },
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length < HISTORY_PAGE_SIZE ? undefined : allPages.length * HISTORY_PAGE_SIZE,
    });
  },

  // One specific order (a history row's link), with its trading day.
  orderById(orderId: string) {
    return queryOptions({
      queryKey: ["customer", "order-by-id", orderId],
      queryFn: async (): Promise<SpecificOrder | null> => {
        const { data, error } = await createClient()
          .from("daily_orders")
          .select("id, status, submitted_at, trading_day_id, trading_days(trade_date, phase)")
          .eq("id", orderId)
          .maybeSingle();
        if (error) throw error;
        return data;
      },
    });
  },

  // A trading day's own date/phase, for a history row with no order behind it.
  tradingDayById(tradingDayId: string) {
    return queryOptions({
      queryKey: ["customer", "trading-day-by-id", tradingDayId],
      queryFn: async (): Promise<EmptyTradingDay | null> => {
        const { data, error } = await createClient()
          .from("trading_days")
          .select("trade_date, phase")
          .eq("id", tradingDayId)
          .maybeSingle();
        if (error) throw error;
        return data;
      },
    });
  },

  // A closed order's lines, read-only.
  orderLines(orderId: string) {
    return queryOptions({
      queryKey: ["customer", "order-lines-readonly", orderId],
      queryFn: async (): Promise<HistoricalLineRow[]> => {
        const { data, error } = await createClient().rpc("get_customer_order_lines", {
          p_daily_order_id: orderId,
        });
        if (error) throw error;
        return data;
      },
    });
  },
};
