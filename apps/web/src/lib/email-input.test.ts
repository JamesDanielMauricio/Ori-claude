import { describe, expect, it } from "vitest";

import { changedEmail, isEmailShaped, normalizeEmailInput } from "./email-input";

describe("email input", () => {
  it("changedEmail ignores case and spaces", () => {
    expect(changedEmail("a@b.co", " A@B.CO ")).toBeNull();
  });

  it("returns the new address normalised", () => {
    expect(changedEmail("a@b.co", " New@B.CO ")).toBe("new@b.co");
    expect(changedEmail(undefined, "X@y.io")).toBe("x@y.io");
  });

  it("normalizeEmailInput trims and lower-cases", () => {
    expect(normalizeEmailInput("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });

  it("isEmailShaped refuses a@b, a b@c.co and empty", () => {
    expect(isEmailShaped("a@b")).toBe(false);
    expect(isEmailShaped("a b@c.co")).toBe(false);
    expect(isEmailShaped("")).toBe(false);
    expect(isEmailShaped(" a@b.co ")).toBe(true);
  });
});
