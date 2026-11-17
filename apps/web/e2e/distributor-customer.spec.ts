import { expect, test } from "@playwright/test";

import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import {
  createTestGrowerWithProduct,
  deleteTestGrowerWithProduct,
  deleteTestTradingDay,
} from "@ori/domain/lifecycle-engine/testing";

// Drives the distributor's Customer Order Status oversight screen end to
// end: a flat, always-visible list of every active customer (see
// distributor-customer.tsx's own comment for why this replaced a master-
// detail pane — same rationale as distributor-grower.spec.ts, mirrored onto
// orders), a chevron per row revealing that customer's order grouped by
// family, a pencil opening the exact same OrderLinesEditor the customer's
// own order screen uses in a dialog, and a bell resending the order
// reminder. Also carries the performance requirement Prompt 10 couldn't
// verify because this screen didn't exist yet (Performance Issues spec,
// Issue 3, tab=distributor+customer): reopening a customer's dialog after
// already viewing them this session must not fire a fresh catalog query —
// see the last test below, mirroring performance-verification.spec.ts's
// network-counting technique.
test.describe("Backoffice — Customer Order Status", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  test("a distributor expands a customer's row, edits their order via the pencil dialog, and sends a reminder", async ({
    page,
  }) => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));

    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    const admin = await createTestProfile({ companyId: adminCompany.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const adminClient = await signInTestUser(admin.email, admin.password);

    // The customer company must exist before open_shop runs — its
    // bootstrap only creates a daily_orders row for customers that
    // already exist at that moment (same ordering requirement
    // performance-verification.spec.ts's Issue 4 test already established).
    const customerCompany = await createTestCompany(
      `לקוח בדיקה ${crypto.randomUUID()}`,
      "customer",
    );
    cleanupFns.push(() => deleteTestCompany(customerCompany.id));

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await adminClient.rpc("initiate_business_day", { p_trade_date: tradeDate });
    if (initiate.error) throw initiate.error;
    const dayId = initiate.data!.id;
    cleanupFns.push(() => deleteTestTradingDay(dayId));
    const openShop = await adminClient.rpc("open_shop", { p_can_see_prices: true });
    if (openShop.error) throw openShop.error;

    const pickRow = await adminClient
      .from("daily_picks")
      .select("id")
      .eq("trading_day_id", dayId)
      .eq("grower_company_id", grower.companyId)
      .single();
    await adminClient
      .from("daily_pick_products")
      .update({ pallets_picked: 10 })
      .eq("daily_pick_id", pickRow.data!.id)
      .eq("product_variety_id", grower.varietyId);

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    await page.goto("/backoffice/distributor-customer");

    // Expanding shows the (still-empty) order grouped by family before any
    // editing happens — the read-only browse view, distinct from editing.
    // `exact`, not a regex: the row's pencil and bell are labelled "ערוך את
    // הזמנת <name>" and "שלח תזכורת ל<name>", so a substring match on the
    // company name resolves to all three controls. Only the row toggle is
    // named by the company alone.
    const expandButton = page.getByRole("button", { name: customerCompany.name, exact: true });
    await expandButton.click();
    // Scoped to this customer's own row: every seeded customer without an
    // order renders the same sentence, so on a populated day the unscoped
    // text matches a dozen of them.
    const customerRow = page.locator("li").filter({ hasText: customerCompany.name });
    await expect(customerRow.getByText("אין עדיין הזמנה עבור לקוח זה.")).toBeVisible();

    // The pencil, not the row itself, is what opens the editor now.
    const editButton = page.getByRole("button", { name: `ערוך את הזמנת ${customerCompany.name}` });
    await editButton.click();
    await expect(page.locator("dialog[open]")).toContainText(`הזמנה — ${customerCompany.name}`);

    // No "ערוך" gate inside the popup: the pencil already said "I want to
    // change this order", so the catalogue is live and "שמור" stays pinned
    // rather than sitting under the whole list, same as the arrangement
    // board's identical dialog.
    await expect(page.getByRole("button", { name: "ערוך", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "שמור" })).toBeVisible();
    // Rows render collapsed inside the dialog too; expand THIS fixture's
    // family before it has a pallets input to fill. The dialog hosts the same
    // full catalogue the customer's own screen does — every seeded family
    // included — so "the collapsed row in the dialog" matches dozens.
    const dialog = page.locator("dialog[open]");
    const dialogFamily = dialog.locator("li").filter({ hasText: grower.familyName });
    await dialogFamily.locator("button[aria-expanded]").first().click();
    await expect(dialogFamily.locator('input[type="number"]')).toBeEnabled();
    await dialogFamily.locator('input[type="number"]').fill("4");
    await page.getByRole("button", { name: "שמור" }).click();
    await expect(page.getByText("אישור הזמנה")).toBeVisible();
    await page.getByRole("button", { name: "שלח הזמנה" }).click();
    await expect(page.getByText("ההזמנה נשלחה.")).toBeVisible();
    // No explicit close here: a successful submit closes this dialog itself
    // (distributor-customer.tsx's onSubmitted clears the selected customer),
    // so waiting to click "סגור" waits for a button that is already gone.
    // The two closes later in this file are different — nothing was
    // submitted there, so the dialog stays up until it is dismissed.
    await expect(dialog).toHaveCount(0);

    // The order is now submitted — a reminder no longer makes sense, so
    // the bell is disabled instead of a second write path being exposed.
    const remindButton = page.getByRole("button", { name: `שלח תזכורת ל${customerCompany.name}` });
    await expect(remindButton).toBeDisabled();

    await page.reload();
    await page.getByRole("button", { name: `ערוך את הזמנת ${customerCompany.name}` }).click();
    // Read back off this fixture's own row, not "the number input in the
    // dialog": the dialog carries the whole catalogue, so that is one input
    // per variety in it.
    await expect(
      page.locator("dialog[open] li").filter({ hasText: grower.familyName }).locator('input[type="number"]'),
    ).toHaveValue("4");
  });

  // One backoffice user, one customer with one person who has a phone, and an
  // open shop, signed in on the screen, with that customer's bell ready to
  // press. Shared by the three reminder tests below.
  async function reminderWorld(page: import("@playwright/test").Page) {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));

    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    const admin = await createTestProfile({ companyId: adminCompany.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const adminClient = await signInTestUser(admin.email, admin.password);

    const customerCompany = await createTestCompany(
      `לקוח בדיקה ${crypto.randomUUID()}`,
      "customer",
    );
    cleanupFns.push(() => deleteTestCompany(customerCompany.id));
    const withPhone = await createTestProfile({
      companyId: customerCompany.id,
      role: "customer",
      displayName: "אבי עם טלפון",
      phoneNumber: "0501234567",
    });
    cleanupFns.push(() => deleteTestUser(withPhone.userId));

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await adminClient.rpc("initiate_business_day", { p_trade_date: tradeDate });
    if (initiate.error) throw initiate.error;
    const dayId = initiate.data!.id;
    cleanupFns.push(() => deleteTestTradingDay(dayId));
    const openShop = await adminClient.rpc("open_shop", { p_can_see_prices: true });
    if (openShop.error) throw openShop.error;

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    await page.goto("/backoffice/distributor-customer");
    const bell = page.getByRole("button", { name: `שלח תזכורת ל${customerCompany.name}` });
    await expect(bell).toBeEnabled();
    return { adminClient, bell, customerCompany, dayId };
  }

  // Every reminder request the page makes from here on, to prove that
  // cancelling sends none and to read the body of the one that is sent.
  function reminderRequests(page: import("@playwright/test").Page): string[] {
    const bodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/rpc/send_order_reminder")) {
        bodies.push(request.postData() ?? "");
      }
    });
    return bodies;
  }

  async function reminderRows(
    adminClient: Awaited<ReturnType<typeof signInTestUser>>,
    customerId: string,
  ) {
    // Scoped to reminder rows — open_shop's own bootstrap separately enqueues
    // a shop_open row to the same customer.
    const outbox = await adminClient
      .from("notification_outbox")
      .select("template_key, recipient_company_id, recipient_user_ids")
      .eq("recipient_company_id", customerId)
      .eq("template_key", "order_reminder");
    if (outbox.error) throw outbox.error;
    return outbox.data;
  }

  test("the bell asks first; ביטול and Escape send nothing; at phone width it fits", async ({
    page,
  }) => {
    const { bell, customerCompany } = await reminderWorld(page);
    const bodies = reminderRequests(page);
    const dialog = page.locator("dialog[open]");

    // The same yes/no question as the סידור board: nobody to choose.
    await bell.click();
    await expect(dialog).toContainText("שליחת תזכורת");
    await expect(dialog).toContainText(`לשלוח ל${customerCompany.name} תזכורת לשלוח הזמנה?`);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog).not.toContainText("מקבלי ההודעה:");
    await dialog.getByRole("button", { name: "ביטול", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await bell.click();
    await expect(dialog).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // On a phone both buttons are on screen and nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await bell.click();
    await expect(dialog.getByRole("button", { name: "שלח", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "ביטול", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await dialog.getByRole("button", { name: "ביטול", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });

    expect(bodies).toHaveLength(0);
  });

  test("שלח sends one reminder with no list, even on a double click, and stamps reminder_sent_at", async ({
    page,
  }) => {
    const { adminClient, bell, customerCompany, dayId } = await reminderWorld(page);
    const bodies = reminderRequests(page);

    await bell.click();
    await page.locator("dialog[open]").getByRole("button", { name: "שלח", exact: true }).dblclick();
    await expect(page.getByText("התזכורת נשלחה.")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    // No list of people goes with it, so the server picks the recipients:
    // the customer's WhatsApp group, otherwise each person with a phone.
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body).toHaveProperty("p_daily_order_id");
    expect(body).not.toHaveProperty("p_recipient_user_ids");

    const order = await adminClient
      .from("daily_orders")
      .select("reminder_sent_at")
      .eq("trading_day_id", dayId)
      .eq("customer_company_id", customerCompany.id)
      .single();
    expect(order.data!.reminder_sent_at).not.toBeNull();

    const rows = await reminderRows(adminClient, customerCompany.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient_user_ids).toBeNull();
  });

  test("a quick double Enter on שלח sends one reminder", async ({ page }) => {
    const { bell } = await reminderWorld(page);
    const bodies = reminderRequests(page);

    // The keyboard twin of the double click: the closing box ignores the
    // mouse, but not a key, and שלח keeps the focus while the box fades out.
    await bell.click();
    await page.locator("dialog[open]").getByRole("button", { name: "שלח", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(page.getByText("התזכורת נשלחה.").first()).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    expect(bodies).toHaveLength(1);
  });

  test("a send in flight keeps the bell off, and a later refusal is a toast", async ({ page }) => {
    const { bell } = await reminderWorld(page);

    // Hold the send open so the bell can be watched while it is in flight,
    // then answer with the refusal the server gives a submitted order.
    let releaseSend: (() => void) | undefined;
    const sendHeld = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sends = 0;
    await page.route("**/rest/v1/rpc/send_order_reminder", async (route) => {
      sends += 1;
      await sendHeld;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          code: "P0007",
          message:
            "INVALID_STATE: cannot send a reminder about an order that's already been submitted",
          details: null,
          hint: null,
        }),
      });
    });

    await bell.click();
    await page.locator("dialog[open]").getByRole("button", { name: "שלח", exact: true }).click();
    // The box closes at once; the bell stays off until the answer comes.
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect.poll(() => sends).toBe(1);
    await expect(bell).toBeDisabled();

    releaseSend!();
    await expect(
      page.getByText("שליחת התזכורת נכשלה: הלקוח כבר שלח את ההזמנה, ואין צורך בתזכורת."),
    ).toBeVisible();
    await expect(bell).toBeEnabled();
    expect(sends).toBe(1);
  });

  test("filters customers by order status and counts orders sent", async ({ page }) => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));

    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    const admin = await createTestProfile({ companyId: adminCompany.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const adminClient = await signInTestUser(admin.email, admin.password);

    const sentCustomer = await createTestCompany(`לקוח בדיקה נשלח ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(sentCustomer.id));
    const openCustomer = await createTestCompany(`לקוח בדיקה פתוח ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(openCustomer.id));

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await adminClient.rpc("initiate_business_day", { p_trade_date: tradeDate });
    if (initiate.error) throw initiate.error;
    const dayId = initiate.data!.id;
    cleanupFns.push(() => deleteTestTradingDay(dayId));
    const openShop = await adminClient.rpc("open_shop", { p_can_see_prices: true });
    if (openShop.error) throw openShop.error;

    // Send one customer's order (an empty one, as the office may); the other
    // stays open. submit_order records the order for the customer named.
    const orderRow = await adminClient
      .from("daily_orders")
      .select("id")
      .eq("trading_day_id", dayId)
      .eq("customer_company_id", sentCustomer.id)
      .single();
    if (orderRow.error) throw orderRow.error;
    const markSent = await adminClient
      .from("daily_orders")
      .update({ status: "submitted", submitted_at: new Date().toISOString() })
      .eq("id", orderRow.data.id);
    if (markSent.error) throw markSent.error;

    // The counter's two numbers from the database, not hard-coded: X =
    // submitted orders, Y = orders, both of active customers only.
    const activeCustomers = await adminClient
      .from("companies")
      .select("id")
      .eq("type", "customer")
      .eq("status", "active");
    if (activeCustomers.error) throw activeCustomers.error;
    const activeIds = new Set(activeCustomers.data.map((row) => row.id));
    const orders = await adminClient
      .from("daily_orders")
      .select("customer_company_id, status")
      .eq("trading_day_id", dayId);
    if (orders.error) throw orders.error;
    const ofActive = orders.data.filter((order) => activeIds.has(order.customer_company_id));
    const expectedDone = ofActive.filter((order) => order.status === "submitted").length;
    const expectedTotal = ofActive.length;

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);
    await page.goto("/backoffice/distributor-customer");

    const sentEdit = page.getByRole("button", { name: `ערוך את הזמנת ${sentCustomer.name}` });
    const openEdit = page.getByRole("button", { name: `ערוך את הזמנת ${openCustomer.name}` });
    const statusFilter = page.getByRole("combobox", { name: "סינון לפי סטטוס" });
    const pickStatus = async (label: string) => {
      await statusFilter.click();
      await page.getByRole("option", { name: label, exact: true }).click();
    };

    await expect(page.getByText(`הזמנות הוזנו: ${expectedDone} מתוך ${expectedTotal}`)).toBeVisible();
    await expect(sentEdit).toBeVisible();
    await expect(openEdit).toBeVisible();

    // Phone width: the filter and counter stay on screen (wrapped under the
    // search box) and the page does not scroll sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(statusFilter).toBeVisible();
    await expect(page.getByText(`הזמנות הוזנו: ${expectedDone} מתוך ${expectedTotal}`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Screenshots only on request, so CI writes no files.
    if (process.env.ORI_SHOTS) await page.screenshot({ path: `${process.env.ORI_SHOTS}/customer-375.png` });
    await page.setViewportSize({ width: 1280, height: 720 });

    await pickStatus("נשלחה");
    await expect(sentEdit).toBeVisible();
    await expect(openEdit).toHaveCount(0);
    await expect(page.getByText(`הזמנות הוזנו: ${expectedDone} מתוך ${expectedTotal}`)).toBeVisible();

    await pickStatus("פתוחה");
    await expect(openEdit).toBeVisible();
    await expect(sentEdit).toHaveCount(0);

    // An impossible combination: the sent customer, filtered to open orders.
    await page.getByRole("searchbox").fill(sentCustomer.name);
    await expect(page.getByText("אין לקוחות בסטטוס הזה")).toBeVisible();
    await expect(page.getByText("נסה מונח חיפוש או סטטוס אחר.")).toBeVisible();
  });

  test("reopening a previously-viewed customer's dialog fires no new catalog query", async ({
    page,
  }) => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));

    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    const admin = await createTestProfile({ companyId: adminCompany.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const adminClient = await signInTestUser(admin.email, admin.password);

    const customerA = await createTestCompany(`לקוח בדיקה א ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customerA.id));
    const customerB = await createTestCompany(`לקוח בדיקה ב ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customerB.id));

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await adminClient.rpc("initiate_business_day", { p_trade_date: tradeDate });
    if (initiate.error) throw initiate.error;
    const dayId = initiate.data!.id;
    cleanupFns.push(() => deleteTestTradingDay(dayId));
    const openShop = await adminClient.rpc("open_shop", { p_can_see_prices: true });
    if (openShop.error) throw openShop.error;

    const pickRow = await adminClient
      .from("daily_picks")
      .select("id")
      .eq("trading_day_id", dayId)
      .eq("grower_company_id", grower.companyId)
      .single();
    await adminClient
      .from("daily_pick_products")
      .update({ pallets_picked: 10 })
      .eq("daily_pick_id", pickRow.data!.id)
      .eq("product_variety_id", grower.varietyId);

    const catalogRequestUrls: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/rest/v1/rpc/get_orderable_catalog_for_customer")) {
        catalogRequestUrls.push(url);
      }
    });

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(admin.email);
    await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "התחברות" }).click();
    await expect(page).toHaveURL(/\/backoffice\/shop$/);

    await page.goto("/backoffice/distributor-customer");

    const editA = page.getByRole("button", { name: `ערוך את הזמנת ${customerA.name}` });
    const editB = page.getByRole("button", { name: `ערוך את הזמנת ${customerB.name}` });
    const dialog = page.locator("dialog[open]");

    await editA.click();
    // "שמור" is the editor's own landmark — it appears once the catalog
    // query for this customer has resolved, which is exactly the moment
    // this test is counting requests around.
    await expect(dialog.getByRole("button", { name: "שמור" })).toBeVisible();
    const countAfterA1 = catalogRequestUrls.length;
    // Closing unmounts OrderLinesEditor (see CustomerOrdersDialog's own
    // comment on why: `customerId !== null` gates whether it renders at
    // all) — the property under test is that React Query's cache, not the
    // component instance, is what makes reopening free.
    await dialog.getByRole("button", { name: "סגור" }).click();
    await expect(dialog).toHaveCount(0);

    await editB.click();
    await expect(dialog.getByRole("button", { name: "שמור" })).toBeVisible();
    const countAfterB = catalogRequestUrls.length;
    await dialog.getByRole("button", { name: "סגור" }).click();
    await expect(dialog).toHaveCount(0);

    // Reopening A: within the QueryClient's 30s staleTime window
    // (apps/web/src/lib/providers.tsx), OrderLinesEditor must reuse the
    // cached result for A's (tradingDayId, customerCompanyId) query key —
    // the same cache reuse performance-verification.spec.ts's Issue 3/5
    // test already proved for customer history, now against the screen
    // that issue actually named, and unaffected by the dialog remounting
    // the editor on every open/close (React Query's cache lives outside
    // the component's own mount lifecycle).
    await editA.click();
    await expect(dialog.getByRole("button", { name: "שמור" })).toBeVisible();
    const countAfterA2 = catalogRequestUrls.length;

    console.log(
      `[perf] get_orderable_catalog_for_customer requests: ${countAfterA1} after A, ${countAfterB} after A+B, ${countAfterA2} after reopening A`,
    );
    expect(countAfterA1).toBe(1);
    expect(countAfterB).toBe(2);
    expect(countAfterA2, "reopening A must reuse the cached result, firing no new request").toBe(
      countAfterB,
    );
  });
});
