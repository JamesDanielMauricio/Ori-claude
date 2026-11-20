// Copies Bubble's values into the columns Bubble column parity added
// (migrations 0092-0094; spec docs/superpowers/specs/2026-11-10-bubble-column-parity-design.md §8.2):
// company טלפון / כתובת / יישוב / ח.פ. / מספר בהנה״ח and איש קשר, variety
// pictures, order comments — and Ori's own copies of the family pictures
// still loading from Bubble's servers.
//
// Run from packages/db, after the migrations are applied and the new web app
// is live:
//   pnpm bubble:export -- --env live      (read-only against Bubble)
//   pnpm fill:from-bubble                  dry run (default): writes and uploads nothing
//   pnpm fill:from-bubble -- --commit      the real run
//
// It only ever fills EMPTY fields (Ori wins), apart from replacing a family's
// Bubble picture link with Ori's copy of the same picture; it never changes
// any other field. Pictures are uploaded first; then every database change
// runs in ONE transaction, and if that fails the pictures this run uploaded
// are removed again. Safe to run again: a second run finds everything filled.
//
// Not blocked by bubble_import_lock (0084): that lock stops the IMPORTER,
// which replaces data; this only fills.
//
// Reads DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the root
// .env and never prints them. Prints counts and Ori ids only — never a phone,
// a name or a comment — so its output is safe to share.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import {
  checkPicture,
  copyPicture,
  loadExport,
  supabasePictureStore,
  type PictureStore,
} from "./lib/bubble-extras";
import { FILL_FIELDS, planFill, type FieldReport, type FillExport, type FillField, type IdMaps, type OriSnapshot } from "./lib/fill-plan";
import { fillStatements, type FillStatement, type FillWrites } from "./lib/fill-sql";
import { targetProject } from "./lib/target-project";

const EXPORT_TYPES = ["company", "productvarieties", "productfamily", "dailyorder"] as const;
const NEW_COLUMNS: ReadonlyArray<[string, string]> = [
  ["companies", "phone"],
  ["companies", "address_line"],
  ["companies", "city"],
  ["companies", "tax_id"],
  ["companies", "accounting_id"],
  ["daily_orders", "comment"],
  ["product_varieties", "image_url"],
];

type PictureJob =
  | { field: "variety_picture"; id: string; source: string }
  | { field: "family_picture"; id: string; source: string; current: string | null };

async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await run(item);
    }
  });
  await Promise.all(workers);
}

