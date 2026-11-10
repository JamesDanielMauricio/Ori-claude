# Bubble Column Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the columns Bubble's screens show and Ori lacks, and copy Bubble's
values into them.

**Architecture:**
- Three migrations add the columns and extend the save functions. A save that
  leaves a new input out keeps the stored value.
- The web app gains the columns, the order comment, the picture link and four
  read-only additions.
- A fill script that James runs copies Bubble's values. The importer learns the
  same fields. Both use one shared mapping and picture-copying module.

**Tech Stack:**
- Postgres / Supabase: hand-written SQL migrations, RLS, PostgREST.
- React + Vite, TanStack Query, zod (`@ori/domain`), vitest.
- tsx scripts using postgres.js and supabase-js.
- Local checks: PGlite and embedded Postgres.

**Spec:** `docs/superpowers/specs/2026-11-10-bubble-column-parity-design.md`.
Read it first; this plan argues from it.

## Global Constraints

### Migrations
- They are files only. James applies them; nothing here runs them against live.
- Each new file gets a `meta/_journal.json` entry:
  - `"version": "7"` and `"breakpoints": true`;
  - `when` is the previous entry's value + 86400000.
- Never edit a migration that has already been applied.
- Every file says "Safe to run again" and is written that way: `add column if
  not exists`, `drop function if exists`, `create or replace`.

### Rules for new inputs and recreated functions
- **Rule 1, new optional function inputs:**
  - NULL (not sent) keeps the stored value.
  - Empty text clears it (stored as NULL).
  - Any other text is trimmed: `nullif(btrim(p_x), '')`.
  - On update: `x = case when p_x is null then x else nullif(btrim(p_x), '') end`.
- **Rule 2, recreated functions:**
  - Drop the old signature, then create the new one.
  - Then run `revoke execute … from public, anon;` and
    `grant execute … to authenticated, service_role;`.
  - Put a `-- SECURITY: ALLOWS … PROTECTS AGAINST …` comment above them.
- No new RLS policies or storage policies.

### Labels and limits
- Labels, exactly as written:
  - טלפון · כתובת · יישוב · הנה״ח
  - "ח.פ.: …" / "מספר בהנה״ח: …", or "—" when both are empty
  - "+ הערה כללית" / "✎ הערה כללית" / "הערה כללית: …"
  - "לחצו כאן לתמונה עדכנית"
  - משטחים במלאי · הזמנת יתר מותרת · לפי לקוח
  - "שעת איסוף HH:MM"
- Company detail limits (characters): phone 30, address 200, city 100, tax ID
  30, accounting ID 30.

### Pictures
- Only JPEG, PNG or WebP, up to 5 MB.
- **Uploads in the app** follow the family upload's steps: a fresh random name
  and the file's own content type, with no cache setting.
- **Script copies** also set `cacheControl: "31536000"`.
- **Family upload code stays exactly as it is.** Do not modify
  `use-family-mutations.ts`, `use-family-photo.ts` or `family-header.tsx`.

### Fill script
- A dry run is the default; `--commit` makes it real.
- It prints counts and Ori ids only — never phones, names, comments or secrets.

### Data, files and commits
- **Bubble is read-only.** Real export data stays in `.bubble-export/` (which is
  gitignored) or the scratchpad. Print counts only.
- **Line endings:** most existing files are CRLF. Change existing files with the
  Edit tool, which keeps their endings. New files may be LF.
- **Commits:**
  - Run `git status` before each one. Never stage `.env` or `.bubble-export/`.
  - End the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Prefix with the part: `feat(parity-1)` … `feat(parity-5)`, or
    `chore(parity)`. That way a part can be reverted as a group, which is how
    this plan meets the spec's "one commit per part".
- **End-to-end tests:** never run them locally without James's OK, because
  locally they hit live. CI runs everything on a throwaway stack.

## Review Focus

These are the failure modes most likely to bite a person, and the task that
pins each one:

1. **An old browser tab saves after the migrations.** A company, variety or
   order saved by a caller that leaves the new inputs out must keep the stored
   values. Pinned in Tasks 2, 5 and 8 (PGlite: "left out keeps") and in Tasks
   3, 6 and 9 (CI database tests).
2. **Padded or whitespace-only input.** "  050-1234567 " must save trimmed, and
   "   " must clear. Pinned in Task 3 (zod) and Task 2 (database `btrim`).
3. **The order comment fails to load before שמור is pressed.** The order must
   still save, and the stored comment must survive. Pinned in Task 7
   (`orderCommentToSend(false, …) === undefined`).
4. **A value changes in Ori between the fill's read and its write.** This
   includes a value typed in, or a stale family form writing a Bubble link back.
   It must never be overwritten, and a re-run must settle it. Pinned in Task 17
   (the SQL race and compare-and-set checks).
5. **Pallet numbers arrive as decimal strings** ("1.50", 0.1 + 0.2) in
   משטחים במלאי. They must be summed and rounded. Pinned in Task 12.

## Local tools (scratchpad, never committed)

```bash
S=/c/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/d22cd120-ac16-41cb-b3be-0ad401fa3e75/scratchpad
```

- **Harness:** `$S/harness/` (copied in Task 1). Its parts:
  - `db.mjs`: builds PGlite from the journal;
  - `seed.mjs`: writes `world.tar` and `world.json`;
  - `flows.mjs`: the steps;
  - `run.mjs`: runs them;
  - `compare.mjs`: compares two runs.
- **Build an app for the harness.** Run this from `apps/web`. Never source
  `.env` first.

  ```bash
  VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=mock-anon-key \
    VITE_API_URL=http://localhost:54399 npx vite build --outDir "$S/dist-branch"
  ```
- **Run flows:**
  - `cd $S/harness && LABEL=branch DIST_DIR="$S/dist-branch" ONLY=<flows> node run.mjs`
  - A step failed when its snapshot in `out/<LABEL>/snapshots.json` has a
    non-null `stepError` or entries in `problems`.
- **Re-seed after a migration lands in the journal:** `cd $S/harness && node seed.mjs`.
- **Pure domain tests.** The domain suite's own setup needs a local Supabase,
  which isn't here, so run single files with the shared package's config:

  ```bash
  pnpm --filter @ori/domain exec vitest run --root . --config ../shared/vitest.config.ts <file>
  ```
- **Database tests** (`rpc.test.ts`, `customer.test.ts`) run in CI only.

---

### Task 1: Harness baseline

**Files:**
- Scratch: `$S/harness/` (a copy), `$S/harness/flows.mjs`, `$S/harness/db.mjs`

**Interfaces:**
- Produces:
  - `buildDatabase({ log?, upTo? })` in `$S/harness/db.mjs`. `upTo` is a
    journal tag: stop after it.
  - `export const PLATFORM` (the Supabase stand-ins).
  - A `flows.mjs` that main's build passes with no failing step.

- [ ] **Step 1: Copy the harness:**
  `cp -r /c/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/e4c3942f-28d4-417c-97ec-487140506a1e/scratchpad/harness "$S/harness"`.
  - In the copied `db.mjs`, export `PLATFORM` and add the `upTo` option.
  - In `run-both.sh` and `recheck.sh`, point `S=` at this session's scratchpad.
- [ ] **Step 2:** Run `cd $S/harness && node try-build.mjs`. Expected:
  `migrationsApplied: 91` (0047 is skipped; it counts the rest).
- [ ] **Step 3:** Build main's app into `$S/dist-main`.
  - We're on the branch, but the branch has no app changes yet, so it is main's
    app.
  - Run `node seed.mjs`, then
    `LABEL=main DIST_DIR="$S/dist-main" node run.mjs`.
  - Expected: 16 failing steps:
    - bo-products: open caps, add cap, change family, save family, new family,
      delete empty family, delete new variety, edit then escape, edit family
      photo state, cancel family edit, column picker, hide a column, close
      column picker;
    - customer-flow: choose quantity, save, send.
- [ ] **Step 4: Repair `flows.mjs`.**
  - Delete the two cap steps. Per-customer caps were removed in 0087 and 0091.
  - Fix the other 14 selectors against today's UI: read each step's
    `stepError` and its screenshot.
- [ ] **Step 5:** Re-run `LABEL=main DIST_DIR="$S/dist-main" node run.mjs`.
  Expected: every step has `stepError === null` and empty `problems`. Keep this
  run as the baseline (`out/main`). Nothing to commit.

### Task 2: Migration 0092 — company details

