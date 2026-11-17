# בשם לקוח reminder as a yes/no question — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reminder bell on בשם לקוח asks the same yes/no question as the סידור board and sends with no list of people.

**Architecture:** One shared yes/no box, `OrderReminderConfirmDialog`, replaces the board's inline dialog and בשם לקוח's choose-people window. Both screens call `useSendOrderReminder().mutate({ dailyOrderId })` with no list, so the database's existing rule picks the recipients (the customer's WhatsApp group, otherwise each person with a usable phone). Everything only the old window used is then deleted. No database change.

**Tech Stack:** React 19 + TanStack Query 5 (`apps/web`), Vitest with `renderToStaticMarkup`, the real Playwright e2e specs run locally through the PGlite harness.

**Spec:** `docs/superpowers/specs/2026-11-17-customer-reminder-confirm-design.md`

## Global Constraints

- Website only: no migration and no change under `packages/db`, `packages/domain` or `supabase/functions`.
- Exact copy: title `שליחת תזכורת`; question `` `לשלוח ל${customerName} תזכורת לשלוח הזמנה?` ``; buttons `ביטול` (`variant="secondary"`) and `שלח`; the toasts stay the hook's `התזכורת נשלחה.` and `` `שליחת התזכורת נכשלה: ${errorMessage(error)}` ``.
- A reminder request from the web app never carries `p_recipient_user_ids`.
- The board's bell behaves exactly as it does at 0141839.
- Hebrew, right to left; the box usable at 375 px wide.
- Tests run only against the local harness (`$H`), never a hosted Supabase project; never source `.env`.
- Edit existing files with the Edit tool (it keeps their CRLF endings); new files may be LF.
- Comments say what is true after the change: a comment naming the people list, `openWindow` or `closeWindow` is rewritten or removed.
- `git status` before every commit; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no push, no merge.

**Paths, ports and the two harness commands used below:**

```bash
WT="D:/Downloads/Downloads/Ori main/.claude/worktrees/fix+customer-reminder-confirm"   # branch fix/customer-reminder-confirm, exists (c2502d0)
SRC_H="C:/Users/JAMES DANIEL/AppData/Local/Temp/claude/94616838bbf90b1a/056aa1b0-533a-4c0b-bd63-3d005991b9c7/scratchpad/harness"   # source copy — never edit
H="C:/Users/JAMES DANIEL/AppData/Local/Temp/claude/94616838bbf90b1a/a3153be2-ddbd-493c-bd1b-49f14ea17122/scratchpad/harness"
# Build a site (cwd MUST be apps/web, or Tailwind scans the wrong tree):
cd "$WT/apps/web" && ORI_WEB="$WT/apps/web" SUPABASE_PORT=59521 API_PORT=59599 node "$H/build-plain.mjs" "$H/../dist-<label>"
# Run one real spec against it:
cd "$H" && ORI_REPO="$WT" SPEC="$WT/apps/web/e2e/<name>.spec.ts" DIST_DIR="$H/../dist-<label>" WORLD_TAR=world-bare.tar \
  SUPABASE_PORT=59521 API_PORT=59599 APP_PORT=4773 node e2e-local.mjs 2>&1 | cut -c1-300 | grep "^§"
```

A spec run prints `§ PASS <spec> › <test>` or `§ FAIL …` (with the failing assertion) per test, ends with `§ <name>.spec.ts: N/M passed`, and exits 0 only when every test passed. `world-bare.tar` holds every migration through 0107 (no seed), the same start CI gives the suite.

## Review Focus

1. A double click on `שלח` sends exactly one reminder. Closing dialogs ignore clicks (`globals.css`: `dialog[open][data-closing] { pointer-events: none }`), but the box replays its last content while it fades out, so a click that got through would call `onConfirm` again. Pinned in Task 2, second test.
2. Escape (or the backdrop) closes the box and sends nothing. Pinned in Task 2, first test.
3. A send that fails after the box has closed: the bell stays off until the answer, the failure is a toast, then the bell is back. Pinned in Task 2, third test.
4. At 375 px the question and both buttons are on screen and the page does not scroll sideways. Pinned in Task 2, first test.
5. The board's bell is unchanged: its two reminder tests in `arrangement.spec.ts` pass untouched (Tasks 1 and 3).

---

### Task 1: The shared yes/no box, used by the board

