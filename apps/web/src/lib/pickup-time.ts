// When a grower's pallets are collected on a trading day — one rule, used by
// the arrangement board (which orders growers by it) and by the grower's own
// picking screen (Bubble shows it in the pick's header), so the two can
// never disagree.
//
// A pick holds a time of its own once the grower has chosen one (the pickup
// time dialog on their picking screen), and sending keeps a time already
// chosen. A pick sent without one takes a snapshot of the grower's default
// (submit_pick), and drops that snapshot again if it goes back to draft.
// Until it has a time, the company's current default stands in.
export function effectivePickupTime(pickTime: string | null, companyDefault: string | null): string | null {
  return pickTime ?? companyDefault ?? null;
}

// Postgres sends a `time` as "HH:MM:SS"; the screens show "HH:MM".
export function formatPickupTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

// What an <input type="time"> is given: "HH:MM", or an empty box for no time.
export function toTimeInputValue(time: string | null): string {
  return formatPickupTime(time) ?? "";
}