**Files:**
- Create: `packages/db/migrations/0092_company-contact-details.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append idx 92)
- Modify: `packages/db/src/schema/company.ts`
- Modify: `packages/db/src/supabase-types.ts`
  - `companies` Row/Insert/Update, about line 59
  - `save_grower`, `save_customer`, `save_transporter` Args, about lines
    1157–1199
- Scratch: `$S/parity/check-migrations.mjs`

**Interfaces:**
- Consumes: `buildDatabase`, `PLATFORM` (Task 1).
- Produces (SQL): the three functions keep their current parameters, followed
  by `p_phone text default null`, `p_address_line text default null`,
  `p_city text default null`, `p_tax_id text default null` and
  `p_accounting_id text default null`. All three still return
  `public.companies`.
- Produces (types):
  - `companies.Row` gets `phone`, `address_line`, `city`, `tax_id` and
    `accounting_id`, each `string | null`. Insert/Update get the same fields as
    optional.
  - Each function's Args get `p_phone?: string | null` … `p_accounting_id?: string | null`.
- Produces (tool): `node $S/parity/check-migrations.mjs <0092|0093|0094> [--mutant=<name>]`.
  Later tasks add their own sections.

- [ ] **Step 1: Write the failing check, section `0092`.**
  - BEFORE is `buildDatabase({ upTo: "0091_after-web-deploy-close-prices-to-growers-drop-caps" })`.
    AFTER is BEFORE plus the 0092 file's text.
  - Seed both with direct inserts into `auth.users`, `companies` and
    `profiles`: one back-office user and company, one grower user and company,
    one customer company and one transporter company.
  - Run calls as a role:
    `begin; set local role authenticated; select set_config('request.jwt.claim.sub', <user id>, true); …`.
    For an anonymous caller, use `set local role anon`.
  - Assertions on AFTER:
    1. `companies` has the five columns, `text`, nullable.
    2. `pg_proc` holds exactly one each of `save_grower`, `save_customer` and
       `save_transporter`.
    3. Each `proacl` contains `authenticated=X` and `service_role=X`. It
       contains no `anon=X` and no PUBLIC entry (a leading `=X/`).
    4. As back office, for each function:
       - creating with `p_phone => ' 050-1234567 '` stores `050-1234567`;
       - an update that leaves the five out keeps all five;
       - `p_city => ''` and `p_tax_id => '   '` store NULL.
    5. As anon, `save_customer(…)` fails with SQLSTATE `42501`.
    6. As the grower user, `save_customer(…)` fails with `42501` (the
       function's own FORBIDDEN).
    7. The same `save_grower` update, with the new inputs left out, returns
       the same row on BEFORE and AFTER, apart from the five new columns.
- [ ] **Step 2:** Run `node $S/parity/check-migrations.mjs 0092`. Expected:
  FAIL, because the migration file doesn't exist.
- [ ] **Step 3: Write `0092_company-contact-details.sql`.**
  - **Header:** what it does; that it runs before the web app of the same
    release; that old copies of the app keep working; "Safe to run again."
  - **Columns:** `alter table public.companies add column if not exists phone text, …`,
    covering all five. Add a `comment on column` for each, naming the Bubble
    field and the Ori label.
  - **Drop the old signatures:**
    - `public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean)`
    - `public.save_customer(uuid, text, public.company_status, boolean, text, uuid)`
    - `public.save_transporter(uuid, text, public.company_status, text, uuid)`
  - **Recreate each function** from its latest body:
    - `save_grower` from 0082, lines 82–161;
    - `save_customer` from 0080, lines 21–99;
    - `save_transporter` from 0057, lines 170–213.

    The only changes:
    - the five parameters are appended;
    - each insert adds the five as `nullif(btrim(p_x), '')`;
    - each update adds the rule 1 `case` for each;
    - `comment on function` uses the new signature.
  - **Permissions:** one block per function, for example:

    ```sql
    -- SECURITY: ALLOWS signed-in users and the service role to call save_customer;
    -- inside, only the back office passes the current_role() check.
    -- PROTECTS AGAINST anonymous visitors calling it at all: live granted anon and
    -- PUBLIC on save_customer and save_transporter until now (refused inside, but
    -- reachable). 0082 closed the same gap on save_grower.
    revoke execute on function public.save_customer(uuid, text, public.company_status, boolean, text, uuid, text, text, text, text, text) from public, anon;
    grant execute on function public.save_customer(uuid, text, public.company_status, boolean, text, uuid, text, text, text, text, text) to authenticated, service_role;
    ```
  - **Journal:** append
    `{ "idx": 92, "version": "7", "when": 1792098000000, "tag": "0092_company-contact-details", "breakpoints": true }`.
- [ ] **Step 4:** Run `node $S/parity/check-migrations.mjs 0092`. Expected: PASS.
  Then run `node $S/harness/try-build.mjs`. Expected: `migrationsApplied: 92`.
- [ ] **Step 5: Mutants.** Each one must FAIL:
  - `--mutant=no-keep`: every rule 1 `case when p_… is null then … else …`
    is replaced by `nullif(btrim(p_…), '')`. Assertion 4 must fail.
  - `--mutant=no-revoke`: the `revoke` lines are removed. Assertion 3 must
    fail.
- [ ] **Step 6: Drizzle schema and types.**
  - In `company.ts`, add `phone: text("phone")`,
    `addressLine: text("address_line")`, `city: text("city")`,
    `taxId: text("tax_id")` and `accountingId: text("accounting_id")`, each
    with a one-line comment naming migration 0092 and the Bubble field.
  - In `supabase-types.ts`, add what Interfaces lists.
  - Run `pnpm typecheck`. Expected: passes.
- [ ] **Step 7: Commit:** `feat(parity-1): company phone, address, city and tax IDs (migration 0092)`.

### Task 3: Domain — company details inputs

**Files:**
- Modify: `packages/domain/src/reference-data/schemas.ts`
- Modify: `packages/domain/src/reference-data/index.ts` (exports)
- Test: `packages/domain/src/reference-data/schemas.test.ts` (runs locally)
- Test: `packages/domain/src/reference-data/rpc.test.ts` (CI only)

**Interfaces:**
- Consumes: the 0092 functions (Task 2).
- Produces:

  ```ts
  export const COMPANY_DETAIL_MAX_LENGTH: { readonly phone: 30; readonly addressLine: 200; readonly city: 100; readonly taxId: 30; readonly accountingId: 30 };
  export const companyDetailsSchema: z.ZodObject<{ phone; addressLine; city; taxId; accountingId }>; // each z.string().trim().max(n).optional()
  export type CompanyDetailsInput = z.infer<typeof companyDetailsSchema>;
  export function toCompanyDetailsRpcArgs(input: CompanyDetailsInput): { p_phone?: string; p_address_line?: string; p_city?: string; p_tax_id?: string; p_accounting_id?: string };
  ```

  - `saveGrowerInputSchema`, `saveCustomerInputSchema` and
    `saveTransporterInputSchema` become `.extend(companyDetailsSchema.shape)`.
  - Their `to…RpcArgs` spread `toCompanyDetailsRpcArgs(input)`. A key is
    present only when its field is defined.

- [ ] **Step 1: Write the failing tests** in `schemas.test.ts`:
  - `it("company details (0092): trimmed, an empty string kept to clear, and left out of the call when not given")`.
    It parses the grower base plus `phone: "  050-1234567 "` and
    `city: "   "`, then expects:
    - `args.p_phone === "050-1234567"`;
    - `args.p_city === ""`;
    - `"p_address_line" in args === false` and `"p_tax_id" in args === false`.
  - `it("company details (0092): a value over its limit is refused")`:
    - a 31-character phone fails;
    - `addressLine` passes at 200 characters and fails at 201;
    - `city` fails at 101;
    - `taxId` and `accountingId` fail at 31.
  - `it("company details (0092): customers and transporters send the same arguments")`:
    - for a customer, `taxId: "123456789", accountingId: "4321"` gives
      `p_tax_id "123456789"` and `p_accounting_id "4321"`;
    - for a transporter, `phone: "03-5000000"` gives `p_phone "03-5000000"`.
- [ ] **Step 2:** Run
  `pnpm --filter @ori/domain exec vitest run --root . --config ../shared/vitest.config.ts src/reference-data/schemas.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** in `schemas.ts`, with a comment explaining rule 1.
  Add the four new exports to `index.ts`.
- [ ] **Step 4:** Run the same command, then `pnpm --filter @ori/domain typecheck`.
  Expected: PASS.
- [ ] **Step 5: Add the CI test** to `rpc.test.ts`:
  `it("save_grower/save_customer/save_transporter (migration 0092): store company details trimmed, keep them when left out, clear them with an empty string")`.
  For each function:
  - create with all five, padded → the returned row has them trimmed;
  - save again with the five left out → unchanged;
  - save with `city: ""` → `city === null`.
- [ ] **Step 6: Commit:** `feat(parity-1): company details in the company save inputs`.

