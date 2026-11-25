// The phone rule (Israeli numbers stored as 0501234567, foreign ones as
// +<country code><number>) — a copy of packages/shared/src/phone.ts, because
// the Edge bundle cannot import that package; the reasons for each step are
// written there. SQL has the same rule (public.normalize_phone_number,
// migration 0077). index.test.ts runs this copy against
// packages/shared/src/phone-cases.json, the examples the other two are tested
// against, so the three cannot drift apart unnoticed. Change one, change all
// three.

const ALLOWED = /^[0-9 \u00a0\-\u2010-\u2015+()./\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/;
const ISRAELI_LOCAL = /^0(?:[23489][0-9]{7}|[57][0-9]{8})$/;
const FOREIGN = /^[1-9][0-9]{6,14}$/;
// Typed without + or 00 (2026-11-25): a whole international number only.
const FOREIGN_WITHOUT_PLUS = /^[1-9][0-9]{9,14}$/;

export function normalizePhoneNumber(input: string | null | undefined): string | null {
  if (!input || !ALLOWED.test(input)) return null;
  const compact = input.replace(/[^0-9+]/g, "");
  if (compact.slice(1).includes("+")) return null;
  const international = compact.startsWith("+") || compact.startsWith("00");
  const digits = (international ? input.split("(0)").join("") : input).replace(/[^0-9]/g, "");
  if (!digits) return null;
  let full: string | null = null;
  if (compact.startsWith("+")) full = digits;
  else if (digits.startsWith("00")) full = digits.slice(2);
  else if (digits.startsWith("972") && digits.length >= 11) full = digits;
  if (full !== null && !full.startsWith("972")) return FOREIGN.test(full) ? `+${full}` : null;
  let local = full !== null ? full.slice(3) : digits;
  if (!local.startsWith("0")) local = `0${local}`;
  if (ISRAELI_LOCAL.test(local)) return local;
  if (full === null) {
    const bare = input
      .split("(0)")
      .join("")
      .replace(/[^0-9]/g, "");
    if (!bare.startsWith("972") && FOREIGN_WITHOUT_PLUS.test(bare)) return `+${bare}`;
  }
  return null;
}

export function toWhatsAppPersonalNumber(input: string | null | undefined): string | null {
  const stored = normalizePhoneNumber(input);
  if (!stored) return null;
  return stored.startsWith("+") ? stored.slice(1) : `972${stored.slice(1)}`;
}
