// A product's price type (migration 0100): Bubble's "Price Types" option set,
// a closed list rather than free text. Each type says which price, if any,
// is shown:
//   - מספר (fixed): the product's price;
//   - טווח (range): its price range, from–to;
//   - every תקליט type: no number at all — the type's own name is the price
//     ("תקליט + ₪1": the market's recorded price plus one shekel).
// Bubble shows them the same way (its products table: "range" shows from -
// to, "fixed_price" the price, any other type its Display).
//
// The list exists twice, because two runtimes need it:
//   - here, for the screens, the zod schemas every save goes through
//     (packages/domain) and the Bubble importer;
//   - SQL: the public.price_type enum and public.price_type_label (migration
//     0100), which the closing WhatsApp message uses.

/** The price types, in Bubble's order. Stored as these codes. */
export const PRICE_TYPES = [
  "record",
  "record_minus_0_5",
  "record_minus_1",
  "record_minus_1_5",
  "record_minus_2",
  "record_plus_0_5",
  "record_plus_1",
  "record_plus_1_5",
  "record_plus_2",
  "fixed",
  "range",
] as const;

export type PriceType = (typeof PRICE_TYPES)[number];

/** Each type's name as people read it — Bubble's own captions. */
export const PRICE_TYPE_LABELS: Record<PriceType, string> = {
  record: "תקליט",
  record_minus_0_5: "תקליט - ₪0.5",
  record_minus_1: "תקליט - ₪1",
  record_minus_1_5: "תקליט - ₪1.5",
  record_minus_2: "תקליט - ₪2",
  record_plus_0_5: "תקליט + ₪0.5",
  record_plus_1: "תקליט + ₪1",
  record_plus_1_5: "תקליט + ₪1.5",
  record_plus_2: "תקליט + ₪2",
  fixed: "מספר",
  range: "טווח",
};

export function isPriceType(value: unknown): value is PriceType {
  return typeof value === "string" && (PRICE_TYPES as readonly string[]).includes(value);
}

// A caption compared without its spacing, its shekel sign and its kind of
// minus, so "תקליט -₪1", "תקליט − 1 ש״ח" and "תקליט - ₪1" are one type.
function captionKey(text: string): string {
  return text
    .replace(/ש["״]?ח/g, "")
    .replace(/[₪\s]/g, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/(\d+(?:\.\d+)?)/g, (number) => String(Number(number)));
}

const TYPE_BY_CAPTION = new Map<string, PriceType>(
  PRICE_TYPES.map((type) => [captionKey(PRICE_TYPE_LABELS[type]), type]),
);

/**
 * A price type from its code or from its Bubble caption ("תקליט + ₪1",
 * "מספר"), as the Bubble import and data stored before migration 0100 hold
 * it. Anything else, and an empty value, is no type: null.
 */
export function parsePriceType(value: string | null | undefined): PriceType | null {
  const text = value?.trim();
  if (!text) return null;
  if (isPriceType(text)) return text;
  return TYPE_BY_CAPTION.get(captionKey(text)) ?? null;
}

export interface Prices {
  price: number | null;
  priceRangeFrom: number | null;
  priceRangeTo: number | null;
}

/**
 * The type a stored product or record has: its own (parsePriceType), or —
 * when it has none — what its numbers say, the way migration 0100 converted
 * the stored text: a price makes it מספר, both ends of a range טווח.
 */
export function priceTypeOf(value: string | null | undefined, prices: Prices): PriceType | null {
  const type = parsePriceType(value);
  if (type) return type;
  if (prices.price != null) return "fixed";
  if (prices.priceRangeFrom != null && prices.priceRangeTo != null) return "range";
  return null;
}

/**
 * The numbers a type keeps: מספר its price, טווח the two ends of its range,
 * a תקליט type — and no type — none. What a save sends, so a number hidden
 * by the type chosen is never stored behind it.
 */
export function pricesForType(priceType: PriceType | null, prices: Prices): Prices {
  return {
    price: priceType === "fixed" ? prices.price : null,
    priceRangeFrom: priceType === "range" ? prices.priceRangeFrom : null,
    priceRangeTo: priceType === "range" ? prices.priceRangeTo : null,
  };
}

export interface PricedItem extends Prices {
  // A code, or a caption stored before migration 0100 (parsePriceType).
  priceType: string | null;
}

/**
 * The price as it is shown: מספר → "₪12.5", טווח → "₪10–₪12", a תקליט type
 * → its name. With no type, as priceTypeOf reads it: a price, else a range
 * (prices entered before there were types). Null when there is nothing to
 * show — a מספר with no price, a טווח missing an end.
 */
export function formatPriceByType(item: PricedItem): string | null {
  const type = priceTypeOf(item.priceType, item);
  if (type === "fixed") return item.price != null ? `₪${item.price}` : null;
  if (type === "range") {
    return item.priceRangeFrom != null && item.priceRangeTo != null
      ? `₪${item.priceRangeFrom}–₪${item.priceRangeTo}`
      : null;
  }
  return type === null ? null : PRICE_TYPE_LABELS[type];
}

/** What a person is told when a מספר product is saved with no price. */
export const PRICE_MISSING_MESSAGE = 'לסוג המחיר "מספר" יש להזין מחיר.';

/** What a person is told when a טווח product is saved without both ends. */
export const PRICE_RANGE_MISSING_MESSAGE = 'לסוג המחיר "טווח" יש להזין מחיר מ- ועד.';

/** What a person is told when a range starts above where it ends. */
export const PRICE_RANGE_ORDER_MESSAGE = 'בטווח המחירים, "מ-" לא יכול להיות גבוה מ"עד".';

/** What a person is told when a price below zero is saved. */
export const PRICE_NEGATIVE_MESSAGE = "מחיר לא יכול להיות שלילי.";

/** The messages above, for the screens' error toasts (apps/web lib/error-message.ts). */
export const PRICE_TYPE_MESSAGES: readonly string[] = [
  PRICE_MISSING_MESSAGE,
  PRICE_RANGE_MISSING_MESSAGE,
  PRICE_RANGE_ORDER_MESSAGE,
  PRICE_NEGATIVE_MESSAGE,
];

/**
 * Why a product's price cannot be saved with this type, or null when it can:
 * מספר needs a price, טווח both ends with "from" no higher than "to", and
 * neither may be below zero. The תקליט types, and no type, need no number.
 * Only the numbers the type uses are checked — the others are never saved
 * (pricesForType).
 */
export function priceTypeProblem(priceType: PriceType | null, prices: Prices): string | null {
  if (priceType === "fixed") {
    if (prices.price == null) return PRICE_MISSING_MESSAGE;
    if (prices.price < 0) return PRICE_NEGATIVE_MESSAGE;
  }
  if (priceType === "range") {
    if (prices.priceRangeFrom == null || prices.priceRangeTo == null) return PRICE_RANGE_MISSING_MESSAGE;
    if (prices.priceRangeFrom < 0 || prices.priceRangeTo < 0) return PRICE_NEGATIVE_MESSAGE;
    if (prices.priceRangeFrom > prices.priceRangeTo) return PRICE_RANGE_ORDER_MESSAGE;
  }
  return null;
}
