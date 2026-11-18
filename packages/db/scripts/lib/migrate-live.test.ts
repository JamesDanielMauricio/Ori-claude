import net from "node:net";

import { describe, expect, it } from "vitest";

import { LIVE_PROJECT_REF, type JournalEntry, type LoggedRow } from "./live-migration-guard";
import { connectToLive, describeDatabaseError, migrateLive, type LiveConnection } from "./migrate-live";

const m0105: JournalEntry = { idx: 105, when: 1793221200000, tag: "0105_grower-sets-pickup-time" };
const m0106: JournalEntry = { idx: 106, when: 1793307600000, tag: "0106_whatsapp-schedule-calls-its-own-project" };
const m0107: JournalEntry = { idx: 107, when: 1793394000000, tag: "0107_whatsapp-routing-like-bubble" };
const fileHashes: Record<string, string> = Object.fromEntries([m0105, m0106, m0107].map((e) => [e.tag, `sha-of-${e.tag}`]));
const backfilledLog: LoggedRow[] = [m0105, m0106].map((e) => ({ hash: `dev-sha-of-${e.tag}`, when: e.when }));
const row0107: LoggedRow = { hash: `sha-of-${m0107.tag}`, when: m0107.when };

const LIVE_URL = `postgresql://postgres.${LIVE_PROJECT_REF}:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`;
const DEV_URL = "postgresql://postgres.owjgzyxuldmgvwxnhrom:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

// A stand-in for live: a log, and what Drizzle's run appends to it.
function fakeLive(options: { log: LoggedRow[]; readLogFails?: Error; migrateFails?: unknown; migrateAppends?: LoggedRow[] }) {
  const calls = { connect: 0, readLog: 0, migrate: 0, end: 0 };
  let log = [...options.log];
  const connection: LiveConnection = {
    readLog: async () => {
      calls.readLog++;
      if (options.readLogFails) throw options.readLogFails;
      return [...log];
    },
    migrate: async () => {
      calls.migrate++;
      if (options.migrateFails !== undefined) throw options.migrateFails;
      log = [...log, ...(options.migrateAppends ?? [])];
    },
    end: async () => {
      calls.end++;
    },
  };
  const lines: string[] = [];
  return {
    calls,
    lines,
    run: (databaseUrl: string | undefined, journal: JournalEntry[]) =>
      migrateLive({
        databaseUrl,
        journal,
        fileHashes,
        connect: () => {
          calls.connect++;
          return connection;
        },
        log: (line) => lines.push(line),
      }),
  };
}

describe("migrateLive", () => {
  it("refuses a database that is not live without ever connecting to it", async () => {
    const live = fakeLive({ log: backfilledLog });
    expect(await live.run(DEV_URL, [m0105, m0106])).toBe(1);
    expect(live.calls.connect).toBe(0);
    expect(live.lines.join("\n")).toContain("not the live project");
  });

  it("refuses when live's log cannot be read, and closes the connection", async () => {
    const live = fakeLive({ log: [], readLogFails: new Error("connection refused") });
    expect(await live.run(LIVE_URL, [m0105, m0106])).toBe(1);
    expect(live.lines.join("\n")).toContain("could not read live's migration log");
    expect(live.calls.end).toBe(1);
  });

  it("refuses before migrating when the guard refuses (the backfill has not run)", async () => {
    const live = fakeLive({ log: [{ hash: "dev", when: 1783870018810 }] });
    expect(await live.run(LIVE_URL, [m0105, m0106])).toBe(1);
    expect(live.calls.migrate).toBe(0);
    expect(live.lines.join("\n")).toContain("backfill");
    expect(live.calls.end).toBe(1);
  });

  it("with nothing new, does not run Drizzle and succeeds", async () => {
    const live = fakeLive({ log: backfilledLog });
    expect(await live.run(LIVE_URL, [m0105, m0106])).toBe(0);
    expect(live.calls.migrate).toBe(0);
    expect(live.lines.join("\n")).toContain("nothing new");
    expect(live.calls.end).toBe(1);
  });

  it("runs the new file, then checks live really recorded it", async () => {
    const live = fakeLive({ log: backfilledLog, migrateAppends: [row0107] });
    expect(await live.run(LIVE_URL, [m0105, m0106, m0107])).toBe(0);
    expect(live.calls.migrate).toBe(1);
    expect(live.lines.some((line) => line.includes(m0107.tag))).toBe(true);
    expect(live.lines.join("\n")).toContain("Done");
    expect(live.calls.end).toBe(1);
  });

  it("fails when Drizzle returned but live did not record the file — green must mean applied", async () => {
    const live = fakeLive({ log: backfilledLog, migrateAppends: [] });
    expect(await live.run(LIVE_URL, [m0105, m0106, m0107])).toBe(1);
    expect(live.lines.join("\n")).toContain("not recorded");
    expect(live.lines.join("\n")).toContain(m0107.tag);
  });

  it("a failing file is reported with safe fields only — never the row values in Postgres's detail", async () => {
    const failure = Object.assign(new Error('duplicate key value violates unique constraint "profiles_phone_key"'), {
      code: "23505",
      detail: "Key (phone_number)=(0501234567) already exists.",
      where: "SQL statement \"update public.profiles set phone_number = '0501234567'\"",
      table_name: "profiles",
      constraint_name: "profiles_phone_key",
    });
    const live = fakeLive({ log: backfilledLog, migrateFails: failure });
    expect(await live.run(LIVE_URL, [m0105, m0106, m0107])).toBe(1);
    const output = live.lines.join("\n");
    expect(output).toContain("23505");
    expect(output).toContain("profiles_phone_key");
    expect(output).not.toContain("0501234567");
    expect(live.calls.end).toBe(1);
  });
});

describe("describeDatabaseError", () => {
  it("describes the database error inside a wrapper, without its detail", () => {
    const cause = Object.assign(new Error('column "x" does not exist'), { code: "42703", detail: "secret row value 0501234567" });
    const wrapped = Object.assign(new Error("Failed query: alter table ..."), { cause });
    const text = describeDatabaseError(wrapped);
    expect(text).toContain("42703");
    expect(text).toContain('column "x" does not exist');
    expect(text).not.toContain("0501234567");
  });
});

describe("connectToLive", () => {
  it("asks for an encrypted connection first and never sends the login in clear text", async () => {
    const received: Buffer[] = [];
    const isSslRequest = (chunk: Buffer) => chunk.length >= 8 && chunk.readInt32BE(4) === 80877103;
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk);
        // An encryption request gets "N" (no encryption here); anything else — a
        // clear-text login, or the TLS handshake that follows — gets a hang-up.
        if (received.length === 1 && isSslRequest(chunk)) socket.write("N");
        else socket.destroy();
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;

    const connection = connectToLive(`postgresql://postgres.${LIVE_PROJECT_REF}:the-password@127.0.0.1:${port}/postgres`, "unused", {
      readDeadlineMs: 500,
    });
    await expect(connection.readLog()).rejects.toBeDefined();
    await connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const bytes = Buffer.concat(received);
    // An SSLRequest is 8 bytes: length 8, then the code 80877103.
    expect(bytes.readInt32BE(4)).toBe(80877103);
    // The login (StartupMessage + password) would name the user in clear text.
    expect(bytes.includes(`postgres.${LIVE_PROJECT_REF}`)).toBe(false);
    expect(bytes.includes("the-password")).toBe(false);
  });
});
