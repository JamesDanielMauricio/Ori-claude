import { describe, expect, it } from "vitest";

import { thumbGeometry, type ScrollMetrics } from "./geometry";

// A ~700px-tall, 1000px-wide scrollport; each case overrides what it needs.
function metrics(overrides: Partial<ScrollMetrics>): ScrollMetrics {
  return {
    clientHeight: 700,
    scrollHeight: 700,
    scrollTop: 0,
    clientWidth: 1000,
    scrollWidth: 1000,
    scrollLeft: 0,
    ...overrides,
  };
}

describe("thumbGeometry", () => {
  it("draws no thumb on an axis that has nothing to scroll", () => {
    expect(thumbGeometry(metrics({}))).toEqual({ vertical: null, horizontal: null });
  });

  it("gives a vertical-only overflow the full-height track", () => {
    // Track: 700 - 6 - 6 = 688, thumb 688 × 700/7000.
    const top = thumbGeometry(metrics({ scrollHeight: 7000 }));
    expect(top.horizontal).toBeNull();
    expect(top.vertical?.top).toBeCloseTo(6);
    expect(top.vertical?.height).toBeCloseTo(68.8);
    expect(top.vertical?.percent).toBe(0);

    const bottom = thumbGeometry(metrics({ scrollHeight: 7000, scrollTop: 6300 }));
    expect(bottom.vertical?.top).toBeCloseTo(6 + 688 - 68.8);
    expect(bottom.vertical?.percent).toBe(100);
  });

  it("reserves the corner gutter on both tracks when both axes overflow", () => {
    const { vertical, horizontal } = thumbGeometry(
      metrics({ scrollHeight: 7000, scrollWidth: 2000 }),
    );
    // Vertical track: 700 - 6 - 18 = 676.
    expect(vertical?.height).toBeCloseTo(67.6);
    // Horizontal track: from 18 to 1000 - 6 = 976 wide, thumb half of it.
    expect(horizontal?.width).toBeCloseTo(488);
    // Unscrolled RTL: the thumb sits at the RIGHT end of its travel.
    expect(horizontal?.left).toBeCloseTo(18 + 488);
    expect(horizontal?.percent).toBeCloseTo(0);
  });

  it("moves the horizontal thumb left as RTL scrollLeft goes negative", () => {
    const half = thumbGeometry(metrics({ scrollWidth: 2000, scrollLeft: -500 })).horizontal;
    // No vertical overflow, so the track runs 6..994: 988 wide, thumb 494.
    expect(half?.left).toBeCloseTo(6 + 0.5 * 494);
    expect(half?.percent).toBe(50);

    const end = thumbGeometry(metrics({ scrollWidth: 2000, scrollLeft: -1000 })).horizontal;
    expect(end?.left).toBeCloseTo(6);
    expect(end?.percent).toBe(100);
  });

  it("never shrinks a thumb below its grabbable minimum", () => {
    const { vertical, horizontal } = thumbGeometry(
      metrics({ scrollHeight: 39_000, scrollWidth: 100_000 }),
    );
    expect(vertical?.height).toBe(28);
    expect(horizontal?.width).toBe(40);
  });
});
