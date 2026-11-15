import { describe, expect, it } from "vitest";

import { changedEmail, isEmailShaped, normalizeEmailInput, planEmailChange } from "./email-input";

describe("planEmailChange", () => {
  it("unknown saved address: no email change and no validation", () => {
    expect(planEmailChange(undefined, null)).toEqual({ kind: "none" });
    expect(planEmailChange(undefined, "garbage")).toEqual({ kind: "none" });
  });
  it("an untouched box or the same address changes nothing", () => {
    expect(planEmailChange("a@b.co", null)).toEqual({ kind: "none" });
    expect(planEmailChange("a@b.co", " A@B.CO ")).toEqual({ kind: "none" });
  });
  it("a real change is returned normalised; a malformed one is invalid", () => {
    expect(planEmailChange("a@b.co", " New@B.CO ")).toEqual({ kind: "change", email: "new@b.co" });
    expect(planEmailChange("a@b.co", "a@b")).toEqual({ kind: "invalid" });
    expect(planEmailChange("a@b.co", "")).toEqual({ kind: "invalid" });
  });
});

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
