// When a grower's pallets are collected on a trading day — one rule, used by
// the arrangement board (which orders growers by it) and by the grower's own
// picking screen (Bubble shows it in the pick's header), so the two can
// never disagree.
//
// A pick takes a snapshot of the grower's default pickup time when it is
// sent (submit_pick), and drops it again if it goes back to draft. Until it
// has one, the company's current default stands in.
export function effectivePickupTime(pickTime: string | null, companyDefault: string | null): string | null {
  return pickTime ?? companyDefault ?? null;
}

// Postgres sends a `time` as "HH:MM:SS"; the screens show "HH:MM".
export function formatPickupTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}