### Task 4: Web — company detail columns

**Files:**
- Modify: `apps/web/src/lib/queries/reference-data.ts`
  - the `GrowerCompany`, `CustomerCompany` and `TransporterCompany` types;
  - the three `companies` selects (about lines 205, 252 and 271).
- Create: `apps/web/src/components/reference-data/company-details.ts`, plus `company-details.test.ts`
- Create: `apps/web/src/components/reference-data/company-detail-columns.tsx`
- Modify: `apps/web/src/routes/backoffice/growers.tsx`, `customers.tsx`, `transporters.tsx`

**Interfaces:**
- Consumes: `COMPANY_DETAIL_MAX_LENGTH`, plus the extended schemas and
  mappers (Task 3).
- Produces:

  ```ts
  export interface CompanyDetailsRow { phone: string | null; address_line: string | null; city: string | null; tax_id: string | null; accounting_id: string | null }
  export interface CompanyDetailsForm { phone: string; addressLine: string; city: string; taxId: string; accountingId: string }
  export const BLANK_COMPANY_DETAILS: CompanyDetailsForm;
  export function toCompanyDetailsForm(row: CompanyDetailsRow): CompanyDetailsForm;
  export function toCompanyDetailsRow(form: CompanyDetailsForm): CompanyDetailsRow; // trimmed; "" -> null
  export function taxAccountingLines(row: Pick<CompanyDetailsRow, "tax_id" | "accounting_id">): string[];
  export function buildCompanyDetailColumns<Row extends CompanyDetailsRow>(ctx: { details: CompanyDetailsForm; onChange: (patch: Partial<CompanyDetailsForm>) => void }): { beforeContact: RecordTableColumn<Row>[]; afterContact: RecordTableColumn<Row>[] };
  ```

  - The three company types extend `CompanyDetailsRow`.

- [ ] **Step 1: Write the failing tests** in `company-details.test.ts`:
  - `taxAccountingLines({ tax_id: "514000000", accounting_id: "77" })`
    → `["ח.פ.: 514000000", "מספר בהנה״ח: 77"]`.
  - `taxAccountingLines({ tax_id: null, accounting_id: " 77 " })`
    → `["מספר בהנה״ח: 77"]`.
  - `taxAccountingLines({ tax_id: "", accounting_id: null })` → `[]`.
  - `toCompanyDetailsRow({ phone: " 050 ", addressLine: "", city: "חדרה", taxId: "  ", accountingId: "9" })`
    → `{ phone: "050", address_line: null, city: "חדרה", tax_id: null, accounting_id: "9" }`.
  - `toCompanyDetailsForm` turns nulls into `""`.