export async function runFill({
  sql,
  store,
  exportDir,
  commit,
  fetchFn = fetch,
  log = (line: string) => console.log(line),
}: {
  sql: postgres.Sql;
  store: PictureStore;
  exportDir: string;
  commit: boolean;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
}): Promise<Record<FillField, FieldReport>> {
  // 1. The migrations must be in place, or there is nothing to fill.
  const present = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and table_name in ('companies', 'daily_orders', 'product_varieties')
  `;
  const have = new Set(present.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = NEW_COLUMNS.filter(([table, column]) => !have.has(`${table}.${column}`));
  if (missing.length > 0) {
    throw new Error(`Apply migrations 0092–0094 first — missing: ${missing.map(([table, column]) => `${table}.${column}`).join(", ")}.`);
  }

  // 2. What Bubble has, and what Ori has now.
  const data = (await loadExport(exportDir, EXPORT_TYPES, "live")) as unknown as FillExport;
  const idRows = await sql<{ entity_type: keyof IdMaps; bubble_id: string; new_id: string }[]>`
    select entity_type, bubble_id, new_id::text as new_id from public._bubble_migration_id_map
    where entity_type in ('company', 'user', 'productfamily', 'productvarieties', 'dailyorder')
  `;
  const maps = { company: new Map(), user: new Map(), productfamily: new Map(), productvarieties: new Map(), dailyorder: new Map() } as Record<keyof IdMaps, Map<string, string>>;
  for (const row of idRows) maps[row.entity_type].set(row.bubble_id, row.new_id);

  const companies = await sql<Array<{ id: string } & Record<string, string | null>>>`
    select id::text as id, phone, address_line, city, tax_id, accounting_id, contact_person_id::text as contact_person_id from public.companies
  `;
  const varieties = await sql<{ id: string; image_url: string | null }[]>`select id::text as id, image_url from public.product_varieties`;
  const families = await sql<{ id: string; image_url: string | null }[]>`select id::text as id, image_url from public.product_families`;
  const orders = await sql<{ id: string; comment: string | null }[]>`select id::text as id, comment from public.daily_orders`;
  const profiles = await sql<{ user_id: string }[]>`select user_id::text as user_id from public.profiles`;
  const ori: OriSnapshot = {
    companies: new Map(
      companies.map(({ id, ...values }) => [
        id,
        {
          phone: values.phone ?? null,
          address_line: values.address_line ?? null,
          city: values.city ?? null,
          tax_id: values.tax_id ?? null,
          accounting_id: values.accounting_id ?? null,
          contact_person_id: values.contact_person_id ?? null,
        },
      ]),
    ),
    varieties: new Map(varieties.map((row) => [row.id, row.image_url])),
    families: new Map(families.map((row) => [row.id, row.image_url])),
    orders: new Map(orders.map((row) => [row.id, row.comment])),
    profileIds: new Set(profiles.map((row) => row.user_id)),
  };

  // 3. The plan.
  const plan = planFill(data, maps, ori);
  const report = plan.report;

  const jobs: PictureJob[] = [
    ...plan.varietyPictures.map((picture) => ({ field: "variety_picture" as const, ...picture })),
    ...plan.familyPictures.map((picture) => ({ field: "family_picture" as const, ...picture })),
  ];
  const skip = (job: PictureJob, reason: string) => {
    report[job.field].filled -= 1;
    const keeps = job.field === "family_picture" && job.current !== null ? " (keeps its Bubble link)" : "";
    report[job.field].problems.push({ oriId: job.id, reason: `${reason}${keeps}` });
  };

  // 4. Dry run: header-only picture checks, then stop.
  if (!commit) {
    await eachLimited(jobs, 4, async (job) => {
      const check = await checkPicture(job.source, fetchFn);
      if (!check.ok) skip(job, check.reason);
    });
    log("Dry run: nothing was written and no picture was uploaded.");
    return report;
  }

  // 5. Commit: pictures first, then every database change in one transaction.
  const uploadedPathById = new Map<string, string>();
  const writes: FillWrites = { companies: plan.companies, varietyPictures: [], familyPictures: [], orderComments: plan.orderComments };
  let written: Record<FillStatement["label"], Set<string>>;
  try {
    await eachLimited(jobs, 4, async (job) => {
      const copy = await copyPicture(job.source, store, { fetchFn });
      if (!copy.ok) {
        skip(job, copy.reason);
        return;
      }
      uploadedPathById.set(`${job.field}:${job.id}`, copy.path);
      if (job.field === "variety_picture") writes.varietyPictures.push({ id: job.id, image_url: copy.url });
      else writes.familyPictures.push({ id: job.id, image_url: copy.url, current: job.current });
    });

    written = await sql.begin(async (tx) => {
      const result: Record<FillStatement["label"], Set<string>> = {
        companies: new Set(),
        variety_pictures: new Set(),
        family_pictures: new Set(),
        order_comments: new Set(),
      };
      for (const statement of fillStatements(writes)) {
        // tx.json: postgres.js encodes the rows as the one jsonb parameter.
        const rows = (await tx.unsafe(statement.text, [tx.json(statement.rows as postgres.JSONValue)])) as unknown as Array<{ id: string }>;
        for (const row of rows) result[statement.label].add(String(row.id));
      }
      return result;
    });
  } catch (error) {
    const uploaded = [...uploadedPathById.values()];
    if (uploaded.length > 0) {
      await store
        .remove(uploaded)
        .then(() => log(`Removed the ${uploaded.length} picture(s) this run uploaded.`))
        .catch((removeError: unknown) => log(`Could NOT remove the ${uploaded.length} picture(s) this run uploaded: ${String(removeError)}`));
    }
    throw error;
  }

  // 6. A row that changed in Ori between the read and the write was left
  // alone: it counts as already set, and its uploaded copy goes.
  const unwanted: string[] = [];
  const settle = (field: "variety_picture" | "family_picture" | "order_comment", ids: readonly string[], done: Set<string>) => {
    for (const id of ids) {
      if (done.has(id)) continue;
      report[field].filled -= 1;
      report[field].alreadySet += 1;
      const uploaded = uploadedPathById.get(`${field}:${id}`);
      if (uploaded) unwanted.push(uploaded);
    }
  };
  settle("variety_picture", writes.varietyPictures.map((row) => row.id), written.variety_pictures);
  settle("family_picture", writes.familyPictures.map((row) => row.id), written.family_pictures);
  settle("order_comment", writes.orderComments.map((row) => row.id), written.order_comments);
  if (unwanted.length > 0) {
    await store.remove(unwanted).catch((removeError: unknown) => log(`Could not remove ${unwanted.length} unused picture(s): ${String(removeError)}`));
  }
  log("Committed.");
  return report;
}

export function formatReport(report: Record<FillField, FieldReport>): string {
  const lines = [`${"field".padEnd(20)}${"filled".padStart(8)}${"already set".padStart(13)}${"no Ori row".padStart(12)}${"problems".padStart(10)}`];
  for (const field of FILL_FIELDS) {
    const row = report[field];
    lines.push(`${field.padEnd(20)}${String(row.filled).padStart(8)}${String(row.alreadySet).padStart(13)}${String(row.noOriRow).padStart(12)}${String(row.problems.length).padStart(10)}`);
  }
  const problems = new Map<string, string[]>();
  for (const field of FILL_FIELDS) {
    for (const problem of report[field].problems) {
      const key = `${field}: ${problem.reason}`;
      problems.set(key, [...(problems.get(key) ?? []), problem.oriId ?? "(no Ori id)"]);
    }
  }
  if (problems.size > 0) {
    lines.push("", "Problems (Ori ids):");
    for (const [key, ids] of problems) lines.push(`  ${key} — ${ids.join(", ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptsDir, "../../..");
  try {
    // Node's own .env parser. Variables already set in the shell win.
    process.loadEnvFile(path.join(repoRoot, ".env"));
  } catch {
    // No root .env — rely on whatever the shell exported.
  }
  const commit = process.argv.includes("--commit");
  const DATABASE_URL = process.env.DATABASE_URL ?? "";
  const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (root .env).");
  }

  // The project both addresses name — refused if they name two (a shell that
  // set only some variables, over the root .env that is dev's). Named, not
  // the host: dev and live share one pooler host. Never the password.
  const target = targetProject(DATABASE_URL, SUPABASE_URL);
  console.log(`${commit ? "COMMIT RUN" : "DRY RUN (writes nothing — pass --commit to fill for real)"} against the ${target.label.toUpperCase()} project (${target.ref})\n`);
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false, idle_timeout: 20, onnotice: () => undefined });
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const report = await runFill({
      sql,
      store: supabasePictureStore(client),
      exportDir: path.resolve(scriptsDir, "..", ".bubble-export", "live"),
      commit,
    });
    console.log(`\n${formatReport(report)}`);
  } finally {
    await sql.end();
  }
}

// Only when run as a script — importing runFill (the checks do) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
