import { roundPallets } from "@ori/shared/pallets";

import { fetchOpenTradingDay } from "@/lib/queries/trading-day";
import { createClient } from "@/lib/supabase/client";

// Workbook Task 04: what the Growers screen warns about before a variety
// leaves a grower's in-season list — that variety's line on today's open pick
// still holds stock: pallets picked, carried in from an earlier day (עודף), or
// already arranged to customers. Saving keeps such a line (sync_grower_picks
// never deletes one), so nothing is lost; the warning is there so that a
// variety unticked by mistake is noticed before the save, not after.

export interface SeasonStockLine {
  varietyId: string;
  picked: number;
  leftover: number;
  arranged: number;
}

// One daily_pick_products row as readSeasonStock reads it, with the
// arrangement records made from it.
export interface PickLineStockRow {
  product_variety_id: string;
  pallets_picked: number | null;
  leftover_pallets: number | null;
  arrangement_records: ReadonlyArray<{ quantity_pallets: number | null }> | null;
}

export function toSeasonStockLines(rows: readonly PickLineStockRow[]): SeasonStockLine[] {
  return rows.map((row) => ({
    varietyId: row.product_variety_id,
    picked: Number(row.pallets_picked ?? 0),
    leftover: Number(row.leftover_pallets ?? 0),
    arranged: roundPallets(
      (row.arrangement_records ?? []).reduce(
        (sum, record) => sum + Number(record.quantity_pallets ?? 0),
        0,
      ),
    ),
  }));
}

// The lines for varieties leaving the season that hold any stock.
export function linesHoldingStock(
  removedVarietyIds: ReadonlySet<string>,
  lines: readonly SeasonStockLine[],
): SeasonStockLine[] {
  return lines.filter(
    (line) =>
      removedVarietyIds.has(line.varietyId) &&
      (line.picked > 0 || line.leftover > 0 || line.arranged > 0),
  );
}

// The grower's lines on the open trading day's pick, each with what has been
// arranged from it. No open day, or no pick for this grower: no lines. Read at
// the moment it is needed — just before a save that takes varieties out of
// season — and never kept, because stock changes all day.
export async function readSeasonStock(growerId: string): Promise<SeasonStockLine[]> {
  const day = await fetchOpenTradingDay();
  if (!day) return [];
  const { data, error } = await createClient()
    .from("daily_picks")
    .select(
      "daily_pick_products(product_variety_id, pallets_picked, leftover_pallets, arrangement_records(quantity_pallets))",
    )
    .eq("trading_day_id", day.id)
    .eq("grower_company_id", growerId)
    .maybeSingle();
  if (error) throw error;
  return toSeasonStockLines(data?.daily_pick_products ?? []);
}
