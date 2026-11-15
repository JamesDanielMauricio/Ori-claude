import { db } from "@ori/db";
import { sql } from "drizzle-orm";

import { normalizeEmail } from "./email";
import { EmailInUseError, UserNotFoundError } from "./errors";
import { createServiceRoleClient } from "./supabase-clients";

export interface UpdateUserEmailInput {
  targetUserId: string;
  email: string;
}

// The Users screen's "change login email". The address lives in
// `auth.users`, which the browser's client can't reach, so this goes through
// the Supabase Admin API with the service-role key.
//
// `email_confirm: true` marks the new address as already confirmed, so
// Supabase applies the change at once and sends no confirmation email. That
// adds no new power: the office can already change a user's phone and send
// them a password-reset link, and the person is signed in with the same
// password either way.
//
// SECURITY: the service-role key bypasses every access rule, so the only
// caller (apps/api's auth.updateUserEmail) restricts this to backoffice
// users before it gets here.
// Does a DIFFERENT account already hold this (normalised) address?
async function heldByAnotherAccount(email: string, targetUserId: string): Promise<boolean> {
  const rows = await db.execute(
    sql`select 1 from auth.users where lower(email) = ${email} and id <> ${targetUserId} limit 1`,
  );
  return rows.length > 0;
}

export async function updateUserEmail({
  targetUserId,
  email,
}: UpdateUserEmailInput): Promise<{ email: string }> {
  const normalized = normalizeEmail(email);
  const supabase = createServiceRoleClient();

  // Checked first because Supabase's admin update never reports a taken
  // address properly: it hits the unique index and answers only a generic
  // HTTP 500 ("Error updating user"). Looking the address up ourselves is the
  // only way to tell the office "already in use" instead of "failed".
  if (await heldByAnotherAccount(normalized, targetUserId)) {
    throw new EmailInUseError();
  }

  const { error } = await supabase.auth.admin.updateUserById(targetUserId, {
    email: normalized,
    email_confirm: true,
  });
  if (error) {
    if (error.status === 404) {
      throw new UserNotFoundError();
    }
    // Harmless if Supabase ever adds its own duplicate check (code "email_exists").
    if ("code" in error && error.code === "email_exists") {
      throw new EmailInUseError();
    }
    // The address may have been taken between our check and the write; that
    // too comes back as the generic 500, so look once more.
    if (await heldByAnotherAccount(normalized, targetUserId)) {
      throw new EmailInUseError();
    }
    throw new Error(`Failed to update email: ${error.message}`);
  }
  return { email: normalized };
}
