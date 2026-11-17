// The migrate-live job's whole run, on ONE connection to live:
//   1. refuse unless the address is live's (before connecting at all);
//   2. read live's migration log and let the guard decide (live-migration-guard.ts);
//   3. run the new files with Drizzle's own migrator — the same function
//      `drizzle-kit migrate` calls, so all of them run in one transaction;
//   4. read the log again: every file of the run must now be recorded.
// Entry point: scripts/migrate-live.ts. The job's log is public (the repository
// is), so nothing here prints a database value — see describeDatabaseError.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { checkLiveMigrationLog, liveUrlProblem, type JournalEntry, type LoggedRow } from "./live-migration-guard";

export type LiveConnection = {
  readLog(): Promise<LoggedRow[]>;
  migrate(): Promise<void>;
  end(): Promise<void>;
};

const LIVE_CONNECTION_OPTIONS = {
  max: 1,
  connect_timeout: 20,
  // SECURITY: the connection must be encrypted (TLS) before anything else is
  // sent. It ALLOWS the job to reach live across the internet. It PROTECTS
  // AGAINST the live password and live data travelling in clear text between
  // GitHub's machine and Supabase — postgres.js does not encrypt unless told
  // to. ("require" encrypts without checking the server's certificate, like
  // Postgres's own sslmode=require.)
  ssl: "require",
  // SECURITY: Postgres notices are dropped instead of printed. It ALLOWS the
  // run to go on as normal. It PROTECTS AGAINST a notice raised by a
  // migration (which can quote row values) landing in the public job log.
  onnotice: () => {},
} as const;

// readDeadlineMs: how long reading the log may take. postgres.js keeps
// reconnecting while a server keeps hanging up on it (for example when the two
// sides cannot agree on encryption), which would otherwise spin until the job's
// own time limit. Drizzle's run itself has no deadline here: a long migration
// is allowed to take its time.
export function connectToLive(url: string, migrationsFolder: string, options: { readDeadlineMs?: number } = {}): LiveConnection {
  const readDeadlineMs = options.readDeadlineMs ?? 60_000;
  const sql = postgres(url, LIVE_CONNECTION_OPTIONS);
  return {
    readLog: () =>
      withDeadline(
        // created_at is the file's journal `when`; a bigint, which arrives as text.
        sql<{ hash: string; created_at: string }[]>`select hash, created_at from drizzle.__drizzle_migrations`.then((rows) =>
          rows.map((row) => ({ hash: row.hash, when: Number(row.created_at) })),
        ),
        readDeadlineMs,
        `live did not answer within ${readDeadlineMs / 1000} seconds`,
      ),
    migrate: () => migrate(drizzle(sql), { migrationsFolder }),
    // Closes cleanly when nothing is pending; otherwise cuts the line after 1 s.
    end: () => sql.end({ timeout: 1 }),
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function readJournal(migrationsFolder: string): JournalEntry[] {
  const raw = readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries.map(({ idx, when, tag }) => ({ idx, when, tag }));
}

// Each file's sha256 exactly as Drizzle computes it when it runs the file
// (drizzle-orm's readMigrationFiles), so it can be compared with live's log.
export function readFileHashes(migrationsFolder: string, journal: JournalEntry[]): Record<string, string> {
  return Object.fromEntries(
    journal.map((entry) => {
      const query = readFileSync(`${migrationsFolder}/${entry.tag}.sql`).toString();
      return [entry.tag, createHash("sha256").update(query).digest("hex")];
    }),
  );
}

// SECURITY: what a failure prints is limited to these fields. It ALLOWS the
// log to say which statement failed and why (the error code, its message, and
// the table, column and constraint involved). It PROTECTS AGAINST live
// customers' data reaching the public job log: Postgres's `detail` (for example
// "Key (phone_number)=(0501234567) already exists"), `where` and `hint` can
// quote row values, so they are never printed. When a library wraps the
// database error, the database error inside it is the one described.
export function describeDatabaseError(error: unknown): string {
  const outer = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const source =
    typeof outer.cause === "object" && outer.cause !== null && "code" in outer.cause ? (outer.cause as Record<string, unknown>) : outer;
  const parts = [typeof source.message === "string" ? source.message : String(error)];
  for (const field of ["code", "table_name", "column_name", "constraint_name"]) {
    if (typeof source[field] === "string") parts.push(`${field}: ${source[field]}`);
  }
  return parts.join(" | ");
}

export async function migrateLive(deps: {
  databaseUrl: string | undefined;
  journal: JournalEntry[];
  fileHashes: Record<string, string>;
  connect: (url: string) => LiveConnection;
  log: (line: string) => void;
}): Promise<number> {
  const { databaseUrl } = deps;

  // SECURITY: the address is checked BEFORE any connection. It ALLOWS a
  // connection only to an address that names the live project. It PROTECTS
  // AGAINST migrating some other database, and against sending the password
  // to it, because the secret was filled in wrong: a refused address is
  // never connected to.
  const urlProblem = liveUrlProblem(databaseUrl);
  if (urlProblem !== null || databaseUrl === undefined) {
    deps.log(`Refusing: ${urlProblem ?? "no database address."}`);
    return 1;
  }

  const connection = deps.connect(databaseUrl);
  try {
    let logged: LoggedRow[];
    try {
      logged = await connection.readLog();
    } catch (error) {
      deps.log(`Refusing: could not read live's migration log (${describeDatabaseError(error)}). Nothing was run.`);
      return 1;
    }

    const decision = checkLiveMigrationLog({ databaseUrl, journal: deps.journal, fileHashes: deps.fileHashes, logged });
    if (!decision.ok) {
      deps.log(`Refusing: ${decision.reason}`);
      return 1;
    }
    if (decision.pending.length === 0) {
      deps.log("Live already has every migration file: nothing new to run.");
      return 0;
    }

    deps.log(`Live will now run ${decision.pending.length} new migration file(s), in this order:`);
    for (const entry of decision.pending) deps.log(`  ${entry.tag}`);
    try {
      await connection.migrate();
    } catch (error) {
      deps.log(`Failed: ${describeDatabaseError(error)}. Live is unchanged: the files of this run are applied together or not at all.`);
      return 1;
    }

    // Green must mean applied: every file of the run is now in live's log.
    const after = new Set((await connection.readLog()).map((row) => row.when));
    const missing = decision.pending.filter((entry) => !after.has(entry.when));
    if (missing.length > 0) {
      deps.log(`Failed: Drizzle finished, but live has not recorded ${missing.map((entry) => entry.tag).join(", ")}. Ask Claude.`);
      return 1;
    }
    deps.log("Done: live has every migration file.");
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}
