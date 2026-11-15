import { describe, expect, it } from "vitest";

import {
  CUSTOMER_FILTER_OPTIONS,
  customerOrderState,
  GROWER_FILTER_OPTIONS,
  growerPickState,
  matchesFilter,
  progressCount,
} from "./oversight-status";

describe("growerPickState", () => {
  it("maps every pick status and the missing pick", () => {
    expect(growerPickState({ status: "draft" })).toBe("draft");
    expect(growerPickState({ status: "submitted" })).toBe("submitted");
    expect(growerPickState({ status: "closed" })).toBe("closed");
    expect(growerPickState(null)).toBe("none");
  });
});

describe("customerOrderState", () => {
  it("maps every order status and the missing order", () => {
    expect(customerOrderState({ status: "open" })).toBe("open");
    expect(customerOrderState({ status: "submitted" })).toBe("submitted");
    expect(customerOrderState(null)).toBe("none");
  });
});

describe("matchesFilter", () => {
  it("lets every state through on all", () => {
    for (const state of ["draft", "submitted", "closed", "none"] as const) {
      expect(matchesFilter(state, "all")).toBe(true);
    }
  });

  it("lets only the chosen state through otherwise", () => {
    const states = ["draft", "submitted", "closed", "none"] as const;
    for (const filter of states) {
      for (const state of states) {
        expect(matchesFilter(state, filter)).toBe(state === filter);
      }
    }
  });
});

describe("progressCount", () => {
  it("counts the done states out of every state but none", () => {
    expect(
      progressCount(["submitted", "closed", "draft", "none"], ["submitted", "closed"]),
    ).toEqual({ done: 2, total: 3 });
  });

  it("is zero over zero when nobody has anything", () => {
    expect(progressCount(["none", "none"], ["submitted"])).toEqual({ done: 0, total: 0 });
  });
});

describe("filter option lists", () => {
  it("labels the grower filter in order", () => {
    expect(GROWER_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      "הכול",
      "טיוטה",
      "נשלח",
      "סגור",
      "ללא ליקוט",
    ]);
    expect(GROWER_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      "all",
      "draft",
      "submitted",
      "closed",
      "none",
    ]);
  });

  it("labels the customer filter in order", () => {
    expect(CUSTOMER_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      "הכול",
      "פתוחה",
      "נשלחה",
      "ללא הזמנה",
    ]);
    expect(CUSTOMER_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      "all",
      "open",
      "submitted",
      "none",
    ]);
  });
});
