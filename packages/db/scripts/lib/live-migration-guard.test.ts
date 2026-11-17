import { describe, expect, it } from "vitest";

import { checkLiveMigrationLog, isLiveDatabaseUrl, journalProblems, type JournalEntry, type LoggedRow } from "./live-migration-guard";

// Real entries from migrations/meta/_journal.json (0107 is the WhatsApp
// routing file, on its own branch when this was written).
const m0104: JournalEntry = { idx: 104, when: 1793134800000, tag: "0104_order-reminder-recipients" };
const m0105: JournalEntry = { idx: 105, when: 1793221200000, tag: "0105_grower-sets-pickup-time" };
const m0106: JournalEntry = { idx: 106, when: 1793307600000, tag: "0106_whatsapp-schedule-calls-its-own-project" };
const m0107: JournalEntry = { idx: 107, when: 1793394000000, tag: "0107_whatsapp-routing-like-bubble" };
const m0108: JournalEntry = { idx: 108, when: 1793480400000, tag: "0108_example-next-file" };

// What this checkout's files hash to (stand-ins for sha256 values).
const shaOf = (entry: JournalEntry) => `sha-of-${entry.tag}`;
const fileHashes: Record<string, string> = Object.fromEntries([m0104, m0105, m0106, m0107, m0108].map((entry) => [entry.tag, shaOf(entry)]));
// A row exactly as the job writes it after running a file of this checkout.
const ran = (entry: JournalEntry): LoggedRow => ({ hash: shaOf(entry), when: entry.when });
// A row the backfill copied from dev: dev's hash differs (line endings).
const backfilled = (entry: JournalEntry): LoggedRow => ({ hash: `dev-sha-of-${entry.tag}`, when: entry.when });

const LIVE_POOLER_URL = "postgresql://postgres.zvzqfjrxknxigddkwlir:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
const DEV_POOLER_URL = "postgresql://postgres.owjgzyxuldmgvwxnhrom:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

describe("isLiveDatabaseUrl", () => {
  it("accepts live's session pooler address (user postgres.<live ref>)", () => {
    expect(isLiveDatabaseUrl(LIVE_POOLER_URL)).toBe(true);
  });

  it("accepts live's direct address (host db.<live ref>.supabase.co)", () => {
    expect(isLiveDatabaseUrl("postgresql://postgres:pw@db.zvzqfjrxknxigddkwlir.supabase.co:5432/postgres")).toBe(true);
  });

  it("refuses dev's pooler address", () => {
    expect(isLiveDatabaseUrl(DEV_POOLER_URL)).toBe(false);
  });

  it("refuses an address whose only mention of the live ref is the password", () => {
    expect(
      isLiveDatabaseUrl("postgresql://postgres.owjgzyxuldmgvwxnhrom:zvzqfjrxknxigddkwlir@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"),
    ).toBe(false);
  });

  it("refuses text that is not an address", () => {
    expect(isLiveDatabaseUrl("not a url")).toBe(false);
  });
});

describe("journalProblems", () => {
  it("finds nothing wrong with consecutive files whose whens only go up", () => {
    expect(journalProblems([m0104, m0105, m0106, m0107])).toEqual([]);
  });

  it("names two files that share a when (two branches picked the same one)", () => {
    const twin: JournalEntry = { idx: 107, when: m0106.when, tag: "0107_twin-of-0106" };
    const problems = journalProblems([m0105, m0106, twin]);
    expect(problems.join("\n")).toContain("0107_twin-of-0106");
    expect(problems.join("\n")).toContain(m0106.tag);
  });

  it("names a file whose when goes backwards", () => {
    const early: JournalEntry = { idx: 107, when: m0105.when - 1, tag: "0107_written-before-0105" };
    expect(journalProblems([m0105, m0106, early]).join("\n")).toContain("0107_written-before-0105");
  });

  it("names a skipped or repeated idx and a repeated tag", () => {
    expect(journalProblems([m0104, m0106]).join("\n")).toContain(m0106.tag);
    expect(journalProblems([m0104, { ...m0105, tag: m0104.tag }]).join("\n")).toContain(m0104.tag);
  });
});

describe("checkLiveMigrationLog", () => {
  const journal = [m0104, m0105, m0106];
  const backfilledLog = journal.map(backfilled);

  function check(overrides: { databaseUrl?: string | undefined; journal?: JournalEntry[]; logged?: LoggedRow[] }) {
    return checkLiveMigrationLog({
      databaseUrl: "databaseUrl" in overrides ? overrides.databaseUrl : LIVE_POOLER_URL,
      journal: overrides.journal ?? journal,
      fileHashes,
      logged: overrides.logged ?? backfilledLog,
    });
  }

  it("refuses when no database address was given (the secret is missing)", () => {
    for (const databaseUrl of [undefined, ""]) {
      const result = check({ databaseUrl });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("LIVE_DATABASE_URL");
    }
  });

  it("refuses an address that is not the live project", () => {
    const result = check({ databaseUrl: DEV_POOLER_URL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not the live project");
  });

  it("refuses live's log as it is today (34 rows ending at 0033): the backfill has not run", () => {
    const today = [...Array.from({ length: 33 }, (_, i) => 1783611912446 + i), 1783870018810].map((when) => ({ hash: "dev", when }));
    const result = check({ logged: today });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("backfill");
  });

  it("refuses an empty log", () => {
    const result = check({ logged: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("backfill");
  });

  it("refuses when a file older than live's last logged one never ran, and names it", () => {
    const result = check({ journal: [m0104, m0105, m0106, m0107], logged: [backfilled(m0104), backfilled(m0106)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0105_grower-sets-pickup-time");
  });

  it("refuses a journal where two files share a when — Drizzle would run only one of them", () => {
    const twin: JournalEntry = { idx: 107, when: m0106.when, tag: "0107_twin-of-0106" };
    const result = check({ journal: [...journal, twin] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0107_twin-of-0106");
  });

  it("refuses when live ran a file this checkout no longer has (a reverted pull request)", () => {
    const result = check({ logged: [...backfilledLog, ran(m0107)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(String(m0107.when));
  });

  it("refuses when live ran a different file at the same when (reverted, then a new file took its when)", () => {
    const newFile: JournalEntry = { idx: 107, when: m0107.when, tag: "0107_a-different-file" };
    const result = checkLiveMigrationLog({
      databaseUrl: LIVE_POOLER_URL,
      journal: [...journal, newFile],
      fileHashes: { ...fileHashes, [newFile.tag]: "sha-of-the-new-file" },
      logged: [...backfilledLog, ran(m0107)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0107_a-different-file");
  });

  it("allows a log that already has every file, with nothing to run (backfilled rows carry dev's hashes)", () => {
    expect(check({})).toEqual({ ok: true, pending: [] });
  });

  it("allows a log that ends at 0106 and lists 0107 as the file to run", () => {
    expect(check({ journal: [...journal, m0107] })).toEqual({ ok: true, pending: [m0107] });
  });

  it("allows a file the job ran before (same when, same hash) and lists the next one", () => {
    expect(check({ journal: [...journal, m0107, m0108], logged: [...backfilledLog, ran(m0107)] })).toEqual({
      ok: true,
      pending: [m0108],
    });
  });
});
