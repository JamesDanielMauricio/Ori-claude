# Bubble column parity — design

**Date:** 2026-11-10 · **Status:** for James's review · **Branch:** `feat/bubble-column-parity`

## 1. Goal

Every column that Bubble's live screens show and Ori lacks is added to Ori, and
the values Bubble already holds are copied across. Bubble's live app
(`uri-and-the-bananas`) is the reference. The gaps come from a read-only
comparison of every Bubble screen against Ori on 2026-11-10.

Done means:

- each item in §2 shows on its Ori screen, with Bubble's label;
- Bubble's existing values appear once the fill script has run;
- nothing else on any screen changes.

## 2. Scope

### In scope

| # | Item | Where in Ori | Part |
|---|---|---|---|
| 1 | טלפון | מגדלים, לקוחות, מובילים | 1 |
| 2 | כתובת | same three | 1 |
| 3 | יישוב | same three | 1 |
| 4 | הנה״ח (ח.פ. + מספר בהנה״ח) | same three | 1 |
| 5 | Order comment "הערה כללית" | customer order screen, בשם לקוח, board pencil | 2 |
| 6 | Variety picture | מוצרים, מוצרים שנקטפו, customer order screen | 3 |
| 7 | משטחים במלאי | מוצרים שנקטפו | 4 |
| 8 | הזמנת יתר מותרת | סידור product strip | 4 |
| 9 | לפי לקוח | סידור records table | 4 |
| 10 | Pickup time | grower's picking screen | 4 |
| 11 | Fill איש קשר from Bubble's Main Contact. The column exists but is empty on every live company. | company screens | 5 |
| 12 | Copy Bubble's values into all of the above. Also give Ori its own copies of the 126 family pictures it still loads from Bubble. | fill script + importer | 5 |

### Out of scope

James decided these:

- Splitting a user's name into first and last name.
- סה״כ במלאי on סידור לפי מוצרים stays "picked only".
- Bubble columns nobody filled: company לוגו, and company / user / variety הערות.
- The blocked-products difference: Bubble blocks families, Ori blocks varieties.

Left out because Bubble's screens don't show them:

- Bubble's "Area code" (empty on all 114 companies).
- Bubble's "Phone prefix".

## 3. Rules every part follows

1. **A new optional input that isn't sent keeps the saved value.**
   - Empty text clears the value (stored as NULL).
   - Any other text is trimmed and saved.

   This is migration 0082's rule (`coalesce(p_new, existing)`), extended to
   text. Why: a browser tab still running the previous web app doesn't know the
   new inputs. It must not wipe them when it saves.
2. **Changing a function's inputs or its result means drop, create, and
   restate the permissions.**
   - Postgres treats an extra parameter as a separate function. So the old
     version is dropped, leaving one version for the API to call.
   - Dropping a function also drops its permissions. Each migration
     therefore restates them:
     - `revoke execute … from public, anon`;
     - `grant execute … to authenticated, service_role`. This matches what
       0082 left on `save_grower` and what live shows for the others.
   - Each permission block has a comment saying what it allows and what it
     protects against.
3. **No new security rules.** Each part names the existing rule that covers
   it. Nothing new becomes visible to growers or customers.
4. **Migrations are files.** James applies them. Each gets its
   `meta/_journal.json` entry, and an applied file is never edited.
5. **Live updates need no change.**
   - The broadcast sends only the table name, and the app refetches every open
     query on any message.
   - Reference data (companies, products) has been outside live updates since
     0061, as today.
6. **The WhatsApp sender needs no redeploy.** It reads only
   `notification_settings`, `profiles` and its outbox functions. Nothing here
   changes any of them.
7. **`supabase-types.ts` is edited by hand.** The generator needs a local
   stack, which this machine doesn't have. Once James has applied the
   migrations, the file is compared with the live catalog.

## 4. Part 1 — Company details (migration 0092)

### Database

