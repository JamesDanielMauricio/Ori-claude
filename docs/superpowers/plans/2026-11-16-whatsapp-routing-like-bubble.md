# WhatsApp Routing Like Bubble Implementation Plan

Renumbered to 0107 at merge time (2026-11-17): main's 0106 is the WhatsApp-schedule migration.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every WhatsApp message except the reset link reaches the people Bubble's live app reaches — group, people, or both — per message.

**Architecture:** One migration (0106, three sections added task by task): a per-message rule list used by `resolve_outbox_dispatch`, "pick updated" re-addressed to the grower, and a private copy of "new order" to the customer who ordered. One web change: the סידור board's bell confirms and sends without a list. Proven on the local PGlite harness (database tests, outbox before/after, e2e, click-through) before anything is migrated or pushed.

**Tech Stack:** Postgres/Supabase PL/pgSQL, Drizzle schema, zod, React 19 + TanStack Query + Tailwind v4 (`apps/web`), Vitest, Playwright, the PGlite harness.

**Spec:** `docs/superpowers/specs/2026-11-16-whatsapp-routing-like-bubble-design.md` (approved by James 2026-11-16). Read it first.

## Global Constraints

- Migrations are files only; James runs them. The new file is `packages/db/migrations/0106_whatsapp-routing-like-bubble.sql`, journal entry `{"idx": 106, "version": "7", "when": 1793307600000, "tag": "0106_whatsapp-routing-like-bubble", "breakpoints": true}`. 0104 and 0105 are applied on live — never edited.
- `whatsapp-dispatch` is not redeployed: `resolve_outbox_dispatch(uuid) returns table(target text, is_group boolean, message text)` keeps signature, `security invoker`, `search_path=public`, grants.
- Old tabs keep working: `submit_order(uuid, jsonb, uuid, text)`, `save_pick_lines(uuid, jsonb)`, `update_pick_product_pallets(uuid, numeric)`, `send_order_reminder(uuid, uuid[])` keep their signatures and grants.
- Every security rule (grant, revoke, role check, security definer) has a comment above it: what it allows, what it protects against.
- Every rebuilt function is copied from its latest body (`resolve_outbox_dispatch` 0104, `save_pick_lines` and `update_pick_product_pallets` 0076, `submit_order` and `compose_outbox_message` 0102) and changed only where a task says. Everything in 0106 is safe to run twice.
- Hebrew copy verbatim: label `העתק ללקוח ששלח הזמנה`; confirm title `שליחת תזכורת`, text `לשלוח ל<customer name> תזכורת לשלוח הזמנה?`, buttons `שלח` / `ביטול`; toasts `התזכורת נשלחה.` / `שליחת התזכורת נכשלה: …`. Links: `https://ori-claude-web.vercel.app/grower/picks`, `https://ori-claude-web.vercel.app/customer/order`.
- Hebrew UI, right to left, usable at 375 px. Existing files are CRLF — change them with Edit; new files CRLF (`node -e "const f=process.argv[1],fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))" <file>`).
- Tests run only against the local harness, never the hosted project. No writes to Bubble. Nothing pushed, nothing migrated, without James.

## Review Focus

1. A grower with a group whose people include a bad number ("12") and no number: the pick reminder reaches the group and only the person with a usable phone. → Task 1, `pick_reminder reaches the group and each person with a usable phone`.
2. The customer user who ordered has no usable phone: the office message is still queued; the copy is queued and reaches nobody. → Task 3, `a copy for an orderer with no usable phone reaches nobody`.
3. Repeated saves: a grower saving six times in ten minutes queues at most five "pick updated" rows, and another grower is not held back; a customer submitting six times queues at most five copies. → Task 2 `pick_updated is capped at 5 per grower per 10 minutes`, Task 3 `copies are capped like the office message`.
4. The office submits an order on a customer's behalf: no office message and no copy. → Task 3, `the office ordering for a customer queues no copy`.
5. The customer sends the order after the office opened the board's confirm: pressing שלח shows `שליחת התזכורת נכשלה: הלקוח כבר שלח את ההזמנה, ואין צורך בתזכורת.` as a toast. → Task 4, `a refusal after confirming shows as a toast`.

