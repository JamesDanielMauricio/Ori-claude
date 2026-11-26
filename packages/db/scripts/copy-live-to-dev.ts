// Copies the LIVE database's data into the DEV database, so dev has real data
// to try things on. Not part of the shipped app; run by hand.
//
// James's choices (2026-11-19): an EXACT copy — real names, emails, phone
// numbers and passwords, so everyone signs in on dev with their live email and
// password — and dev's made-up seed data is REPLACED, not kept alongside.
// (Dev never sends a WhatsApp message to the real number: every dev send goes
// to the test phone in notification_settings, which this copy leaves alone.)
//
// How it works:
//   1. Live is opened READ-ONLY. Every table is read inside one read-only
//      snapshot, so a sale happening on live mid-copy can't leave dev with
//      half of it.
//   2. Dev is changed in ONE transaction: its data and logins are emptied,
//      live's rows are written in with dev's triggers switched off (they would
//      re-tidy phone numbers, stamp new "updated" times and send live-update
//      messages — a copy must land exactly as live has it), and then every
//      copied table is compared with live's, row for row. Any failure rolls
//      everything back: dev is left exactly as it was.
//   3. A dry run (the default) does all of that, prints the report, then rolls
//      back. Pass --commit to keep it.
//
// Not copied — dev keeps its own:
//   notification_templates        dev's message links point at the preview site
//   notification_settings         dev's test phone and WhatsApp switches
//   alert_types                   the same rows on both, made by migrations
//   notification_dispatch_status  dev's own sender status
//   _bubble_migration_id_map, _bubble_migration_log, bubble_import_lock
//                                 bookkeeping of the Bubble import (live only)
// Emptied on dev and left empty:
//   notification_outbox           live's message queue is history, not sample
//                                 data (and an unsent row would go out again as
//                                 a dev preview)
//   crash_trail                   its rows point at dev's old logins
// Every other table in public is copied, so a table added by a later
// migration is copied too — add it to a list above if it shouldn't be.
//
// Run from the repo root in PowerShell. It reads DATABASE_URL from
// .env.prod.local (live) and from .env (dev) itself, so no password is typed:
//   pnpm.cmd --filter @ori/db exec tsx scripts/copy-live-to-dev.ts            dry run
//   pnpm.cmd --filter @ori/db exec tsx scripts/copy-live-to-dev.ts --commit   for real

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const PROD_REF = "zvzqfjrxknxigddkwlir";
const DEV_REF = "owjgzyxuldmgvwxnhrom";
const COMMIT = process.argv.includes("--commit");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const KEEP_ON_DEV = new Set([
  "notification_templates",
  "notification_settings",
  "alert_types",
  "notification_dispatch_status",
  "_bubble_migration_id_map",
  "_bubble_migration_log",
  "bubble_import_lock",
]);
const EMPTY_ON_DEV = ["notification_outbox", "crash_trail"];
// Logins: users before identities (identities point at users).
const AUTH_TABLES = ["users", "identities"];

// Keeps each insert's data well under any server or pooler message limit.
const CHUNK_BYTES = 2_000_000;

type Table = { schema: string; name: string };
type Column = { name: string; type: string; generated: boolean };
type Tx = postgres.TransactionSql;

class Refusal extends Error {}
class DryRunRollback extends Error {}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ident = (t: Table) => `${quote(t.schema)}.${quote(t.name)}`;
const label = (t: Table) => `${t.schema}.${t.name}`;

// Which Supabase project an address reaches. The pooler routes by the user
// name (postgres.<ref>); a direct address names the project in its host.
function projectOf(url: string): "live" | "dev" | "unknown" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  const names = (ref: string) => parsed.username.endsWith(`.${ref}`) || parsed.hostname.includes(ref);
  if (names(PROD_REF)) return "live";
  if (names(DEV_REF)) return "dev";
  return "unknown";
}

