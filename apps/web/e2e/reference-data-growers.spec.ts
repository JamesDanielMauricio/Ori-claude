import { randomUUID } from "node:crypto";

import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import {
  initiateBusinessDayInputSchema,
  toInitiateBusinessDayRpcArgs,
  toUpdatePickProductPalletsRpcArgs,
  updatePickProductPalletsInputSchema,
} from "@ori/domain/lifecycle-engine";
import {
  createTestGrowerWithProduct,
  deleteTestGrowerWithProduct,
  deleteTestTradingDay,
  getDailyPickForGrower,
  getPickProductLine,
} from "@ori/domain/lifecycle-engine/testing";
import {
  createTestProductFamily,
  createTestProductVariety,
  deleteTestCompany as deleteTestCompanyById,
  deleteTestProductFamily,
  deleteTestProductVariety,
  findCompanyIdByName,
} from "@ori/domain/reference-data/testing";
import { expect, test, type Page } from "@playwright/test";

import { chooseOption } from "./choose-option";

// The single <tr> currently in inline-edit mode — identified by carrying
// the row's own "שמור" button, which only ever exists on one row at a
// time. Field lookups are scoped to it rather than done at the page level
// because record-table.tsx's column-visibility picker renders a checkbox
// per column labelled with that column's own name (e.g. "שם"), which is
// also literally every field's own aria-label — an unscoped
// `page.getByLabel("שם")` matches both and Playwright refuses the
// ambiguity. The in-season checklist below lives in the row's separate
// expand-panel <tr> (not this one), so it stays looked up at the page
// level — nothing there collides with a column name.
function editingRow(page: Page) {
  return page.locator("tr").filter({ has: page.getByRole("button", { name: "שמור" }) });
}