`companies` gets five nullable text columns, each with a column comment:

| Column | Bubble field | Label in Ori |
|---|---|---|
| `phone` | Phone no. | טלפון |
| `address_line` | Address Line | כתובת |
| `city` | City | יישוב |
| `tax_id` | Tax ID | ח.פ. |
| `accounting_id` | Accounting ID | מספר בהנה״ח |

### Functions

Each save function is recreated from its latest version with five new inputs:

- `p_phone`, `p_address_line`, `p_city`, `p_tax_id`, `p_accounting_id`;
- all `text default null`, following rule 1;
- the bodies are otherwise copied unchanged.

| Function | Latest version | Inputs today → after |
|---|---|---|
| `save_grower` | 0082 | 9 → 14 |
| `save_customer` | 0080 | 6 → 11 |
| `save_transporter` | 0057 | 5 → 10 |

**Permissions found on live today:**

- `save_grower` can be run by `authenticated` and `service_role` only.
- `save_customer` and `save_transporter` can also be run by `anon` and
  `PUBLIC`.
  - Nothing leaks: an anonymous caller is refused on the function's first
    line, because `current_role()` is not `backoffice`.
  - Restating the permissions (rule 2) closes this gap, the same way 0082
    closed it for `save_grower`.

### Domain (`packages/domain`)

`saveGrowerInputSchema`, `saveCustomerInputSchema` and
`saveTransporterInputSchema` each get five fields:

| Field | Limit (characters) | Bubble's longest |
|---|---|---|
| `phone` | 30 | 13 |
| `addressLine` | 200 | 32 |
| `city` | 100 | 11 |
| `taxId` | 30 | 9 |
| `accountingId` | 30 | 4 |

- Each is a trimmed string; an empty string means "clear".
- No copied value comes close to a limit.
- The `to…RpcArgs` mappers pass them on as `p_…`.
- There's no format check. These fields are for people to read, and
  nothing sends messages to them.

### Web

- The three screens' queries (`lib/queries/reference-data.ts`) select the
  five columns.
- New columns on מגדלים, לקוחות and מובילים, grouped around איש קשר as in
  Bubble:
  - **טלפון, כתובת, יישוב** just before איש קשר;
  - **הנה״ח** just after it.
- They are edited inline like every other cell: form state, optimistic patch
  and dirty check.
- **הנה״ח** is one shared cell component used by all three screens (like
  the contact-person cell).
  - Read mode shows up to two lines, "ח.פ.: …" and "מספר בהנה״ח: …". A line
    appears only when it has a value; when both are empty the cell shows "—".
  - Edit mode shows two labelled boxes.

### Security

- **Writing:** only through the save functions, which check for back office
  inside, or through the existing `companies_write_backoffice` rule.
- **Reading:**
  - The back office reads every company.
  - `companies_select_own` lets a grower or customer read only their own
    company's row. At most they see their own phone and tax ID.
  - No grower or customer screen shows these fields.

## 5. Part 2 — Order comment (migration 0093)

### Database

`daily_orders.comment`: nullable text, with a column comment.

### Function

`submit_order` (latest: 0076, 3 inputs) is recreated with a fourth input,
`p_comment text default null`, following rule 1.

- **The only change to its body:** once it has locked the caller's order
  row, it sets `comment`. NULL keeps the saved comment, empty text clears it,
  anything else is saved trimmed.
- **Copied unchanged:** the lines, blocked products, demand thresholds, the
  submission-log snapshot (which does not get the comment) and the office's
  `order_submitted` alert.
- **Permissions** are restated as today: `authenticated`, `service_role`.

### Domain

- `submitOrderInputSchema` gets an optional `comment: string | null`.
- `toSubmitOrderRpcArgs` passes it as `p_comment`, NULL when it's absent.
- No length limit, the same as line comments. Bubble's longest is 136
  characters.

### Web

