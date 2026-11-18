import { describe, expect, it } from "vitest";

import { EMPTY_UNSAVED_DAY, updateUnsavedDay, type UnsavedDay } from "./unsaved-changes";

const L1 = { growerId: "g", varietyId: "v", customerId: "c1", quantity: 1 };
const L2 = { growerId: "g", varietyId: "v", customerId: "c2", quantity: 2 };

describe("updateUnsavedDay", () => {
  it("keeps each trading day's changes apart", () => {
    const one = updateUnsavedDay(new Map(), "d1", () => ({ lines: [L1], refusal: null }));
    const two = updateUnsavedDay(one, "d2", () => ({ lines: [L2], refusal: null }));
    expect(two.get("d1")?.lines).toEqual([L1]);
    expect(two.get("d2")?.lines).toEqual([L2]);
  });

  it("drops a day once it holds no lines and no message", () => {
    const one = updateUnsavedDay(new Map(), "d1", () => ({ lines: [L1], refusal: null }));
    expect(updateUnsavedDay(one, "d1", () => EMPTY_UNSAVED_DAY).has("d1")).toBe(false);
  });

  it("hands the update the day's current changes, or the empty day", () => {
    const seen: UnsavedDay[] = [];
    updateUnsavedDay(new Map(), "d1", (current) => {
      seen.push(current);
      return current;
    });
    expect(seen).toEqual([EMPTY_UNSAVED_DAY]);
  });

  it("returns the same map when nothing changes", () => {
    const one = updateUnsavedDay(new Map(), "d1", () => ({ lines: [L1], refusal: null }));
    expect(updateUnsavedDay(one, "d1", (current) => current)).toBe(one);
  });
});
