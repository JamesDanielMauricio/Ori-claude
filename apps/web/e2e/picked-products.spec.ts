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
  openShopInputSchema,
  toInitiateBusinessDayRpcArgs,
  toOpenShopRpcArgs,
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
import { expect, test } from "@playwright/test";

// מוצרים שנקטפו: the "משטחים במלאי" number is a button (the quick stock
// popup of סידור לפי מוצרים) for a product exactly one grower supplies that
// day, and a plain number for a product two growers supply.
test.describe("Backoffice — picked products stock popup", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  test("a product one grower supplies can have its stock changed here; a product two growers supply cannot", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    const admin = await createTestProfile({ companyId: adminCompany.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const adminClient = await signInTestUser(admin.email, admin.password);

    // `solo` is the only grower of its product; `shared` is grown by `first`
    // and ALSO by `second`, so two pick lines supply it.
    const solo = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(solo));
    const first = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(first));
    const second = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(second));
    // Before the day opens, so initiate_business_day gives `second` a pick line
    // for first's product too.
    const share = await adminClient
      .from("grower_products")
      .insert({ company_id: second.companyId, product_variety_id: first.varietyId });
    if (share.error) throw share.error;

    const initiate = await adminClient.rpc(
      "initiate_business_day",
      toInitiateBusinessDayRpcArgs(
        initiateBusinessDayInputSchema.parse({ tradeDate: new Date().toISOString().slice(0, 10) }),
      ),
    );
    if (initiate.error) throw initiate.error;
    const dayId = initiate.data!.id;
    cleanupFns.push(() => deleteTestTradingDay(dayId));
    const openShop = await adminClient.rpc(
      "open_shop",
      toOpenShopRpcArgs(openShopInputSchema.parse({ canSeePrices: true })),
    );
    if (openShop.error) throw openShop.error;

    async function pick(growerCompanyId: string, varietyId: string, pallets: number) {
      const dailyPick = await getDailyPickForGrower(dayId, growerCompanyId);
      const line = await getPickProductLine(dailyPick!.id, varietyId);
      const update = await adminClient.rpc(
        "update_pick_product_pallets",
        toUpdatePickProductPalletsRpcArgs(
          updatePickProductPalletsInputSchema.parse({
            dailyPickProductId: line!.id,
            palletsPicked: pallets,
          }),
        ),
      );
      if (update.error) throw update.error;
      return line!;
    }
    const soloLine = await pick(solo.companyId, solo.varietyId, 10);
    await pick(first.companyId, first.varietyId, 4);
    await pick(second.companyId, first.varietyId, 6);

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);
    await page.goto("/backoffice/picked-products");

    // The table opens with every family collapsed; searching by the variety
    // name opens the match.
    const search = page.getByPlaceholder("חיפוש מוצר, זן או משפחה");
    await search.fill(solo.varietyName);
    const soloRow = page.locator("tr").filter({ hasText: solo.varietyName });
    const soloButton = soloRow.getByRole("button", { name: `עדכון מלאי — ${solo.varietyName}` });
    await expect(soloButton).toHaveText("10");

    await soloButton.click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toContainText(solo.companyName);
    await dialog.getByLabel("משטחים מהיום:").fill("12");
    await dialog.getByRole("button", { name: "אישור" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    // The screen re-reads: the number is the new one.
    await expect(soloButton).toHaveText("12");
    const saved = await adminClient
      .from("daily_pick_products")
      .select("pallets_picked")
      .eq("id", soloLine.id)
      .single();
    expect(Number(saved.data!.pallets_picked)).toBe(12);

    // Two growers supply this one: the sum (4 + 6) shows, but as plain text.
    await search.fill(first.varietyName);
    const sharedRow = page.locator("tr").filter({ hasText: first.varietyName });
    await expect(sharedRow).toContainText("10");
    await expect(sharedRow.getByRole("button", { name: /^עדכון מלאי/ })).toHaveCount(0);
  });
});