**`OrderLinesEditor`** is one component with three hosts: the customer's
order screen, בשם לקוח, and the arrangement board's pencil.

- **Reading the comment:** the editor reads its own order's comment with one
  small query on `daily_orders` `(id, comment)` for this trading day.
  - When the office edits for a customer, the query is filtered to
    `customerCompanyId`.
  - The orders rule already limits a customer to their own order.
- **The button:** "הערה כללית" sits in the bottom bar.
  - It reads "+ הערה כללית" when there's no comment and "✎ הערה כללית" when
    there is one, the same convention as line comments.
  - It opens the existing `CommentPopup`, which gains an optional title.
- **The draft:** the comment is part of it, just as lines are today.
  - A change lights up שמור, and "בטל שינויים" restores the saved comment.
  - A refetch never overwrites it while someone is editing it.
- **Saving:** the comment is sent with the order on שמור. If the comment
  query hasn't loaded, or failed, NULL is sent so the saved comment is kept.
- **Confirmation:** the confirmation popup shows "הערה כללית: …" when there is
  a comment.
- **Read-only** (closed day, history): the comment shows as plain text above
  the list, with no button.

**בשם לקוח:**

- `oversightQueries.ordersForDay` also selects `comment`.
- An expanded customer row shows "הערה כללית: …" above its lines.

### Security

- **Writing:** only through `submit_order`'s existing checks.
  - A customer can change only their own order, and only while the shop is
    open (0071).
  - Staff can change any order.
- **Reading:** the existing `daily_orders` rules. A customer reads only their
  own orders; the back office reads all of them.

## 6. Part 3 — Variety pictures (migration 0094)

### Database

`product_varieties.image_url`: nullable text, with a column comment.

### Functions

- **`save_product`** (latest: 0087, 15 inputs) gets `p_image_url text default
  null` as its 16th input.
  - It follows rule 1; empty text removes the picture.
  - The body is otherwise unchanged, including the version check and
    increment.
  - Permissions as today: `authenticated`, `service_role`.
- **`get_orderable_catalog_for_customer`** (latest: 0090) returns one more
  column at the end: `variety_image_url`.
  - Its result type changes, so it is dropped and recreated, as in 0036.
  - The body is otherwise unchanged. It still hides blocked products, other
    categories and lines that can't be ordered.
  - Permissions as today: `authenticated`, `service_role`.

### Domain

- `saveProductInputSchema` gets `imageUrl`, a string where empty means
  "remove".
- `toSaveProductRpcArgs` passes it as `p_image_url`.

### Web

**A shared upload helper** handles product pictures for both family and
variety saves.

- Every upload gets a fresh random file name, so no browser keeps showing a
  cached old picture.
- It keeps the file's own content type.
- It sets a one-year browser cache. That's safe because a file name is never
  reused.
- Families get the one-year cache too, because they share the helper.
- Removing a replaced or deleted picture stays best-effort. It only ever
  touches files in Ori's own storage (`productPhotoPathFromUrl`).

**מוצרים and מוצרים שנקטפו** both use the same `ProductCatalogScreen`.

- A variety row shows its picture as a small round thumbnail in the name
  column's gutter, where the family row shows the family picture. A variety
  with no picture shows nothing there.
- Edit mode has the family's picture control:
  - pick a JPEG, PNG or WebP up to 5 MB;
  - × removes it;
  - a preview shows before saving;
  - the upload happens on שמור.
- Deleting a variety deletes its picture file.

**Customer order list** (`OrderProductList`, in all three editor hosts):

- A variety with a picture shows the link "לחצו כאן לתמונה עדכנית". It opens a
  dialog with the large picture.
- The link works in read-only mode too.
- No picture, no link.

### Security

- **Storage bucket** `product-photos` (0058) is unchanged:
  - Anyone with a picture's link can view it. That's how customers see
    family pictures today.
  - Only the back office can upload, replace or delete
    (`product_photos_write_backoffice`).
  - The bucket refuses other file types and files over 5 MB.
