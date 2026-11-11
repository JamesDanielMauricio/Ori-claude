// The importer's planning, with no database: importing the script runs
// nothing (main() runs only as a script), and planReference / planTrading
// take a Bubble export and return rows.

import { describe, expect, it } from "vitest";

import { DATA_TYPES, planReference, planTrading, Report, type ExportData, type PreviousIds } from "./import-from-bubble";

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T06:00:00.000Z`;

// One office, one grower, one customer and two products; one closed day on
// which the grower picked both, the customer ordered the tomato, and it was
// arranged to them. All made up.
function bubbleExport(): ExportData {
  const data = Object.fromEntries(DATA_TYPES.map((type) => [type, []])) as unknown as ExportData;
  data.appsettings = [{ _id: "settings", "Created Date": at(1), "assigned distributor for reset password": "u-office" }];
  data.company = [
    { _id: "c-office", "Created Date": at(1), Name: "המשרד", Type: "משווק", Status: "פעיל" },
    { _id: "c-grower", "Created Date": at(1), Name: "מגדל", Type: "מגדל", Status: "פעיל", "Products in season": ["v-tomato", "v-cucumber"] },
    { _id: "c-customer", "Created Date": at(1), Name: "לקוח", Type: "לקוח", Status: "פעיל" },
  ];
  data.user = [
    { _id: "u-office", "Created Date": at(1), Company: "c-office", Role: "משווק", authentication: { email: { email: "office@example.test" } } },
    {
      _id: "u-customer",
      "Created Date": at(1),
      Company: "c-customer",
      Role: "לקוח",
      "Products Blacklist": ["f-cucumber"],
      authentication: { email: { email: "customer@example.test" } },
    },
  ];
  data.productfamily = [
    { _id: "f-tomato", "Created Date": at(1), Name: "עגבניה" },
    { _id: "f-cucumber", "Created Date": at(1), Name: "מלפפון" },
  ];
  data.productvarieties = [
    { _id: "v-tomato", "Created Date": at(1), "Product Family": "f-tomato", Variety: "רד-דיימונד", Size: "גדול" },
    { _id: "v-cucumber", "Created Date": at(1), "Product Family": "f-cucumber", Variety: "מלפפון" },
  ];
  data.dailyarrangement = [{ _id: "a-1", "Created Date": at(5), Date: at(5), status: "Close" }];
  data.dailypick = [{ _id: "p-1", "Created Date": at(5), Date: at(5), Status: "נשלח", "linked to company (grower)": "c-grower" }];
  data.dailypickproduct = [
    { _id: "pl-tomato", "Created Date": at(5), "linked to daily pick": "p-1", "linked to product variety": "v-tomato", "Pallets picked": 4, "the number of leftover pallets after the day ended": 1 },
    { _id: "pl-cucumber", "Created Date": at(5), "linked to daily pick": "p-1", "linked to product variety": "v-cucumber", "Pallets picked": 2, "the number of leftover pallets after the day ended": 2 },
  ];
  data.dailyorder = [
    {
      _id: "o-1",
      "Created Date": at(5),
      Date: at(5),
      Status: "נשלחה למשווק",
      "link to company (customer)": "c-customer",
      "order logs": [JSON.stringify({ user: { "unique id": "u-customer" }, date: at(5), order_data: [{ "variety unique id": "v-tomato", order: "3", comment: "" }] })],
    },
  ];
  data.dailyorderproducts = [{ _id: "ol-tomato", "Created Date": at(5), "linked to daily order": "o-1", "linked to product variety": "v-tomato", "No. of pallets (new)": 3 }];
  data.dailyarrangementrecords = [
    {
      _id: "r-1",
      "Created Date": at(5),
      "linked to daily pick product": "pl-tomato",
      "linked to company (customer)": "c-customer",
      "linked to product variety": "v-tomato",
      "linked to daily arrangement": "a-1",
      "Number Pallets Arranged": 3,
    },
  ];
  return data;
}

// What main() reads back from _bubble_migration_id_map before the next import.
function previousIdsOf(plan: ReturnType<typeof planReference>): PreviousIds {
  const ids = { company: new Map<string, string>(), productfamily: new Map<string, string>(), productvarieties: new Map<string, string>() };
  for (const row of plan.idMap) ids[row.entity_type as keyof PreviousIds].set(String(row.bubble_id), String(row.new_id));
  return ids;
}

const loginsOf = (plan: ReturnType<typeof planReference>) => new Map(plan.users.map((user) => [user.bubbleId, `login-${user.bubbleId}`]));
const notKeptIssues = (report: Report) =>
  report.issues.filter((issue) => issue.code.endsWith(".id_not_kept")).map((issue) => [issue.severity, issue.code, issue.bubbleId]);

describe("planReference: a repeat import keeps ids (Task 20)", () => {
  it("keeps every company's, family's and variety's id; what is new in Bubble gets a new one", () => {
    const first = planReference(bubbleExport(), new Report());
    const before = previousIdsOf(first);

    // Since the first import Bubble got a new family with a variety, and a
    // new tomato.
    const data = bubbleExport();
    data.productfamily.push({ _id: "f-pepper", "Created Date": at(6), Name: "פלפל" });
    data.productvarieties.push(
      { _id: "v-pepper", "Created Date": at(6), "Product Family": "f-pepper", Variety: "פלפל אדום" },
      { _id: "v-cherry", "Created Date": at(6), "Product Family": "f-tomato", Variety: "שרי" },
    );
    const report = new Report();
    const after = previousIdsOf(planReference(data, report, before));

    for (const type of ["company", "productfamily", "productvarieties"] as const) {
      for (const [bubbleId, id] of before[type]) expect(after[type].get(bubbleId)).toBe(id);
    }
    const earlier = new Set([...before.productfamily.values(), ...before.productvarieties.values()]);
    for (const id of [after.productfamily.get("f-pepper"), after.productvarieties.get("v-pepper"), after.productvarieties.get("v-cherry")]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(earlier.has(id!)).toBe(false);
    }
    expect(notKeptIssues(report)).toEqual([]);
  });

  it("every row that names a product names it by its kept id", () => {
    const before = previousIdsOf(planReference(bubbleExport(), new Report()));
    const reference = planReference(bubbleExport(), new Report(), before);
    const tomato = before.productvarieties.get("v-tomato");
    const cucumber = before.productvarieties.get("v-cucumber");
    const grower = before.company.get("c-grower");

    expect(reference.productVarieties.map((row) => [row.id, row.family_id])).toEqual([
      [tomato, before.productfamily.get("f-tomato")],
      [cucumber, before.productfamily.get("f-cucumber")],
    ]);
    expect(reference.growerProducts).toEqual([
      { company_id: grower, product_variety_id: tomato },
      { company_id: grower, product_variety_id: cucumber },
    ]);
    expect(reference.users.find((user) => user.bubbleId === "u-customer")?.blockedVarietyIds).toEqual([cucumber]);

    const { rows } = planTrading(bubbleExport(), reference, loginsOf(reference), new Report());
    expect(rows.profile_blocked_products).toEqual([{ user_id: "login-u-customer", product_variety_id: cucumber }]);
    expect(rows.daily_pick_products.map((row) => row.product_variety_id)).toEqual([tomato, cucumber]);
    expect(rows.daily_order_products.map((row) => row.product_variety_id)).toEqual([tomato]);
    expect(rows.order_submission_logs.map((row) => row.snapshot)).toEqual([[{ productVarietyId: tomato, palletsOrdered: 3, comment: null }]]);
    const tomatoPickLine = rows.daily_pick_products.find((row) => row.product_variety_id === tomato)?.id;
    expect(rows.arrangement_records.map((row) => [row.daily_pick_product_id, row.daily_order_product_id])).toEqual([
      [tomatoPickLine, rows.daily_order_products[0]?.id],
    ]);
  });

  it("an earlier id that is not a uuid, or that two records had, is not kept: the row gets a new id and the report says so", () => {
    const shared = "0b7e9c3a-5d21-4f8b-9a64-2c3d4e5f6a7b";
    const report = new Report();
    const plan = planReference(bubbleExport(), report, {
      company: new Map(),
      productfamily: new Map([["f-tomato", "not-an-id"]]),
      productvarieties: new Map([["v-tomato", shared], ["v-cucumber", shared]]),
    });

    const varietyIds = plan.productVarieties.map((row) => row.id);
    expect(varietyIds).not.toContain(shared);
    expect(new Set(varietyIds).size).toBe(2);
    expect(plan.productFamilies.map((row) => row.id)).not.toContain("not-an-id");
    // The tomato points at its family's new id.
    expect(plan.productVarieties[0]?.family_id).toBe(plan.productFamilies[0]?.id);
    expect(notKeptIssues(report)).toEqual([
      ["warning", "family.id_not_kept", "f-tomato"],
      ["warning", "variety.id_not_kept", "v-tomato"],
      ["warning", "variety.id_not_kept", "v-cucumber"],
    ]);
  });

  it("a family and a variety that had one id keep neither, so no two rows share it", () => {
    const one = "6f1c2b9e-3a4d-4c5e-8f70-1a2b3c4d5e6f";
    const report = new Report();
    const plan = planReference(bubbleExport(), report, {
      company: new Map(),
      productfamily: new Map([["f-tomato", one]]),
      productvarieties: new Map([["v-cucumber", one]]),
    });

    expect([...plan.productFamilies, ...plan.productVarieties].map((row) => row.id)).not.toContain(one);
    expect(notKeptIssues(report)).toEqual([
      ["warning", "family.id_not_kept", "f-tomato"],
      ["warning", "variety.id_not_kept", "v-cucumber"],
    ]);
  });
});
