import type { Database } from "@ori/db/supabase-types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { submitPickIfStillDraft } from "./submit-pick-if-draft";

const PICK_ID = "11111111-1111-4111-8111-111111111111";

// A stand-in for the two calls the helper makes — the pick's status read and
// submit_pick — recording what was asked of it.
function fakeClient({
  status = "draft",
  readError = null,
  submitError = null,
  throws = false,
}: {
  status?: string;
  readError?: { message: string } | null;
  submitError?: { code: string; message: string } | null;
  throws?: boolean;
}) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      calls.push(`read ${table}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => {
              if (throws) throw new Error("network down");
              return readError ? { data: null, error: readError } : { data: { status }, error: null };
            },
          }),
        }),
      };
    },
    async rpc(name: string, args: unknown) {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return { error: submitError };
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

describe("submitPickIfStillDraft", () => {
  it("sends a pick that is still a draft", async () => {
    const { client, calls } = fakeClient({ status: "draft" });
    expect(await submitPickIfStillDraft(client, PICK_ID)).toEqual({ status: "sent" });
    expect(calls).toEqual(["read daily_picks", `submit_pick {"p_daily_pick_id":"${PICK_ID}"}`]);
  });

  it("sends nothing for a pick already submitted or closed", async () => {
    for (const status of ["submitted", "closed"]) {
      const { client, calls } = fakeClient({ status });
      expect(await submitPickIfStillDraft(client, PICK_ID)).toEqual({ status: "not_draft" });
      expect(calls).toEqual(["read daily_picks"]);
    }
  });

  it("counts a pick that left draft in the instant before the submit as nothing to send", async () => {
    const { client } = fakeClient({ submitError: { code: "P0007", message: "INVALID_STATE: pick is submitted" } });
    expect(await submitPickIfStillDraft(client, PICK_ID)).toEqual({ status: "not_draft" });
  });

  it("returns every other failure instead of throwing it", async () => {
    const refused = { code: "42501", message: "FORBIDDEN: not this pick's grower" };
    expect(await submitPickIfStillDraft(fakeClient({ submitError: refused }).client, PICK_ID)).toEqual({
      status: "failed",
      error: refused,
    });

    const unreadable = { message: "JWT expired" };
    expect(await submitPickIfStillDraft(fakeClient({ readError: unreadable }).client, PICK_ID)).toEqual({
      status: "failed",
      error: unreadable,
    });

    const thrown = await submitPickIfStillDraft(fakeClient({ throws: true }).client, PICK_ID);
    expect(thrown.status).toBe("failed");
  });
});
