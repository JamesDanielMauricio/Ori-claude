import { describe, expect, it } from "vitest";

import {
  clearPreferredGrower,
  growersByVariety,
  initialGrowerChoice,
  readPreferredGrower,
  setPreferredGrower,
} from "./preferred-grower";

// Workbook Task 36: the preferred grower is words in the line's comment —
// "מגדל מועדף: <name>", beside the rest of the comment, joined with " · ".

// Today's growers for the variety: what the chooser offers.
const growers = ["חוות הגליל", "משק כהן"];

describe("setPreferredGrower", () => {
  it("writes the preference into an empty comment", () => {
    expect(setPreferredGrower("", "משק כהן", growers)).toBe("מגדל מועדף: משק כהן");
  });

  it("keeps what the comment already says, and adds the preference after it", () => {
    expect(setPreferredGrower("דחוף", "משק כהן", growers)).toBe("דחוף · מגדל מועדף: משק כהן");
  });

  it("replaces an earlier preference where it stood, keeping the rest", () => {
    expect(setPreferredGrower("דחוף · מגדל מועדף: משק כהן · בבוקר", "חוות הגליל", growers)).toBe(
      "דחוף · מגדל מועדף: חוות הגליל · בבוקר",
    );
  });

  it("changes nothing more when done twice", () => {
    const once = setPreferredGrower("דחוף", "משק כהן", growers);
    expect(setPreferredGrower(once, "משק כהן", growers)).toBe(once);
  });

  it("finds a preference the customer retyped with other spacing", () => {
    expect(
      setPreferredGrower("  דחוף  ·   מגדל   מועדף :משק כהן  ", "חוות הגליל", growers),
    ).toBe("דחוף · מגדל מועדף: חוות הגליל");
  });

  it("drops empty parts left by doubled or stray separators", () => {
    expect(setPreferredGrower("· דחוף ·· ·", "משק כהן", growers)).toBe(
      "דחוף · מגדל מועדף: משק כהן",
    );
  });

  it("keeps a single preference when the comment somehow held two", () => {
    expect(setPreferredGrower("מגדל מועדף: א · דחוף · מגדל מועדף: ב", "ג", growers)).toBe(
      "מגדל מועדף: ג · דחוף",
    );
  });

  it("writes the name with single spaces and no separator inside it", () => {
    expect(setPreferredGrower("", "  משק   כהן · ובניו ", growers)).toBe(
      "מגדל מועדף: משק כהן ובניו",
    );
  });

  it("removes the preference when given no name", () => {
    expect(setPreferredGrower("דחוף · מגדל מועדף: משק כהן", "   ", growers)).toBe("דחוף");
  });

  it("leaves the customer's own sentence that only mentions the words alone", () => {
    expect(setPreferredGrower("בלי מגדל מועדף: כל אחד בסדר", "משק כהן", growers)).toBe(
      "בלי מגדל מועדף: כל אחד בסדר · מגדל מועדף: משק כהן",
    );
  });

  // The customer adds to the comment in a plain one-line box: after the
  // name, with a comma, a space or a dash rather than " · ".
  it("keeps the customer's own words typed after the name, however they were joined", () => {
    expect(setPreferredGrower("מגדל מועדף: משק כהן, בבוקר", "חוות הגליל", growers)).toBe(
      "מגדל מועדף: חוות הגליל, בבוקר",
    );
    expect(setPreferredGrower("מגדל מועדף: משק כהן בבוקר", "חוות הגליל", growers)).toBe(
      "מגדל מועדף: חוות הגליל בבוקר",
    );
    expect(setPreferredGrower("מגדל מועדף: משק כהן - דחוף", "חוות הגליל", growers)).toBe(
      "מגדל מועדף: חוות הגליל - דחוף",
    );
  });

  it("replaces a preference that does not start the comment, rather than adding a second", () => {
    expect(setPreferredGrower("דחוף, מגדל מועדף: משק כהן", "חוות הגליל", growers)).toBe(
      "דחוף, מגדל מועדף: חוות הגליל",
    );
    expect(setPreferredGrower("דחוף מגדל מועדף: משק כהן", "חוות הגליל", growers)).toBe(
      "דחוף מגדל מועדף: חוות הגליל",
    );
  });

  it("matches today's name in other spacing and keeps what follows it", () => {
    expect(setPreferredGrower("מגדל מועדף:  משק   כהן, בבוקר", "חוות הגליל", growers)).toBe(
      "מגדל מועדף: חוות הגליל, בבוקר",
    );
  });

  it("reads the longer of two names that start alike, not the shorter one and the customer's word", () => {
    expect(
      setPreferredGrower("מגדל מועדף: משק כהן ובניו, דחוף", "משק כהן", ["משק כהן", "משק כהן ובניו"]),
    ).toBe("מגדל מועדף: משק כהן, דחוף");
  });

  it("replaces a grower no longer on offer up to the comma after it, keeping the rest", () => {
    expect(setPreferredGrower("מגדל מועדף: משק לוי, בבוקר", "חוות הגליל", growers)).toBe(
      "מגדל מועדף: חוות הגליל, בבוקר",
    );
  });
});

