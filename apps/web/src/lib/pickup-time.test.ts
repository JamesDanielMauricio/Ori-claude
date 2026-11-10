import { describe, expect, it } from "vitest";

import { effectivePickupTime, formatPickupTime } from "./pickup-time";

// One rule for "when is this grower collected today", shared by the
// arrangement board and the grower's own picking screen.
describe("effectivePickupTime", () => {
  it("is the pick's own time once it has one (set when the pick is sent)", () => {
    expect(effectivePickupTime("06:00:00", "14:00:00")).toBe("06:00:00");
  });

  it("is the company's current default while the pick has none", () => {
    expect(effectivePickupTime(null, "14:00:00")).toBe("14:00:00");
  });

  it("is nothing when neither exists", () => {
    expect(effectivePickupTime(null, null)).toBeNull();
  });
});

describe("formatPickupTime", () => {
  it("drops the seconds Postgres sends", () => {
    expect(formatPickupTime("14:00:00")).toBe("14:00");
  });

  it("keeps a time that has none", () => {
    expect(formatPickupTime("07:30")).toBe("07:30");
  });

  it("is nothing for no time", () => {
    expect(formatPickupTime(null)).toBeNull();
  });
});
