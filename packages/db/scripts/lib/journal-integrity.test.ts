import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { journalProblems, type JournalEntry } from "./live-migration-guard";

// The real migrations folder. These run in CI on every pull request (the `ci`
// check), so a pull request that would make Drizzle skip a file — a reused or
// earlier "when", a file missing from the journal — fails before it can merge
// and reach live through the migrate-live job.
const migrations = new URL("../../migrations/", import.meta.url);
const journal = (JSON.parse(readFileSync(new URL("meta/_journal.json", migrations), "utf8")) as { entries: JournalEntry[] }).entries;
const sqlFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql")).map((name) => name.slice(0, -".sql".length));

describe("the real migration journal", () => {
  it("starts at idx 0 and has nothing out of order", () => {
    expect(journal[0]?.idx).toBe(0);
    expect(journalProblems(journal)).toEqual([]);
  });

  it("lists every .sql file in the folder (Drizzle never runs a file missing from the journal)", () => {
    const listed = new Set(journal.map((entry) => entry.tag));
    expect(sqlFiles.filter((file) => !listed.has(file))).toEqual([]);
  });

  it("has a .sql file for every entry", () => {
    const files = new Set(sqlFiles);
    expect(journal.map((entry) => entry.tag).filter((tag) => !files.has(tag))).toEqual([]);
  });
});
