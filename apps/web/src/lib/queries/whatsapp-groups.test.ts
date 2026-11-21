import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWhatsAppGroups,
  parseWhatsAppGroupList,
  retryWhatsAppGroups,
  WHATSAPP_GROUPS_FRESH_MS,
  WhatsAppGroupsError,
  whatsAppGroupsErrorKind,
  whatsAppGroupsQueries,
  whatsAppGroupsRetryDelay,
  whatsAppGroupsStaleTime,
  type WhatsAppGroupList,
} from "./whatsapp-groups";

const LIST: WhatsAppGroupList = {
  env: "live",
  groups: [
    { id: "120363000000000001", name: "אבוקדו" },
    { id: "120363000000000002", name: "תפוחים — הזמנות" },
  ],
};

// What a call that failed hands back, the way functions.invoke builds it.
const httpError = (status: number, body?: unknown) =>
  new FunctionsHttpError(
    new Response(
      body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "content-type": typeof body === "object" ? "application/json" : "text/plain" },
      },
    ),
  );

describe("parseWhatsAppGroupList", () => {
  it("takes the function's answer as it is", () => {
    expect(parseWhatsAppGroupList(LIST)).toEqual(LIST);
    expect(parseWhatsAppGroupList({ env: "dev", groups: [] })).toEqual({ env: "dev", groups: [] });
  });

  it("keeps a group listed twice once, and shows the id for a blank name", () => {
    expect(
      parseWhatsAppGroupList({
        env: "dev",
        groups: [
          { id: "1", name: "  " },
          { id: "1", name: "שוב" },
          { id: "2", name: "ב" },
        ],
      }),
    ).toEqual({
      env: "dev",
      groups: [
        { id: "1", name: "1" },
        { id: "2", name: "ב" },
      ],
    });
  });

  it.each([
    ["nothing", null],
    ["text", "<html>"],
    ["a list", [LIST.groups]],
    ["no env", { groups: LIST.groups }],
    ["an unknown env", { env: "staging", groups: [] }],
    ["no groups", { env: "live" }],
    ["groups not a list", { env: "live", groups: {} }],
    ["a null group", { env: "live", groups: [null] }],
    ["a group without an id", { env: "live", groups: [{ name: "x" }] }],
    ["an empty id", { env: "live", groups: [{ id: "", name: "x" }] }],
    ["a numeric id", { env: "live", groups: [{ id: 120363, name: "x" }] }],
    ["a group without a name", { env: "live", groups: [{ id: "1" }] }],
  ])("refuses %s whole, as 'unavailable'", (_name, data) => {
    let thrown: unknown;
    try {
      parseWhatsAppGroupList(data);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WhatsAppGroupsError);
    expect((thrown as WhatsAppGroupsError).kind).toBe("unavailable");
  });
});

describe("whatsAppGroupsErrorKind", () => {
  it("reads the function's own kind", async () => {
    for (const kind of ["not_configured", "channel", "unavailable", "refused"]) {
      expect(await whatsAppGroupsErrorKind(httpError(502, { error: "x", kind }))).toBe(kind);
    }
  });

  it("goes by the status when the gateway answered instead of the function", async () => {
    expect(
      await whatsAppGroupsErrorKind(httpError(401, { code: 401, message: "Invalid JWT" })),
    ).toBe("refused");
    expect(await whatsAppGroupsErrorKind(httpError(403))).toBe("refused");
    expect(
      await whatsAppGroupsErrorKind(
        httpError(404, { code: "NOT_FOUND", message: "Requested function was not found" }),
      ),
    ).toBe("not_deployed");
    expect(await whatsAppGroupsErrorKind(httpError(500, "<html>boom</html>"))).toBe("unavailable");
    expect(await whatsAppGroupsErrorKind(httpError(546, { code: "WORKER_LIMIT" }))).toBe(
      "unavailable",
    );
    // A kind it does not know is not trusted.
    expect(await whatsAppGroupsErrorKind(httpError(403, { kind: "something-new" }))).toBe(
      "refused",
    );
  });

  it("is 'unavailable' for a call that never got an answer, or anything else", async () => {
    expect(
      await whatsAppGroupsErrorKind(new FunctionsFetchError(new TypeError("Failed to fetch"))),
    ).toBe("unavailable");
    expect(
      await whatsAppGroupsErrorKind(new FunctionsRelayError(new Response(null, { status: 502 }))),
    ).toBe("unavailable");
    expect(await whatsAppGroupsErrorKind(new Error("?"))).toBe("unavailable");
    expect(await whatsAppGroupsErrorKind(undefined)).toBe("unavailable");
  });

  it("keeps the kind of an answer already refused here", async () => {
    expect(await whatsAppGroupsErrorKind(new WhatsAppGroupsError("channel", "x"))).toBe("channel");
  });
});

