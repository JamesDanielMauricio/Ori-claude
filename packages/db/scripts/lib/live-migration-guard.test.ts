import { describe, expect, it } from "vitest";

import { checkLiveMigrationLog, isLiveDatabaseUrl, type JournalEntry } from "./live-migration-guard";

// Real entries from migrations/meta/_journal.json (0107 is the WhatsApp
// routing file, on its own branch when this was written).
const m0033: JournalEntry = { idx: 33, when: 1783870018810, tag: "0033_save-grower-transporter-assignment" };
const m0104: JournalEntry = { idx: 104, when: 1793134800000, tag: "0104_order-reminder-recipients" };
const m0105: JournalEntry = { idx: 105, when: 1793221200000, tag: "0105_grower-sets-pickup-time" };
const m0106: JournalEntry = { idx: 106, when: 1793307600000, tag: "0106_whatsapp-schedule-calls-its-own-project" };
const m0107: JournalEntry = { idx: 107, when: 1793394000000, tag: "0107_whatsapp-routing-like-bubble" };

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

describe("checkLiveMigrationLog", () => {
  const journal = [m0104, m0105, m0106];
  const fullLog = journal.map((entry) => entry.when);

  it("refuses when no database address was given (the secret is missing)", () => {
    for (const databaseUrl of [undefined, ""]) {
      const result = checkLiveMigrationLog({ databaseUrl, journal, loggedWhens: fullLog });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("LIVE_DATABASE_URL");
    }
  });

  it("refuses an address that is not the live project", () => {
    const result = checkLiveMigrationLog({ databaseUrl: DEV_POOLER_URL, journal, loggedWhens: fullLog });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not the live project");
  });

  it("refuses live's log as it is today (34 rows ending at 0033): the backfill has not run", () => {
    const today = [...Array.from({ length: 33 }, (_, i) => 1783611912446 + i), m0033.when];
    const result = checkLiveMigrationLog({ databaseUrl: LIVE_POOLER_URL, journal: [m0033, ...journal], loggedWhens: today });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("backfill");
  });

  it("refuses an empty log", () => {
    const result = checkLiveMigrationLog({ databaseUrl: LIVE_POOLER_URL, journal, loggedWhens: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("backfill");
  });

  it("refuses when a file older than live's last logged one never ran, and names it", () => {
    const result = checkLiveMigrationLog({
      databaseUrl: LIVE_POOLER_URL,
      journal: [m0104, m0105, m0106, m0107],
      loggedWhens: [m0104.when, m0106.when],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0105_grower-sets-pickup-time");
  });

  it("allows a log that already has every file, with nothing to run", () => {
    expect(checkLiveMigrationLog({ databaseUrl: LIVE_POOLER_URL, journal, loggedWhens: fullLog })).toEqual({ ok: true, pending: [] });
  });

  it("allows a log that ends at 0106 and lists 0107 as the file to run", () => {
    expect(
      checkLiveMigrationLog({ databaseUrl: LIVE_POOLER_URL, journal: [...journal, m0107], loggedWhens: fullLog }),
    ).toEqual({ ok: true, pending: [m0107] });
  });
});
