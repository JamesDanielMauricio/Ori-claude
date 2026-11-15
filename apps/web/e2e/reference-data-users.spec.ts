import { randomUUID } from "node:crypto";

import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import { createTestGrowerCompany, deleteTestCompany as deleteTestCompanyById } from "@ori/domain/reference-data/testing";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { chooseOption } from "./choose-option";

// A row created on a *different* page (the import flow below) has been
// observed taking a few seconds to appear in this list after navigating
// straight here — reproduced against the real hosted Supabase project,
// not local dev. Root-caused as far as it can be from the client side:
// Postgres itself has no replication lag (single primary, no read
// replicas) and it isn't a browser/request cache (an explicit
// `Cache-Control: no-store` request header didn't change the behavior
// either) — it looks like transient caching on Supabase's own hosted
// REST gateway for a repeated identical GET URL, which nothing on our
// side can force-bypass. A same-page create-then-list (the other four
// reference-data screens) never shows this, because those refetch via an
// explicit `queryClient.invalidateQueries()` the moment the mutation
// resolves, not a fresh cross-page navigation. One reload reliably
// resolves it, so that's what this waits through instead of either a
// flaky fixed timeout or silently masking a real (if minor, few-second)
// UX gap — see docs/ARCHITECTURE.md.
async function waitForRowWithReload(page: Page, name: string) {
  const row = page.locator("tr").filter({ hasText: name });
  try {
    await row.waitFor({ timeout: 8000 });
  } catch {
    await page.reload();
    await row.waitFor({ timeout: 15000 });
  }
}

// The single <tr> currently in inline-edit mode — see the identical helper
// in reference-data-growers.spec.ts for why field lookups need to be
// scoped to it: record-table.tsx's column-visibility picker labels a
// checkbox with each column's own name (e.g. "שם תצוגה"), which collides
// with that same field's input aria-label at the page level.
function editingRow(page: Page) {
  return page.locator("tr").filter({ has: page.getByRole("button", { name: "שמור" }) });
}