- [ ] **Step 2:** Run
  `pnpm --filter @ori/web exec vitest run src/components/reference-data/company-details.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement `company-details.ts`, then run the same command.
  Expected: PASS.
- [ ] **Step 4: Write `company-detail-columns.tsx`.**
  - `beforeContact` holds טלפון, כתובת and יישוב; `afterContact` holds הנה״ח.
  - Column keys are `phone`, `address`, `city` and `taxAccounting`.
  - **Read mode:** the value, or "—". הנה״ח shows the lines from
    `taxAccountingLines`, or "—" when there are none.
  - **Edit mode:** `inputClassName` inputs.
    - Each `aria-label` is the column label. For הנה״ח the two inputs are
      labelled "ח.פ." and "מספר בהנה״ח".
    - `maxLength` comes from `COMPANY_DETAIL_MAX_LENGTH`.
    - The phone and both IDs are `dir="ltr"`; the phone also gets
      `inputMode="tel"`.
- [ ] **Step 5: Wire up each of the three screens.**
  - `FormState.details: CompanyDetailsForm`, and `BLANK_FORM.details = BLANK_COMPANY_DETAILS`.
  - `blankRow()` sets the five columns to `null`.
  - `toFormState` sets `details: toCompanyDetailsForm(row)`.
  - The optimistic patch spreads `toCompanyDetailsRow(form.details)`.
  - The save input adds `phone`, `addressLine`, `city`, `taxId` and
    `accountingId` from `form.details`. The UI always sends all five, so an
    emptied box clears.
  - Add `...beforeContact` just before the `contactPerson` column and
    `...afterContact` just after it.
- [ ] **Step 6:** Run `pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint`.
  Expected: clean.
- [ ] **Step 7: Harness check.**
  - Re-seed. First give grower `G[0]` phone `04-6000000`, tax ID `514000000`
    and accounting ID `77` in `seed.mjs`.
  - Build the branch app.
  - In `bo-reference`, add two steps:
    - "growers detail columns": the grower row shows `ח.פ.: 514000000` under
      הנה״ח.
    - "edit grower phone": ✎, type ` 050-1234567 `, then שמור. The cell then
      shows `050-1234567`, and the `rpc/save_grower` request body has
      `p_phone`.
  - Run `ONLY=bo-reference`. Expected: no failing step.
- [ ] **Step 8: Commit:** `feat(parity-1): טלפון, כתובת, יישוב and הנה״ח on growers, customers and transporters`.

### Task 5: Migration 0093 — order comment

**Files:**
- Create: `packages/db/migrations/0093_order-comment.sql`
- Modify: `meta/_journal.json` (append idx 93)
- Modify: `packages/db/src/schema/daily-order.ts`
- Modify: `supabase-types.ts`: `daily_orders` Row/Insert/Update, and the
  `submit_order` Args
- Scratch: `$S/parity/check-migrations.mjs`, section `0093`

**Interfaces:**
- Produces:
  - `submit_order(p_trading_day_id uuid, p_lines jsonb, p_customer_company_id uuid default null, p_comment text default null) returns public.daily_orders`.
  - `daily_orders.Row.comment: string | null`.
  - In Args, `p_comment?: string | null`.

- [ ] **Step 1: Write the failing check, section `0093`.**
  - Re-seed the harness world first, so `world.tar` is at 0092.
  - BEFORE is `world.tar`; AFTER is the same plus the 0093 text. Each scenario
    gets a fresh copy.
  - Use world users `c1`, `c2` and `bo`, and today's open day.
  - Assertions:
    1. `daily_orders.comment` exists (text, nullable). There is one
       `submit_order`, and its `proacl` follows rule 2.
    2. As `c1`:
       - c1's current lines plus `p_comment => '  להביא לפני 6 '` store
         `להביא לפני 6`;
       - the same lines without `p_comment` keep it;
       - `p_comment => ''` stores NULL.
    3. As `c1` with `p_customer_company_id` set to c2's company: refused with
       the same SQLSTATE as BEFORE. c2's comment is unchanged.
    4. As `bo` on behalf of c2, with a comment: stored.
    5. **BEFORE vs AFTER**, comparing BEFORE's 3-argument call with AFTER's
       call without `p_comment`. These come out identical, after normalising
       ids and timestamps:
       - c1's `daily_order_products`;
       - the new `order_submission_logs.snapshot`;
       - the new `notification_outbox` rows (`template_key`, `payload`);
       - `daily_orders.status`.
    6. After `close_shop` as `bo`, c1's send with a comment fails with the
       same SQLSTATE as BEFORE, and the comment is unchanged.
- [ ] **Step 2:** Run `node $S/parity/check-migrations.mjs 0093`. Expected: FAIL.
- [ ] **Step 3: Write `0093_order-comment.sql`.**
  - **Header**, ending "Safe to run again."
  - **Column:** `alter table public.daily_orders add column if not exists comment text;`,
    plus a `comment on column`.
  - **Drop:** `drop function if exists public.submit_order(uuid, jsonb, uuid);`.
  - **Recreate** from 0076, from its
    `create or replace function public.submit_order(` at line 534 through
    the end of that function body (`return v_order;` is at line 847). Keep it
    unchanged apart from two things:
    - the new parameter;
    - in the stamping update at 0076 lines 790–793, add
      `comment = case when p_comment is null then comment else nullif(btrim(p_comment), '') end`.
  - Update `comment on function`.
  - **Permissions:** a SECURITY comment, then
    `revoke … from public, anon; grant … to authenticated, service_role;`.
  - **Journal:**
    `{ "idx": 93, "version": "7", "when": 1792184400000, "tag": "0093_order-comment", "breakpoints": true }`.
- [ ] **Step 4:** Run the check. Expected: PASS. Then run
  `--mutant=no-keep`, which replaces the `case` with
  `nullif(btrim(p_comment), '')`. Expected: FAIL on assertion 2.
- [ ] **Step 5:** In `daily-order.ts`, add `comment: text("comment")` and
  import `text`. Update the types. Run `pnpm typecheck`.
- [ ] **Step 6: Commit:** `feat(parity-2): order comment column and submit_order input (migration 0093)`.

### Task 6: Domain — order comment input

**Files:**
- Modify: `packages/domain/src/customer/schemas.ts`
- Create: `packages/domain/src/customer/schemas.test.ts` (runs locally)
- Test: `packages/domain/src/customer/customer.test.ts` (CI only)

**Interfaces:**
- Produces:
  - `submitOrderInputSchema` gets `comment: z.string().trim().optional()`.
  - `toSubmitOrderRpcArgs(input)` adds `p_comment` only when
    `input.comment !== undefined`.

- [ ] **Step 1: Write the failing tests:**
  - `it("submit_order args (0093): an order comment is sent trimmed")`:
    `p_comment === "להביא לפני 6"`.
  - `it("submit_order args (0093): left out, p_comment is not sent, so the stored comment is kept")`:
    `"p_comment" in args === false`.
  - `it("submit_order args (0093): an empty comment is sent so it clears")`:
    `p_comment === ""`.
- [ ] **Step 2:** Run the pure domain command on `src/customer/schemas.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement, then run it again. Expected: PASS. Then run
  `pnpm --filter @ori/domain typecheck`.
- [ ] **Step 4: Add the CI test** to `customer.test.ts`:
  `it("submit_order (migration 0093): stores the order comment trimmed, keeps it when left out, clears it with an empty string, and refuses a customer's own change once the shop has closed")`.
  Use the existing `createOpenTestDay`, `createTestCustomer`, `pickLine` and
  `signedInCustomer`.
- [ ] **Step 5: Commit:** `feat(parity-2): order comment in the submit_order input`.

### Task 7: Web — order comment

**Files:**
- Modify: `apps/web/src/components/customer/order-draft.ts`, plus its test
- Modify: `apps/web/src/lib/queries/customer.ts`
- Modify: `apps/web/src/components/customer/order-lines-editor.tsx`
- Modify: `apps/web/src/components/customer/comment-popup.tsx`
- Modify: `apps/web/src/components/customer/submission-confirmation-dialog.tsx`
- Modify: `apps/web/src/lib/queries/oversight.ts` (the `ordersForDay` select
  and `DailyOrderForDay`)
- Modify: `apps/web/src/routes/backoffice/distributor-customer.tsx`

**Interfaces:**
- Consumes: the `comment` input (Task 6).
- Produces:

  ```ts
  export function orderCommentToSend(loaded: boolean, draft: string): string | undefined; // undefined = left out (keeps the stored comment)
  export function orderCommentChanged(saved: string | null | undefined, draft: string): boolean; // trimmed compare; null ≡ ""
  customerQueries.orderComment(tradingDayId: string, customerCompanyId?: string); // -> { id: string; comment: string | null } | null, key ["customer","order-comment",tradingDayId,customerCompanyId ?? "own"]
  ```

  - `CommentPopup` gets `title?: string`; the default stays "הערה".
  - `SubmissionConfirmationDialog` gets `orderComment?: string`.
  - `DailyOrderForDay.comment: string | null`.

- [ ] **Step 1: Write the failing tests** in `order-draft.test.ts`:
  - `orderCommentToSend(false, "abc") === undefined`
  - `orderCommentToSend(true, "  abc ") === "abc"`
  - `orderCommentToSend(true, "") === ""`
  - `orderCommentChanged(null, "  ") === false`
  - `orderCommentChanged("abc", " abc ") === false`
  - `orderCommentChanged("abc", "") === true`
  - `orderCommentChanged(undefined, "x") === true`
- [ ] **Step 2:** Run
  `pnpm --filter @ori/web exec vitest run src/components/customer/order-draft.test.ts`.
  Expected: FAIL. Implement, then run again. Expected: PASS.
- [ ] **Step 3: Add the query.** It reads `daily_orders` `(id, comment)` for
  `trading_day_id`, adds `.eq("customer_company_id", …)` only when a company
  is given, and uses `.maybeSingle()`.
- [ ] **Step 4: Wire up the editor:**
  - **Draft state:** `commentDraft` state and a `commentEdited` ref. A refetch
    re-seeds the draft only while it hasn't been edited.
  - **Unsaved changes:** `dirty ||= orderCommentChanged(commentQuery.data?.comment, commentDraft)`.
  - **Discard** restores the comment and clears `commentEdited`.
  - **Saving:**
    - The submit input adds `comment: orderCommentToSend(commentQuery.isSuccess, commentDraft)`.
    - On success, clear `commentEdited` and invalidate the comment query.
  - **The button:** in `ActionBar`'s `extra`, before the count, styled like the
    line-comment button. It reads "✎ הערה כללית" when there's text and
    "+ הערה כללית" when there isn't. It opens
    `<CommentPopup title="הערה כללית" …>`.
  - **Confirmation:** pass `orderComment={commentDraft.trim() || undefined}`.
  - **Read-only:** above the card, show `הערה כללית: {comment}` when there is
    one, and no button.
- [ ] **Step 5: בשם לקוח.** Add `comment` to `ordersForDay` and its type. In the
  expanded row, above `FamilyGroupedLines`, show
  `הערה כללית: {order.comment}` when there is one.
- [ ] **Step 6:** Run `pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint && pnpm --filter @ori/web test`.
- [ ] **Step 7: Harness check.**
  - Re-seed (now at 0093). In `seed.mjs`, give c1's order for today the
    comment `להביא לפני 6`.
  - Add steps:
    - customer-flow: "order comment shows ✎";
    - customer-flow: "edit order comment and send". The `rpc/submit_order`
      request body has `p_comment`.
    - bo-oversight: "בשם לקוח shows הערה כללית". Expanding c1 shows the
      comment.
  - Run `ONLY=customer-flow,bo-oversight`. Expected: no failing step.
- [ ] **Step 8: Commit:** `feat(parity-2): הערה כללית on the order editor and בשם לקוח`.

### Task 8: Migration 0094 — variety pictures

**Files:**
- Create: `packages/db/migrations/0094_variety-pictures.sql`
- Modify: `meta/_journal.json` (append idx 94)
- Modify: `packages/db/src/schema/product-variety.ts`
- Modify: `supabase-types.ts`: `product_varieties` Row/Insert/Update, the
  `save_product` Args, and the `get_orderable_catalog_for_customer` Returns
- Scratch: `$S/parity/check-migrations.mjs`, section `0094`

**Interfaces:**
- Produces:
  - `save_product(…its 15 parameters…, p_image_url text default null)`.
  - The catalog function returns a last column, `variety_image_url text`.
  - In types: `p_image_url?: string | null`, and Returns gets
    `variety_image_url: string | null`.

- [ ] **Step 1: Write the failing check, section `0094`.**
  - Re-seed first (world at 0093). AFTER is the world plus 0094.
  - If the world has no customer user with a category or a blocked product,
    seed one.
  - Assertions:
    1. The column exists. There is one `save_product` and one
       `get_orderable_catalog_for_customer`, and both `proacl`s follow rule 2.
    2. As `bo`, on an existing variety at its current version:
       - `p_image_url => ' https://example.test/a.jpg '` stores it trimmed,
         and `version` goes up by 1;
       - the next save, leaving it out, keeps it;
       - `''` stores NULL.
    3. A stale `p_expected_version` with a picture still raises `P0003`.
    4. **Catalog, for c1, c2 and bo on behalf of c1:**
       - every row has `variety_image_url`;
       - the variety from assertion 2 returns its picture;
       - otherwise the row set is identical to BEFORE's, sorted by
         `variety_id`. That includes blocked products and categories.
- [ ] **Step 2:** Run the check. Expected: FAIL.
- [ ] **Step 3: Write `0094_variety-pictures.sql`.**
  - **Header**, ending "Safe to run again."
  - **Column:** `alter table public.product_varieties add column if not exists image_url text;`,
    plus a comment.
  - **save_product:**
    - drop `public.save_product(uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric, boolean, boolean, integer, integer, jsonb)`;
    - recreate it from 0087, lines 25–106. Only `p_image_url` is added: the
      insert takes `nullif(btrim(p_image_url), '')`, and the update uses the
      rule 1 `case`.
  - **Catalog function:**
    - drop `public.get_orderable_catalog_for_customer(uuid, uuid)`;
    - recreate it from 0090, lines 165–325, with `variety_image_url text`
      appended to `returns table` and the variety's `image_url` appended as
      the last select expression.
  - Update `comment on function` for both, then add both permission blocks.
  - **Journal:**
    `{ "idx": 94, "version": "7", "when": 1792270800000, "tag": "0094_variety-pictures", "breakpoints": true }`.
- [ ] **Step 4:** Run the check. Expected: PASS. Then two mutants:
  - `--mutant=null-picture` (the catalog selects `null::text`) must fail
    assertion 4;
  - `--mutant=no-revoke` must fail assertion 1.
- [ ] **Step 5:** In `product-variety.ts`, add `imageUrl: text("image_url")`.
  Update the types, then run `pnpm typecheck`.
- [ ] **Step 6: Commit:** `feat(parity-3): variety picture column, save_product input and catalog column (migration 0094)`.

### Task 9: Domain — variety picture input

**Files:**
- Modify: `packages/domain/src/reference-data/schemas.ts`, plus `schemas.test.ts`
- Test: `rpc.test.ts` and `customer/customer.test.ts` (CI only)

**Interfaces:**
- Produces:
  - `saveProductInputSchema` gets `imageUrl: z.string().trim().optional()`.
  - `toSaveProductRpcArgs` adds `p_image_url` only when it is defined.

- [ ] **Step 1: Write the failing test:**
  `it("save_product args (0094): a picture link is sent trimmed, an empty one is sent to remove it, and when left out it is not sent")`.
- [ ] **Step 2:** Run the pure domain command. Expected: FAIL. Implement, then
  run again. Expected: PASS.
- [ ] **Step 3: Add the CI tests:**
  - in `rpc.test.ts`:
    `it("save_product (migration 0094): sets the variety picture, keeps it when left out, removes it with an empty string")`;
  - in `customer.test.ts`:
    `it("get_orderable_catalog_for_customer (migration 0094): returns the variety's own picture as variety_image_url, null when it has none")`.
- [ ] **Step 4: Commit:** `feat(parity-3): variety picture in the save_product input`.

### Task 10: Web — variety pictures on מוצרים and מוצרים שנקטפו

**Files:**
- Modify: `apps/web/src/lib/queries/reference-data.ts`:
  `ProductVariety.image_url: string | null`, and `image_url` in the products
  select.
- Modify: `components/reference-data/product-catalog/catalog-form.tsx`:
  `FormState.imageUrl`, `blankForm`, `toFormState`, and `image_url: null` in
  `blankRow`.
- Create: `product-catalog/variety-photo.ts`, plus `variety-photo.test.ts`
- Create: `product-catalog/use-variety-photo.ts`
- Create: `product-catalog/variety-photo-button.tsx`
- Modify: `product-catalog/variety-columns.tsx`, `product-catalog/use-variety-mutations.ts`
- Modify: `components/reference-data/product-catalog-screen.tsx`

**Interfaces:**
- Consumes: `imageUrl` (Task 9); `PHOTO_MIME_EXTENSIONS`, `PHOTO_MAX_BYTES`,
  `PRODUCT_PHOTOS_BUCKET` and `productPhotoPathFromUrl` from `catalog-form.tsx`.
  These are read only.
- Produces:

  ```ts
  export function replacedPhotoPath(previousUrl: string | null, nextUrl: string | null): string | null; // previous file's path in OUR storage when it changed, else null
  export async function uploadVarietyPhoto(supabase: ReturnType<typeof createClient>, file: File): Promise<string>; // `${crypto.randomUUID()}.${ext}`, contentType: file.type, no cacheControl; returns getPublicUrl
  export function useVarietyPhoto(args: { showToast: ShowToast; setForm: Dispatch<SetStateAction<FormState>> }): { pendingPhotoFile: File | null; setPendingPhotoFile: (file: File | null) => void; photoPreviewUrl: string | null; photoInputRef: RefObject<HTMLInputElement | null>; handlePhotoFileChange: (event: ChangeEvent<HTMLInputElement>) => void; handleRemovePhoto: () => void };
  export function VarietyPhotoButton(props: { pendingPhotoFile: File | null; imageUrl: string; previewUrl: string | null; inputRef: RefObject<HTMLInputElement | null>; disabled: boolean; onRemove: () => void }): JSX.Element;
  ```

  - `VarietyColumnsContext` gets `photo: ReturnType<typeof useVarietyPhoto>`
    and `saving: boolean`.
  - `useVarietyMutations` gets `pendingPhotoFile` and `setPendingPhotoFile`.

- [ ] **Step 1: Write the failing tests:**
  - `replacedPhotoPath(".../storage/v1/object/public/product-photos/a.jpg", ".../product-photos/b.jpg") === "a.jpg"`
  - with the same URL twice → `null`
  - previous `null` → `null`
  - previous `"https://x.cdn.bubble.io/f/a.jpg"` → `null` (not ours)
  - previous ours, next `null` → `"a.jpg"`
- [ ] **Step 2:** Run
  `pnpm --filter @ori/web exec vitest run src/components/reference-data/product-catalog/variety-photo.test.ts`.
  Expected: FAIL. Implement `variety-photo.ts`, then run again. Expected:
  PASS.
- [ ] **Step 3: Hook and button.** Mirror `useFamilyPhoto` and
  `FamilyPhotoButton`, with the same validation toasts. The labels are
  "העלאת תמונת הזן", "החלפת תמונת הזן" and "הסרת תמונה". Leave the family
  files untouched.
- [ ] **Step 4: Name column.**
  - **Read:** the `NAME_GUTTER` slot holds
    `<ProductThumbnail imageUrl={row.image_url} size="sm" />` when there is a
    picture, and stays empty when there isn't. The name follows.
  - **Edit:** the gutter holds `VarietyPhotoButton` and a hidden
    `<input type="file" accept="image/jpeg,image/png,image/webp">`.
- [ ] **Step 5: Mutations and screen.**
  - **Save:**
    1. If a file is pending, upload it first. The result is the picture link.
    2. Otherwise, send `imageUrl: form.imageUrl.trim()`. `""` removes the
       picture.
    3. The optimistic patch includes `image_url`.
    4. On success, remove `replacedPhotoPath(previous, saved.image_url)`
       (best-effort, with a `console.warn` on failure) and clear the pending
       file.
  - **Delete** removes the variety's own picture, best-effort, and only when it
    is in Ori's storage.
  - **Screen:**
    - Use `useVarietyPhoto`.
    - Set `dirty = hasChanges(form, baseline) || pendingPhotoFile !== null`.
    - Clear the pending file when an edit starts or is cancelled.
    - Pass `photo` and `saving` into `buildVarietyColumns`.
- [ ] **Step 6:** Run `pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint && pnpm --filter @ori/web test`.
- [ ] **Step 7: Harness check.** Re-seed (now at 0094). In `bo-products`, add
  steps:
  - "variety photo upload": edit a variety, pick a JPEG, then שמור. A storage
    upload happens, followed by `rpc/save_product` carrying `p_image_url`, and
    the thumbnail shows.
  - "variety photo remove": ×, then שמור. `p_image_url` is `""`.

  Run `ONLY=bo-products,bo-picked-products`. Expected: no failing step.
- [ ] **Step 8: Commit:** `feat(parity-3): variety pictures on מוצרים and מוצרים שנקטפו`.

### Task 11: Web — picture link on the customer order list

**Files:**
- Modify: `apps/web/src/components/customer/catalog-grouping.ts`:
  `CatalogRow.variety_image_url: string | null`, with a comment.
- Modify: `apps/web/src/components/customer/order-product-list.tsx`
- Modify: `apps/web/src/components/customer/order-lines-editor.tsx`, in the
  families map.

**Interfaces:**
- Consumes: `variety_image_url` (Task 8).
- Produces: `OrderVarietyRow.imageUrl?: string | null`.

- [ ] **Step 1: Map the field.** In the editor's families map, add
  `imageUrl: row.variety_image_url`.
- [ ] **Step 2: Add the link.** In `OrderProductList`'s variety row:
  - when `imageUrl` is set, show a link-styled button,
    "לחצו כאן לתמונה עדכנית";
  - the list owns `pictureFor` state;
  - the button opens `<Dialog title={varietyName}>` containing
    `<img src={imageUrl} alt={varietyName} className="max-h-[70vh] w-full object-contain">`.
  - It is shown in read-only mode too.
- [ ] **Step 3:** Run `pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint`.
- [ ] **Step 4: Harness check.**
  - In `seed.mjs`, give one of today's orderable varieties an `image_url` in
    the fake storage.
  - Add the customer-flow step "variety picture link opens the picture". The
    dialog shows an `img` with that `src`.
  - Run `ONLY=customer-flow`. Expected: no failing step.
- [ ] **Step 5: Commit:** `feat(parity-3): "לחצו כאן לתמונה עדכנית" on the customer order list`.

### Task 12: Web — משטחים במלאי on מוצרים שנקטפו

**Files:**
- Modify: `apps/web/src/lib/queries/picked-products.ts`
- Create: `apps/web/src/lib/queries/picked-products.test.ts`
- Modify: `apps/web/src/routes/backoffice/picked-products.tsx`
- Modify: `components/reference-data/product-catalog-screen.tsx`, `product-catalog/variety-columns.tsx`

**Interfaces:**
- Produces:

  ```ts
  export function sumStockByVariety(lines: ReadonlyArray<{ product_variety_id: string; pallets_picked: number | string | null; leftover_pallets: number | string | null }>): ReadonlyMap<string, number>; // parsePallets each, roundPallets the sum, keep totals > 0
  export interface PickedStock { varietyIds: ReadonlySet<string>; stockByVariety: ReadonlyMap<string, number> }
  export const NO_PICKED_STOCK: PickedStock;
  // pickedProductsQueries.varietiesForDay(dayId): queryFn returns Array<[string, number]>; select (module-level) returns PickedStock
  ```

  - `ProductCatalogScreen` prop: `stockByVariety?: ReadonlyMap<string, number>`.
  - `VarietyColumnsContext` gets `stockByVariety?`.

- [ ] **Step 1: Write the failing tests:**
  - Variety A has two lines: (`"1.50"`, `0.1`) and (`0.2`, `null`). It sums
    to exactly `1.8`.
  - Variety B with (`0`, `0`) is absent from the map.
  - `"2.00"` parses as `2`.
- [ ] **Step 2:** Run
  `pnpm --filter @ori/web exec vitest run src/lib/queries/picked-products.test.ts`.
  Expected: FAIL. Implement, then run again. Expected: PASS.
- [ ] **Step 3: Wire it up.**
  - **Route:** pass `varietyIds={stock.varietyIds}` and
    `stockByVariety={stock.stockByVariety}`, falling back to
    `NO_PICKED_STOCK`.
  - **Columns:** when `stockByVariety` is given, add a column right after
    `name`:
    - key `stock`, label "משטחים במלאי";
    - read-only, showing `formatPallets(stockByVariety.get(row.id) ?? 0)`;
    - no `groupLabel`.
- [ ] **Step 4:** Typecheck and lint. Then run the harness with
  `ONLY=bo-picked-products`. The column shows the seeded totals.
- [ ] **Step 5: Commit:** `feat(parity-4): משטחים במלאי on מוצרים שנקטפו`.

### Task 13: Web — הזמנת יתר מותרת in the סידור strip

**Files:**
- Modify: `apps/web/src/lib/queries/arrangement.ts`. In `boardData` only, both
  `product_varieties(…)` embeds get `no_overbooking`.
- Modify: `apps/web/src/components/arrangement/board-data.ts`, plus `board-data.test.ts`
- Modify: `apps/web/src/components/arrangement/product-strip.tsx`

**Interfaces:**
- Produces:
  - `BoardVarietyRow.no_overbooking?: number`. It's optional, like `sizes`.
  - `BoardProduct.overbookingAllowed: number`, set to
    `parsePallets(variety.no_overbooking ?? 0)`.

- [ ] **Step 1: Write the failing test:**
  `it("a board product carries its variety's overbooking allowance, 0 when the row has none")`.
- [ ] **Step 2:** Run
  `pnpm --filter @ori/web exec vitest run src/components/arrangement/board-data.test.ts`.
  Expected: FAIL. Implement, then run again. Expected: PASS, including every
  existing test.
- [ ] **Step 3: Add the stat.** In `STATS`, after `remaining`, add
  `{ key: "overbookingAllowed", label: "הזמנת יתר מותרת", hint: "כמה משטחים מותר ללקוחות להזמין מהמוצר הזה מעבר למלאי" }`.
  Its value uses `text-warning`.
- [ ] **Step 4:** Typecheck and lint. Then run the harness with
  `ONLY=bo-arrangement`. Expected: the "select product" snapshot shows the
  stat.
- [ ] **Step 5: Commit:** `feat(parity-4): הזמנת יתר מותרת in the סידור product strip`.

### Task 14: Web — לפי לקוח in the records table

**Files:**
- Create: `apps/web/src/components/arrangement/records-sort.ts`, plus `records-sort.test.ts`
- Modify: `apps/web/src/components/arrangement/records-table.tsx`

**Interfaces:**
- Produces:

  ```ts
  export type RecordsViewMode = "by-product" | "by-grower" | "by-customer";
  export function sortRecords(records: readonly FlatRecord[], mode: RecordsViewMode): FlatRecord[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - `by-customer` sorts by `customerName`, then `varietyLabel`, both with
    `localeCompare(…, "he")`.
  - `by-product` and `by-grower` give exactly today's order (port the current
    comparator and assert on a fixture).
- [ ] **Step 2:** Run it. Expected: FAIL. Implement, then run again. Expected:
  PASS.
- [ ] **Step 3: Switch the table over.** It uses `sortRecords`, and the button
  list adds `["by-customer", "לפי לקוח"]` third.
- [ ] **Step 4:** Typecheck and lint. In `bo-arrangement`, add the step
  "by-customer view" after "by-grower view". Run the harness. Expected: no
  failing step.
- [ ] **Step 5: Commit:** `feat(parity-4): לפי לקוח in the סידור records table`.

### Task 15: Web — pickup time on the grower's picking screen

**Files:**
- Create: `apps/web/src/lib/pickup-time.ts`, plus `pickup-time.test.ts`
- Modify: `apps/web/src/components/arrangement/board-data.ts`, which uses
  `effectivePickupTime`. It currently does this at about line 533.
- Modify: `apps/web/src/lib/queries/grower.ts`. Both `daily_picks` selects add
  `pickup_time, companies(default_pickup_time)`. There is only one foreign key
  to `companies`, so no hint is needed.
- Modify: `apps/web/src/routes/grower/picks.tsx` (`PickDetail`'s strip)

**Interfaces:**
- Produces:

  ```ts
  export function effectivePickupTime(pickTime: string | null, companyDefault: string | null): string | null; // pickTime ?? companyDefault ?? null — the board's existing rule
  export function formatPickupTime(value: string | null): string | null; // "14:00:00" -> "14:00", "07:30" -> "07:30", null -> null
  // DailyPickSummary gains: pickup_time: string | null; companies: { default_pickup_time: string | null } | null
  ```

- [ ] **Step 1: Write the failing tests:**
  - `effectivePickupTime("06:00:00", "14:00:00") === "06:00:00"`
  - `effectivePickupTime(null, "14:00:00") === "14:00:00"`
  - `effectivePickupTime(null, null) === null`
  - the three `formatPickupTime` cases above
- [ ] **Step 2:** Run it. Expected: FAIL. Implement, then run again. Expected:
  PASS. Then run `board-data.test.ts`: still PASS.
- [ ] **Step 3: Show it in the strip.** Compute
  `formatPickupTime(effectivePickupTime(pick.pickup_time, pick.companies?.default_pickup_time ?? null))`.
  When it isn't null, show `<Icon name="clock" …/>` and `שעת איסוף {time}`
  beside the date.
- [ ] **Step 4:** Typecheck and lint. Then run the harness with
  `ONLY=grower-flow`. Expected: the strip shows "שעת איסוף".
- [ ] **Step 5: Commit:** `feat(parity-4): pickup time on the grower's picking screen`.

### Task 16: Scripts — shared Bubble module

**Files:**
- Create: `packages/db/scripts/lib/bubble-extras.ts`, plus `bubble-extras.test.ts`
- Modify: `packages/db/vitest.config.ts`. Set
  `include: ["src/**/*.test.ts", "scripts/**/*.test.ts"]`.

**Interfaces:**
- Produces:

  ```ts
  export type BubbleRecord = { _id: string } & Record<string, unknown>;
  export const COMPANY_DETAIL_FIELDS: { readonly phone: "Phone no."; readonly address_line: "Address Line"; readonly city: "City"; readonly tax_id: "Tax ID"; readonly accounting_id: "Accounting ID" };
  export type CompanyDetailColumn = keyof typeof COMPANY_DETAIL_FIELDS;
  export function bubbleText(record: BubbleRecord, field: string): string | null; // trimmed string (numbers via String), else null
  export function companyDetailsFromBubble(record: BubbleRecord): Record<CompanyDetailColumn, string | null>;
  export function mainContactBubbleId(record: BubbleRecord): string | null;     // "Main Contact"
  export function orderCommentFromBubble(record: BubbleRecord): string | null;  // "comment"
  export function varietyPictureFromBubble(record: BubbleRecord): string | null; // "Image", as https
  export function familyPictureFromBubble(record: BubbleRecord): string | null;  // "image", as https
  export function toHttpsUrl(value: string): string;                             // "//x" -> "https://x"
  export function isBubblePictureUrl(url: string): boolean;                     // host ends with ".cdn.bubble.io"
  export const PICTURE_TYPES: { readonly "image/jpeg": "jpg"; readonly "image/png": "png"; readonly "image/webp": "webp" };
  export const PICTURE_MAX_BYTES: 5242880;
  export const PICTURE_CACHE_SECONDS: "31536000";
  export type PictureSkip = "unsupported-type" | "too-big" | "download-failed";
  export interface PictureStore { upload(path: string, bytes: Uint8Array, options: { contentType: string; cacheControl: string }): Promise<string>; remove(paths: string[]): Promise<void> }
  export function supabasePictureStore(client: SupabaseClient, bucket?: string): PictureStore; // bucket default "product-photos"; upsert false; returns getPublicUrl
  export async function checkPicture(url: string, fetchFn?: typeof fetch): Promise<{ ok: true } | { ok: false; reason: PictureSkip }>; // HEAD, 15 s timeout
  export async function copyPicture(url: string, store: PictureStore, options?: { fetchFn?: typeof fetch; newName?: () => string }): Promise<{ ok: true; url: string; path: string } | { ok: false; reason: PictureSkip }>; // GET, 30 s timeout, `${newName()}.${ext}`
  export async function loadExport(dir: string, types: readonly string[], expectEnv: "live" | "test"): Promise<Record<string, BubbleRecord[]>>; // checks _manifest.json bubbleEnv and counts
  ```

- [ ] **Step 1: Write the failing tests:**
  - `toHttpsUrl("//abc.cdn.bubble.io/f1/a.jpg") === "https://abc.cdn.bubble.io/f1/a.jpg"`
  - `companyDetailsFromBubble({ _id: "1", "Phone no.": " 050 ", City: "  " })`
    → `{ phone: "050", address_line: null, city: null, tax_id: null, accounting_id: null }`
  - `isBubblePictureUrl` is true for `https://x.cdn.bubble.io/a.jpg`, and false
    for a Supabase storage link and for `https://cdn.bubble.io.evil.test/a.jpg`.
  - `copyPicture` with a fake fetch returning `200`,
    `content-type: image/jpeg; charset=binary` and 10 bytes, plus a fake store:
    - one upload, to `"<name>.jpg"`;
    - with `{ contentType: "image/jpeg", cacheControl: "31536000" }`.
  - `copyPicture` uploads nothing in these cases:
    - `image/avif` → `{ ok: false, reason: "unsupported-type" }`;
    - more than 5242880 bytes → `"too-big"`;
    - fetch throws, or returns 404 → `"download-failed"`.
- [ ] **Step 2:** Run
  `pnpm --filter @ori/db exec vitest run scripts/lib/bubble-extras.test.ts`.
  Expected: FAIL. Implement, then run again. Expected: PASS. Then run
  `pnpm --filter @ori/db typecheck`.
- [ ] **Step 3: Commit:** `feat(parity-5): shared Bubble field mapping and picture copying for the scripts`.

### Task 17: Scripts — the fill script

**Files:**
- Create: `packages/db/scripts/lib/fill-plan.ts`, plus `fill-plan.test.ts`
- Create: `packages/db/scripts/lib/fill-sql.ts`
- Create: `packages/db/scripts/fill-from-bubble.ts`
- Modify: `packages/db/package.json`. Add the script
  `"fill:from-bubble": "tsx scripts/fill-from-bubble.ts"`.
- Scratch: `$S/pg/` (embedded Postgres), `$S/parity/check-fill-sql.ts`,
  `$S/parity/check-fill-run.ts`, `$S/fake-export/`

**Interfaces:**
- Consumes: everything from Task 16.
- Produces:

  ```ts
  // fill-plan.ts
  export interface IdMaps { company: ReadonlyMap<string, string>; user: ReadonlyMap<string, string>; productfamily: ReadonlyMap<string, string>; productvarieties: ReadonlyMap<string, string>; dailyorder: ReadonlyMap<string, string> } // Bubble id -> Ori id
  export interface OriSnapshot { companies: ReadonlyMap<string, Record<CompanyDetailColumn | "contact_person_id", string | null>>; varieties: ReadonlyMap<string, string | null>; families: ReadonlyMap<string, string | null>; orders: ReadonlyMap<string, string | null>; profileIds: ReadonlySet<string> }
  export type FillField = CompanyDetailColumn | "contact_person_id" | "variety_picture" | "family_picture" | "order_comment";
  export interface FieldReport { filled: number; alreadySet: number; noOriRow: number; problems: Array<{ oriId: string | null; reason: string }> }
  export interface FillExport { company: BubbleRecord[]; productvarieties: BubbleRecord[]; productfamily: BubbleRecord[]; dailyorder: BubbleRecord[] }
  export interface FillPlan { companies: Array<{ id: string } & Partial<Record<CompanyDetailColumn | "contact_person_id", string>>>; varietyPictures: Array<{ id: string; source: string }>; familyPictures: Array<{ id: string; source: string; current: string | null }>; orderComments: Array<{ id: string; comment: string }>; report: Record<FillField, FieldReport> }
  export function planFill(data: FillExport, ids: IdMaps, ori: OriSnapshot): FillPlan;
  // fill-sql.ts
  export interface FillWrites { companies: FillPlan["companies"]; varietyPictures: Array<{ id: string; image_url: string }>; familyPictures: Array<{ id: string; image_url: string; current: string | null }>; orderComments: FillPlan["orderComments"] }
  export interface FillStatement { label: "companies" | "variety_pictures" | "family_pictures" | "order_comments"; text: string; params: [string] }
  export function fillStatements(writes: FillWrites): FillStatement[]; // one per non-empty group; params[0] = JSON.stringify(rows); each statement ends "returning <alias>.id"
  // fill-from-bubble.ts
  export async function runFill(options: { sql: postgres.Sql; store: PictureStore; exportDir: string; commit: boolean; fetchFn?: typeof fetch; log?: (line: string) => void }): Promise<Record<FillField, FieldReport>>;
  ```

**Planning rules for `planFill`:**
- **Company fields and the contact:** planned only when Ori's value is NULL.
- **Contact:** Bubble's Main Contact is mapped through `ids.user`. A contact
  that isn't in `profileIds` is a problem (`"contact login not in Ori"`), never
  planned.
- **Family pictures:**
  - when Ori's link is a Bubble link, the source is Ori's own link, and
    `current` is that link;
  - when Ori's is NULL, the source is the export's picture, and `current` is
    null;
  - otherwise it counts as `alreadySet`.
- **Variety pictures and order comments:** planned only when Ori's is NULL.
- **No Ori row:** a Bubble record that has no Ori id counts as `noOriRow`.

**The SQL** — use these texts exactly. They re-check "still empty" when they
write:

```sql
update public.companies c set
  phone = coalesce(c.phone, x.phone), address_line = coalesce(c.address_line, x.address_line),
  city = coalesce(c.city, x.city), tax_id = coalesce(c.tax_id, x.tax_id),
  accounting_id = coalesce(c.accounting_id, x.accounting_id),
  contact_person_id = coalesce(c.contact_person_id, (select p.user_id from public.profiles p where p.user_id = x.contact_person_id))
from jsonb_to_recordset($1::jsonb) as x(id uuid, phone text, address_line text, city text, tax_id text, accounting_id text, contact_person_id uuid)
where c.id = x.id
returning c.id;

update public.product_varieties v set image_url = x.image_url, version = v.version + 1
from jsonb_to_recordset($1::jsonb) as x(id uuid, image_url text)
where v.id = x.id and v.image_url is null
returning v.id;

update public.product_families f set image_url = x.image_url
from jsonb_to_recordset($1::jsonb) as x(id uuid, image_url text, current text)
where f.id = x.id and f.image_url is not distinct from x.current
returning f.id;

update public.daily_orders o set comment = x.comment
from jsonb_to_recordset($1::jsonb) as x(id uuid, comment text)
where o.id = x.id and o.comment is null
returning o.id;
```

**What `runFill` does:**
1. **Guard:** the seven new columns exist in `information_schema.columns`.
   Otherwise it stops: "Apply migrations 0092–0094 first."
2. Load the export (`expectEnv: "live"`).
3. Read the id map and the Ori snapshot.
4. Run `planFill`.
5. **Pictures:**
   - on a dry run, `checkPicture` each one;
   - on commit, `copyPicture` each one, four at a time. A skipped family
     picture keeps its Bubble link and is listed. A skipped variety picture is
     listed.
6. **Commit only:** `sql.begin`. Run each statement via
   `tx.unsafe(text, params)`.
   - Any upload whose row came back unwritten is removed after the commit.
   - On error, roll back, `store.remove` every upload, and rethrow.
7. Return the report.

**What `main()` does:**
- Load the root `.env`, the way the importer does.
- Print the target database's host only.
- Build postgres.js and `supabasePictureStore`.
- Call `runFill` with `.bubble-export/live` and `--commit`.
- Print the report table: field / filled / already set / no Ori row /
  problems, then the problem lines with Ori ids.
- Run only when executed directly:
  `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`.

- [ ] **Step 1: Write the failing tests** in `fill-plan.test.ts`:
  - `it("fills only empty company fields; a value already in Ori counts as already set")`
  - `it("a Bubble company with no Ori row counts as noOriRow")`
  - `it("Main Contact becomes the Ori login; a contact whose login isn't in Ori is a problem, not guessed")`
  - `it("variety picture: planned when Ori has none, already set when it has one")`
  - `it("family picture: a Bubble link in Ori is copied from that link; an empty one from the export; an Ori upload is left alone")`
  - `it("order comment: filled only when Ori's is empty")`
- [ ] **Step 2:** Run
  `pnpm --filter @ori/db exec vitest run scripts/lib/fill-plan.test.ts`.
  Expected: FAIL. Implement `planFill`, then run again. Expected: PASS.
- [ ] **Step 3:** Write `fill-sql.ts` and `fill-from-bubble.ts` (`runFill`,
  `main`). Add the package script, then run `pnpm --filter @ori/db typecheck`.
- [ ] **Step 4: SQL check against PGlite.** Write `$S/parity/check-fill-sql.ts`
  and run it with `pnpm --filter @ori/db exec tsx $S/parity/check-fill-sql.ts`.
  - It loads the harness world at 0094 and seeds every state.
  - It runs `fillStatements` inside `begin` / `commit`.
  - It asserts:
    - empty fields are filled and set ones are untouched;
    - a contact is set only when its profile exists;
    - a variety's `version` goes up by 1 only when it was written;
    - a family is written only when it still holds `current`;
    - an order comment is filled only when it was empty;
    - **race:** a phone set in Ori after planning survives the write;
    - **all or nothing:** with a failing fifth statement appended, no row
      changed.
- [ ] **Step 5: End-to-end check against embedded Postgres.**
  - Set up the server:
    `mkdir -p $S/pg && cd $S/pg && npm init -y && npm install embedded-postgres@17.11.0-beta.19 postgres@3`.
  - `$S/pg/start.mjs`:
    - starts port 55432 with `initdbFlags: ["--encoding=UTF8","--locale=C"]`
      and `onLog: () => {}`, then creates the database `ori`;
    - applies `PLATFORM`;
    - applies these stubs:
      `alter table auth.users add column if not exists encrypted_password text, add column if not exists updated_at timestamptz; create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid); create schema if not exists extensions;`,
      plus `extensions.gen_salt(text, int)` and `extensions.crypt(text, text)`
      returning constant text;
    - applies every journal migration except 0047.
  - `$S/parity/check-fill-run.ts`:
    - seeds rows plus `_bubble_migration_id_map` entries;
    - writes `$S/fake-export/` (four JSON files and a `_manifest.json` with
      `bubbleEnv: "live"`, all made-up values);
    - calls `runFill` with a fake store and a fake fetch.
  - Expected:
    - a dry run writes nothing and uploads nothing;
    - a commit fills the planned rows and uploads with `cacheControl "31536000"`;
    - a second commit writes and uploads nothing;
    - with an injected statement failure, the fake store's `remove` gets every
      upload, and no row changed.
- [ ] **Step 6: Commit:** `feat(parity-5): fill script that copies Bubble's values into the new fields`.

### Task 18: Scripts — the importer learns the same fields

**Files:**
- Modify: `packages/db/scripts/import-from-bubble.ts`

**Interfaces:**
- Consumes: Task 16's mapping functions, `copyPicture`, `checkPicture` and
  `supabasePictureStore`.
- Produces:
  - `ReferencePlan.contactLinks: Array<{ id: string; contact_bubble_user_id: string }>`.
  - Picture results printed as `Pictures: <n> copied, <m> skipped (<reason>: <count>, …)`.

- [ ] **Step 1: Columns.** In `COLUMNS`:
  - `companies` gets `phone`, `address_line`, `city`, `tax_id` and
    `accounting_id`;
  - `product_varieties` gets `image_url`;
  - `daily_orders` gets `comment`.

  `insertRows` refuses a row that is missing any of them.
- [ ] **Step 2: Planning.**
  - **Companies:** each company row spreads `companyDetailsFromBubble(company)`.
    A company with `mainContactBubbleId` gets a `contactLinks` entry.
  - **Varieties:** each variety row gets
    `image_url: varietyPictureFromBubble(variety)`. For now that's Bubble's
    link; a commit replaces it.
  - **Orders:**
    - each order row gets `comment: orderCommentFromBubble(order)`;
    - delete the `order.comment_not_imported` note.
  - **`fieldsNotImported`:** remove "Address Line", "City", "Tax ID",
    "Accounting ID", "Phone no." and "Main Contact" from the company list, and
    "Image" from the variety list.
- [ ] **Step 3: `main()`.** After the logins and before `sql.begin`:
  - **Dry run:** `checkPicture` every family and variety Bubble link.
  - **Commit:**
    - `copyPicture` each one into the row's `image_url`.
    - A skipped family keeps its Bubble link; a skipped variety gets `null`.
      Both are reported.
    - Collect the uploaded paths. In the `catch`, also remove them, next to
      `deleteCreatedLogins()`.
  - **Contacts:** after `insertRows(tx, "profiles", …)`, run
    `update companies set contact_person_id = …` from `contactLinks` mapped
    through `loginIds`. A link whose login is missing becomes a
    `report.note("warning", "company", …, "company.contact_not_imported", …)`.
- [ ] **Step 4:** Run `pnpm --filter @ori/db typecheck`. Then do a dry run
  against `$S/pg`, using the Bubble **test** export.

  ```bash
  node $S/pg/start.mjs &   # wait for "ready"
  cd packages/db && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/ori SUPABASE_URL=http://127.0.0.1:9 \
    SUPABASE_SERVICE_ROLE_KEY=stub pnpm import:from-bubble -- --env test 2>&1 \
    | grep -E "Verification passed|Dry run finished|field_not_imported|Pictures:|Error"
  ```

  - Expected: "Verification passed" and "Dry run finished".
  - None of the newly imported fields appears in a `field_not_imported` line.
  - The "Pictures:" line has counts.
  - If the embedded server can't be made to run, stop and report it. Don't
    claim the importer is verified.
- [ ] **Step 5: Commit:** `feat(parity-5): the importer carries company details, contacts, pictures and order comments`.

### Task 19: Whole-app regression, then CI

**Files:**
- Scratch only. Nothing to commit unless a fix is needed.

- [ ] **Step 1:** Re-seed (all 94 migrations, with the seed additions from
  Tasks 4, 7, 10, 11 and 12). Rebuild `$S/dist-branch` from the branch.
  `$S/dist-main` stays main's build from Task 1.
- [ ] **Step 2:** Run `LABELS="main branch" bash $S/harness/run-both.sh`.
  - This is also the "old copies keep working" check: main's app runs against
    the new schema.
  - Every difference reported must be one of these:
    - the new company columns and save arguments;
    - the variety thumbnail and photo control, and the products select;
    - the stock column;
    - the strip stat, and the board select's `no_overbooking`;
    - the third records button;
    - the pickup time, and the grower selects;
    - the order-comment button, its request and `p_comment`;
    - the comment on בשם לקוח, and the `ordersForDay` select;
    - the picture link.
  - Main's build must show no step error. Fix anything else before going on.
- [ ] **Step 3: Full local checks:**
  - `pnpm lint && pnpm typecheck && pnpm --filter @ori/web test && pnpm --filter @ori/db test`;
  - the three pure domain files.

  Expected: all clean.
- [ ] **Step 4: Push and watch CI.**
  - Ask James before pushing.
  - On a yes: `git push -u origin feat/bubble-column-parity`.
  - Watch CI through the public GitHub API, since there's no `gh` CLI. Fix any
    domain or e2e failure on the branch, re-running a failing test before
    concluding anything.
- [ ] **Step 5: Hand-off to James:**
  - Apply 0092, 0093 and 0094 on live, in that order, and report back.
  - Then: check read-only (columns, one version of each function, permissions);
    compare `supabase-types.ts` with live; merge; confirm the live bundle.
  - Then James runs:
    1. `pnpm bubble:export -- --env live`
    2. `pnpm fill:from-bubble` — he pastes the output
    3. `pnpm fill:from-bubble -- --commit`
