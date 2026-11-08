import { INVALID_PHONE_MESSAGE, normalizePhoneNumber } from "@ori/shared/phone";

// What to write to profiles.phone_number for what someone typed — the same
// rule the database applies to every save (migration 0077), checked here
// first so the person gets the Hebrew message at once, before anything is
// sent:
//   - blank → no number;
//   - an Israeli number, however it was typed → its stored form, 0501234567;
//   - a foreign number written with + (or 00) and its country code → stored
//     as +12125551234;
//   - exactly the number already stored → left as it is, even if it was saved
//     before the rule existed and does not pass it, so an unrelated edit (a
//     name, a role) is never refused because of it — the database does the
//     same;
//   - anything else → refused, with INVALID_PHONE_MESSAGE.
export function phoneToSave(typed: string, stored: string | null): string | null {
  const value = typed.trim();
  if (!value) return null;
  const tidy = normalizePhoneNumber(value);
  if (tidy) return tidy;
  if (stored !== null && value === stored.trim()) return stored;
  throw new Error(INVALID_PHONE_MESSAGE);
}

// For an optimistic screen update: the tidy form when there is one, otherwise
// what was typed (a refused save rolls it back anyway).
export function phoneForDisplay(typed: string): string | null {
  return normalizePhoneNumber(typed) ?? (typed.trim() || null);
}
