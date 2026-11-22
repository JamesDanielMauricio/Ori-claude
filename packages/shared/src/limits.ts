// The largest quantities and the longest comments Ori stores: the same
// numbers the database holds itself to (migration 0109), checked here first so
// a person is told in Hebrew, by the screen, before anything is sent.
//
// Why both: found in testing (2026-11-20/21), a grower calling the database
// directly — not through any screen — could save a pick of 4.5 pallets, of
// 99,999,999 pallets, or with a 10,000-character comment. The database now
// refuses those however it is reached; the screens refuse them first, with a
// clear message, instead of sending them to be refused.
//
// The limits sit far above anything real. On live, 2026-11-21: the largest
// pick 128 pallets, the largest carried-over leftover 42, the largest order
// line 1,111, the longest comment 72 characters.
//
// The SQL in migration 0109 holds the same numbers; packages/db's
// limits-match.test.ts fails if the two ever drift apart.

/** A day's pick on one line: whole pallets, never more than this. */
export const MAX_PICKED_PALLETS = 9999;

/**
 * Leftover pallets on one line, when someone changes it. Higher than a day's
 * pick on purpose: unsold stock is carried from day to day (each new day's
 * leftover is the last day's picked + leftover − arranged), so it can add up.
 * The database holds a CHANGED leftover to this, never a carried-over one, so
 * opening a day is never refused over it (migration 0109).
 */
export const MAX_LEFTOVER_PALLETS = 99999;

/** One order line. */
export const MAX_ORDERED_PALLETS = 9999;

/** A pick line's comment, an order line's comment, and the whole order's comment. */
export const MAX_COMMENT_LENGTH = 500;

// "9,999", as the messages below write a number — built from the limits
// themselves, so a message can never name a different number than is enforced.
const count = (value: number) => value.toLocaleString("en-US");

/** What a person is told when a picked number is not a whole number from 0 to the limit. */
export const PICKED_PALLETS_MESSAGE = `כמות המשטחים שנקטפו חייבת להיות מספר שלם בין 0 ל-${count(MAX_PICKED_PALLETS)}.`;

/** What a person is told when a leftover is below 0 or above the limit. */
export const LEFTOVER_PALLETS_MESSAGE = `כמות העודף חייבת להיות בין 0 ל-${count(MAX_LEFTOVER_PALLETS)} משטחים.`;

/** What a person is told when an order line asks for more than the limit. */
export const ORDERED_PALLETS_MESSAGE = `אפשר להזמין עד ${count(MAX_ORDERED_PALLETS)} משטחים בשורה אחת.`;

/** What a person is told when a comment is longer than the limit. */
export const COMMENT_LENGTH_MESSAGE = `הערה יכולה להכיל עד ${count(MAX_COMMENT_LENGTH)} תווים.`;

/** The messages above, which the screens show as they are (apps/web lib/error-message.ts). */
export const LIMIT_MESSAGES: readonly string[] = [
  PICKED_PALLETS_MESSAGE,
  LEFTOVER_PALLETS_MESSAGE,
  ORDERED_PALLETS_MESSAGE,
  COMMENT_LENGTH_MESSAGE,
];
