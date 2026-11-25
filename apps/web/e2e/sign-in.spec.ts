import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  setTestCompanyStatus,
} from "@ori/domain/auth/testing";
import { expect, test } from "@playwright/test";

test.describe("sign-in", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  test("routes a grower to their home page after a successful sign-in", async ({ page }) => {
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const { email, password, userId } = await createTestProfile({
      companyId: company.id,
      role: "grower",
    });
    cleanupFns.push(() => deleteTestUser(userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(email);
    await page.getByLabel("סיסמה", { exact: true }).fill(password);
    await page.getByRole("button", { name: "התחברות" }).click();

    // `/grower` itself immediately redirects to the default tab — see
    // the index route in apps/web/src/app-routes.tsx.
    await expect(page).toHaveURL(/\/grower\/picks$/);
  });

  test("routes a backoffice user to /backoffice after a successful sign-in", async ({ page }) => {
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const { email, password, userId } = await createTestProfile({
      companyId: company.id,
      role: "backoffice",
    });
    cleanupFns.push(() => deleteTestUser(userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(email);
    await page.getByLabel("סיסמה", { exact: true }).fill(password);
    await page.getByRole("button", { name: "התחברות" }).click();

    // `/backoffice` itself immediately redirects to the default tab — see
    // the index route in apps/web/src/app-routes.tsx.
    await expect(page).toHaveURL(/\/backoffice\/shop$/);
  });

  test("stays on the login page and shows an error for a wrong password", async ({ page }) => {
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const { email, userId } = await createTestProfile({ companyId: company.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(email);
    await page.getByLabel("סיסמה", { exact: true }).fill("definitely-wrong");
    await page.getByRole("button", { name: "התחברות" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  // The password is right, so the user is signed in for a moment and signed
  // straight back out — and signing out remounts every screen (a new account
  // scope, lib/providers.tsx). The reason used to be kept in the sign-in
  // page's own state and was lost with it: the form just went blank.
  test("tells a user whose company is inactive why they cannot sign in", async ({ page }) => {
    const company = await createTestCompany(undefined, "customer");
    cleanupFns.push(() => deleteTestCompany(company.id));
    const { email, password, userId } = await createTestProfile({
      companyId: company.id,
      role: "customer",
    });
    cleanupFns.push(() => deleteTestUser(userId));
    await setTestCompanyStatus(company.id, "inactive");

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(email);
    await page.getByLabel("סיסמה", { exact: true }).fill(password);
    await page.getByRole("button", { name: "התחברות" }).click();

    await expect(page.getByRole("alert")).toContainText("החברה שלך מסומנת כלא פעילה");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a customer visiting /backoffice directly is signed out and redirected to login", async ({
    page,
  }) => {
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const { email, password, userId } = await createTestProfile({
      companyId: company.id,
      role: "customer",
    });
    cleanupFns.push(() => deleteTestUser(userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(email);
    await page.getByLabel("סיסמה", { exact: true }).fill(password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/customer\/order$/);

    await page.goto("/backoffice");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("forces a password change on first login for an admin-provisioned user", async ({
    page,
  }) => {
    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const { email, password, userId } = await createTestProfile({
      companyId: company.id,
      role: "grower",
      mustChangePassword: true,
    });
    cleanupFns.push(() => deleteTestUser(userId));

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(email);
    await page.getByLabel("סיסמה", { exact: true }).fill(password);
    await page.getByRole("button", { name: "התחברות" }).click();

    await expect(page).toHaveURL(/\/change-password$/);

    await page.getByLabel("סיסמה חדשה").fill("a-brand-new-password-123");
    await page.getByRole("button", { name: "שמור סיסמה חדשה" }).click();

    await expect(page).toHaveURL(/\/grower\/picks$/);
  });
});
