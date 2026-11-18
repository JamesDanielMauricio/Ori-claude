import { z } from "zod";

// The one rule for "is this a usable login email". The Users screen checks it
// before saving and the API checks it again before touching the account, and
// both import it from here so they can never disagree: an address the box
// accepts is an address the server accepts.
export const emailSchema = /* @__PURE__ */ z.string().trim().email();

export function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}
