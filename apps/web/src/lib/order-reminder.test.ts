import { describe, expect, it } from "vitest";

import { failureNeedsToast, initiallyTicked, reminderPeople, shouldResetOnClose } from "./order-reminder";

const row = (user_id: string, display_name: string, phone_number: string | null) => ({
  user_id,
  display_name,
  phone_number,
});

describe("reminderPeople", () => {
  it("reads numbers the way the sender does", () => {
    const people = reminderPeople([
      row("a", "א", "050-123 4567"),
      row("b", "ב", "+970 59-123-4567"),
      // "12" is refused in packages/shared/src/phone-cases.json too.
      row("c", "ג", "12"),
      row("d", "ד", null),
      row("e", "ה", ""),
    ]);
    const by = Object.fromEntries(people.map((p) => [p.userId, p]));
    expect(by.a).toMatchObject({ canReceive: true, reason: null });
    expect(by.b).toMatchObject({ canReceive: true, reason: null });
    expect(by.c).toMatchObject({ canReceive: false, reason: "invalid_phone", phoneTail: null });
    expect(by.d).toMatchObject({ canReceive: false, reason: "no_phone", phoneTail: null });
    expect(by.e).toMatchObject({ canReceive: false, reason: "no_phone" });
  });

  it("sorted by Hebrew name", () => {
    const people = reminderPeople([row("1", "תמר", null), row("2", "אבי", null), row("3", "דנה", null)]);
    expect(people.map((p) => p.name)).toEqual(["אבי", "דנה", "תמר"]);
  });

  it("phoneTail shows only the last four digits", () => {
    const [person] = reminderPeople([row("1", "אבי", "0501234512")]);
    expect(person!.phoneTail).toBe("•••4512");
  });
});

describe("initiallyTicked", () => {
  it("ticks exactly the reachable", () => {
    const people = reminderPeople([row("a", "א", "0501234567"), row("b", "ב", null), row("c", "ג", "12")]);
    expect([...initiallyTicked(people)]).toEqual(["a"]);
  });
});

describe("the reminder window while a send is in flight", () => {
  it("closing it detaches nothing that is still sending", () => {
    expect(shouldResetOnClose({ sending: true })).toBe(false);
    expect(shouldResetOnClose({ sending: false })).toBe(true);
  });

  it("a failure shows its own toast only when the window it belongs to is gone", () => {
    expect(failureNeedsToast({ windowOpen: false })).toBe(true);
    expect(failureNeedsToast({ windowOpen: true })).toBe(false);
  });
});
