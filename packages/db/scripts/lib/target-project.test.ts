import { describe, expect, it } from "vitest";

import { LIVE_PROJECT_REF } from "./live-migration-guard";
import { DEV_PROJECT_REF, targetProject } from "./target-project";

const pooler = (ref: string, password = "pw") =>
  `postgresql://postgres.${ref}:${password}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`;
const direct = (ref: string) => `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
const api = (ref: string) => `https://${ref}.supabase.co`;

// The data scripts (fill-from-bubble.ts) write both a project's database and
// its storage, from two addresses that may come from different places: a
// variable set in the shell wins over the root .env one by one, and the root
// .env is dev's. Dev and live share one pooler host, so the host alone cannot
// tell them apart either.
describe("targetProject", () => {
  it("names live when both addresses are live's", () => {
    expect(targetProject(pooler(LIVE_PROJECT_REF), api(LIVE_PROJECT_REF))).toEqual({
      ref: LIVE_PROJECT_REF,
      label: "live",
    });
    expect(targetProject(direct(LIVE_PROJECT_REF), api(LIVE_PROJECT_REF))).toEqual({
      ref: LIVE_PROJECT_REF,
      label: "live",
    });
  });

  it("names dev when both addresses are dev's", () => {
    expect(targetProject(pooler(DEV_PROJECT_REF), api(DEV_PROJECT_REF))).toEqual({
      ref: DEV_PROJECT_REF,
      label: "dev",
    });
  });

  it("refuses a database of one project and storage of the other, naming both", () => {
    expect(() => targetProject(pooler(LIVE_PROJECT_REF), api(DEV_PROJECT_REF))).toThrow(
      /live.*dev|dev.*live/,
    );
    expect(() => targetProject(pooler(DEV_PROJECT_REF), api(LIVE_PROJECT_REF))).toThrow(
      /live.*dev|dev.*live/,
    );
  });

  it("does not take a project ref that only appears inside the password", () => {
    expect(() =>
      targetProject(pooler(DEV_PROJECT_REF, LIVE_PROJECT_REF), api(LIVE_PROJECT_REF)),
    ).toThrow();
  });

  it("refuses an address it cannot read a project from", () => {
    expect(() =>
      targetProject("postgresql://postgres:pw@localhost:5432/postgres", api(DEV_PROJECT_REF)),
    ).toThrow();
    expect(() => targetProject(pooler(DEV_PROJECT_REF), "not a url")).toThrow();
  });
});