- **`product_varieties`** stays back-office only. Customers get a variety's
  link only through the catalog function, which applies their blocked
  products and category.

## 7. Part 4 — Screen-only additions (no migration)

1. **משטחים במלאי on מוצרים שנקטפו.**
   - `pickedProductsQueries.varietiesForDay` returns each variety's total of
     `pallets_picked + leftover_pallets`, summed over all of the day's picks.
     Today it returns only which varieties have any stock.
   - The varieties listed are exactly those whose total is above zero, the
     same set as today.
   - `ProductCatalogScreen` takes an optional `stockByVariety`. When it's
     given, the screen adds a read-only "משטחים במלאי" column right after
     "זן". That's Bubble's position, after שם.
   - Family rows leave this cell empty. Bubble showed the category there, and
     Ori already shows the category in its משפחה column.
   - Only this route passes `stockByVariety`.
2. **הזמנת יתר מותרת in the סידור product strip.**
   - A sixth number after נקטף, עודף, הוזמן, חולק and נותר, in orange like
     Bubble.
   - It shows the selected variety's `no_overbooking`. Despite the column's
     name, this holds Bubble's "Overbooking": how many pallets may be ordered
     beyond stock.
   - The board already loads it (`lib/queries/arrangement.ts`), and
     `BoardProduct` carries it to the strip.
3. **לפי לקוח in the records table.**
   - A third view button after לפי מוצר and לפי מגדל.
   - It shows the same rows sorted by customer name, then product, using
     Hebrew sorting like the other two.
   - The columns don't change.
4. **Pickup time on the grower's picking screen.**
   - The strip with the date and status shows "שעת איסוף 14:00".
   - It follows the board's rule:
     - once the pick is sent, the pick's own time;
     - while it's a draft, the company's current default;
     - with neither, nothing is shown.
   - The rule moves into one small shared function that both the board and
     the grower screen use, so they can't disagree.
   - `lib/queries/grower.ts` adds the pick's `pickup_time` and the company's
     `default_pickup_time` to its reads.
   - History shows it too, since it's the same component.

**Security:** nothing changes. Each item uses reads its screen already has. A
grower reads only their own picks and their own company's row.

## 8. Part 5 — Copying Bubble's values

### 8.1 Shared module

One module under `packages/db/scripts/` is used by both scripts. It holds:

- **The field mapping:**
  - the table in §4;
  - Main Contact → `companies.contact_person_id`;
  - variety Image → `product_varieties.image_url`;
  - family image → `product_families.image_url`;
  - order comment → `daily_orders.comment`.
- **Text cleaning:** values are trimmed, and empty means "no value".
- **Picture copying:**
  1. Turn Bubble's protocol-relative link into an `https:` one.
  2. Download it, with a timeout.
  3. Accept only JPEG, PNG or WebP up to 5 MB. These are the bucket's own
     limits.
  4. Upload it with the shared naming and the one-year cache.
  5. Return Ori's link.

  Anything else is skipped and the reason recorded: AVIF, another type, too
  big, or a failed download.

### 8.2 Fill script: `packages/db/scripts/fill-from-bubble.ts`

James runs it from `packages/db`, after the new web app is live:

1. `pnpm bubble:export -- --env live`: the existing exporter, read-only
   against Bubble. It takes a fresh snapshot.
2. `pnpm fill:from-bubble`: a dry run, the default.
   - It writes nothing, and its picture checks use header-only requests.
   - It prints what it would do.
3. `pnpm fill:from-bubble -- --commit`: the real run. It uses the same flag
   as the importer.

**How it works:**

- **Matching:** it finds each Bubble record's Ori row through
  `_bubble_migration_id_map`. On live that record covers 113 companies, 80
  users, 150 families, 1,163 varieties and 11,722 orders.