// Drives the Users screen through the browser. Unlike the other four
// screens, "create" isn't a button on this screen itself — per the PRD, a
// `profiles` row with no matching `auth.users` identity would be an
// orphan, so account creation stays the existing bulk-import flow (linked
// directly from this screen's list pane). This test exercises that real
// create path first, then the Users screen's own edit (display name,
// role, product blacklist) and delete on the account it just created.
test.describe("Backoffice — Users", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  test("imports a user, then edits their profile and deletes them", async ({ page }) => {
    test.setTimeout(60000);
    const targetCompany = await createTestGrowerCompany();
    cleanupFns.push(() => deleteTestCompanyById(targetCompany.id));

    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    const admin = await createTestProfile({ companyId: adminCompany.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    // Create: the bulk-import flow.
    await page.goto("/backoffice/users/import");
    const newUserEmail = `e2e-${randomUUID()}@example.test`;
    const newUserDisplayName = `משתמש E2E ${randomUUID()}`;
    await page.getByLabel("אימייל").fill(newUserEmail);
    await page.getByLabel("שם תצוגה").fill(newUserDisplayName);
    await chooseOption(page.getByRole("combobox", { name: "תפקיד", exact: true }), "מגדל");
    await chooseOption(
      page.getByRole("combobox", { name: "חברה", exact: true }),
      targetCompany.name,
    );
    await page.getByRole("button", { name: "צור משתמשים" }).click();

    await expect(page.getByText("נוצר", { exact: true })).toBeVisible();

    // Edit: back on the main Users screen, change display name + role. The
    // row's own pencil icon turns the row itself into the edit form —
    // there's no dialog for this any more, no separate "select the row,
    // then press ערוך" step, and fields are read directly off the page
    // since only one row can be mid-edit at a time.
    await page.goto("/backoffice/users");
    await waitForRowWithReload(page, newUserDisplayName);
    await page
      .locator("tr")
      .filter({ hasText: newUserDisplayName })
      .getByRole("button", { name: "ערוך" })
      .click();
    await editingRow(page).getByLabel("שם תצוגה").fill(`${newUserDisplayName} (edited)`);
    await chooseOption(
      editingRow(page).getByRole("combobox", { name: "תפקיד", exact: true }),
      "לקוח",
    );
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    const editedRow = page.locator("tr").filter({ hasText: `${newUserDisplayName} (edited)` });
    await expect(editedRow).toBeVisible();

    // Delete, closing the loop on full CRUD for this screen — the row's own
    // trash icon still opens a confirm dialog (unlike editing, a
    // destructive action keeps the extra "are you sure" step).
    await editedRow.getByRole("button", { name: "מחק" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "מחק" }).click();

    await expect(page.locator("tr").filter({ hasText: newUserDisplayName })).toHaveCount(0);
  });

  // Signs an office user in and opens the Users screen, with two other
  // accounts to work on (the second is there for its email to be taken).
  async function openUsersWithTwoAccounts(page: Page) {
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const admin = await createTestProfile({ companyId: company.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const target = await createTestProfile({
      companyId: company.id,
      role: "backoffice",
      displayName: `יעד E2E ${randomUUID()}`,
    });
    cleanupFns.push(() => deleteTestUser(target.userId));
    const other = await createTestProfile({ companyId: company.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(other.userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);
    await page.goto("/backoffice/users");
    return { target, other };
  }

  // The service-role client the other e2e specs use (bypasses RLS).
  function serviceClient() {
    return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async function startEditing(page: Page, userId: string, email: string) {
    const { data } = await serviceClient().from("profiles").select("display_name").eq("user_id", userId).single();
    const row = page.locator("tr").filter({ hasText: email });
    await row.waitFor({ timeout: 15000 });
    await row.getByRole("button", { name: "ערוך" }).click();
    return data!.display_name as string;
  }

  test("changes a user's email; they sign in with the new one", async ({ page }) => {
    test.setTimeout(60000);
    const { target } = await openUsersWithTwoAccounts(page);
    await startEditing(page, target.userId, target.email);

    const newEmail = `changed-${randomUUID()}@example.test`;
    await editingRow(page).getByLabel("אימייל").fill(newEmail);
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    await expect(page.locator("tr").filter({ hasText: newEmail })).toBeVisible();
    // The new address really logs in, with the same password.
    await expect(signInTestUser(newEmail, target.password)).resolves.toBeDefined();
  });

  test("a phone change saves while the email list is unavailable", async ({ page }) => {
    test.setTimeout(60000);
    const { target } = await openUsersWithTwoAccounts(page);
    const { data: profile } = await serviceClient()
      .from("profiles")
      .select("display_name")
      .eq("user_id", target.userId)
      .single();
    // The emails call fails from here on; reload so the page starts without it.
    await page.route("**/trpc/auth.listUserEmails*", (route) => route.abort());
    await page.reload();
    const row = page.locator("tr").filter({ hasText: profile!.display_name });
    await row.waitFor({ timeout: 15000 });
    await row.getByRole("button", { name: "ערוך" }).click();

    // The box is locked, not empty-and-invalid.
    await expect(editingRow(page).getByLabel("אימייל")).toBeDisabled();
    await editingRow(page).getByLabel("טלפון").fill("0501234567");
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    await expect(page.getByText("הנתונים נשמרו.")).toBeVisible();
    const { data } = await serviceClient().from("profiles").select("phone_number").eq("user_id", target.userId).single();
    expect(data?.phone_number).toBe("0501234567");
  });

  test("the email changes but a later write fails: the message says so and the screen re-reads", async ({ page }) => {
    test.setTimeout(60000);
    const { target } = await openUsersWithTwoAccounts(page);
    const originalName = await startEditing(page, target.userId, target.email);

    // The email change goes first and succeeds; save_user then fails.
    await page.route("**/rpc/save_user*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "forced failure", code: "XX000" }),
      }),
    );
    const newEmail = `partial-${randomUUID()}@example.test`;
    await editingRow(page).getByLabel("שם תצוגה").fill(`${originalName} (changed)`);
    await editingRow(page).getByLabel("אימייל").fill(newEmail);
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    await expect(page.getByText(/^האימייל עודכן, אבל שאר השינויים לא נשמרו:/)).toBeVisible();
    await page.unroute("**/rpc/save_user*");

    // The login email really changed; the name did not.
    const service = serviceClient();
    const { data: authUser } = await service.auth.admin.getUserById(target.userId);
    expect(authUser.user?.email).toBe(newEmail);
    const { data } = await service.from("profiles").select("display_name").eq("user_id", target.userId).single();
    expect(data?.display_name).toBe(originalName);
    // The row stays in edit mode (its box holds what was typed, which is not
    // evidence), so leave it and read the plain cell: the list was re-read,
    // so the email column shows the new address.
    await editingRow(page).getByRole("button", { name: "ביטול" }).click();
    await expect(page.locator("tr").filter({ hasText: newEmail })).toBeVisible();
  });

  test("an address another user has is refused and nothing else is saved", async ({ page }) => {
    test.setTimeout(60000);
    const { target, other } = await openUsersWithTwoAccounts(page);
    const originalName = await startEditing(page, target.userId, target.email);

    await editingRow(page).getByLabel("שם תצוגה").fill(`${originalName} (changed)`);
    await editingRow(page).getByLabel("אימייל").fill(other.email);
    await editingRow(page).getByRole("button", { name: "שמור" }).click();

    await expect(page.getByText("כתובת האימייל כבר רשומה למשתמש אחר.")).toBeVisible();
    // Still in edit mode, so the office can correct it.
    await expect(editingRow(page).getByLabel("אימייל")).toBeVisible();
    const { data } = await serviceClient().from("profiles").select("display_name").eq("user_id", target.userId).single();
    expect(data?.display_name).toBe(originalName);
  });
});
