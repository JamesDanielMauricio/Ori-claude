# Bubble Feature Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the seven Bubble features Ori lacks — status filter and "X מתוך Y" counter, a chosen-recipients order reminder (also on סידור), changing a user's email, a quick stock popup, and a grower-set pickup time — without changing anything that works today.

**Architecture:** Two new migrations carry the database side (0104 reminders, 0105 pickup time); one new API procedure changes emails through the Supabase Admin API; everything else is web code reusing existing functions (`save_pick_lines`, the reminder RPC, the shared phone rule). Every change is proven on the local PGlite harness (database tests, e2e suite, click-through compare) before anything is pushed or migrated.

**Tech Stack:** Postgres/Supabase (PL/pgSQL, RLS), Drizzle schema, zod, tRPC v11 + Fastify (`apps/api`), React 19 + TanStack Query + Tailwind v4 (`apps/web`), Vitest, Playwright, the PGlite harness.

**Spec:** `docs/superpowers/specs/2026-11-15-bubble-feature-gaps-design.md` (approved by James 2026-11-15). Read it first; this plan argues from it.

## Global Constraints

- Migrations are files only. James runs them. Each gets a `packages/db/migrations/meta/_journal.json` entry. An applied migration is never edited. Live is at 0103.
- Old browser tabs keep working: every changed database function accepts the calls today's website makes, unchanged.
- `whatsapp-dispatch` is not redeployed: `resolve_outbox_dispatch(uuid) returns table(target text, is_group boolean, message text)` keeps that signature; `claim_outbox_rows`, `settle_outbox_row`, `record_outbox_target_sent` are untouched.
- Every security rule (grant, revoke, role check, policy, security definer) has a comment above it saying what it allows and what it protects against.
- `packages/db/src/supabase-types.ts` is edited by hand.
- Hebrew UI, right-to-left, usable at 375 px wide; the matrix phone layout (`arrangement-matrix-mobile.tsx`) gets the same feature as the desktop grid.
- Line endings: existing files are CRLF — change them only with Edit. New files must be CRLF too: after creating one with Write, run `node -e "const f=process.argv[1],fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))" <file>` and confirm `git ls-files --eol <file>` shows `w/crlf` once staged.
- No writes to Bubble. No contact with the hosted Supabase project from tests. Nothing pushed, nothing migrated, without James.
- Hebrew copy pinned by the spec is used verbatim (quoted in each task).

## Review Focus

1. A phone stored the old way ("050-123 4567") or foreign ("+970 59-123-4567") must count as reachable in the reminder window exactly as the sender reads it; "12" must not. → Task 6, test `reminderPeople reads numbers the way the sender does`.
2. A person moved to another company between opening the window and pressing שלח: the server refuses (`P0008`), the window says so and stays open; a person moved after the reminder was queued is skipped at sending. → Task 1 (`refuses a recipient who is not a user of this customer`, `skips a listed user who moved company`), Task 6 (`error-message maps the recipient refusals`).
3. An email retyped with other capitals or spaces is not a change (no API call); an address another user has is refused and the role, company and phone are not saved either. → Task 8 (`changedEmail ignores case and spaces`, e2e `an address another user has is refused and nothing else is saved`).
4. Stock changed by someone else between opening the popup and אישור: the server's `P0006` message is shown and the popup stays open; reopening shows fresh numbers. → Task 9, e2e `a total below what is arranged is refused and the popup stays open`.
5. The grower's pick is closed with the truck while the pickup dialog is open: saving shows "הליקוט סגור, ואי אפשר לשנות אותו." and, after the re-read, the button is gone. → Task 11, e2e `a pick closed meanwhile refuses the new time`.

## Shared setup (do once, before Task 1)

