import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { EmailInUseError, UserNotFoundError } from "./errors";
import { createServiceRoleClient } from "./supabase-clients";
import {
  createAnonClient,
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
} from "./test-helpers";
import { updateUserEmail } from "./update-user-email";

// The Users screen's "change login email", through the real Supabase Admin
// API. The change applies at once (no confirmation email) and the password
// keeps working with the new address.
describe("updateUserEmail", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  async function makeUser() {
    const company = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(company.id));
    const user = await createTestProfile({ companyId: company.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(user.userId));
    return user;
  }

  async function emailOf(userId: string) {
    const { data } = await createServiceRoleClient().auth.admin.getUserById(userId);
    return data.user?.email;
  }

  it("changes the login email at once, with the password unchanged", async () => {
    const user = await makeUser();
    const newEmail = `new-${randomUUID()}@example.test`;

    const result = await updateUserEmail({ targetUserId: user.userId, email: newEmail });
    expect(result).toEqual({ email: newEmail });

    const fresh = await createAnonClient().auth.signInWithPassword({
      email: newEmail,
      password: user.password,
    });
    expect(fresh.error).toBeNull();
    const old = await createAnonClient().auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    expect(old.error).not.toBeNull();
  }, 30000);

  it("stores it trimmed and lower-cased", async () => {
    const user = await makeUser();
    const id = randomUUID();

    const result = await updateUserEmail({
      targetUserId: user.userId,
      email: `  New-${id}@Example.TEST `,
    });

    expect(result).toEqual({ email: `new-${id}@example.test` });
    expect(await emailOf(user.userId)).toBe(`new-${id}@example.test`);
  }, 30000);

  it("refuses an address another account has", async () => {
    const a = await makeUser();
    const b = await makeUser();

    await expect(
      updateUserEmail({ targetUserId: a.userId, email: b.email }),
    ).rejects.toBeInstanceOf(EmailInUseError);

    expect(await emailOf(a.userId)).toBe(a.email);
    expect(await emailOf(b.userId)).toBe(b.email);
  }, 30000);

  it("an unknown user is UserNotFoundError", async () => {
    await expect(
      updateUserEmail({ targetUserId: randomUUID(), email: `x-${randomUUID()}@example.test` }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  }, 30000);
});