- **It fills only empty fields, so Ori wins.**
  - The one exception: a family picture is replaced, but only while its link
    still points at Bubble (`cdn.bubble.io`). It's replaced with Ori's own
    copy of the same picture.
  - Pictures uploaded in Ori are never touched.
  - Nothing on Bubble is changed or deleted.
- **It never changes any other field.**
- **Stale product forms are protected.** A variety that gets a picture has its
  `version` raised by one. A products form opened before the run then gets the
  normal "changed by someone else" message, instead of silently dropping the
  new picture.
- **Stale company and family forms are not protected.** Companies and
  families have no version number, so James runs the script when nobody is
  editing those screens. If a stale form sets a family picture back to
  Bubble's link, running the script again fixes it.
- **All or nothing:**
  1. Pictures are uploaded first.
  2. Then every database change runs in one transaction, as one bulk
     statement per table. Each statement re-checks "still empty" at the
     moment it writes.
  3. If the transaction fails, the pictures this run uploaded are removed.

  One transaction also means just one live-update message.
- **Safe to run again:** a second run finds everything filled and does
  nothing.
- **It stops before touching anything** if the 0092–0094 columns don't exist
  yet.
- **It is not blocked by `bubble_import_lock` (0084).** That lock stops the
  *importer*, which replaces data. This script only fills.
- **Settings:** it reads `DATABASE_URL`, `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` from the root `.env`, like the importer. It
  never prints them.
- **Output:** counts and Ori ids only, never phones, names or comments, so the
  output is safe to paste. For each field it counts:
  - filled;
  - already set;
  - no Ori row (for example, a record created in Bubble after 12 Oct);
  - problems: a contact whose login isn't in Ori, or a picture that was
    skipped, with the reason.

**Expected counts,** from the 12 Oct export (a fresh export will differ a
little):

| Field | Growers | Customers | Transporters | Total |
|---|---|---|---|---|
| טלפון | 32 | 32 | 9 | 73 |
| כתובת | 16 | 16 | 0 | 32 |
| יישוב | 25 | 15 | 0 | 40 |
| ח.פ. | 32 | 31 | 0 | 63 |
| מספר בהנה״ח | 32 | 32 | 0 | 64 |
| איש קשר | 34 | 34 | 10 | 78 |

Plus:

- 177 variety pictures (1 AVIF is skipped);
- 124 family pictures (2 AVIF keep their Bubble link);
- 456 order comments.

James re-uploads the 3 AVIF pictures by hand as JPEG.

### 8.3 Importer: `packages/db/scripts/import-from-bubble.ts`

These changes let the final switch-over carry the same fields:

- `companies` rows include the five new columns.
- **`contact_person_id`** is set from Main Contact once the logins exist,
  inside the same transaction. A contact whose login wasn't imported is
  reported, never guessed.
- **Variety and family pictures** are copied into Ori's storage with the
  shared helper.
  - This happens on `--commit` only.
  - The pictures are created before the transaction and removed again if it
    fails. That's the same pattern the importer already uses for logins.
- **Order comments** go into `daily_orders.comment`, and the
  `order.comment_not_imported` warning is removed.
- **The newly imported fields** come off the `fieldsNotImported` lists.
- **Known trade-off:** a repeat full import leaves the previous import's
  picture copies in storage, unreferenced. That's about 28 MB per import. They
  aren't cleaned up automatically, which is acceptable at that size.

## 9. Testing

None of this touches the live database.

**Migrations, using PGlite** (every journal migration replayed into
Postgres 17 running in WASM):

- **Each recreated function:**
  - Leaving out the new inputs keeps the saved values.
  - Empty text clears a value, and a real value saves.
  - Anonymous callers are refused because they have no EXECUTE permission.
  - Growers and customers can't run the company or product saves.
  - Exactly one version of each function exists.
