import type { User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { settleProfileRead, type AuthProfile } from "./auth-context";

// The re-read that follows every return to the tab must neither sign a user
// out because the network blinked nor re-render every useAuth() consumer when
// nothing changed.

const user = (id = "u1"): User =>
  ({ id, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "" }) as User;

const profile = (over: Partial<AuthProfile> = {}): AuthProfile => ({
  role: "grower",
  displayName: "Ori",
  companyId: "c1",
  companyName: "Ori farms",
  mustChangePassword: false,
  accountActive: true,
  ...over,
});

const loaded = (id = "u1") => ({ user: user(id), profile: profile(), loading: false });

const networkError = { code: "" };

describe("settleProfileRead", () => {
  it("keeps the loaded profile when a re-read for the same user fails", () => {
    const current = loaded();
    expect(settleProfileRead(current, user(), null, networkError)).toBe(current);
  });

  it("still clears the profile when the re-read finds no row", () => {
    const next = settleProfileRead(loaded(), user(), null, { code: "PGRST116" });
    expect(next).toEqual({ user: user(), profile: null, loading: false });
  });

  it("keeps the same object when a re-read changed nothing", () => {
    const current = loaded();
    expect(settleProfileRead(current, user(), profile(), null)).toBe(current);
  });

  it("publishes a re-read that changed the profile", () => {
    const next = settleProfileRead(loaded(), user(), profile({ displayName: "New" }), null);
    expect(next.profile?.displayName).toBe("New");
  });

  it("does not keep anything for a first read, failed or not", () => {
    const pending = { user: user(), profile: null, loading: true };
    expect(settleProfileRead(pending, user(), null, networkError)).toEqual({
      user: user(),
      profile: null,
      loading: false,
    });
  });

  it("does not keep another user's profile", () => {
    const next = settleProfileRead(loaded("u1"), user("u2"), null, networkError);
    expect(next).toEqual({ user: user("u2"), profile: null, loading: false });
  });
});
