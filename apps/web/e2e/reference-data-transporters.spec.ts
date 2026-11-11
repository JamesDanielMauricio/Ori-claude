import { randomUUID } from "node:crypto";

import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
} from "@ori/domain/auth/testing";
import {
  deleteTestCompany as deleteTestCompanyById,
  findCompanyIdByName,
} from "@ori/domain/reference-data/testing";
import { expect, test, type Page } from "@playwright/test";

// The single <tr> currently in inline-edit mode — see the identical helper
// in reference-data-growers.spec.ts for why field lookups need to be
// scoped to it: record-table.tsx's column-visibility picker labels a
// checkbox with each column's own name, which collides with that same
// field's input aria-label at the page level.
function editingRow(page: Page) {
  return page.locator("tr").filter({ has: page.getByRole("button", { name: "שמור" }) });
}

// Drives the Transporters screen through the browser — a create and an
// edit through the real form and `save_transporter` RPC.
test.describe("Backoffice — Transporters", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  test("creates a transporter, then edits its name and WhatsApp group", async ({ page }) => {
    // The group is picked from the connected number's WhatsApp groups, which
    // the whatsapp-groups Edge Function reads from Green API. Answered here by
    // the test instead — nothing leaves this machine, and the list is known.
    // A fresh group id each run: a company's group may not be another's (0082).
    const group = { id: `120363${Date.now()}`, name: `קבוצת E2E ${randomUUID().slice(0, 8)}` };
    await page.route("**/functions/v1/whatsapp-groups", (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({
            status: 200,
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
              "access-control-allow-methods": "POST, OPTIONS",
            },
          })
        : route.fulfill({
            headers: { "access-control-allow-origin": "*" },
            json: { env: "dev", groups: [group] },
          }),
    );

    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const admin = await createTestProfile({ companyId: company.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    await page.goto("/backoffice/transporters");

    const transporterName = `מוביל E2E ${randomUUID()}`;
    // The table's own toolbar add button (record-table.tsx's `onAdd`)
    // prepends a draft row, already in inline-edit mode — one button now,
    // so no `.first()` disambiguation needed.
    await page.getByRole("button", { name: "מוביל חדש" }).click();
    await editingRow(page).getByLabel("שם").fill(transporterName);
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    const transporterRow = page.locator("tr").filter({ hasText: transporterName });
    await expect(transporterRow).toBeVisible();
    cleanupFns.push(async () => {
      const id = await findCompanyIdByName(transporterName);
      if (id) await deleteTestCompanyById(id);
    });
    cleanupFns.push(async () => {
      const id = await findCompanyIdByName(`${transporterName} (edited)`);
      if (id) await deleteTestCompanyById(id);
    });

    // The row's own pencil icon turns the row itself into the edit form,
    // so the rest of this step reads fields directly off the page — safe
    // since only one row can be mid-edit at a time.
    await transporterRow.getByRole("button", { name: "ערוך" }).click();
    await editingRow(page).getByLabel("שם").fill(`${transporterName} (edited)`);
    const groupCell = editingRow(page).getByRole("button", { name: "קבוצת WhatsApp" });
    const picker = page.getByRole("dialog", { name: "קבוצת WhatsApp" });
    const groupOption = picker.getByRole("option", { name: new RegExp(group.name) });

    // The keyboard: the search box has the focus once the picker opens; an
    // arrow key moves the highlight, not the choice; Escape closes the picker
    // and leaves the row's edit alone.
    await groupCell.click();
    await expect(picker.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(picker.getByRole("combobox")).toHaveAttribute(
      "aria-activedescendant",
      (await groupOption.getAttribute("id")) ?? "",
    );
    await expect(picker.getByRole("option", { selected: true })).toHaveText("ללא קבוצה");
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(groupCell).toHaveText("ללא קבוצה");
    await expect(groupCell).toBeFocused();

    // Picking a group closes the picker, hands the focus back to the cell and
    // shows the group's name in it.
    await groupCell.click();
    await groupOption.click();
    await expect(picker).toHaveCount(0);
    await expect(groupCell).toBeFocused();
    await expect(groupCell).toHaveText(group.name);
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    // Saved, and shown by its name rather than its id.
    const editedRow = page.locator("tr").filter({ hasText: `${transporterName} (edited)` });
    await expect(editedRow).toBeVisible();
    await expect(editedRow).toContainText(group.name);
  });
});
