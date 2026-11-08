import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizePhoneNumber, toWhatsAppPersonalNumber } from "./phone";

// The examples every copy of the rule is tested against (see phone.ts).
const { cases } = JSON.parse(readFileSync(new URL("./phone-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ input: string | null; local: string | null }>;
};

describe("normalizePhoneNumber", () => {
  it.each(cases.map((c) => [c.input, c.local] as const))("%j → %j", (input, local) => {
    expect(normalizePhoneNumber(input)).toBe(local);
  });

  it("treats undefined like a missing number", () => {
    expect(normalizePhoneNumber(undefined)).toBeNull();
  });

  it("gives every accepted number one stored form, however it was typed", () => {
    const israeli = cases.filter((c) => c.local === "0501234567").map((c) => normalizePhoneNumber(c.input));
    expect(israeli.length).toBeGreaterThan(10);
    expect(new Set(israeli)).toEqual(new Set(["0501234567"]));
    const american = cases.filter((c) => c.local === "+12125551234").map((c) => normalizePhoneNumber(c.input));
    expect(american.length).toBeGreaterThan(2);
    expect(new Set(american)).toEqual(new Set(["+12125551234"]));
  });

  it("reads a number written without + or 00 as Israeli, never as foreign", () => {
    expect(normalizePhoneNumber("12125551234")).toBeNull();
    expect(normalizePhoneNumber("+12125551234")).toBe("+12125551234");
  });
});

describe("toWhatsAppPersonalNumber", () => {
  it("is the country code and number: 972 + an Israeli number without its zero", () => {
    expect(toWhatsAppPersonalNumber("050-123 4567")).toBe("972501234567");
    expect(toWhatsAppPersonalNumber("+972 50-123-4567")).toBe("972501234567");
    expect(toWhatsAppPersonalNumber("04-6123456")).toBe("97246123456");
  });

  it("…or a foreign number without its +", () => {
    expect(toWhatsAppPersonalNumber("+970 59-123-4567")).toBe("970591234567");
    expect(toWhatsAppPersonalNumber("+44 (0)20 7946 0958")).toBe("442079460958");
  });

  it("has no address for something that is not a phone number", () => {
    expect(toWhatsAppPersonalNumber("12")).toBeNull();
    expect(toWhatsAppPersonalNumber("+12")).toBeNull();
    expect(toWhatsAppPersonalNumber("")).toBeNull();
    expect(toWhatsAppPersonalNumber(null)).toBeNull();
  });
});