**Files:**
- Create: `apps/web/src/components/reference-data/order-reminder-confirm-dialog.tsx`
- Create: `apps/web/src/components/reference-data/order-reminder-confirm-dialog.test.tsx`
- Modify: `apps/web/src/routes/backoffice/arrangement.tsx` (the inline dialog at 711-737; the `Button` and `Dialog` imports at 39 and 41)

**Interfaces:**
- Produces: `OrderReminderConfirmDialog({ target, onClose, onConfirm }: { target: { dailyOrderId: string; customerName: string } | null; onClose: () => void; onConfirm: (dailyOrderId: string) => void })`. Open while `target` is not null. `ביטול`, Escape and the backdrop call `onClose`. `שלח` calls `onConfirm(target.dailyOrderId)` and then `onClose()`.

- [ ] **Step 1: Setup.** In `$WT`: `pnpm install --frozen-lockfile --offline --store-dir D:/.pnpm-store --package-import-method copy` (if it reports a missing package, run it again without `--offline`). Copy the harness: `mkdir -p "$H" && (cd "$SRC_H" && tar --force-local -cf - --exclude=./out --exclude='*.tar' .) | (cd "$H" && tar --force-local -xf -) && cp "$SRC_H/world-bare.tar" "$H/"`. Ports free: `netstat -ano | grep -E ':(59521|59599|4773)\s'` prints nothing. Baseline: `pnpm --filter @ori/web test`. Expected: every command exits 0; `git status` clean.

- [ ] **Step 2: Write the failing test** `order-reminder-confirm-dialog.test.tsx`, server-rendered like the old `order-reminder-dialog.test.tsx`, with `@/components/ui/dialog` mocked as `({ open, title, children }) => <section data-open={String(open)}><h2>{title}</h2>{children}</section>` and `render(target)` = `renderToStaticMarkup(<OrderReminderConfirmDialog target={target} onClose={() => undefined} onConfirm={() => undefined} />)`:

```tsx
describe("OrderReminderConfirmDialog", () => {
  it("asks whether to remind the customer, with ביטול and שלח and no list of people", () => {
    const html = render({ dailyOrderId: "o1", customerName: "מאפיית כהן" });
    expect(html).toContain('data-open="true"');
    expect(html).toContain("<h2>שליחת תזכורת</h2>");
    expect(html).toContain("לשלוח למאפיית כהן תזכורת לשלוח הזמנה?");
    expect(html).toMatch(/<button[^>]*>ביטול<\/button>/);
    expect(html).toMatch(/<button[^>]*>שלח<\/button>/);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("מקבלי ההודעה:");
  });

  it("is closed when there is no target", () => {
    expect(render(null)).toContain('data-open="false"');
  });
});
```

- [ ] **Step 3: Run** `cd "$WT" && pnpm --filter @ori/web exec vitest run src/components/reference-data/order-reminder-confirm-dialog.test.tsx`. Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement `OrderReminderConfirmDialog`** by moving the board's markup (`arrangement.tsx:711-737`: `Dialog`, the `<p className="mb-4 text-sm">` question, the `flex justify-end gap-2` row of two `Button`s) into the new file behind the props above. Header comment: it asks first because a reminder is a real WhatsApp message that cannot be taken back; it lists nobody, because Bubble's board does not and James chose the same for בשם לקוח (2026-11-17) — the server sends to the customer's WhatsApp group, otherwise to each person with a usable phone.

- [ ] **Step 5: Run** Step 3's command. Expected: PASS, 2/2.

- [ ] **Step 6: The board uses it.** In `arrangement.tsx` replace the comment and the `<Dialog …>…</Dialog>` block with `<OrderReminderConfirmDialog target={reminderTarget} onClose={() => setReminderTarget(null)} onConfirm={(dailyOrderId) => reminderMutation.mutate({ dailyOrderId })} />`, with a one-line comment that the bell's spinner shows the send and the result arrives as a toast. Remove the `Button` and `Dialog` imports (nothing else in the file uses them).

- [ ] **Step 7: Verify.** `cd "$WT" && pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint` exit 0. Build `dist-t1`; run `arrangement.spec.ts` against it. Expected: `§ arrangement.spec.ts: 7/7 passed`, including the unchanged `a customer card's bell asks first, then sends the reminder to the group or everyone` and `a refusal after confirming shows as a toast`.

- [ ] **Step 8: Commit** `feat(web): one shared yes/no box for the order reminder; the board uses it`.

### Task 2: בשם לקוח asks yes/no and sends with no list