- **`submit_order`:**
  - The comment saves.
  - A customer still can't write another customer's order, or to a closed
    shop.
  - Before (0076) vs after (0093) on the same seeded day, everything else
    comes out identical row by row: lines, blocked products, alerts and the
    submission log.
- **`get_orderable_catalog_for_customer`:**
  - It returns the variety picture.
  - Before (0090) vs after (0094), everything else is identical, including
    blocked products and categories.
- **A fingerprint, before vs after,** shows that only the intended objects
  changed. It covers function bodies, the definer flag, permissions,
  policies, columns and grants.
- **Deliberately broken copies** of each migration must fail at least one
  check.

**Domain tests** (`packages/domain`): new cases for the new inputs in the
schema tests, the RPC-args tests and the database-rule tests. They run in CI.

**Web:**

- Unit tests:
  - the comment draft (it counts as a change, it restores, it's kept when its
    load fails);
  - the stock totals;
  - the customer sort;
  - the pickup-time rule.
- Typecheck, lint and build.

**Whole-app browser harness** (the real built app against a local fake
backend):

- New steps for every item in §2.
- The full run, before vs after. Any screen that changes without being meant
  to shows up.
- Every screen that reads something that changed is covered:
  - the three company screens and the user screens' company pickers;
  - all three order-editor hosts, plus the customer's history;
  - מוצרים and מוצרים שנקטפו;
  - סידור;
  - the grower's picking screen and its history.

**Fill script and importer,** run against a throwaway database with a small
made-up export (no real data) and fake storage:

- A dry run writes nothing; a commit fills; a second run changes nothing.
- Values typed in Ori win.
- Only Bubble picture links get replaced.
- AVIF and oversized pictures are skipped and listed.
- A failure part-way leaves nothing behind and removes its uploads.

**CI** runs all of it, end-to-end tests included, on its own throwaway
Supabase. End-to-end tests run locally only with James's OK, because locally
they hit live.

## 10. Rollout

1. **Build:** on `feat/bubble-column-parity`, one commit per part, with CI
   green.
2. **Migrations:** James applies 0092, 0093 and 0094 on live and reports
   back.
   - Claude then checks read-only: the columns, one version of each function,
     and the permissions.
   - Then `supabase-types.ts` is compared with the live catalog.
3. **Deploy:** merge to main, and Vercel deploys. Claude confirms the live
   site carries the new code.
   - The migrations go first because the new web app calls the new inputs.
   - Old copies of the app keep working once the migrations are applied.
4. **Fill:** James runs the export, then the fill dry run, and pastes its
   output. Then he runs it with `--commit`.
5. **Check:** Claude checks the counts read-only. James spot-checks the
   screens and re-uploads the 3 AVIF pictures.

The WhatsApp sender needs no redeploy.

## 11. Measured facts behind this design

All measured on 2026-11-10, read-only.

**Live database:**

- 117 companies, none with a `contact_person_id`.
- None of the new columns exist yet.
- 150 families. 126 have a picture, all of them on Bubble's servers and none
  in Ori's storage.
- `bubble_import_lock` is empty, so the final switch-over hasn't happened yet.

**Pictures** (12 Oct export, header-only requests):

| | Files | Total | Median | Largest | AVIF |
|---|---|---|---|---|---|
| Families | 126 | 12 MB | 41 KB | 0.63 MB | 2 |
| Varieties | 178 | 16 MB | 37 KB | 0.87 MB | 1 |

None is over 1 MB.

**Storage and downloads:**

- All 304 pictures come to about 28 MB of the Free plan's 1 GB.
- A customer's first visit downloads about 1 MB, then close to nothing
  thanks to the one-year cache. The Free plan allows 5 GB of downloads a
  month.

**Triggers on the touched tables (live):**

- `companies` has triggers on `status` and `whatsapp_group_id` only, so the
  new columns fire neither.
- `daily_orders` has the statement-level live-update broadcast.
- `product_varieties` and `product_families` have none.