- `WT` = `d:/Downloads/Downloads/Ori main/.claude/worktrees/feat+bubble-feature-gaps`
- `H` = `C:/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/87779c3c-b3b9-4f03-9552-4239237c1562/scratchpad/harness`
- `SRC_H` = `C:/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/c512e411-434b-40ed-a110-89560b079dab/scratchpad/harness` (another session's copy — read only, never edited)

- [ ] **S1: Worktree.** Use superpowers:using-git-worktrees. From `main` at 9adef3a: `git worktree add "$WT" -b feat/bubble-feature-gaps main`, then `pnpm install --frozen-lockfile` in `$WT`. Expected: install finishes, `git -C "$WT" status` clean.
- [ ] **S2: Docs onto the branch.** Copy the spec and this plan from the main tree into `$WT/docs/superpowers/{specs,plans}/`, convert to CRLF, commit `docs: design and plan for the Bubble feature gaps`, then delete the two untracked copies from the main tree (`git -C "d:/Downloads/Downloads/Ori main" status` must be clean afterwards).
- [ ] **S3: Harness copy.** `cp -r "$SRC_H" "$H"` (skip `out/`, `dist*`). In the copy only, replace the literal `d:/Downloads/Downloads/Ori main` with `$WT` in every `*.mjs` and `*.sh`; then make `e2e-local.mjs`, `vitest-local.mjs`, `db.mjs` and `run-all-e2e.sh` (its spec folder) read `process.env.ORI_REPO ?? "<$WT>"`, and `build-plain.mjs` read `const WEB = process.env.ORI_WEB ?? "<$WT>/apps/web"` — Task 12 runs main's own suite by pointing these at the main tree. Use ports 59421 / 59499 / 4673 everywhere (`SUPABASE_PORT`, `API_PORT`, `APP_PORT`) so no other session's harness can answer. Expected: `cd "$H" && node bare-world.mjs` writes `world-bare.tar` with the worktree's journal (through 0103 at this point) and exits 0.
- [ ] **S4: Fake Auth learns email changes.** In `$H/fake-ori.mjs`, the admin `PUT users/<id>` branch also handles `b.email`: lower-case/trim it; if another `auth.users` row has it (case-insensitive), return `{ status: 422, json: { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" } }`; otherwise `update auth.users set email = $1 where id = $2` and return the updated `userJson`. Passwords keep working with the new email. (Used from Task 4 on.)

---

### Task 1: Migration 0104 — a reminder can carry its list of people

**Files:**
- Create: `packages/db/migrations/0104_order-reminder-recipients.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append `{ "idx": 104, "version": "7", "when": 1793134800000, "tag": "0104_order-reminder-recipients", "breakpoints": true }`)
- Modify: `packages/db/src/schema/notification-outbox.ts` (column `recipientUserIds: uuid("recipient_user_ids").array()`, nullable, with a comment)
- Modify: `packages/db/src/supabase-types.ts` (`notification_outbox` Row `recipient_user_ids: string[] | null`, Insert/Update `recipient_user_ids?: string[] | null`; `send_order_reminder` Args gains `p_recipient_user_ids?: string[]`)
- Modify: `packages/domain/src/customer/schemas.ts`, `packages/domain/src/customer/schemas.test.ts`
- Modify: `packages/domain/src/notifications/test-helpers.ts` (`CreateTestOutboxRowOptions.recipientUserIds?: string[] | null`, passed through)
- Test: `packages/domain/src/customer/customer.test.ts`, `packages/domain/src/notifications/message-content.test.ts`, `packages/domain/src/auth/rpc-authorization.test.ts`

**Interfaces:**
- Produces (SQL): column `public.notification_outbox.recipient_user_ids uuid[]` (NULL = the company's usual routing); `public.send_order_reminder(p_daily_order_id uuid, p_recipient_user_ids uuid[] default null) returns public.daily_orders`; `resolve_outbox_dispatch(p_outbox_id uuid)` unchanged signature.
- Produces (TS): `sendOrderReminderInputSchema = z.object({ dailyOrderId: z.string().uuid(), recipientUserIds: z.array(z.string().uuid()).min(1).max(50).optional() })` with a refine "no duplicates"; `toSendOrderReminderRpcArgs(input)` returns `{ p_daily_order_id }` plus `p_recipient_user_ids` only when the list is given.
- Error messages (exact, the web maps them in Task 6): `INVALID_INPUT: choose at least one recipient` (P0008), `INVALID_INPUT: a recipient is not a user of this customer` (P0008).

- [ ] **Step 1: Unit tests for the args** in `customer/schemas.test.ts`, describe `send_order_reminder args: chosen people (migration 0104)`:
  - `without a list, sends only p_daily_order_id` → `toEqual({ p_daily_order_id: ID })` (no `p_recipient_user_ids` key at all — today's call).
  - `with a list, sends it as p_recipient_user_ids` → `toEqual({ p_daily_order_id: ID, p_recipient_user_ids: [A, B] })`.
  - `refuses an empty list, a duplicate and a non-uuid` → three `safeParse(...).success === false`.
- [ ] **Step 2: Database tests.**
  - `customer.test.ts`, beside the existing reminder test: `send_order_reminder with a list stores it on the queued row and queues one row` (customer with two profiles A, B; list [B]; outbox row `recipientUserIds` = [B]); `refuses an empty list` (code `P0008`, message starts `INVALID_INPUT: choose at least one recipient`, no outbox row, `reminder_sent_at` still null); `refuses a recipient who is not a user of this customer` (a profile of another company; `P0008`, `INVALID_INPUT: a recipient is not a user of this customer`); `duplicates in the list are sent once` (list [A, A] stores [A]). The existing test (no list) must pass unchanged.
  - `message-content.test.ts`: `a reminder with a list goes to exactly those people, privately, never the group` — company WITH `whatsapp_group_id`, three profiles (A readable phone, B readable phone, C no phone); row with list [B, C] resolves to exactly one target: B's number, `is_group = false`, message greeting B's first name. `skips a listed user who moved company` — list [A], then A's `company_id` changed → zero targets. Existing tests (no list: group, else everyone) must pass unchanged.
  - `rpc-authorization.test.ts`: in the "refuse" block, `send_order_reminder` with a list refuses a visitor who is not signed in, an account with no profile, a grower and a customer (`expectRefused` with the 0076 caller set), and the outbox gets no row.
- [ ] **Step 3: Run them — they fail.** `cd "$H" && TEST="$WT/packages/domain/src/customer/customer.test.ts" WORLD_TAR=world-bare.tar SUPABASE_PORT=59421 node vitest-local.mjs` (and the same for the two other files). Expected: the new tests fail (unknown argument / column); every old test passes.
- [ ] **Step 4: Write `0104_order-reminder-recipients.sql`.** Header comment: what it does, "run before the web deploy; today's site keeps working; no `whatsapp-dispatch` redeploy; safe to run again". Contents, in order:
  1. `alter table public.notification_outbox add column if not exists recipient_user_ids uuid[];` + `comment on column` (NULL = usual routing; a list = exactly these users of `recipient_company_id`, privately, never the group; written only by `send_order_reminder`).
  2. `drop function if exists public.send_order_reminder(uuid);` then `create function public.send_order_reminder(p_daily_order_id uuid, p_recipient_user_ids uuid[] default null) returns public.daily_orders language plpgsql security invoker set search_path = public`. Body = 0028's, with: the role check as `public.current_role() is distinct from 'backoffice'` (comment: allows backoffice; protects against a caller with no role, whom `<>` let past); after the submitted check and before the stamp, when the list is not null: de-duplicate (`array(select distinct unnest(...))`), raise the empty-list error when `cardinality = 0`, raise the stranger error when any id is not a `profiles.user_id` with `company_id = v_order.customer_company_id` (a NULL element counts as a stranger); the insert writes `recipient_user_ids` (NULL when no list).
  3. `revoke execute ... (uuid, uuid[]) from public, anon;` / `grant execute ... to authenticated, service_role;` each with its security comment; `comment on function` describing both forms and the two refusals.
  4. `create or replace function public.resolve_outbox_dispatch(p_outbox_id uuid)` = 0102's body with a first branch: when `v_row.recipient_user_ids is not null`, return the same personal-target query as the no-group branch, restricted to `p.user_id = any(v_row.recipient_user_ids)` and still `p.company_id = v_row.recipient_company_id`, and `return`. Keep `security invoker`, `search_path`, and 0102's security comment; update the `comment on function` to mention 0104. `resolve_outbox_preview` is not changed.
- [ ] **Step 5: Journal, Drizzle column, types, schema, helper** (files above).
- [ ] **Step 6: Rebuild the world and run the tests — they pass.** `cd "$H" && node bare-world.mjs` (now includes 0104), then the three `vitest-local.mjs` runs from Step 3 and the same run for `customer/schemas.test.ts`. Expected: all tests in all four files pass. `pnpm -C "$WT" typecheck` passes.
- [ ] **Step 7: Commit** `feat(db): 0104 a reminder can carry its list of people` (migration, journal, schema, types, domain, tests).

### Task 2: Migration 0105 — the grower sets the day's pickup time

**Files:**
- Create: `packages/db/migrations/0105_grower-sets-pickup-time.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (`{ "idx": 105, "version": "7", "when": 1793221200000, "tag": "0105_grower-sets-pickup-time", "breakpoints": true }`)
- Modify: `packages/db/src/supabase-types.ts` (`set_pick_pickup_time: { Args: { p_daily_pick_id: string; p_pickup_time: string }; Returns: Database["public"]["Tables"]["daily_picks"]["Row"] }`)
- Modify: `packages/domain/src/grower/schemas.ts`, `packages/domain/src/grower/index.ts` (exports)
- Create: `packages/domain/src/grower/schemas.test.ts`
- Test: `packages/domain/src/lifecycle-engine/lifecycle.test.ts`, `packages/domain/src/notifications/message-content.test.ts`, `packages/domain/src/auth/rpc-authorization.test.ts`

**Interfaces:**
- Produces (SQL): `public.set_pick_pickup_time(p_daily_pick_id uuid, p_pickup_time time) returns public.daily_picks`, security definer; `submit_pick(uuid)` unchanged signature.
- Produces (TS): `setPickPickupTimeInputSchema = z.object({ dailyPickId: z.string().uuid(), pickupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })`; `toSetPickPickupTimeRpcArgs(input) → { p_daily_pick_id, p_pickup_time }`.
- Error messages: reuse save_pick_lines' exact texts so the web's existing Hebrew applies — `FORBIDDEN: not this pick's grower` (42501), `INVALID_STATE: this pick is closed — no further edits are permitted` (P0007, also used when the trading day is closed); `NOT_FOUND: pick % does not exist` (P0002); `INVALID_INPUT: pickup time is required` (P0008).

- [ ] **Step 1: Unit tests** in the new `grower/schemas.test.ts`: `accepts "07:05" and "23:59"`, `refuses "24:00", "7:5", "" and "14:00:00"`, `maps to p_daily_pick_id / p_pickup_time`.
- [ ] **Step 2: Database tests.**
  - `lifecycle.test.ts`, new describe `the grower sets the day's pickup time (0105)`: `the pick's own grower sets it on a draft` (`pickup_time` = "06:30:00"); `sending keeps a time the grower chose` (`submit_pick` after setting → still "06:30:00"); `a grower who never chose still gets the default when sending` (unchanged 0043 behaviour); `it can change after sending` (submitted pick → new time stored, status still submitted); `backoffice may set it`; `refuses a closed pick` (truck closed → P0007, exact message above); `refuses a NULL time` (P0008).
  - `message-content.test.ts`: `the transporter's message names the time the grower chose` — grower with a transporter and a sale (arrangement record > 0), time set to "05:45", truck closes the pick → the queued `close_arrangement_grower_transporter` row's `payload.pickupTime` is "05:45".
  - `rpc-authorization.test.ts`: `set_pick_pickup_time` refuses a visitor, an account with no profile, another grower and a customer (`expectRefused(..., everyoneButStaffAndOwner())`); in the "right people" test the owning grower succeeds.
- [ ] **Step 3: Run — they fail** (`vitest-local.mjs` on the three files, world from Task 1). Expected: unknown function `set_pick_pickup_time`; `sending keeps a time the grower chose` fails (submit overwrites it).
- [ ] **Step 4: Write `0105_grower-sets-pickup-time.sql`.** Header: what and why (Bubble lets the grower change the day's time; 1851 picks since Aug 2026 kept one time each, but James wants the feature), rollout (before the web deploy; today's site keeps working), safe to run again.
  1. `create or replace function public.set_pick_pickup_time(...)` — `security definer`, `set search_path = public` (comment: growers can only read `daily_picks`; this is their one checked way to write its time). Locks the pick `for update`; the 0076 fail-closed caller check verbatim (comment: allows backoffice or a grower of the pick's company; protects against everyone else, including no-profile and signed-out callers); refuses NULL time, closed pick, closed trading day; `update public.daily_picks set pickup_time = p_pickup_time, updated_at = now() ... returning *`.
  2. `revoke all on function ... from public, anon; grant execute ... to authenticated, service_role;` with comments; `comment on function`.
  3. `create or replace function public.submit_pick(p_daily_pick_id uuid)` = 0076's body verbatim except `pickup_time = coalesce(v_pick.pickup_time, v_pickup_time)` (comment: a draft only has a time if its grower chose one, so everyone else keeps 0043's snapshot).
- [ ] **Step 5: Journal, types, domain schema + exports.**
- [ ] **Step 6: Rebuild the world, run — they pass.** `node bare-world.mjs` (now through 0105), the three `vitest-local.mjs` runs, plus `schemas.test.ts`. `pnpm -C "$WT" typecheck` passes.
- [ ] **Step 7: Commit** `feat(db): 0105 the grower sets the day's pickup time`.

### Task 3: Prove 0104 and 0105 change only what they should

**Files (harness only, not committed):**
- Create: `$H/diff-0104-0105.mjs` (from `diff-0102.mjs`: BEFORE = `world-bare-0103.tar`, AFTER = BEFORE with the two files exec'd)
- Create: `$H/make-after-world-0105.mjs` (from `make-after-world-0103.mjs`: applies 0104 then 0105)
- Create: `$H/outbox-ab.mjs`

- [ ] **Step 1: Catalog diff.** `node diff-0104-0105.mjs`. Expected, and nothing else: column `notification_outbox.recipient_user_ids` added; function `send_order_reminder(uuid)` gone and `send_order_reminder(uuid, uuid[])` present (invoker, grants: authenticated, service_role); `resolve_outbox_dispatch` source changed (same signature, security, grants); `submit_pick` source changed (same signature, definer, config, grants); `set_pick_pickup_time(uuid, time)` added (definer, `search_path=public`, grants: authenticated, service_role, no PUBLIC/anon).
- [ ] **Step 2: Runs twice.** Apply 0104 and 0105 a second time on AFTER; expected: no error, catalog identical to the first AFTER.
- [ ] **Step 3: Same recipients for every existing message.** `outbox-ab.mjs`: load `world-0103.tar` (the seeded business); add one outbox row per template (all eleven, payloads as in `$H/q-payloads.mjs`) for a company with a WhatsApp group and one for a company without; resolve every outbox row with `resolve_outbox_dispatch` on BEFORE and on AFTER (`make-after-world-0105.mjs` output). Expected print: `rows N, identical N` — every row's (target, is_group, message) multiset equal.
- [ ] **Step 4: Before/after domain suites.** Run `customer.test.ts`, `message-content.test.ts`, `lifecycle.test.ts`, `rpc-authorization.test.ts`, `notifications.test.ts`, `dispatch-queue.test.ts` with `vitest-local.mjs` on `world-bare-0103.tar` and on the 0105 world. Expected: on 0105 every test passes; on 0103 only the tests added in Tasks 1–2 fail (proving they test the change).
- [ ] **Step 5: Record the outputs** in `$H/out/task3.txt` (paste into the final report). No commit.

### Task 4: Server — change a user's login email

**Files:**
- Create: `packages/domain/src/auth/update-user-email.ts`, `packages/domain/src/auth/update-user-email.test.ts`
- Modify: `packages/domain/src/auth/errors.ts` (`EmailInUseError`), `packages/domain/src/auth/index.ts` (export `updateUserEmail`, `type UpdateUserEmailInput`)
- Modify: `apps/api/src/routers/auth.ts`, `apps/api/src/trpc-errors.ts`, `apps/api/src/routers/auth.test.ts`

**Interfaces:**
- Produces: `updateUserEmail(input: { targetUserId: string; email: string }): Promise<{ email: string }>` — normalises with `normalizeEmail`, calls `createServiceRoleClient().auth.admin.updateUserById(targetUserId, { email, email_confirm: true })`; `error.code === "email_exists"` (or status 422 naming the address) → `EmailInUseError`; status 404 → `UserNotFoundError`; anything else → `Error("Failed to update email: …")`.
- Produces: tRPC `auth.updateUserEmail` — `backofficeProcedure.input(z.object({ targetUserId: z.string().uuid(), email: z.string().trim().email() }))` → `{ ok: true, email }`.
- Produces: `toTRPCError(EmailInUseError)` → `TRPCError({ code: "CONFLICT", message: "כתובת האימייל כבר רשומה למשתמש אחר." })`.

- [ ] **Step 1: Domain test** `update-user-email.test.ts` (pattern: `delete-user.test.ts`): `changes the login email at once, with the password unchanged` (sign in with the new address and old password succeeds; the old address fails); `stores it trimmed and lower-cased` ("  New@Example.TEST " → "new@example.test"); `refuses an address another account has` (EmailInUseError, both accounts unchanged); `an unknown user is UserNotFoundError`.
- [ ] **Step 2: API test** in `auth.test.ts`: `updateUserEmail refuses a signed-out caller and a grower` (UNAUTHORIZED, FORBIDDEN); `a backoffice caller changes another user's email`; `a taken address is CONFLICT with the Hebrew sentence`.
- [ ] **Step 3: Run — they fail.** `cd "$H" && TEST="$WT/packages/domain/src/auth/update-user-email.test.ts" node vitest-local.mjs`; same for `apps/api/src/routers/auth.test.ts` (if vitest-local cannot load an `apps/api` test, note it in the report — CI runs it).
- [ ] **Step 4: Implement** the files above. The comment above the procedure: allows a signed-in backoffice user; protects against anyone else changing a login (the guard runs before the service-role call). Comment in the domain function: why `email_confirm: true` (no confirmation email, applied at once) and why this adds no new power (the office can already change a phone and send a reset link).
- [ ] **Step 5: Run — they pass.** Same commands; `pnpm -C "$WT" --filter @ori/api typecheck` and `--filter @ori/domain typecheck` pass.
- [ ] **Step 6: Commit** `feat(api): the office can change a user's login email`.

### Task 5: Web — status filter and counter on בשם מגדל / בשם לקוח

**Files:**
- Create: `apps/web/src/lib/oversight-status.ts`, `apps/web/src/lib/oversight-status.test.ts`
- Create: `apps/web/src/components/reference-data/oversight-toolbar.tsx`
- Modify: `apps/web/src/routes/backoffice/distributor-grower.tsx`, `apps/web/src/routes/backoffice/distributor-customer.tsx`
- Test (e2e): `apps/web/e2e/distributor-grower.spec.ts`, `apps/web/e2e/distributor-customer.spec.ts`

**Interfaces:**
- Produces (`oversight-status.ts`):
  - `type GrowerPickState = "draft" | "submitted" | "closed" | "none"`; `growerPickState(pick: { status: "draft" | "submitted" | "closed" } | null): GrowerPickState`
  - `type CustomerOrderState = "open" | "submitted" | "none"`; `customerOrderState(order: { status: "open" | "submitted" } | null): CustomerOrderState`
  - `type StatusFilter<S extends string> = "all" | S`; `matchesFilter<S extends string>(state: S, filter: StatusFilter<S>): boolean`
  - `progressCount<S extends string>(states: readonly S[], done: readonly S[]): { done: number; total: number }` — `total` counts every state except `"none"`
  - `GROWER_FILTER_OPTIONS: readonly SelectOption<StatusFilter<GrowerPickState>>[]` — labels in order: הכול, טיוטה, נשלח, סגור, ללא ליקוט
  - `CUSTOMER_FILTER_OPTIONS` — הכול, פתוחה, נשלחה, ללא הזמנה
- Produces (`oversight-toolbar.tsx`): `OversightToolbar<F extends string>({ search, onSearchChange, searchLabel, searchPlaceholder, filter, onFilterChange, filterOptions, counter }: { …; counter: { label: string; done: number; total: number } | null })` — the existing search box markup moved here unchanged, the `Select` labelled "סינון לפי סטטוס" beside it, the counter text `${label}: ${done} מתוך ${total}`; wraps under the search box below `sm`.

- [ ] **Step 1: Unit tests** `oversight-status.test.ts`: state mapping for every status and `null`; `matchesFilter` for "all" and each state; `progressCount(["submitted","closed","draft","none"], ["submitted","closed"])` → `{ done: 2, total: 3 }`; the two option lists' labels exactly as above.
- [ ] **Step 2: Run — fails** (`pnpm -C "$WT" --filter @ori/web exec vitest run src/lib/oversight-status.test.ts`: module not found).
- [ ] **Step 3: Implement** `oversight-status.ts`; **Step 4: run — passes.**
- [ ] **Step 5: Screens.** Each screen keeps a `filter` state (`"all"` on arrival, not remembered); rows are filtered by search AND `matchesFilter(state, filter)`; the counter is computed from every company on the unfiltered, unsearched list — growers: `done` = submitted or closed, Y = growers with a pick; customers: `done` = submitted, Y = customers with an order; `counter` is `null` (hidden) when there is no trading day, on בשם לקוח's "shop not open" state, or when `total === 0`. Labels: "הזינו קטיף", "הזמנות הוזנו". Empty state when the filter (or filter + search) leaves nothing: title "אין מגדלים בסטטוס הזה" / "אין לקוחות בסטטוס הזה", hint "בחר סטטוס אחר." (with a search too: "נסה מונח חיפוש או סטטוס אחר.").
- [ ] **Step 6: e2e tests.** `distributor-grower.spec.ts`: `filters growers by pick status and counts who has sent` — two test growers, one sent; the counter's two numbers equal what the test reads from the database for that day (sent picks / picks of active growers), never hard-coded, since other fixtures may share the day; choosing "נשלח" shows only the sent one; "טיוטה" only the other; an impossible combination shows "אין מגדלים בסטטוס הזה". `distributor-customer.spec.ts`: `filters customers by order status and counts orders sent` (same shape). Build for the harness: `ORI_WEB="$WT/apps/web" SUPABASE_PORT=59421 API_PORT=59499 node "$H/build-plain.mjs" "$H/../dist-branch"`; run each spec: `cd "$H" && SPEC="$WT/apps/web/e2e/<spec>" DIST_DIR="$H/../dist-branch" SUPABASE_PORT=59421 API_PORT=59499 APP_PORT=4673 node e2e-local.mjs`. Expected: every test in both specs passes.
- [ ] **Step 7: Commit** `feat(web): status filter and counter on the on-behalf-of screens`.

### Task 6: Web — the reminder window on בשם לקוח

**Files:**
- Create: `apps/web/src/lib/order-reminder.ts`, `apps/web/src/lib/order-reminder.test.ts`
- Create: `apps/web/src/lib/use-send-order-reminder.ts`
- Create: `apps/web/src/components/reference-data/order-reminder-dialog.tsx`, `apps/web/src/components/reference-data/order-reminder-dialog.test.tsx`
- Modify: `apps/web/src/lib/queries/oversight.ts` (`customerPeople`), `apps/web/src/lib/error-message.ts` (+ its test), `apps/web/src/routes/backoffice/distributor-customer.tsx`
- Test (e2e): `apps/web/e2e/distributor-customer.spec.ts`

**Interfaces:**
- Consumes: `toSendOrderReminderRpcArgs` with `recipientUserIds` (Task 1); `toWhatsAppPersonalNumber`, `normalizePhoneNumber` from `@ori/shared/phone`.
- Produces (`order-reminder.ts`):
  - `interface ReminderPerson { userId: string; name: string; phoneTail: string | null; canReceive: boolean; reason: "no_phone" | "invalid_phone" | null }`
  - `reminderPeople(rows: ReadonlyArray<{ user_id: string; display_name: string; phone_number: string | null }>): ReminderPerson[]` — sorted by name (`localeCompare(…, "he")`); `canReceive = toWhatsAppPersonalNumber(phone) !== null`; `phoneTail` = `•••` + the last four digits of `normalizePhoneNumber(phone)` when readable; `reason` "no_phone" for empty, "invalid_phone" for unreadable.
  - `initiallyTicked(people: ReminderPerson[]): Set<string>` — every `canReceive` person.
- Produces: `oversightQueries.customerPeople(customerId: string | null)` — key `["customer-oversight", "people", customerId]`, `enabled: !!customerId`, `staleTime: 0`, reads `profiles` `user_id, display_name, phone_number` where `company_id = customerId`.
- Produces: `useSendOrderReminder(options?: { ordersForDayQueryKey?: QueryKey }): UseMutationResult<void, { message?: string }, { dailyOrderId: string; recipientUserIds: string[] }>` — today's `reminderMutation` moved here: optimistic `reminder_sent_at` patch when the key is given, toast "התזכורת נשלחה.", `nudgeWhatsAppDispatch`, error toast `שליחת התזכורת נכשלה: …`.
- Produces: `OrderReminderDialog({ target, onClose, sending, onSend }: { target: { dailyOrderId: string; customerId: string; customerName: string } | null; onClose: () => void; sending: boolean; onSend: (recipientUserIds: string[]) => void })`.

- [ ] **Step 1: Unit tests** `order-reminder.test.ts`: `reminderPeople reads numbers the way the sender does` — "050-123 4567" and "+970 59-123-4567" can receive, "12" is `invalid_phone`, null/"" is `no_phone` (cross-check one case from `packages/shared/src/phone-cases.json`); `sorted by Hebrew name`; `phoneTail shows only the last four digits` ("0501234512" → "•••4512"); `initiallyTicked ticks exactly the reachable`. `error-message.test.ts`: `maps the recipient refusals` — P0008 `INVALID_INPUT: choose at least one recipient` → "יש לבחור לפחות אדם אחד."; P0008 `INVALID_INPUT: a recipient is not a user of this customer` → "אחד המקבלים כבר לא משויך ללקוח הזה. סגרו את החלון ופתחו אותו שוב.".
- [ ] **Step 2: Dialog test** `order-reminder-dialog.test.tsx` (`renderToStaticMarkup`, a `QueryClient` pre-filled with `customerPeople` data): title "שליחת תזכורת — מאפיית כהן", "מקבלי ההודעה:", a reachable person's checkbox checked, a phoneless person's checkbox disabled with "אין טלפון", "מספר לא תקין" for an unreadable one; with nobody reachable the sentence "לאף אחד מאנשי הלקוח אין מספר טלפון שאפשר לשלוח אליו הודעת WhatsApp. אפשר להוסיף מספר במסך המשתמשים." shows and "שלח" is disabled.
- [ ] **Step 3: Run — both fail; implement; run — both pass** (`pnpm -C "$WT" --filter @ori/web exec vitest run src/lib/order-reminder.test.ts src/components/reference-data/order-reminder-dialog.test.tsx src/lib/error-message.test.ts`).
- [ ] **Step 4: Wire בשם לקוח.** The bell sets `reminderTarget` (same enabled rule as today: live day, an order, not submitted, nothing pending); the dialog's "שלח" calls the hook with the ticked ids and closes on success; "שולח…" while pending; a refusal leaves it open with the mapped message. Buttons "ביטול" / "שלח".
- [ ] **Step 5: e2e.** Update `sending a reminder on an un-submitted order …`: the customer gets a user with phone "0501234567" and one without; the bell opens the window; the phoneless person is listed, unticked and disabled; "שלח" → toast "התזכורת נשלחה."; the outbox row's `recipient_user_ids` equals `[the phone user's id]`. Add `the reminder window can untick everyone, and then cannot send` ("שלח" disabled), and `a person moved to another company meanwhile is refused and the window stays open` (open the window, move the ticked user's profile to another company over `db`, press "שלח" → "אחד המקבלים כבר לא משויך ללקוח הזה. סגרו את החלון ופתחו אותו שוב." inside the still-open dialog; no outbox row). The first test (bell disabled after submitting) stays as is. Rebuild `dist-branch`, run the spec with `e2e-local.mjs`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(web): choose who gets a customer's reminder`.

### Task 7: Web — the reminder bell on סידור's customer cards

**Files:**
- Modify: `apps/web/src/components/arrangement/board-data.ts` (`CustomerDemand.dailyOrderId: string`, set from `order.id`), `apps/web/src/components/arrangement/board-data.test.ts`
- Modify: `apps/web/src/components/arrangement/customer-demand-board.tsx` (props `onRemind: (customerId: string) => void`, `remindDisabled: (customer: CustomerDemand) => boolean`, `remindingId: string | null`)
- Modify: `apps/web/src/routes/backoffice/arrangement.tsx`
- Test (e2e): `apps/web/e2e/arrangement.spec.ts`

**Interfaces:**
- Consumes: `OrderReminderDialog`, `useSendOrderReminder` (Task 6).

- [ ] **Step 1: Unit test** in `board-data.test.ts`: `each customer carries its order's id` (`buildBoard(...).customers[0].dailyOrderId === order.id`). Run — fails; add the field; run — passes.
- [ ] **Step 2: The bell.** Beside the card's pencil, a bell (`Icon name="bell"`, `aria-label` `שלח תזכורת ל${customerName}`, same style as `ExpandableEntityRow`'s); enabled when `dayView.isLive`, the order's status is not `submitted`, and no reminder is pending; opens the same dialog; `useSendOrderReminder()` without a cache key.
- [ ] **Step 3: e2e** `a customer card's bell sends a reminder to the ticked people` — on סידור, a customer with an un-submitted order and a user with a phone: bell → window → "שלח" → toast; outbox row with that user's id; after the customer submits, that card's bell is disabled. Rebuild, run `arrangement.spec.ts`. Expected: all pass.
- [ ] **Step 4: Commit** `feat(web): the reminder bell on the arrangement board`.