describe("fetchWhatsAppGroups", () => {
  const clientAnswering = (answer: { data: unknown; error: unknown }) => {
    const invoke = vi.fn(async () => answer);
    return {
      client: { functions: { invoke } } as unknown as Pick<SupabaseClient, "functions">,
      invoke,
    };
  };

  it("asks whatsapp-groups with no body, a timeout and the query's signal, and checks the answer", async () => {
    const { client, invoke } = clientAnswering({ data: LIST, error: null });
    const signal = new AbortController().signal;
    expect(await fetchWhatsAppGroups(client, signal)).toEqual(LIST);
    expect(invoke).toHaveBeenCalledWith("whatsapp-groups", { timeout: 20_000, signal });

    const unexpected = clientAnswering({ data: "<html>", error: null });
    await expect(fetchWhatsAppGroups(unexpected.client)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(unexpected.invoke).toHaveBeenCalledWith("whatsapp-groups", { timeout: 20_000 });
  });

  it("turns a failed call into its kind", async () => {
    const { client } = clientAnswering({
      data: null,
      error: httpError(500, { error: "x", kind: "not_configured" }),
    });
    const error = await fetchWhatsAppGroups(client).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WhatsAppGroupsError);
    expect(error).toMatchObject({ kind: "not_configured" });
  });
});

describe("how often the list is asked for", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 10, 12, 8, 0) + minutes * 60_000).getTime();
  const answered = (dataUpdatedAt: number, errorUpdatedAt = 0) =>
    ({ state: { dataUpdatedAt, errorUpdatedAt } }) as never;

  it("holds an answer — a list or an error — for five minutes, then lets it go stale", () => {
    expect(WHATSAPP_GROUPS_FRESH_MS).toBe(5 * 60_000);
    expect(whatsAppGroupsStaleTime(answered(0), at(0))).toBe(0);
    expect(whatsAppGroupsStaleTime(answered(at(0)), at(4.9))).toBe("static");
    expect(whatsAppGroupsStaleTime(answered(at(0)), at(5))).toBe(0);
    expect(whatsAppGroupsStaleTime(answered(0, at(0)), at(4.9))).toBe("static");
    expect(whatsAppGroupsStaleTime(answered(at(0), at(3)), at(7))).toBe("static");
  });

  it("tries twice more only for an error that may pass", () => {
    expect(retryWhatsAppGroups(0, new WhatsAppGroupsError("unavailable", "x"))).toBe(true);
    expect(retryWhatsAppGroups(1, new WhatsAppGroupsError("unavailable", "x"))).toBe(true);
    expect(retryWhatsAppGroups(2, new WhatsAppGroupsError("unavailable", "x"))).toBe(false);
    for (const kind of ["not_configured", "channel", "refused", "not_deployed"] as const) {
      expect(retryWhatsAppGroups(0, new WhatsAppGroupsError(kind, "x")), kind).toBe(false);
    }
    expect(retryWhatsAppGroups(0, new TypeError("x"))).toBe(false);
  });

  // Green API answers one getContacts a second per number, and refuses the
  // rest (429). Screens opened together were refused together and, a fixed
  // second later, tried again together (found in testing, 2026-11-20).
  it("waits one to three seconds before a try, at random, so screens refused together try apart", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0);
    expect(whatsAppGroupsRetryDelay()).toBe(1_000);
    random.mockReturnValue(0.5);
    expect(whatsAppGroupsRetryDelay()).toBe(2_000);
    random.mockReturnValue(0.999);
    expect(whatsAppGroupsRetryDelay()).toBeLessThan(3_000);
    random.mockRestore();
  });

  it("is one cache entry, with that policy", () => {
    const options = whatsAppGroupsQueries.list();
    expect(options.queryKey).toEqual(["whatsapp-groups"]);
    expect(options.staleTime).toBe(whatsAppGroupsStaleTime);
    expect(options.retry).toBe(retryWhatsAppGroups);
    expect(options.retryDelay).toBe(whatsAppGroupsRetryDelay);
  });

  // What lib/live-updates.ts and lib/refresh-on-return.ts do on every save
  // and every return to the tab: invalidate every query.
  const everything = (client: QueryClient) =>
    client.invalidateQueries(undefined, { cancelRefetch: false });

  async function watch(queryFn: () => Promise<WhatsAppGroupList>) {
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      ...whatsAppGroupsQueries.list(),
      queryFn,
      retryDelay: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe("idle"));
    return { client, observer, unsubscribe };
  }

  it("is not asked again by the app-wide refreshes for five minutes after a list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    const queryFn = vi.fn(async () => LIST);
    const { client, observer, unsubscribe } = await watch(queryFn);
    expect(observer.getCurrentResult().data).toEqual(LIST);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await everything(client);
    vi.setSystemTime(at(4.9));
    await everything(client);
    expect(queryFn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(at(5.1));
    await everything(client);
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("after an error: two more tries if it may pass, then the same hold — and a screen with no list yet still asks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    const passing = vi.fn(async (): Promise<WhatsAppGroupList> => {
      throw new WhatsAppGroupsError("unavailable", "x");
    });
    const first = await watch(passing);
    expect(first.observer.getCurrentResult().isError).toBe(true);
    expect(passing).toHaveBeenCalledTimes(3);
    await everything(first.client);
    expect(passing).toHaveBeenCalledTimes(3);

    // The picker opening (a new observer of a query with no list) asks again.
    const second = new QueryObserver(first.client, {
      ...whatsAppGroupsQueries.list(),
      queryFn: passing,
      retryDelay: 0,
    });
    const stop = second.subscribe(() => undefined);
    await vi.waitFor(() => expect(passing).toHaveBeenCalledTimes(6));
    stop();
    first.unsubscribe();

    const lasting = vi.fn(async (): Promise<WhatsAppGroupList> => {
      throw new WhatsAppGroupsError("not_configured", "x");
    });
    const other = await watch(lasting);
    await everything(other.client);
    expect(lasting).toHaveBeenCalledTimes(1);
    other.unsubscribe();
  });
});
