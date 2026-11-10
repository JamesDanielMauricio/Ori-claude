import type { FlatRecord } from "./board-data";

// The records table's three views (רשומות סידור). Each sorts the same rows by
// two keys, in Hebrew order; none groups or hides anything. "by-customer" is
// Bubble's by-customer list (product, arranged pallets, grower, price per
// customer) — the table's existing columns already carry all four.
export type RecordsViewMode = "by-product" | "by-grower" | "by-customer";

const SORT_KEYS: Record<RecordsViewMode, (record: FlatRecord) => readonly [string, string]> = {
  "by-product": (record) => [record.varietyLabel, record.growerName],
  "by-grower": (record) => [record.growerName, record.varietyLabel],
  "by-customer": (record) => [record.customerName, record.varietyLabel],
};

// A sorted copy; the list passed in is left as it was.
export function sortRecords(records: readonly FlatRecord[], mode: RecordsViewMode): FlatRecord[] {
  const keyOf = SORT_KEYS[mode];
  return [...records].sort((a, b) => {
    const [aFirst, aSecond] = keyOf(a);
    const [bFirst, bSecond] = keyOf(b);
    return aFirst.localeCompare(bFirst, "he") || aSecond.localeCompare(bSecond, "he");
  });
}