// Drives the Growers screen through the browser end to end — a create and
// an edit, both through the real form and `save_grower` RPC, not a direct
// DB write. The in-season checkbox toggle exercises the join-table half
// of that RPC's transactional replace, not just the company row.
test.describe("Backoffice — Growers", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  test("creates a grower, then edits its name, in-season product selection, and assigned transporter", async ({ page }) => {
    const family = await createTestProductFamily();
    cleanupFns.push(() => deleteTestProductFamily(family.id));
    const product = await createTestProductVariety({ familyId: family.id, name: `זן E2E ${randomUUID()}` });
    cleanupFns.push(() => deleteTestProductVariety(product.id));
    const transporter = await createTestCompany(`מוביל E2E ${randomUUID()}`, "transporter");
    cleanupFns.push(() => deleteTestCompany(transporter.id));

    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const admin = await createTestProfile({ companyId: company.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    await page.goto("/backoffice/growers");

    const growerName = `מגדל E2E ${randomUUID()}`;
    // The table's own toolbar add button (record-table.tsx's `onAdd`)
    // prepends a draft row, already in inline-edit mode — no dialog. Only
    // one such button now (unlike the old list-plus-empty-pane layout,
    // which duplicated it), so no `.first()` disambiguation is needed.
    await page.getByRole("button", { name: "מגדל חדש" }).click();
    await editingRow(page).getByLabel("שם").fill(growerName);
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    const growerRow = page.locator("tr").filter({ hasText: growerName });
    await expect(growerRow).toBeVisible();
    cleanupFns.push(async () => {
      const id = await findCompanyIdByName(growerName);
      if (id) await deleteTestCompanyById(id);
    });
    cleanupFns.push(async () => {
      const id = await findCompanyIdByName(`${growerName} (edited)`);
      if (id) await deleteTestCompanyById(id);
    });

    // Edit: rename, add the fixture product to the in-season selection,
    // and assign the fixture transporter (id 8's cc target on arrangement
    // finalization — this is the only screen that can set it). The row's
    // own pencil icon turns the row itself into the edit form; once
    // clicked, `growerRow`'s text no longer contains the (now-input-held)
    // name, so the rest of this step reads fields directly off the page —
    // safe since only one row can be mid-edit at a time.
    await growerRow.getByRole("button", { name: "ערוך" }).click();
    await editingRow(page).getByLabel("שם").fill(`${growerName} (edited)`);

    // The in-season list is its own column; editing it opens that cell's
    // popover (portaled out of the table's scroll container), which carries
    // a filter because the catalog is ~600 varieties deep.
    await editingRow(page).getByRole("button", { name: "מוצרים בעונה" }).click();
    const picker = page.getByRole("dialog", { name: "מוצרים בעונה" });
    await picker.getByLabel("סינון מוצרים בעונה").fill(product.name);
    // The picker lists varieties under their family's header, by their own
    // name alone, and a search opens every family it finds a match in.
    await picker
      .getByRole("group", { name: family.name })
      .getByRole("checkbox", { name: product.name })
      .check();
    // Escape closes the picker only — the row stays in edit mode with the
    // rest of its unsaved changes intact (cell-popover.tsx stops the key
    // from reaching the table's own cancel-the-row handler). If that ever
    // regressed, the save below would have nothing left to save.
    await page.keyboard.press("Escape");

    await chooseOption(
      editingRow(page).getByRole("combobox", { name: "מוביל", exact: true }),
      transporter.name,
    );
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    const editedRow = page.locator("tr").filter({ hasText: `${growerName} (edited)` });
    await expect(editedRow).toBeVisible();
    // The in-season selection is readable straight off the row now, with
    // nothing expanded — the whole point of the column.
    await expect(editedRow).toContainText(`${family.name} — ${product.name}`);

    await page.reload();
    await page
      .locator("tr")
      .filter({ hasText: `${growerName} (edited)` })
      .getByRole("button", { name: "ערוך" })
      .click();
    await expect(
      editingRow(page).getByRole("combobox", { name: "מוביל", exact: true }),
    ).toHaveText(transporter.name);
  });

  // Workbook Task 04: taking a variety off the in-season list keeps today's
  // stock (sync_grower_picks never deletes a line that holds any), but the
  // office is warned first — and cancelling saves nothing.
  test("warns before a variety holding today's stock leaves the season, and cancelling saves nothing", async ({
    page,
  }) => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const admin = await createTestProfile({ companyId: company.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const adminClient = await signInTestUser(admin.email, admin.password);

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await adminClient.rpc(
      "initiate_business_day",
      toInitiateBusinessDayRpcArgs(initiateBusinessDayInputSchema.parse({ tradeDate })),
    );
    if (initiate.error) throw initiate.error;
    const dayId = initiate.data!.id;
    cleanupFns.push(() => deleteTestTradingDay(dayId));
    const pick = await getDailyPickForGrower(dayId, grower.companyId);
    const pickLine = await getPickProductLine(pick!.id, grower.varietyId);
    const picked = await adminClient.rpc(
      "update_pick_product_pallets",
      toUpdatePickProductPalletsRpcArgs(
        updatePickProductPalletsInputSchema.parse({ dailyPickProductId: pickLine!.id, palletsPicked: 5 }),
      ),
    );
    if (picked.error) throw picked.error;

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    await page.goto("/backoffice/growers");
    await page
      .locator("tr")
      .filter({ hasText: grower.companyName })
      .getByRole("button", { name: "ערוך" })
      .click();
    await editingRow(page).getByRole("button", { name: "מוצרים בעונה" }).click();
    const picker = page.getByRole("dialog", { name: "מוצרים בעונה" });
    await picker.getByLabel("סינון מוצרים בעונה").fill(grower.varietyName);
    await picker
      .getByRole("group", { name: grower.familyName })
      .getByRole("checkbox", { name: grower.varietyName })
      .uncheck();
    await page.keyboard.press("Escape");
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    const warning = page.getByRole("dialog", { name: "יש מלאי בזנים שיוצאים מהעונה" });
    await expect(warning).toContainText(grower.varietyName);
    await expect(warning).toContainText("נקטפו 5");
    await warning.getByRole("button", { name: "ביטול" }).click();
    await expect(warning).toBeHidden();

    // Nothing was saved: the row is still being edited, and the variety is
    // still in the grower's season.
    await expect(editingRow(page).getByRole("button", { name: "שמור" })).toBeVisible();
    const { data: inSeason, error } = await adminClient
      .from("grower_products")
      .select("product_variety_id")
      .eq("company_id", grower.companyId);
    if (error) throw error;
    expect(inSeason.map((row) => row.product_variety_id)).toContain(grower.varietyId);
  });
});
