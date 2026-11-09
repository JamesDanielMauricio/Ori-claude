import type { TRPCError } from "@trpc/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { createContext as CreateContext } from "./context";

// Pure: Auth's /user endpoint is a stubbed fetch, and neither path below
// reaches the database.
const authFetch = vi.fn<typeof fetch>();
let createContext: typeof CreateContext;

beforeAll(async () => {
  // Stubbed before context.ts loads: its Supabase client picks up fetch then.
  vi.stubGlobal("fetch", authFetch);
  ({ createContext } = await import("./context"));
});

function contextFor(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  return createContext({ req, res: {} } as never);
}

describe("createContext", () => {
  it("has no caller when Auth says the token is not a valid session", async () => {
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "bad_jwt", msg: "invalid JWT" }), { status: 403 }),
    );
    await expect(contextFor("expired")).resolves.toMatchObject({ caller: null });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Auth answers 503", () => Promise.resolve(new Response("", { status: 503 }))],
    [
      "Auth answers 500",
      () => Promise.resolve(new Response(JSON.stringify({ msg: "boom" }), { status: 500 })),
    ],
    ["Auth is unreachable", () => Promise.reject(new TypeError("fetch failed"))],
  ])("refuses as unavailable, not unauthorized, when %s", async (_case, answer) => {
    authFetch.mockImplementationOnce(answer);
    const error = await contextFor("valid").then(
      () => null,
      (thrown: unknown) => thrown as TRPCError,
    );
    expect(error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(authFetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/auth\/v1\/user$/),
      expect.anything(),
    );
  });
});