function databaseUrlFrom(file: string): string {
  let text: string;
  try {
    text = readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    throw new Refusal(`${file} was not found in the repo folder.`);
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Refusal(`${file} has no DATABASE_URL line.`);
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

function addresses(): { live: string; dev: string; rehearsal: boolean } {
  const testLive = process.env.COPY_TEST_LIVE_URL;
  const testDev = process.env.COPY_TEST_DEV_URL;

  // SECURITY: the rehearsal door.
  // ALLOWS: a practice run between two throwaway databases on this computer,
  //   named by COPY_TEST_LIVE_URL and COPY_TEST_DEV_URL.
  // PROTECTS AGAINST: that door being used to aim the copy at a hosted
  //   database without the live/dev checks below — both addresses must be
  //   localhost, or the script stops.
  if (testLive !== undefined || testDev !== undefined) {
    const local = (u: string | undefined) => {
      try {
        return u !== undefined && ["localhost", "127.0.0.1"].includes(new URL(u).hostname);
      } catch {
        return false;
      }
    };
    if (!local(testLive) || !local(testDev) || testLive === undefined || testDev === undefined) {
      throw new Refusal("COPY_TEST_LIVE_URL and COPY_TEST_DEV_URL must both be set and both point at localhost.");
    }
    return { live: testLive, dev: testDev, rehearsal: true };
  }

  // SECURITY: the copy only ever goes live -> dev.
  // ALLOWS: reading from the address that reaches live's project and writing
  //   to the one that reaches dev's.
  // PROTECTS AGAINST: the two files swapped or edited by mistake (dev values
  //   once landed in the live backup file, 2026-11-17) — which would empty
  //   LIVE, the real business, and fill it with dev's data. Reading the files
  //   here, rather than asking for the addresses, also keeps the database
  //   passwords out of PowerShell's history.
  const live = databaseUrlFrom(".env.prod.local");
  const dev = databaseUrlFrom(".env");
  if (projectOf(dev) === "live") throw new Refusal(".env's DATABASE_URL points at LIVE. This script only ever writes to dev.");
  if (projectOf(dev) !== "dev") throw new Refusal(`.env's DATABASE_URL does not point at the dev project (${DEV_REF}).`);
  if (projectOf(live) !== "live") throw new Refusal(`.env.prod.local's DATABASE_URL does not point at the live project (${PROD_REF}).`);
  return { live, dev, rehearsal: false };
}

// Text forms (dates, numbers) depend on session settings; fix them so live's
// and dev's fingerprints of the same rows come out identical.
async function useStableText(tx: Tx) {
  await tx.unsafe("set local timezone = 'UTC'");
  await tx.unsafe("set local datestyle = 'ISO, MDY'");
  await tx.unsafe("set local intervalstyle = 'postgres'");
  await tx.unsafe("set local extra_float_digits = 1");
  await tx.unsafe("set local bytea_output = 'hex'");
}

async function publicTables(tx: Tx): Promise<string[]> {
  const rows = await tx.unsafe(
    `select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1`,
  );
  return rows.map((r) => String(r.name));
}

async function columnsOf(tx: Tx, t: Table): Promise<Column[]> {
  const rows = await tx.unsafe(
    `select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, a.attgenerated <> '' as generated
     from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attname`,
    [ident(t)],
  );
  return rows.map((r) => ({ name: String(r.name), type: String(r.type), generated: r.generated === true }));
}

// Row count + an md5 over every row's full text (all columns, in name order,
// sorted byte-wise so both servers sort alike).
async function fingerprint(tx: Tx, t: Table, columns: Column[]): Promise<{ rows: number; md5: string }> {
  const list = columns.map((c) => quote(c.name)).join(", ");
  const [row] = await tx.unsafe(
    `select count(*)::int as n, md5(coalesce(string_agg(r, E'\\n' order by r collate "C"), '')) as fp
     from (select row(${list})::text as r from ${ident(t)}) s`,
  );
  return { rows: Number(row?.n), md5: String(row?.fp) };
}

const sameColumns = (a: Column[], b: Column[]) => JSON.stringify(a) === JSON.stringify(b);

type Snapshot = { table: Table; columns: Column[]; rows: string[]; print: { rows: number; md5: string } };

async function readLive(url: string): Promise<{ tables: string[]; copied: Snapshot[] }> {
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20, onnotice: () => undefined });
  try {
    // SECURITY: live is only ever read.
    // ALLOWS: SELECTs, all inside one read-only snapshot.
    // PROTECTS AGAINST: any statement here — by a bug or a future edit —
    //   changing live; Postgres itself refuses every write in a READ ONLY
    //   transaction. (Repeatable read = one consistent moment for all tables.)
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      await useStableText(tx);
      const tables = await publicTables(tx);
      const toCopy: Table[] = [
        ...AUTH_TABLES.map((name) => ({ schema: "auth", name })),
        ...tables
          .filter((name) => !KEEP_ON_DEV.has(name) && !EMPTY_ON_DEV.includes(name))
          .map((name) => ({ schema: "public", name })),
      ];
      const copied: Snapshot[] = [];
      for (const table of toCopy) {
        const columns = await columnsOf(tx, table);
        const rows = (await tx.unsafe(`select row_to_json(t)::text as j from ${ident(table)} t`)).map((r) => String(r.j));
        copied.push({ table, columns, rows, print: await fingerprint(tx, table, columns) });
        console.log(`  read ${label(table).padEnd(38)} ${rows.length.toLocaleString("en-US").padStart(8)} rows`);
      }
      return { tables, copied };
    });
  } finally {
    await sql.end();
  }
}

