import { describe, expect, it } from "vitest";

import { CELL_POPOVER_GAP, placeCellPopoverVertically } from "./cell-popover-placement";

// An 800px-tall window: the panel is capped at 60% of it, 480px.
const viewportHeight = 800;

describe("placeCellPopoverVertically", () => {
  it("opens below the trigger when the panel fits there, exactly where it always did", () => {
    const placement = placeCellPopoverVertically({
      triggerTop: 100,
      triggerBottom: 136,
      viewportHeight,
      panelHeight: 360,
    });
    expect(placement).toEqual({
      top: 136 + CELL_POPOVER_GAP,
      bottom: null,
      maxHeight: 480,
      upward: false,
    });
  });

  it("opens above a trigger near the bottom edge, pinned by its bottom edge", () => {
    const placement = placeCellPopoverVertically({
      triggerTop: 700,
      triggerBottom: 736,
      viewportHeight,
      panelHeight: 360,
    });
    expect(placement.upward).toBe(true);
    expect(placement.top).toBeNull();
    // Its bottom edge sits the gap above the trigger's top.
    expect(placement.bottom).toBe(viewportHeight - 700 + CELL_POPOVER_GAP);
    expect(placement.maxHeight).toBe(480);
  });

  it("stays below when it doesn't fit but there is no more room above", () => {
    const placement = placeCellPopoverVertically({
      triggerTop: 380,
      triggerBottom: 400,
      viewportHeight,
      panelHeight: 480,
    });
    expect(placement.upward).toBe(false);
    expect(placement.top).toBe(400 + CELL_POPOVER_GAP);
    // Shrunk to the room left below, so it scrolls inside instead of off-screen.
    expect(placement.maxHeight).toBe(800 - 400 - CELL_POPOVER_GAP - 8);
  });

  it("shrinks an upward panel to the room above when neither side fits", () => {
    // A tall trigger in a short window: 26px free below, 286px above.
    const placement = placeCellPopoverVertically({
      triggerTop: 300,
      triggerBottom: 560,
      viewportHeight: 600,
      panelHeight: 360,
    });
    expect(placement.upward).toBe(true);
    expect(placement.maxHeight).toBe(300 - CELL_POPOVER_GAP - 8);
  });

  it("measures against the capped height, not the content's full height", () => {
    // 2000px of content is still a 480px panel, which fits below this trigger.
    const placement = placeCellPopoverVertically({
      triggerTop: 200,
      triggerBottom: 220,
      viewportHeight,
      panelHeight: 2000,
    });
    expect(placement.upward).toBe(false);
    expect(placement.maxHeight).toBe(480);
  });
});
