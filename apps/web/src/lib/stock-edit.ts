// The quick stock edit's one rule, kept out of the dialog so it can be tested
// without rendering anything: the two boxes may not add up to less than what
// is already arranged off the line. The database enforces the same floor
// (save_pick_lines refuses with P0006); checking it here only keeps אישור off
// for a number that is certain to be refused, using the arranged total as it
// was when the dialog read it.

export type StockEditCheck =
  | { ok: true; picked: number; leftover: number }
  | { ok: false; reason: "empty" | "below_arranged" };

export function stockEditCheck(input: {
  picked: string;
  leftover: string;
  arranged: number;
}): StockEditCheck {
  // The boxes hold whole numbers only (stripDecimal leaves digits), so an
  // empty string is the one way a box can be "missing" — it is not a zero.
  if (input.picked === "" || input.leftover === "") return { ok: false, reason: "empty" };
  const picked = Number(input.picked);
  const leftover = Number(input.leftover);
  if (picked + leftover < input.arranged) return { ok: false, reason: "below_arranged" };
  return { ok: true, picked, leftover };
}