**Files:**
- Modify: `apps/web/e2e/distributor-customer.spec.ts` (the reminder block at 148-321; the `moveTestProfileToCompany` import at 8)
- Modify: `apps/web/src/routes/backoffice/distributor-customer.tsx` (imports at 10 and 18, the state and its comment at 132-141, `onRemind` at 187-195, the window at 305-322)

**Interfaces:**
- Consumes: `OrderReminderConfirmDialog` (Task 1). `useSendOrderReminder({ ordersForDayQueryKey })` — `mutate({ dailyOrderId })`, `isPending`, `variables` — unchanged in this task.

- [ ] **Step 1: Rewrite the reminder tests.** `reminderWorld(page)` keeps its setup with only the person who has a phone (`אבי עם טלפון`, `0501234567`), no longer clicks the bell, and returns `{ adminClient, bell, customerCompany, dayId }`, where `bell = page.getByRole("button", { name: \`שלח תזכורת ל${customerCompany.name}\` })` has been checked `toBeEnabled()`. Add `reminderRequests(page): string[]`, the bodies of every `/rpc/send_order_reminder` request (as in `arrangement.spec.ts:554-559`). Keep `reminderRows`. Delete the tests `the reminder window can untick everyone, and then cannot send` and `a person moved to another company meanwhile is refused and the window stays open`, and the `moveTestProfileToCompany` import. The three tests:

```ts
test("the bell asks first; ביטול and Escape send nothing; at phone width it fits", async ({ page }) => {
  const { bell, customerCompany } = await reminderWorld(page);
  const bodies = reminderRequests(page);
  const dialog = page.locator("dialog[open]");

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

  await page.setViewportSize({ width: 375, height: 800 });
  await bell.click();
  await expect(dialog.getByRole("button", { name: "שלח", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "ביטול", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await dialog.getByRole("button", { name: "ביטול", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });

  expect(bodies).toHaveLength(0);
});

test("שלח sends one reminder with no list, even on a double click, and stamps reminder_sent_at", async ({ page }) => {
  const { adminClient, bell, customerCompany, dayId } = await reminderWorld(page);
  const bodies = reminderRequests(page);

  await bell.click();
  await page.locator("dialog[open]").getByRole("button", { name: "שלח", exact: true }).dblclick();
  await expect(page.getByText("התזכורת נשלחה.")).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);

  expect(bodies).toHaveLength(1);
  const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
  expect(body).toHaveProperty("p_daily_order_id");
  expect(body).not.toHaveProperty("p_recipient_user_ids");

  const order = await adminClient.from("daily_orders").select("reminder_sent_at")
    .eq("trading_day_id", dayId).eq("customer_company_id", customerCompany.id).single();
  expect(order.data!.reminder_sent_at).not.toBeNull();
  const rows = await reminderRows(adminClient, customerCompany.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.recipient_user_ids).toBeNull();
});

test("a send in flight keeps the bell off, and a later refusal is a toast", async ({ page }) => {
  const { bell } = await reminderWorld(page);
  // Before the click: today's page.route hold on **/rest/v1/rpc/send_order_reminder, counting `sends`
  // and answering 400 {code "P0007", message "INVALID_STATE: cannot send a reminder about an order
  // that's already been submitted"} once `releaseSend()` is called — kept as it is.
  await bell.click();
  await page.locator("dialog[open]").getByRole("button", { name: "שלח", exact: true }).click();
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
```

