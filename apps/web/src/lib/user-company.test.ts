import { describe, expect, it } from "vitest";

import { companyFitsRole } from "./user-company";

const grower = { id: "g1", name: "מגדל", type: "grower" };
const customer = { id: "c1", name: "לקוח", type: "customer" };
const office = { id: "b1", name: "משרד", type: "backoffice" };
const transporter = { id: "t1", name: "מוביל", type: "transporter" };
const all = [grower, customer, office, transporter];
const offered = (
  role: "grower" | "customer" | "backoffice",
  saved = null as Parameters<typeof companyFitsRole>[2],
) => all.filter((company) => companyFitsRole(company, role, saved)).map((company) => company.id);

// Found in testing (2026-11-13 and 2026-11-20): the Users screen offered every
// company for every role, so a customer company's user could be saved as a
// grower — whose screens then have no pick of their own to show.
describe("companyFitsRole", () => {
  it("offers only the companies of the role's own type, as the import screen does", () => {
    expect(offered("grower")).toEqual(["g1"]);
    expect(offered("customer")).toEqual(["c1"]);
    expect(offered("backoffice")).toEqual(["b1"]);
  });

  it("keeps a user's saved company while their role stays the same, even one of another type", () => {
    // Two office accounts on live belong to a customer company; editing their
    // name must not force a move that changes who gets that company's messages.
    expect(offered("backoffice", { role: "backoffice", companyId: "c1" })).toEqual(["c1", "b1"]);
  });

  it("stops offering that company once the role changes", () => {
    expect(offered("grower", { role: "backoffice", companyId: "c1" })).toEqual(["g1"]);
  });
});
