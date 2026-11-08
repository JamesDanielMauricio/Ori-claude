import { INVALID_PHONE_MESSAGE } from "@ori/shared/phone";
import { describe, expect, it } from "vitest";

import { phoneForDisplay, phoneToSave } from "./phone-to-save";

describe("phoneToSave", () => {
  it("stores an Israeli number in one form, however it was typed", () => {
    expect(phoneToSave("050-123 4567", null)).toBe("0501234567");
    expect(phoneToSave("+972 50-123-4567", "0521111111")).toBe("0501234567");
    expect(phoneToSave(" 04-6123456 ", null)).toBe("046123456");
  });

  it("stores a foreign number with its country code", () => {
    expect(phoneToSave("+970 59 123 4567", null)).toBe("+970591234567");
    expect(phoneToSave("001 212 555 1234", null)).toBe("+12125551234");
  });

  it("clears the number when the field is blank", () => {
    expect(phoneToSave("", "0501234567")).toBeNull();
    expect(phoneToSave("   ", null)).toBeNull();
  });

  it("refuses what is not a phone number, with the Hebrew message", () => {
    expect(() => phoneToSave("12", "0501234567")).toThrow(INVALID_PHONE_MESSAGE);
    expect(() => phoneToSave("050-1234567 בבית", null)).toThrow(INVALID_PHONE_MESSAGE);
    // A foreign number needs its + — without it, it is read as Israeli.
    expect(() => phoneToSave("12125551234", null)).toThrow(INVALID_PHONE_MESSAGE);
  });

  it("keeps an old number that predates the rule when it was not changed", () => {
    expect(phoneToSave("not a phone", "not a phone")).toBe("not a phone");
    expect(() => phoneToSave("still not a phone", "not a phone")).toThrow(INVALID_PHONE_MESSAGE);
  });
});

describe("phoneForDisplay", () => {
  it("shows the tidy form, or what was typed", () => {
    expect(phoneForDisplay("050 123 4567")).toBe("0501234567");
    expect(phoneForDisplay("+1 (212) 555-1234")).toBe("+12125551234");
    expect(phoneForDisplay("abc")).toBe("abc");
    expect(phoneForDisplay(" ")).toBeNull();
  });
});
