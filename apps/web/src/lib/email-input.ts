// Helpers for the email box on the Users screen. Login addresses are matched
// without regard to case or surrounding spaces, so every comparison and every
// value sent to the server goes through the same normalising step.

export function normalizeEmailInput(value: string): string {
  return value.trim().toLowerCase();
}

// Deliberately loose: something, an @, something, a dot, something. The
// server (zod + Supabase) has the final say; this only catches obvious typos
// before anything is saved.
export function isEmailShaped(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmailInput(value));
}

// The address to send, or null when typing changed nothing that matters
// (same address in different case or with stray spaces).
export function changedEmail(saved: string | undefined, typed: string): string | null {
  const next = normalizeEmailInput(typed);
  return next === normalizeEmailInput(saved ?? "") ? null : next;
}