async function writeDev(url: string, rehearsal: boolean, live: { tables: string[]; copied: Snapshot[] }) {
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      await useStableText(tx);

      // SECURITY: a second check, asked of the database itself.
      // ALLOWS: writing only to a database whose own address in Vault
      //   (project_url, migration 0106) is dev's project and which holds none
      //   of the Bubble-import message templates live has (11 there, 0 on dev).
      // PROTECTS AGAINST: emptying LIVE through an address that looks like
      //   dev's but reaches live — the same two signals the dev link fix of
      //   2026-11-19 refused on. A database without Vault fails here too.
      const [target] = await tx.unsafe(
        `select (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') as project_url,
                (select count(*)::int from public.notification_templates where template_key like 'bubble_mainalert%') as bubble_templates`,
      );
      const projectUrl = String(target?.project_url ?? "");
      if (projectUrl.includes(PROD_REF) || !projectUrl.includes(DEV_REF) || Number(target?.bubble_templates) !== 0) {
        throw new Refusal(
          "The database behind .env does not identify itself as dev (Vault project_url / Bubble templates). Nothing was changed.",
        );
      }
      console.log(`  dev identifies itself as ${DEV_REF}${rehearsal ? " (rehearsal stand-in)" : ""}`);

      // Same tables and columns on both, or the copy would silently drop or
      // blank data: that means a migration ran on one side but not the other.
      const devTables = await publicTables(tx);
      const missing = live.tables.filter((n) => !devTables.includes(n));
      const extra = devTables.filter((n) => !live.tables.includes(n));
      if (missing.length > 0 || extra.length > 0) {
        throw new Refusal(
          `Live and dev have different tables (only on live: ${missing.join(", ") || "none"}; only on dev: ${extra.join(", ") || "none"}). Bring both to the same migration first.`,
        );
      }
      for (const snap of live.copied) {
        if (!sameColumns(snap.columns, await columnsOf(tx, snap.table))) {
          throw new Refusal(`${label(snap.table)} has different columns on live and dev. Bring both to the same migration first.`);
        }
      }

      // Empty dev. Truncating all of these in one statement satisfies the
      // links between them; deleting the logins then also removes their
      // sessions, refresh tokens and identities (Supabase's own cascades).
      const publicCopied = live.copied.filter((s) => s.table.schema === "public").map((s) => s.table);
      const wipe = [...publicCopied, ...EMPTY_ON_DEV.map((name) => ({ schema: "public", name }))];
      await tx.unsafe(`truncate table ${wipe.map(ident).join(", ")}`);
      await tx.unsafe("delete from auth.users");
      console.log(`  emptied dev (${wipe.length} tables + logins)`);

      // Triggers off for the copy only (Supabase's own restore guide does the
      // same). It also skips the link checks between tables, so the checks
      // further down confirm every link holds.
      await tx.unsafe("set local session_replication_role = replica");
      for (const snap of live.copied) {
        const columns = snap.columns.filter((c) => !c.generated).map((c) => quote(c.name)).join(", ");
        let chunk: string[] = [];
        let bytes = 0;
        const flush = async () => {
          if (chunk.length === 0) return;
          // $1 is sent as plain text and turned into JSON by Postgres: a
          // parameter typed json would be JSON-encoded a second time by the
          // client, arriving as one quoted string.
          await tx.unsafe(
            `insert into ${ident(snap.table)} (${columns})
             select ${columns} from json_populate_recordset(null::${ident(snap.table)}, $1::text::json)`,
            [`[${chunk.join(",")}]`],
          );
          chunk = [];
          bytes = 0;
        };
        for (const row of snap.rows) {
          chunk.push(row);
          bytes += row.length;
          if (bytes >= CHUNK_BYTES) await flush();
        }
        await flush();
      }
      await tx.unsafe("set local session_replication_role = origin");

      // Check 1: every copied table is identical to live's, row for row.
      let problems = 0;
      console.log("");
      for (const snap of live.copied) {
        const got = await fingerprint(tx, snap.table, snap.columns);
        const ok = got.rows === snap.print.rows && got.md5 === snap.print.md5;
        if (!ok) problems += 1;
        console.log(
          `  ${ok ? "OK  " : "DIFF"} ${label(snap.table).padEnd(38)} ${got.rows.toLocaleString("en-US").padStart(8)} rows${ok ? "" : ` (live has ${snap.print.rows.toLocaleString("en-US")})`}`,
        );
      }

      // Check 2: every link out of a copied table points at a row that
      // exists — including links into the tables dev kept (e.g. alert_types).
      const links = await tx.unsafe(
        `select con.conname::text as name, cn.nspname::text as child_schema, c.relname::text as child,
                pn.nspname::text as parent_schema, p.relname::text as parent,
                array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord) as child_cols,
                array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord) as parent_cols
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid join pg_namespace cn on cn.oid = c.relnamespace
         join pg_class p on p.oid = con.confrelid join pg_namespace pn on pn.oid = p.relnamespace
         where con.contype = 'f'`,
      );
      const copiedNames = new Set(live.copied.map((s) => label(s.table)));
      let linksChecked = 0;
      for (const link of links) {
        const child: Table = { schema: String(link.child_schema), name: String(link.child) };
        if (!copiedNames.has(label(child))) continue;
        const parent: Table = { schema: String(link.parent_schema), name: String(link.parent) };
        const childCols = link.child_cols as string[];
        const parentCols = link.parent_cols as string[];
        const set = childCols.map((c) => `c.${quote(c)} is not null`).join(" and ");
        const match = childCols.map((c, i) => `p.${quote(parentCols[i] ?? "")} = c.${quote(c)}`).join(" and ");
        const [row] = await tx.unsafe(
          `select count(*)::int as n from ${ident(child)} c where ${set} and not exists (select 1 from ${ident(parent)} p where ${match})`,
        );
        linksChecked += 1;
        if (Number(row?.n) > 0) {
          problems += 1;
          console.log(`  BROKEN LINK ${String(link.name)}: ${String(row?.n)} row(s) of ${label(child)} point at missing ${label(parent)} rows`);
        }
      }
      console.log(`\n  ${linksChecked} links between tables checked`);

      if (problems > 0) throw new Error(`${problems} check(s) failed — rolled back, dev is unchanged.`);
      if (!COMMIT) throw new DryRunRollback();
    });
  } finally {
    await sql.end();
  }
}

async function main() {
  const { live, dev, rehearsal } = addresses();
  console.log(`${COMMIT ? "COMMIT RUN" : "DRY RUN (rolled back at the end — pass --commit to keep it)"}`);
  console.log(`  from: ${rehearsal ? "local stand-in for live" : `live ${PROD_REF}`} (read-only)`);
  console.log(`  to:   ${rehearsal ? "local stand-in for dev" : `dev ${DEV_REF}`}\n`);

  const snapshot = await readLive(live);
  console.log("");
  await writeDev(dev, rehearsal, snapshot);

  console.log("\nDone: dev is now a copy of live.");
  console.log("  - Sign in on dev with your LIVE email and password (dev's old @example.test logins are gone,");
  console.log("    so dev-logins.local.txt is out of date).");
  console.log("  - Anyone signed in to dev should sign out and in again; open dev screens need a refresh.");
}

main().then(
  () => undefined,
  (error: unknown) => {
    if (error instanceof DryRunRollback) {
      console.log("\nDry run passed: every check above held. Everything was rolled back — dev is unchanged.");
      console.log("Run again with --commit to keep the copy.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n${error instanceof Refusal ? "Refusing" : "Failed"}: ${message}`);
    process.exitCode = 1;
  },
);