### Task 8: Web — change the email on משתמשים

**Files:**
- Create: `apps/web/src/lib/email-input.ts`, `apps/web/src/lib/email-input.test.ts`
- Modify: `apps/web/src/routes/backoffice/users.tsx`
- Test (e2e): `apps/web/e2e/reference-data-users.spec.ts`

**Interfaces:**
- Consumes: `trpc.auth.updateUserEmail` (Task 4).
- Produces: `normalizeEmailInput(value: string): string` (trim + lower-case); `isEmailShaped(value: string): boolean` (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` after normalising); `changedEmail(saved: string | undefined, typed: string): string | null` — the normalised address when it differs from the saved one, else `null`.

- [ ] **Step 1: Unit tests** `email-input.test.ts`: `changedEmail ignores case and spaces` (`changedEmail("a@b.co", " A@B.CO ")` → null); `returns the new address normalised`; `isEmailShaped` refuses "a@b", "a b@c.co", "".
- [ ] **Step 2: Run — fails; implement; run — passes.**
- [ ] **Step 3: users.tsx.** `FormState` gains `email: string` (seeded from `emailsQuery.data?.[row.user_id] ?? ""`, part of the dirty check so an email-only change enables שמור). The email column gets `renderEdit`: `<input type="email" dir="ltr" aria-label="אימייל" …>`. In the save's `mutationFn`, before any write: if `!isEmailShaped(form.email)` throw `new Error("כתובת האימייל אינה תקינה.")`; then, when `changedEmail(...)` is not null, `await updateEmail.mutateAsync({ targetUserId, email })` (`updateEmail = trpc.auth.updateUserEmail.useMutation()`), then the existing `save_user` and phone writes. If a later write fails after the email changed, the toast is `האימייל עודכן, אבל שאר השינויים לא נשמרו: ${errorMessage(error)}`. On success and on that failure, `trpc.useUtils().auth.listUserEmails.invalidate()`. No special case for the office's own row: changing your own email is allowed and your session carries on. Replace the column's "read-only" comment with one saying how the email is changed and why it goes first.
- [ ] **Step 4: e2e** in `reference-data-users.spec.ts`: `changes a user's email; they sign in with the new one` and `an address another user has is refused and nothing else is saved` (also change the display name in the same edit; after the refusal the name is unchanged in the database and the row stays in edit mode). Rebuild, run the spec. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): the office can change a user's email`.

### Task 9: Web — the stock popup on סידור לפי מוצרים

**Files:**
- Create: `apps/web/src/lib/stock-edit.ts`, `apps/web/src/lib/stock-edit.test.ts`
- Create: `apps/web/src/components/arrangement/stock-edit-dialog.tsx`
- Modify: `apps/web/src/lib/queries/arrangement.ts` (`pickLineForEdit`)
- Modify: `apps/web/src/components/arrangement/matrix/row.tsx`, `apps/web/src/components/arrangement/arrangement-matrix.tsx`, `apps/web/src/components/arrangement/arrangement-matrix-mobile.tsx`, `apps/web/src/routes/backoffice/new-arrangement.tsx`
- Test (e2e): `apps/web/e2e/arrangement.spec.ts`

**Interfaces:**
- Produces: `arrangementQueries.pickLineForEdit(lineId: string | null)` — key `["arrangement", "pick-line", lineId]`, `staleTime: 0`, one `daily_pick_products` row: `id, daily_pick_id, pallets_picked, leftover_pallets, comment`, its pick's `status` and grower name, its variety's name/sizes/family name, and `arrangement_records(quantity_pallets)`; returns `{ …, arranged: number }` (sum, `parsePallets`).
- Produces: `stockEditCheck(input: { picked: string; leftover: string; arranged: number }): { ok: true; picked: number; leftover: number } | { ok: false; reason: "empty" | "below_arranged" }` — whole numbers (as `stripDecimal` leaves them), empty counts as missing.
- Produces: `StockEditDialog({ pickLineId, onClose, onSaved }: { pickLineId: string | null; onClose: () => void; onSaved: () => void })` — title `עדכון מלאי — ${growerName} · ${varietyLabel}`, boxes "משטחים מהיום:" and "מלאי קודם:" (the `NumberCell` input rules: `type="number" min="0" step="1"`, `blockDecimalKey`, `blockWheel`, `stripDecimal`), the line "כבר סודרו: N", buttons "ביטול" / "אישור" ("שומר…" pending). אישור is off unless `stockEditCheck` is ok; it calls `save_pick_lines` via `savePickLinesInputSchema` / `toSavePickLinesRpcArgs` with that one line and its fresh comment; on a refusal it shows `errorMessage(error)` inside the dialog and stays open.
- Produces: `MatrixRowCells` / `ArrangementMatrix` / `ArrangementMatrixMobile` prop `onEditStock?: (pickLineId: string) => void`.

- [ ] **Step 1: Unit tests** `stock-edit.test.ts`: `accepts a total at the arranged floor` (8 + 1 with arranged 9 → ok); `refuses below it` (8 + 0, arranged 9 → below_arranged); `an empty box is missing`; `0 and 0 are allowed when nothing is arranged`.
- [ ] **Step 2: Run — fails; implement; run — passes.**
- [ ] **Step 3: Matrix.** The "סה״כ במלאי" cell is a button (same text, an accent underline on hover, `aria-label` `עדכון מלאי — ${growerName}`) on a grower row and on a product row with `expandable === false` (using `row.growers[0]`), only when `onEditStock` is passed, `editable` is true, and that line is not `closed`; otherwise the plain number as today. The phone layout's "במלאי" stat gets the same button under the same rule. `new-arrangement.tsx` passes `onEditStock` only while the grid is editable (not saving, not proposing), holds `stockLineId`, renders `StockEditDialog`, and on save invalidates `newArrangementKeys.matrix(dayId)`, `arrangementKeys.boardDataAll`, `["picked-products"]` and `["grower-oversight", "picks-for-day"]`. Unsaved grid changes are not touched.
- [ ] **Step 4: e2e** in `arrangement.spec.ts`: `סה״כ במלאי opens the stock popup and the new stock shows in the grid` (desktop width; one-grower product; set 12 / 3; the row's סה״כ במלאי reads 12 and זמין rises accordingly); `a total below what is arranged is refused and the popup stays open` (arrange 9 first, then try 8 / 0 — אישור is off; force the server path by arranging from a second client after opening the popup, then confirm → "כבר סודרו …" message, dialog still open); `the phone layout offers the same popup` (375 px wide). Rebuild, run. Expected: all pass, and the spec's existing tests still pass.
- [ ] **Step 5: Commit** `feat(web): quick stock edit in the product grid`.

### Task 10: Web — the stock popup on מוצרים שנקטפו

**Files:**
- Modify: `apps/web/src/lib/queries/picked-products.ts` (+ `picked-products.test.ts`)
- Modify: `apps/web/src/components/reference-data/product-catalog/variety-columns.tsx`, `apps/web/src/components/reference-data/product-catalog-screen.tsx`, `apps/web/src/routes/backoffice/picked-products.tsx`
- Create (e2e): `apps/web/e2e/picked-products.spec.ts`

**Interfaces:**
- Consumes: `StockEditDialog` (Task 9).
- Produces: `PickedStock` gains `singleLineByVariety: ReadonlyMap<string, string>` (variety id → the one pick line id) for every variety whose supply (picked + leftover > 0) comes from exactly one line that day; `NO_PICKED_STOCK` gains an empty map; new pure `singleSupplyLines(lines: ReadonlyArray<{ id: string; product_variety_id: string; pallets_picked: number | string | null; leftover_pallets: number | string | null }>): ReadonlyMap<string, string>`. The query also selects each line's `id`.
- Produces: `ProductCatalogScreen` and the variety columns accept `onEditStock?: (pickLineId: string) => void` and `singleLineByVariety?`.

- [ ] **Step 1: Unit tests** in `picked-products.test.ts`: `singleSupplyLines keeps a variety only one line supplies` (two lines, one with 0 + 0 → kept; two lines both supplying → absent; leftover-only supply counts).
- [ ] **Step 2: Run — fails; implement; run — passes.**
- [ ] **Step 3: Screen.** The "משטחים במלאי" number is a button (same look as Task 9) when the variety is in `singleLineByVariety` and `dayView.isLive`; otherwise the plain number. `picked-products.tsx` owns the dialog and passes `onEditStock` only on the live day. After a save the same invalidations as Task 9.
- [ ] **Step 4: e2e** `picked-products.spec.ts`: `a product one grower supplies can have its stock changed here; a product two growers supply cannot`. Rebuild, run. Expected: passes.
- [ ] **Step 5: Commit** `feat(web): quick stock edit on the picked products screen`.

### Task 11: Web — the grower sets the day's pickup time

**Files:**
- Create: `apps/web/src/components/grower/pickup-time-dialog.tsx`
- Modify: `apps/web/src/lib/pickup-time.ts` (+ `pickup-time.test.ts`), `apps/web/src/routes/grower/picks.tsx`
- Test (e2e): `apps/web/e2e/grower-picks.spec.ts`

**Interfaces:**
- Consumes: `setPickPickupTimeInputSchema`, `toSetPickPickupTimeRpcArgs` (Task 2).
- Produces: `toTimeInputValue(time: string | null): string` — "14:00:00" → "14:00", null → "".
- Produces: `PickupTimeDialog({ pickId, current, open, onClose, onSaved }: { pickId: string; current: string | null; open: boolean; onClose: () => void; onSaved: () => void })` — title "שעת איסוף", one `<input type="time" step="60">` (`aria-label="שעת איסוף"`), buttons "ביטול" / "שמור" ("שומר…" pending); refusals shown with `errorMessage` inside the dialog.

- [ ] **Step 1: Unit test** in `pickup-time.test.ts`: `toTimeInputValue` for "14:00:00", "06:05", null.
- [ ] **Step 2: Run — fails; implement; run — passes.**
- [ ] **Step 3: picks.tsx `PickDetail`.** When `pick.status !== "closed"`: the strip shows a button `שעת איסוף ${time}` with the pencil icon, or "שעת איסוף: לא נקבעה" when there is no time at all; it opens the dialog with `effectivePickupTime(...)` as `current`. A closed pick shows the time as today (nothing when there is none). On save: `onSaved` (the existing invalidation) and close.
- [ ] **Step 4: e2e** in `grower-picks.spec.ts`: `a grower changes the day's pickup time; the office board shows it and sending keeps it` (set 05:45 → strip reads "שעת איסוף 05:45"; send the pick; the strip still reads 05:45; as backoffice the arrangement board's grower caption shows 05:45); `a pick closed meanwhile refuses the new time` (open the dialog, close the pick as backoffice via `set_pick_closed`, press שמור → "הליקוט סגור, ואי אפשר לשנות אותו."; after the re-read there is no button). Rebuild, run. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): the grower sets the day's pickup time`.

