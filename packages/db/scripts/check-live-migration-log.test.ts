import { describe, expect, it } from "vitest";

import { runGuard } from "./check-live-migration-log";
import type { JournalEntry } from "./lib/live-migration-guard";

const m0105: JournalEntry = { idx: 105, when: 1793221200000, tag: "0105_grower-sets-pickup-time" };
const m0106: JournalEntry = { idx: 106, when: 1793307600000, tag: "0106_whatsapp-schedule-calls-its-own-project" };
const m0107: JournalEntry = { idx: 107, when: 1793394000000, tag: "0107_whatsapp-routing-like-bubble" };

const LIVE_POOLER_URL = "postgresql://postgres.zvzqfjrxknxigddkwlir:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
const DEV_POOLER_URL = "postgresql://postgres.owjgzyxuldmgvwxnhrom:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

function harness(readLoggedWhens: (url: string) => Promise<number[]>) {
  const lines: string[] = [];
  const reads: string[] = [];
  return {
    lines,
    reads,
    deps: {
      log: (line: string) => lines.push(line),
      readLoggedWhens: (url: string) => {
        reads.push(url);
        return readLoggedWhens(url);
      },
    },
  };
}

describe("runGuard", () => {
  it("refuses a database that is not live without ever connecting to it", async () => {
    const { deps, lines, reads } = harness(async () => [m0105.when, m0106.when]);
    const code = await runGuard({ ...deps, databaseUrl: DEV_POOLER_URL, journal: [m0105, m0106] });
    expect(code).toBe(1);
    expect(reads).toEqual([]);
    expect(lines.join("\n")).toContain("not the live project");
  });

  it("refuses when live's log cannot be read", async () => {
    const { deps, lines } = harness(async () => {
      throw new Error("connection refused");
    });
    const code = await runGuard({ ...deps, databaseUrl: LIVE_POOLER_URL, journal: [m0105, m0106] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("could not read live's migration log");
  });

  it("refuses when live's log still stops at 0033 (the backfill has not run)", async () => {
    const { deps, lines } = harness(async () => [1783870018810]);
    const code = await runGuard({ ...deps, databaseUrl: LIVE_POOLER_URL, journal: [m0105, m0106] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("backfill");
  });

  it("allows the run and lists 0107 as the file live will run", async () => {
    const { deps, lines } = harness(async () => [m0105.when, m0106.when]);
    const code = await runGuard({ ...deps, databaseUrl: LIVE_POOLER_URL, journal: [m0105, m0106, m0107] });
    expect(code).toBe(0);
    expect(lines.some((line) => line.includes("0107_whatsapp-routing-like-bubble"))).toBe(true);
  });

  it("allows the run and says there is nothing new when live has every file", async () => {
    const { deps, lines } = harness(async () => [m0105.when, m0106.when]);
    const code = await runGuard({ ...deps, databaseUrl: LIVE_POOLER_URL, journal: [m0105, m0106] });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nothing new");
  });
});