- [ ] **Step 2: Run them against today's בשם לקוח.** Build `dist-t2-red` (Task 1's code); run `distributor-customer.spec.ts`. Expected: `§ distributor-customer.spec.ts: 3/6 passed` — the three new tests FAIL: the first at `לשלוח ל… תזכורת לשלוח הזמנה?` (the window's title is `שליחת תזכורת — <name>`), the second at `not.toHaveProperty("p_recipient_user_ids")`, the third at `dialog[open]` count 0 (the window stays open while sending).

- [ ] **Step 3: Implement in `distributor-customer.tsx`.** Import `OrderReminderConfirmDialog` in place of `OrderReminderDialog`. `reminderTarget` becomes `{ dailyOrderId: string; customerName: string } | null`. `onRemind`: `if (!order) return;` then `setReminderTarget({ dailyOrderId: order.id, customerName: customer.name })` (no `openWindow()`). Replace `<OrderReminderDialog …/>` with `<OrderReminderConfirmDialog target={reminderTarget} onClose={() => setReminderTarget(null)} onConfirm={(dailyOrderId) => reminderMutation.mutate({ dailyOrderId })} />`. Remove the `errorMessage` import (its only use was the window's `error`). Rewrite the comment above the state: the bell asks "send a reminder to <customer>?" and `שלח` sends with no list, so the server sends to the customer's WhatsApp group, otherwise to each person with a usable phone — like the סידור board (James, 2026-11-17); `variables` tells each row's bell whether it is the one sending; the optimistic `reminder_sent_at` patch and the toasts live in the hook. If the second test sends twice, guard inside `OrderReminderConfirmDialog` with a `useRef` set on the first `שלח` and cleared when a new target opens (a check on `target` alone does not help: the fading box replays the last open render's handlers).

- [ ] **Step 4: Run.** Build `dist-t2`; run `distributor-customer.spec.ts`, then `arrangement.spec.ts`. Expected: `§ distributor-customer.spec.ts: 6/6 passed` and `§ arrangement.spec.ts: 7/7 passed`. Then `pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint` exit 0.

- [ ] **Step 5: Commit** `feat(web): the בשם לקוח bell asks yes/no and reminds like the board`.

### Task 3: Remove what only the list window used

**Files:**
- Delete: `apps/web/src/components/reference-data/order-reminder-dialog.tsx`, `apps/web/src/components/reference-data/order-reminder-dialog.test.tsx`, `apps/web/src/lib/order-reminder.ts`, `apps/web/src/lib/order-reminder.test.ts`
- Modify: `apps/web/src/lib/queries/oversight.ts:249-268` (`customerPeople` and its comment)
- Modify: `apps/web/src/lib/use-send-order-reminder.ts`
- Modify: `apps/web/src/routes/backoffice/arrangement.tsx:96-101` (the comment that names `openWindow`/`closeWindow`)

**Interfaces:**
- Produces: `useSendOrderReminder(options?: { ordersForDayQueryKey?: QueryKey })` returns TanStack's mutation result typed `<void, { message?: string }, { dailyOrderId: string }, { previous: DailyOrderForDay[] | undefined }>` — no `openWindow`, no `closeWindow`, no `recipientUserIds`.

- [ ] **Step 1: Run the check that must end empty:** `grep -rn -E 'order-reminder-dialog|lib/order-reminder"|customerPeople|openWindow|closeWindow|recipientUserIds|failureNeedsToast|shouldResetOnClose' "$WT/apps/web/src"`. Expected now: matches in the hook, `oversight.ts`, `order-reminder.ts`, its test, the old window and its test.

- [ ] **Step 2: Remove.** Delete the four files and `customerPeople`. In the hook: drop `useRef`, the `@/lib/order-reminder` import, `windowOpen`, `openWindow` and `closeWindow`; the variables become `{ dailyOrderId: string }` and `mutationFn` parses `{ dailyOrderId }`; `onError` is the rollback followed by the failure toast every time; return the mutation itself. Rewrite the hook's header comment to what it does now: it sends a customer's order reminder with no list, so the server's rule decides (the customer's group, otherwise each person with a usable phone); both callers ask first with `OrderReminderConfirmDialog`; the optimistic `reminder_sent_at` patch applies when a key is given; a failure is always a toast. In `arrangement.tsx`'s comment, the sentence about the `openWindow`/`closeWindow` pair becomes "A failure shows as a toast."

- [ ] **Step 3: Verify.** Step 1's grep prints nothing. In `$WT`: `pnpm typecheck --force`, `pnpm lint --force`, `pnpm --filter @ori/web test`, `pnpm --filter @ori/web build` — each exits 0.

- [ ] **Step 4: The whole e2e suite** on a fresh build `dist-final`: `cd "$H" && ORI_REPO="$WT" SUPABASE_PORT=59521 API_PORT=59599 APP_PORT=4773 WORLD_TAR=world-bare.tar bash run-all-e2e.sh "$H/../dist-final" final`, then `cat "$H/out/e2e-final/status.txt"`. Expected: one `<name> exit=0` line for every file in `$WT/apps/web/e2e/*.spec.ts`, then `ALL DONE`. If a spec fails, read its `§ FAIL` lines in `$H/out/e2e-final/<name>.log` and run that spec once more on its own before drawing any conclusion.

- [ ] **Step 5: Commit** `refactor(web): remove the choose-people reminder window and what only it used`.