### Task 12: Whole-branch proof and handoff

**Files:** none in the repo (harness outputs only), plus the memory note.

- [ ] **Step 1: Static checks.** In `$WT`: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @ori/web test`, `pnpm --filter @ori/shared test`, `pnpm --filter @ori/web build`. Expected: all exit 0.
- [ ] **Step 2: Every domain test file touched by this plan, plus `notifications.test.ts`, `dispatch-queue.test.ts`, `grower.test.ts`, `arrangement.test.ts`**, through `vitest-local.mjs` on the 0105 world. Expected: all pass.
- [ ] **Step 3: The whole e2e suite** on the branch build: `bash "$H/run-all-e2e.sh" "$H/../dist-branch" branch` (ports as in S3). Expected: `status.txt` shows every spec `exit=0` (the 17 existing files plus `picked-products`).
- [ ] **Step 4: Today's website on the new database.** Build `main` for the harness (`ORI_WEB="d:/Downloads/Downloads/Ori main/apps/web" node "$H/build-plain.mjs" "$H/../dist-main"`) and run main's own e2e suite against the 0105 world (`ORI_REPO="d:/Downloads/Downloads/Ori main" WORLD_TAR="$H/world-bare.tar" bash "$H/run-all-e2e.sh" "$H/../dist-main" main-on-0105` — main's specs and fixtures, the branch's database). Expected: every spec passes — proof that old browser tabs keep working after James runs the migrations.
- [ ] **Step 5: Click-through compare.** Make the after-world for the seeded business (`node make-after-world-0105.mjs world-0103 world-0105`), then `LABEL=main DIST_DIR=../dist-main WORLD=world-0105 …ports… node run.mjs` and `LABEL=branch DIST_DIR=../dist-branch WORLD=world-0105 …ports… node run.mjs`, then `node compare.mjs main branch`. Expected: every differing step is one of the intended changes (the toolbar and counter on the two on-behalf-of screens, the bell on board cards, the stock buttons, the email box in user edit, the reminder window replacing the direct send, the grower's pickup button); list each difference with its reason in the report. Any other difference is a bug to fix before handoff.
- [ ] **Step 6: Report to James** (plain language): what was built, the proof from Task 3 and Steps 1–5, the rollout order (he runs 0104 and 0105 — either order — before the website goes live; the current site keeps working after them; no `whatsapp-dispatch` redeploy), and that nothing is pushed. Update `memory/bubble-feature-gaps-2026-11-14.md` with the branch, commits and status. Ask whether to push (and how: merge to main or a pull request).
