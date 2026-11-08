// Phone numbers, in the one form Ori stores them (James, 2026-11-09: Israeli
// numbers, and foreign ones too):
//   - an Israeli number as local digits with its leading zero — 0501234567
//     (mobile, 10 digits) or 031234567 (landline, 9 digits) — however it was
//     typed: spaces, dashes, brackets, dots, +972 / 00972 / 972, or without
//     its zero;
//   - a foreign number as + and its country code — +12125551234 — which it
//     must be written with (+ or 00 in front). A number written without one
//     is read as Israeli: there is no telling which country a bare foreign
//     number belongs to, so it is never guessed at.
// Anything else — too short, too long, letters, a + in the middle — is not a
// phone number Ori can message.
//
// The same rule exists three times, because three runtimes need it and none
// can import the others:
//   - here (Node + browser: the profile and users screens, the importer, the
//     admin password-reset sender);
//   - SQL public.normalize_phone_number (migration 0077), which every save of
//     profiles.phone_number goes through, and which the queued WhatsApp
//     dispatch uses to address a person;
//   - supabase/functions/whatsapp-dispatch/phone.ts (Deno; the Edge bundle
//     cannot reach this package).
// phone-cases.json beside this file holds the examples all three are tested
// against, so a change to one that the others don't share fails a test.

// Characters a person may type or paste around the digits. The bidi marks are
// what Hebrew interfaces wrap around a copied number (U+200E/U+200F,
// U+202A-U+202E, U+2066-U+2069); without them a number pasted from WhatsApp
// itself would be refused. Letters are deliberately NOT here: "050-1234567
// בבית" is refused rather than guessed at.
const ALLOWED = /^[0-9 \u00a0\-\u2010-\u2015+()./\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/;

// 0 + area code 2/3/4/8/9 + 7 digits (landlines), or 0 + 5x/7x + 7 digits
// (mobiles and the 07x numbers).
const ISRAELI_LOCAL = /^0(?:[23489][0-9]{7}|[57][0-9]{8})$/;

// A foreign number with its country code, as the international standard
// (E.164) allows: 7 to 15 digits, never starting with 0.
const FOREIGN = /^[1-9][0-9]{6,14}$/;

export function normalizePhoneNumber(input: string | null | undefined): string | null {
  if (!input || !ALLOWED.test(input)) return null;
  // Digits and "+" only. A "+" anywhere but in front is not a phone number.
  const compact = input.replace(/[^0-9+]/g, "");
  if (compact.slice(1).includes("+")) return null;
  // Written internationally: + or 00 in front. Then "(0)" is the trunk zero
  // one drops when dialling from abroad ("+44 (0)20 …"), so it goes.
  const international = compact.startsWith("+") || compact.startsWith("00");
  const digits = (international ? input.split("(0)").join("") : input).replace(/[^0-9]/g, "");
  if (!digits) return null;

  // The number with its country code, when it was written with one. A bare
  // "972…" counts only when a whole Israeli number follows it: "97212345" is
  // the landline 09-7212345 typed without its zero, not a country code.
  let full: string | null = null;
  if (compact.startsWith("+")) full = digits;
  else if (digits.startsWith("00")) full = digits.slice(2);
  else if (digits.startsWith("972") && digits.length >= 11) full = digits;

  if (full !== null && !full.startsWith("972")) return FOREIGN.test(full) ? `+${full}` : null;

  // Israeli: after +972 / 00972 / 972, or written locally. "+972 (0)50…" and
  // "050…" keep their zero; "+972 50…" and "50…" get one.
  let local = full !== null ? full.slice(3) : digits;
  if (!local.startsWith("0")) local = `0${local}`;
  return ISRAELI_LOCAL.test(local) ? local : null;
}

// The WhatsApp address of a person (Green API then appends "@c.us"): the
// country code and number with nothing else — 972 + an Israeli number without
// its zero, or a foreign number without its "+". Null when the input is not a
// phone number Ori can message — there is nobody to send to.
export function toWhatsAppPersonalNumber(input: string | null | undefined): string | null {
  const stored = normalizePhoneNumber(input);
  if (!stored) return null;
  return stored.startsWith("+") ? stored.slice(1) : `972${stored.slice(1)}`;
}

// What the profile and users screens show when a number is refused.
export const INVALID_PHONE_MESSAGE =
  "מספר הטלפון אינו תקין. יש להזין מספר ישראלי (למשל 050-1234567) או מספר מחו״ל עם + וקידומת המדינה.";
