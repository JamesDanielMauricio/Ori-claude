import { roundPallets } from "@ori/shared/pallets";
import { queryOptions } from "@tanstack/react-query";

import { parsePallets } from "@/components/arrangement/board-data";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { createClient } from "@/lib/supabase/client";

// The server read behind "מוצרים שנקטפו" (the Products screen narrowed to a
// day's real supply), defined once — key + fetch together; see
// lib/queries/trading-day.ts for why the keys matter.

// What the screen gets: which varieties had supply on the day, and how much —
// the "משטחים במלאי" column (Bubble's ריכוז מוצרים): picked + leftover
// pallets, summed over every grower.
export interface PickedStock {
  varietyIds: ReadonlySet<string>;
  stockByVariety: ReadonlyMap<string, number>;
}

// A stable empty value for "the day has nothing / we don't know yet", so the
// filtered table's own useMemo isn't handed a new Set on every render.
// Exported so the screen's "still loading" fallback is this same object.
export const NO_PICKED_STOCK: PickedStock = {
  varietyIds: new Set<string>(),
  stockByVariety: new Map<string, number>(),
};

// The queryFn returns plain arrays and the Set and Map are built here, in
// `select`: React Query only structurally shares plain arrays and objects, so
// a Set straight from the queryFn would be a new object on every live-update
// refetch and re-filter the whole table even when nothing changed. A select
// declared once is re-run only when the shared array itself changes.
function toPickedStock(entries: ReadonlyArray<readonly [string, number]>): PickedStock {
  if (entries.length === 0) return NO_PICKED_STOCK;
  return {
    varietyIds: new Set(entries.map(([id]) => id)),
    stockByVariety: new Map(entries),
  };
}

// One grower's pick line for the day. Read through parsePallets below rather
// than a bare `> 0`, the same reading every pallet total in the app uses.
interface PickLine {
  product_variety_id: string;
  pallets_picked: number | string | null;
  leftover_pallets: number | string | null;
}

// Each variety's picked + leftover pallets over all of the day's pick lines,
// rounded the way the database stores pallets (two decimals), so 0.1 + 0.2
// reads as 0.3. A variety whose total is 0 is left out: it has no supply, the
// same rule the list itself has always used ("picked > 0 or leftover > 0" —
// pallets are never negative, so the two agree).
export function sumStockByVariety(lines: ReadonlyArray<PickLine>): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const total = (totals.get(line.product_variety_id) ?? 0) + parsePallets(line.pallets_picked) + parsePallets(line.leftover_pallets);
    totals.set(line.product_variety_id, total);
  }
  const stock = new Map<string, number>();
  for (const [id, total] of totals) {
    const rounded = roundPallets(total);
    if (rounded > 0) stock.set(id, rounded);
  }
  return stock;
}

export const pickedProductsQueries = {
  // Which varieties had supply on a day: a pick line with `pallets_picked >
  // 0` OR `leftover_pallets > 0` (see routes/backoffice/picked-products.tsx
  // for why merely having a pick line doesn't count).
  //
  // Two round trips rather than one nested read: the pick lines for a busy
  // day can outrun PostgREST's 1000-row cap (~78 families × several
  // growers), and that cap TRUNCATES rather than erroring — a short read here
  // would quietly drop products off the list. fetchAllRows pages until a
  // short page arrives.
  varietiesForDay(dayId: string | null) {
    return queryOptions({
      queryKey: ["picked-products", "varieties", dayId],
      enabled: !!dayId,
      queryFn: async (): Promise<Array<[string, number]>> => {
        const supabase = createClient();
        const picks = await supabase.from("daily_picks").select("id").eq("trading_day_id", dayId!);
        if (picks.error) throw picks.error;

        const pickIds = picks.data.map((pick) => pick.id);
        if (pickIds.length === 0) return [];

        const lines = await fetchAllRows<PickLine>((from, to) =>
          supabase
            .from("daily_pick_products")
            .select("product_variety_id, pallets_picked, leftover_pallets")
            // Ordered so paging is stable: without an ORDER BY, Postgres is free
            // to return the same row on two pages and skip another entirely.
            .order("id")
            .in("daily_pick_id", pickIds)
            .range(from, to),
        );

        return [...sumStockByVariety(lines)];
      },
      select: toPickedStock,
    });
  },
};