## Shared setup (do once, before Task 1)

- `WT` = `d:/Downloads/Downloads/Ori main/.claude/worktrees/feat+whatsapp-routing`
- `OLD_H` = `C:/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/87779c3c-b3b9-4f03-9552-4239237c1562/scratchpad/harness` (the last batch's harness — read only)
- `H` = `<the executing session's scratchpad>/harness` (in session 056aa1b0: `C:/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/056aa1b0-533a-4c0b-bd63-3d005991b9c7/scratchpad/harness`)
- Ports are always `SUPABASE_PORT=59421 API_PORT=59499 APP_PORT=4673`, passed explicitly. Each harness script's first lines say how to call it.

- [ ] **S1: Worktree.** Use superpowers:using-git-worktrees (native EnterWorktree, name `feat+whatsapp-routing`) from `main` at e19d036; `pnpm install --frozen-lockfile` in `$WT`. Expected: install exits 0, `git status` clean.
- [ ] **S2: Docs onto the branch.** Move this plan and the spec from the main tree into `$WT/docs/superpowers/{plans,specs}/`, commit `docs: design and plan for WhatsApp routing like Bubble`; the main tree's `git status` is clean afterwards.
- [ ] **S3: Harness copy.** Copy `$OLD_H` to `$H` without `out/` and `dist*`. In the copy only, replace the old worktree path `d:/Downloads/Downloads/Ori main/.claude/worktrees/feat+bubble-feature-gaps` (any drive-letter case) with `$WT` in every `*.mjs` and `*.sh`. `cd "$H" && node bare-world.mjs` writes `world-bare.tar` (through 0105); copy it to `world-bare-0105.tar` (the BEFORE world). Keep `world-0105.tar`/`.json` (the seeded business through 0105). Expected: a smoke run of `vitest-local.mjs` on `packages/domain/src/notifications/notifications.test.ts` passes.
- [ ] **S4: Today's site for Task 6.** `git -C "d:/Downloads/Downloads/Ori main" archive e19d036` into `$H/../main-e19d036`, install there offline (`pnpm install --frozen-lockfile --offline`). Expected: exit 0.

---

### Task 1: 0106 §1 — each message type's rule

**Files:**
- Create: `packages/db/migrations/0106_whatsapp-routing-like-bubble.sql` (§1); Modify: `packages/db/migrations/meta/_journal.json`
- Test: Create `packages/domain/src/notifications/routing.test.ts`; Modify `packages/domain/src/notifications/message-content.test.ts:106-131`

**Interfaces:**
- Produces: `public.outbox_routing(p_template_key text) returns text` — one of `'group_and_people'`, `'people_only'`, `'group_only'`, `'group_else_people'` (`pick_reminder` → group_and_people, `shop_open` → people_only, `pick_updated` → group_only, anything else → group_else_people). `language sql immutable`; revoked from `public, anon`, granted to `authenticated, service_role`.
- Produces: `resolve_outbox_dispatch(uuid)` — a row with `recipient_user_ids` → those users only (0104, unchanged); otherwise the group target when the rule includes a group and the company has one, then each user with `whatsapp_personal_number(...) is not null` when the rule includes people (for `group_else_people`: only when there is no group), people in `order by p.user_id`.

- [ ] **Step 1: Write the failing tests** in `routing.test.ts` (helpers as in `notifications.test.ts:166-248`: `createTestCompany`, `createTestProfile`, `createTestTradingDay`, `createTestOutboxRow` — it takes `recipientUserIds`), resolving with `admin.client.rpc("resolve_outbox_dispatch", { p_outbox_id })`:
  - `pick_reminder reaches the group and each person with a usable phone` — grower with group `grp-…`, users with phones `"050-123 4567"`, `"12"`, none → data equals `[{target: grp, is_group: true, …}, {target: "972501234567", is_group: false, …}]`, in that order.
  - `pick_reminder without a group reaches each person` → `[{target: "972501234567", is_group: false}]`.
  - `shop_open never reaches the group` — customer with group and one phoned user → only that person.
  - `pick_updated reaches only the group` — grower with group and a phoned user → `[{target: grp, is_group: true}]`; grower without group, phoned user → `[]`.
  - `other messages keep group-else-people` — `close_arrangement_customer`: with group → group only; without → the person.
  - `a listed row reaches only the listed people even when the company has a group` — `shop_open` row with `recipientUserIds: [userA]`, customer with group, users A and B phoned → only A.
  - `outbox_routing names each type's rule` — the four mappings above plus `'order_reminder'` and `'anything_else'` → `'group_else_people'`.
- [ ] **Step 2: Run** `cd "$H" && WORLD_TAR=world-bare.tar SUPABASE_PORT=59421 API_PORT=59499 node vitest-local.mjs packages/domain/src/notifications/routing.test.ts`. Expected: FAIL — `outbox_routing` missing; pick_reminder returns only the group; shop_open returns the group.
- [ ] **Step 3: Write 0106 §1**: header (what 0106 does, rollout from spec §9, "safe to run again"), `outbox_routing` with a comment per rule saying what Bubble does, `resolve_outbox_dispatch` from 0104 changed as in Interfaces; journal entry. Rebuild the world (`node bare-world.mjs`).
- [ ] **Step 4: Run** Step 2's command. Expected: PASS 7/7.
- [ ] **Step 5: Move pick_updated out of the office cases** in `message-content.test.ts`: drop its `it.each` row (line 108) and the `pick_updated` greeting branch (line 125); add `pick_updated names the grower — to the grower's group only`: a grower with a group gets one group message containing `שלום. משק הבדיקה עדכן את הערכת הקטיף ליום ר 08.11.26 `; a grower without a group gets `[]`; `resolve_outbox_preview` still contains the text. Run `message-content.test.ts`, `notifications.test.ts`, `dispatch-queue.test.ts`, `customer.test.ts`. Expected: all pass.
- [ ] **Step 6: Run 0106 twice** on a fresh world (a `twice-0106.mjs` modeled on `$H/twice-0105.mjs`). Expected: no error, catalog unchanged by the second run.
- [ ] **Step 7: Commit** `feat(db): 0106 each WhatsApp message follows Bubble's routing`.

### Task 2: 0106 §2 — "pick updated" goes to the grower's own group

**Files:**
- Modify: `packages/db/migrations/0106_whatsapp-routing-like-bubble.sql` (append §2)
- Test: `packages/domain/src/lifecycle-engine/lifecycle.test.ts:887-…`, `packages/domain/src/grower/grower.test.ts`, `packages/domain/src/notifications/message-content.test.ts:276`

**Interfaces:**
- Consumes: Task 1's `group_only` rule for `pick_updated`.
- Produces: `public.enqueue_company_notification(p_trading_day_id uuid, p_recipient_type public.notification_recipient_type, p_company_id uuid, p_template_key text, p_payload jsonb, p_recipient_user_ids uuid[] default null) returns void` — `security definer`, `search_path=public`; inserts one `notification_outbox` row unless 5 rows with the same `recipient_company_id`, `template_key` and `trading_day_id` were created in the last 10 minutes; `revoke execute … from public, anon, authenticated` (only other functions call it, like `enqueue_backoffice_notification` after 0055).

- [ ] **Step 1: Write the failing tests**:
  - `lifecycle.test.ts` — rename the test at :887 to `update_pick_product_pallets queues pick_updated for the grower's own company only when the grower edits — id 3`: a grower edit leaves exactly one `pick_updated` row with `recipient_type 'grower'` and `recipient_company_id` = the grower, and none for the office; a backoffice edit leaves none.
  - `grower.test.ts` — `save_pick_lines by the grower queues pick_updated for the grower, not the office`: a quantity change → one row to the grower; a comment-only change → none; a backoffice save → none.
  - `grower.test.ts` — `pick_updated is capped at 5 per grower per 10 minutes`: six grower saves with a quantity change → 5 rows for grower A; then one save by grower B → 1 row for B.
  - `message-content.test.ts:276` — the `pick_updated` link becomes `` `${ORI}/grower/picks` ``.
- [ ] **Step 2: Run** the three files with `vitest-local.mjs`. Expected: FAIL — rows still go to the office; the link is still the office page.
- [ ] **Step 3: Append 0106 §2**: `enqueue_company_notification`; `save_pick_lines` and `update_pick_product_pallets` from 0076 with only the `pick_updated` call changed to `perform public.enqueue_company_notification(v_trading_day_id, 'grower', v_grower_company_id, 'pick_updated', <the same payload>)`; `update public.notification_templates set link = 'https://ori-claude-web.vercel.app/grower/picks', updated_at = now() where template_key = 'pick_updated'`. Rebuild the world.
- [ ] **Step 4: Run** Step 2's files. Expected: PASS. Also run `message-content.test.ts` and `routing.test.ts`: PASS.
- [ ] **Step 5: Run 0106 twice** (`twice-0106.mjs`). Expected: no error.
- [ ] **Step 6: Commit** `feat(db): 0106 the grower's pick update goes to the grower's own group`.

### Task 3: 0106 §3 + the log label — the customer's copy of a new order

**Files:**
- Modify: `packages/db/migrations/0106_whatsapp-routing-like-bubble.sql` (append §3); `apps/web/src/lib/delivery-labels.ts:32-44`
- Test: `packages/domain/src/customer/customer.test.ts` (near :871), `packages/domain/src/notifications/message-content.test.ts`, Create `apps/web/src/lib/delivery-labels.test.ts` (if none exists)

**Interfaces:**
- Consumes: Task 2's `enqueue_company_notification`; Task 1's list rule.
- Produces: template row `order_submitted_copy` (content copied from the current `order_submitted` row, title `העתק ללקוח ששלח הזמנה`, link `https://ori-claude-web.vercel.app/customer/order`; `on conflict (template_key) do nothing`).

- [ ] **Step 1: Write the failing tests**:
  - `customer.test.ts` — `a customer's own submit also queues a private copy for that customer user — id 6`: one `order_submitted` row for the office and one `order_submitted_copy` row with `recipient_type 'customer'`, the customer's company, `recipient_user_ids = [customer user id]`, payload equal to the office row's; with the customer company given a WhatsApp group, resolving the copy gives only `[{target: <that user's 972 number>, is_group: false}]`.
  - `customer.test.ts` — `the office ordering for a customer queues no copy`: an on-behalf submit leaves zero `order_submitted_copy` and zero `order_submitted` rows.
  - `customer.test.ts` — `copies are capped like the office message`: six submits by the same customer within 10 minutes → 5 copy rows.
  - `customer.test.ts` — `a copy for an orderer with no usable phone reaches nobody`: the copy row exists; resolving it gives `[]`; the office row still exists.
  - `message-content.test.ts` — add `order_submitted_copy` to the template map (line ~279) with `order_submitted`'s text and link `` `${ORI}/customer/order` ``; `order_submitted_copy lists the order like the office message`: a copy row with `dailyOrderId` resolves to the same `%ORDER_DETAILS%` lines as the office row and ends with `\n\nhttps://ori-claude-web.vercel.app/customer/order`.
  - `delivery-labels.test.ts` — `templateLabel("order_submitted_copy", "customer")` is `העתק ללקוח ששלח הזמנה`.
- [ ] **Step 2: Run** `customer.test.ts` and `message-content.test.ts` with `vitest-local.mjs`, and `pnpm --filter @ori/web exec vitest run src/lib/delivery-labels.test.ts`. Expected: FAIL — no copy row, no template, no label.
- [ ] **Step 3: Append 0106 §3**: the template row; `compose_outbox_message` from 0102 with the details `case` matching `p_row.template_key in ('order_submitted', 'order_submitted_copy')`; `submit_order` from 0102 with one addition inside `if v_direct_customer_submission`, after the office call: `perform public.enqueue_company_notification(p_trading_day_id, 'customer', v_customer_company_id, 'order_submitted_copy', <the office call's payload>, array[(select auth.uid())])`. Add `order_submitted_copy: "העתק ללקוח ששלח הזמנה"` to `TEMPLATE_LABELS`. Rebuild the world.
- [ ] **Step 4: Run** Step 2's commands, plus `notifications.test.ts`, `dispatch-queue.test.ts`, `routing.test.ts`. Expected: all pass.
- [ ] **Step 5: Run 0106 twice.** Expected: no error.
- [ ] **Step 6: Commit** `feat(db): 0106 the customer who sent an order gets a private copy`.

### Task 4: Web — the board's bell confirms, then sends without a list

**Files:**
- Modify: `apps/web/src/routes/backoffice/arrangement.tsx:642-726` (the `onRemind` wiring and the `OrderReminderDialog` block)
- Test: `apps/web/e2e/arrangement.spec.ts:477-…` (rewrite)

**Interfaces:**
- Consumes: `useSendOrderReminder` — `mutate({ dailyOrderId })` with no `recipientUserIds` sends today's call (`packages/domain/src/customer/schemas.ts:84-102`); do not call `openWindow()`/`closeWindow()` here, so a failure is a toast (`failureNeedsToast`). The confirm is the shared `Dialog` with two `Button`s, as in `new-arrangement.tsx:747-769`.

- [ ] **Step 1: Rewrite the e2e** at :477 as `a customer card's bell asks first, then sends the reminder to the group or everyone`: the bell opens a dialog titled `שליחת תזכורת` showing `לשלוח ל${customerCompany.name} תזכורת לשלוח הזמנה?`; `ביטול` closes it with no `send_order_reminder` request; the bell again, then `שלח` → toast `התזכורת נשלחה.`; the request body has `p_daily_order_id` and no `p_recipient_user_ids`; the outbox row's `recipient_user_ids` is null. Add `a refusal after confirming shows as a toast`: open the confirm, submit the customer's order through the admin client, press `שלח` → toast `שליחת התזכורת נכשלה: הלקוח כבר שלח את ההזמנה, ואין צורך בתזכורת.`
- [ ] **Step 2: Run** `cd "$H" && SPEC=$WT/apps/web/e2e/arrangement.spec.ts DIST_DIR=<fresh build of $WT> WORLD_TAR=world-bare.tar SUPABASE_PORT=59421 API_PORT=59499 APP_PORT=4673 node e2e-local.mjs` (build: `cd "$WT/apps/web" && SUPABASE_PORT=59421 API_PORT=59499 node "$H/build-plain.mjs" <out>`). Expected: the two new tests FAIL (the choose-people window opens).
- [ ] **Step 3: Implement** in `arrangement.tsx`: the bell sets a confirm target `{ dailyOrderId, customerName }`; the confirm's `שלח` clears it and calls `reminderMutation.mutate({ dailyOrderId })`; `ביטול`/close clears it. Remove the board's `OrderReminderDialog` block and import (בשם לקוח keeps it). A comment says the board follows Bubble's board (group, else everyone; no choosing).
- [ ] **Step 4: Run** Step 2 on a fresh build. Expected: every test in `arrangement.spec.ts` passes (incl. the 375 px ones). Then `pnpm typecheck`, `pnpm lint`, `pnpm --filter @ori/web test`: exit 0.
- [ ] **Step 5: Commit** `feat(web): the board's bell asks, then reminds the customer the way Bubble does`.

### Task 5: Prove 0106 changes only what it should (harness only, no commits)

- [ ] **Step 1: Catalog diff** (`diff-0106.mjs` from `$H/diff-0104-0105.mjs`, BEFORE `world-bare-0105.tar`, AFTER with 0106). Expected, and nothing else: functions `outbox_routing(text)` (grants authenticated, service_role) and `enqueue_company_notification(uuid, notification_recipient_type, uuid, text, jsonb, uuid[])` (definer, `search_path=public`, no API-role grants) added; `resolve_outbox_dispatch`, `save_pick_lines`, `update_pick_product_pallets`, `submit_order`, `compose_outbox_message` sources changed with signature, security, config and grants unchanged; template `order_submitted_copy` added; `pick_updated`'s link changed.
- [ ] **Step 2: Twice.** Apply 0106 again on AFTER. Expected: catalog identical.
- [ ] **Step 3: Outbox before/after** (`outbox-ab-0106.mjs` from `$H/outbox-ab.mjs`): load `world-0105.tar`, add one row per template for a company with a group and one without, resolve every row on BEFORE and on AFTER (`make-after-world-0106.mjs` from `make-after-world-0105.mjs`). Expected print: every row identical except — `pick_reminder` rows of companies with a group gain their people; `shop_open` rows of companies with a group go to people instead; `pick_updated` rows addressed to the office now reach nobody. List each differing row with its kind. (Re-addressing "pick updated" and the customer's copy are changes to the functions that queue messages; Tasks 2–3's tests prove those, not this replay.)
- [ ] **Step 4: Suites on both worlds.** `routing`, `notifications`, `dispatch-queue`, `message-content`, `customer`, `grower`, `lifecycle` on `world-bare-0105.tar` and on the 0106 world. Expected: all pass on 0106 (except the known harness-only `the 1,000-row cap cuts each nested list…` in `grower.test.ts`); on 0105 the new tests fail. Record everything in `$H/out/task5.txt`.

### Task 6: Whole-branch proof and handoff

- [ ] **Step 1: Static checks** in `$WT`: `pnpm typecheck --force`, `pnpm lint --force`, `pnpm --filter @ori/web test`, `pnpm --filter @ori/shared test`, `pnpm --filter @ori/web build`. Expected: all exit 0.
- [ ] **Step 2: The whole e2e suite** on the branch build: `cd "$H" && SUPABASE_PORT=59421 API_PORT=59499 APP_PORT=4673 WORLD_TAR=world-bare.tar bash run-all-e2e.sh <branch dist> branch`. Expected: every spec `exit=0` in `out/e2e-branch/status.txt`.
- [ ] **Step 3: Today's site on the new database**: build `$H/../main-e19d036/apps/web` (`ORI_WEB`), run its own suite on the 0106 world (`ORI_REPO=$H/../main-e19d036`). Expected: every spec passes — open tabs keep working after James runs 0106.
- [ ] **Step 4: Click-through compare**: `node make-after-world-0106.mjs world-0105 world-0106`; `run.mjs` for main and branch on `world-0106`, plus the dialog-aware `run-t12.mjs` for `bo-oversight`; `node compare.mjs <main> <branch>`. Expected: every difference is the board bell's confirm (no window) or known noise (photo file names, the whatsapp-groups lookup crossing a step); explain each.
- [ ] **Step 5: Report to James** in plain words: what changed per message, the proofs, rollout (run 0106, then push; no sender redeploy; WhatsApp stays off until the office switches it on). Update the memory note `whatsapp-routing-like-bubble-2026-11-16.md`. Ask how to merge. After James runs 0106: a read-only check on live that every changed function's body (LF-normalised md5), its comment, its grants, and the `order_submitted_copy` template match the file, as done for 0104/0105.
