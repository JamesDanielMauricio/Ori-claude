import { formatPallets } from "@/components/arrangement/board-data";
import type { FamilyGroupedRow } from "@/components/reference-data/family-grouped-lines";
import { formatVarietyName } from "@/lib/variety-label";

// The shape both oversight reads embed under a pick or order line
// (oversightQueries.picksForDay / ordersForDay).
export interface FamilyGroupableLine {
  id: string;
  comment: string | null;
  product_varieties: {
    name: string;
    sizes: string | null;
    family_id: string;
    product_families: { name: string; image_url: string | null } | null;
  } | null;
}

// One pick's or one order's lines, grouped by family — the read view an
// expanded row shows on "בשם מגדל" and "בשם לקוח" (FamilyGroupedLines). One
// function for both screens so their ordering and labels cannot drift apart;
// only the quantity differs, so each screen passes its own.
//
// Same shape the arrangement board's grower column derives (board-data.ts's
// GrowerFamilyGroup), rebuilt small here rather than imported: that one is
// entangled with allocation totals and a selection these screens have no use
// for, and pulling it in would mean carrying arrangement_records into a
// query that has nothing to do with them.
export function groupLinesByFamily<T extends FamilyGroupableLine>(
  lines: readonly T[],
  quantityOf: (line: T) => number,
): FamilyGroupedRow[] {
  const families = new Map<string, FamilyGroupedRow>();
  for (const line of lines) {
    const variety = line.product_varieties;
    if (!variety) continue;
    let group = families.get(variety.family_id);
    if (!group) {
      group = {
        familyId: variety.family_id,
        familyName: variety.product_families?.name ?? "",
        imageUrl: variety.product_families?.image_url ?? null,
        lines: [],
      };
      families.set(variety.family_id, group);
    }
    const pallets = quantityOf(line);
    group.lines.push({
      id: line.id,
      varietyName: formatVarietyName(variety.name, variety.sizes),
      quantityLabel: formatPallets(pallets),
      hasQuantity: pallets > 0,
      comment: line.comment,
    });
  }
  const groups = [...families.values()];
  for (const group of groups) {
    group.lines.sort((a, b) => a.varietyName.localeCompare(b.varietyName, "he"));
  }
  return groups.sort((a, b) => a.familyName.localeCompare(b.familyName, "he"));
}
