// CRASH TRAIL (temporary) — remove with lib/crash-trail.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inserted: unknown[] = [];
let failInsert = false;
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: async (row: unknown) => {
        if (failInsert) throw new Error("offline");
        inserted.push({ table, row });
        return { error: null };
      },
    }),
  }),
}));

import {
  CRASH_TRAIL_STEPS,
  crashRow,
  crashSteps,
  describeClick,
  forgetCrashSteps,
  recordStep,
  saveCrash,
} from "./crash-trail";

// Just enough of an element for describeClick, which runs in the browser.
type Fake = {
  tagName: string;
  attrs?: Record<string, string>;
  text?: string;
  parent?: Fake;
  matches?: boolean;
};
function element(fake: Fake): Element {
  const self = {
    tagName: fake.tagName,
    textContent: fake.text ?? "",
    getAttribute: (name: string) => fake.attrs?.[name] ?? null,
    closest: (selector: string): unknown => {
      if (selector === "label") {
        let at: Fake | undefined = fake;
        while (at && at.tagName !== "LABEL") at = at.parent;
        return at ? element(at) : null;
      }
      let at: Fake | undefined = fake;
      while (at && at.matches === false) at = at.parent;
      return at ? element(at) : null;
    },
  };
  return self as unknown as Element;
}

beforeEach(() => {
  forgetCrashSteps();
  inserted.length = 0;
  failInsert = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the trail", () => {
  it(`keeps the last ${CRASH_TRAIL_STEPS} steps, oldest first`, () => {
    for (let i = 1; i <= 25; i++) recordStep(`step ${i}`, new Date(Date.UTC(2026, 10, 12, 10, 0, i)));
    const steps = crashSteps();
    expect(steps).toHaveLength(CRASH_TRAIL_STEPS);
    expect(steps[0]).toEqual({ at: "2026-11-12T10:00:06.000Z", what: "step 6" });
    expect(steps.at(-1)?.what).toBe("step 25");
  });

  it("writes nothing to the database: only a crash creates a record", () => {
    for (let i = 0; i < 50; i++) recordStep(`opened /screen-${i}`);
    describeClick(element({ tagName: "BUTTON", attrs: { "aria-label": "שמור" } }));
    crashSteps();
    expect(inserted).toEqual([]);
  });

  it("hands out a copy, so a later step does not change a crash already caught", () => {
    recordStep("one");
    const caught = crashSteps();
    recordStep("two");
    expect(caught.map((step) => step.what)).toEqual(["one"]);
  });
});

describe("what a click is called", () => {
  it("by the control's aria-label, else its visible text", () => {
    expect(describeClick(element({ tagName: "BUTTON", attrs: { "aria-label": "ערוך את מלאי מגדל" }, text: "✎" }))).toBe(
      'clicked button "ערוך את מלאי מגדל"',
    );
    expect(describeClick(element({ tagName: "BUTTON", text: "  שמור\n " }))).toBe('clicked button "שמור"');
    expect(describeClick(element({ tagName: "DIV", attrs: { role: "option" }, text: "קבוצה 1" }))).toBe('clicked option "קבוצה 1"');
  });

  it("a click inside a control is the control's", () => {
    const button = { tagName: "BUTTON", attrs: { "aria-label": "סגור" } };
    expect(describeClick(element({ tagName: "SPAN", matches: false, parent: button }))).toBe('clicked button "סגור"');
  });

  it("names a field, never what is in it", () => {
    expect(describeClick(element({ tagName: "INPUT", attrs: { "aria-label": "טלפון", value: "0501234567" }, text: "0501234567" }))).toBe(
      'clicked input "טלפון"',
    );
    expect(describeClick(element({ tagName: "TEXTAREA", attrs: { name: "comment" }, text: "הערה סודית" }))).toBe(
      'clicked textarea "comment"',
    );
    expect(describeClick(element({ tagName: "INPUT", text: "secret" }))).toBe("clicked input");
  });

  it("a ticked box by the row it sits in", () => {
    const label = { tagName: "LABEL", text: "עגבניה גדול" };
    expect(describeClick(element({ tagName: "INPUT", attrs: { type: "checkbox" }, parent: label }))).toBe(
      'clicked checkbox "עגבניה גדול"',
    );
  });

  it("nothing for a click outside any control", () => {
    expect(describeClick(element({ tagName: "DIV", matches: false }))).toBeNull();
    expect(describeClick(null)).toBeNull();
  });
});

describe("the crash's row", () => {
  const context = {
    person: { id: "u1", name: "דנה", role: "backoffice" },
    screen: "/backoffice/distributor-grower",
    browser: "Chrome",
    version: "788096f",
    steps: [{ at: "2026-11-12T10:00:00.000Z", what: "opened /backoffice/distributor-grower" }],
  };

  it("says who, where, what and the steps before it", () => {
    const error = new TypeError("x is not a function");
    const row = crashRow(error, "\n    at PickLinesEditor", context);
    expect(row).toMatchObject({
      user_id: "u1",
      user_name: "דנה",
      role: "backoffice",
      screen: "/backoffice/distributor-grower",
      error: "x is not a function",
      browser: "Chrome",
      app_version: "788096f",
      breadcrumbs: context.steps,
    });
    expect(row.stack).toContain("TypeError: x is not a function");
    expect(row.stack).toContain("component stack:\n    at PickLinesEditor");
  });

  it("is anonymous without a signed-in person, and cuts every field to the table's limit", () => {
    const row = crashRow("x".repeat(5000), null, {
      ...context,
      person: null,
      screen: "/".repeat(900),
      browser: "b".repeat(900),
      version: "",
      steps: Array.from({ length: 30 }, (_, i) => ({ at: "t", what: `step ${i}` })),
    });
    expect(row.user_id).toBeNull();
    expect(row.user_name).toBeNull();
    expect(row.error).toHaveLength(2000);
    expect(row.stack).toBeNull();
    expect(row.screen).toHaveLength(500);
    expect(row.browser).toHaveLength(500);
    expect(row.app_version).toBeNull();
    expect(row.breadcrumbs).toHaveLength(CRASH_TRAIL_STEPS);
    expect(row.breadcrumbs[0]?.what).toBe("step 10");
  });
});

describe("saving a crash", () => {
  it("writes one crash_trail row with the trail so far", async () => {
    vi.stubGlobal("window", { location: { pathname: "/backoffice/growers", search: "?x=1" } });
    vi.stubGlobal("navigator", { userAgent: "Chrome" });
    recordStep("opened /backoffice/growers?x=1");
    await saveCrash(new Error("boom"), null);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      table: "crash_trail",
      row: { screen: "/backoffice/growers?x=1", error: "boom", browser: "Chrome", user_id: null },
    });
  });

  it("never throws, even when the save fails", async () => {
    vi.stubGlobal("window", { location: { pathname: "/", search: "" } });
    vi.stubGlobal("navigator", { userAgent: "Chrome" });
    failInsert = true;
    await expect(saveCrash(new Error("boom"))).resolves.toBeUndefined();
  });
});
