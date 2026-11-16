import { isValidEmail } from "@ori/shared/email";

// Helpers for the email box on the Users screen. Login addresses are matched
// without regard to case or surrounding spaces, so every comparison and every
// value sent to the server goes through the same normalising step.

export function normalizeEmailInput(value: string): string {
  return value.trim().toLowerCase();
}

// The very rule the API applies (shared, not a second copy), so an address
// that passes here is never refused by the server with a raw validation dump.
export function isEmailShaped(value: string): boolean {
  return isValidEmail(normalizeEmailInput(value));
}

// The address to send, or null when typing changed nothing that matters
// (same address in different case or with stray spaces).
export function changedEmail(saved: string | undefined, typed: string): string | null {
  const next = normalizeEmailInput(typed);
  return next === normalizeEmailInput(saved ?? "") ? null : next;
}

export type EmailPlan = { kind: "none" } | { kind: "invalid" } | { kind: "change"; email: string };

// What a save should do about the email. `typed` is null until the user has
// typed in the box. Editing a user must never depend on the email list (a slow
// call that can fail), so with the saved address unknown, the box untouched,
// or the typed address equal to the saved one, the email is left out of the
// save entirely and is not even validated.
export function planEmailChange(saved: string | undefined, typed: string | null): EmailPlan {
  if (saved === undefined || typed === null) return { kind: "none" };
  const next = changedEmail(saved, typed);
  if (next === null) return { kind: "none" };
  return isEmailShaped(next) ? { kind: "change", email: next } : { kind: "invalid" };
}
