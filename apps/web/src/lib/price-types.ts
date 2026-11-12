import { PRICE_TYPE_LABELS, PRICE_TYPES, type PriceType } from "@ori/shared/price-type";

import type { SelectOption } from "@/components/ui/select";

// The price type pickers' options (migration 0100): "—" for none, then
// Bubble's Price Types in Bubble's order, by their Hebrew names. Used by the
// Products screen, the arrangement screen's price dialog and its records
// table.
export const PRICE_TYPE_OPTIONS: readonly SelectOption<PriceType | "">[] = [
  { value: "", label: "—" },
  ...PRICE_TYPES.map((type) => ({ value: type, label: PRICE_TYPE_LABELS[type] })),
];
