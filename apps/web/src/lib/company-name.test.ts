import { describe, expect, it } from "vitest";

import { activeNameTaken } from "./company-name";

const saved = [
  { id: "a", name: "משק כהן", status: "active" },
  { id: "b", name: "שוק העיר", status: "inactive" },
];

// Found in testing (2026-11-20): a second grower saved under an existing
// grower's name, so every list showed two identical names with no way to tell
// them apart.
describe("activeNameTaken", () => {
  it("refuses a new active company named like another active one", () => {
    expect(activeNameTaken(saved, { id: null, name: "משק כהן", status: "active" })).toBe(true);
  });

  it("ignores spaces around and inside the name, and letter case", () => {
    expect(activeNameTaken(saved, { id: null, name: "  משק   כהן ", status: "active" })).toBe(true);
    expect(
      activeNameTaken([{ id: "x", name: "Green Farm", status: "active" }], {
        id: null,
        name: "green farm",
        status: "active",
      }),
    ).toBe(true);
  });

  it("lets a company keep its own name when it is saved again", () => {
    expect(activeNameTaken(saved, { id: "a", name: "משק כהן", status: "active" })).toBe(false);
  });

  it("allows the name of an inactive company — live has such pairs, an old inactive record beside a new one", () => {
    expect(activeNameTaken(saved, { id: null, name: "שוק העיר", status: "active" })).toBe(false);
  });

  it("allows saving an inactive company whatever its name", () => {
    expect(activeNameTaken(saved, { id: null, name: "משק כהן", status: "inactive" })).toBe(false);
  });

  it("refuses making an inactive company active while an active one has its name", () => {
    expect(
      activeNameTaken([...saved, { id: "c", name: "שוק העיר", status: "active" }], {
        id: "b",
        name: "שוק העיר",
        status: "active",
      }),
    ).toBe(true);
  });
});