describe("clearPreferredGrower", () => {
  it("removes the preference and keeps the rest of the comment", () => {
    expect(clearPreferredGrower("דחוף · מגדל מועדף: משק כהן · בבוקר", growers)).toBe(
      "דחוף · בבוקר",
    );
  });

  it("leaves an empty comment when the preference was all it held", () => {
    expect(clearPreferredGrower("מגדל מועדף: משק כהן", growers)).toBe("");
  });

  it("returns a comment that names no grower exactly as it was", () => {
    expect(clearPreferredGrower("  דחוף ·· מאוד ", growers)).toBe("  דחוף ·· מאוד ");
  });

  it("changes nothing more when done twice", () => {
    const once = clearPreferredGrower("דחוף · מגדל מועדף: משק כהן", growers);
    expect(clearPreferredGrower(once, growers)).toBe(once);
  });

  it("keeps the customer's own words around the preference, and drops the joiner it leaves", () => {
    expect(clearPreferredGrower("מגדל מועדף: משק כהן, בבוקר", growers)).toBe("בבוקר");
    expect(clearPreferredGrower("מגדל מועדף: משק כהן בבוקר", growers)).toBe("בבוקר");
    expect(clearPreferredGrower("מגדל מועדף: משק כהן - דחוף", growers)).toBe("דחוף");
    expect(clearPreferredGrower("דחוף, מגדל מועדף: משק כהן", growers)).toBe("דחוף");
    expect(clearPreferredGrower("דחוף, מגדל מועדף: משק כהן, בבוקר", growers)).toBe(
      "דחוף, בבוקר",
    );
  });
});

describe("readPreferredGrower", () => {
  it("reads the name back out of what setPreferredGrower wrote", () => {
    expect(
      readPreferredGrower(setPreferredGrower("דחוף", "חוות הגליל", growers), growers),
    ).toBe("חוות הגליל");
  });

  it("is null for a comment that names no grower", () => {
    expect(readPreferredGrower("", growers)).toBeNull();
    expect(readPreferredGrower("דחוף", growers)).toBeNull();
    expect(readPreferredGrower("בלי מגדל מועדף: כל אחד בסדר", growers)).toBeNull();
  });

  it("is null for the label with no name after it", () => {
    expect(readPreferredGrower("דחוף · מגדל מועדף:  ", growers)).toBeNull();
  });

  it("reads a name retyped with other spacing, in single spaces", () => {
    expect(readPreferredGrower("דחוף ·מגדל  מועדף :  משק   כהן ", growers)).toBe("משק כהן");
  });

  it("keeps a colon that is part of the name", () => {
    expect(readPreferredGrower("מגדל מועדף: חוות: הגליל", growers)).toBe("חוות: הגליל");
  });

  it("reads only the name when the customer typed more after it", () => {
    expect(readPreferredGrower("מגדל מועדף: משק כהן, בבוקר", growers)).toBe("משק כהן");
    expect(readPreferredGrower("דחוף מגדל מועדף: משק כהן בבוקר", growers)).toBe("משק כהן");
    // Not on offer today: up to the comma.
    expect(readPreferredGrower("מגדל מועדף: משק לוי, בבוקר", growers)).toBe("משק לוי");
  });

  it("does not take a longer word for one of today's names", () => {
    expect(readPreferredGrower("מגדל מועדף: משק כהנים", growers)).toBe("משק כהנים");
  });
});

describe("initialGrowerChoice", () => {
  it("is the grower the comment names, when they are among the options", () => {
    expect(initialGrowerChoice("דחוף · מגדל מועדף: משק כהן", growers)).toBe("משק כהן");
  });

  it("matches a name retyped with other spacing", () => {
    expect(initialGrowerChoice("מגדל מועדף:  משק   כהן", growers)).toBe("משק כהן");
  });

  it("is null — no preference — when the comment names none", () => {
    expect(initialGrowerChoice("דחוף", growers)).toBeNull();
  });

  it("is undefined — nothing chosen yet — when the grower named is not among the options", () => {
    expect(initialGrowerChoice("מגדל מועדף: משק לוי", growers)).toBeUndefined();
    expect(initialGrowerChoice("מגדל מועדף: משק כהנים", growers)).toBeUndefined();
  });
});

// The path the review found broken: a choice, then the customer's own words
// added by hand in "✎ הערה", then the chooser again.
describe("a choice, a hand edit, then the chooser again", () => {
  const chosen = setPreferredGrower("", "משק כהן", growers);
  const edited = `${chosen}, דחוף`;

  it("still opens on the grower chosen", () => {
    expect(initialGrowerChoice(edited, growers)).toBe("משק כהן");
  });

  it("keeps the customer's words when another grower is chosen", () => {
    expect(setPreferredGrower(edited, "חוות הגליל", growers)).toBe(
      "מגדל מועדף: חוות הגליל, דחוף",
    );
  });

  it("keeps the customer's words when the preference is removed", () => {
    expect(clearPreferredGrower(edited, growers)).toBe("דחוף");
  });
});

describe("growersByVariety", () => {
  it("groups each variety's growers, sorted as Hebrew is", () => {
    const byVariety = growersByVariety([
      { variety_id: "lemon", grower_name: "משק כהן" },
      { variety_id: "lemon", grower_name: "חוות הגליל" },
      { variety_id: "lime", grower_name: "תמר" },
      { variety_id: "lime", grower_name: "אבי" },
    ]);
    expect([...byVariety.entries()]).toEqual([
      ["lemon", ["חוות הגליל", "משק כהן"]],
      ["lime", ["אבי", "תמר"]],
    ]);
  });

  it("keeps only varieties that offer a choice: two or more different names", () => {
    const byVariety = growersByVariety([
      { variety_id: "lemon", grower_name: "משק כהן" },
      { variety_id: "lime", grower_name: "משק כהן" },
      { variety_id: "lime", grower_name: "משק  כהן " },
      { variety_id: "lime", grower_name: "   " },
    ]);
    expect(byVariety.size).toBe(0);
  });

  it("is empty for no rows", () => {
    expect(growersByVariety([]).size).toBe(0);
  });
});
