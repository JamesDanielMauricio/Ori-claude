import { describe, expect, it } from "vitest";

import {
  createGreenApiChannel,
  readGreenApiCredentials,
  selectWhatsAppEnv,
  toWhatsAppNumber,
} from "./whatsapp-channel";

// Pure: no database, no network (fetch is a stub).
describe("toWhatsAppNumber", () => {
  it.each([
    ["0501234567", "972501234567"],
    ["050-123-4567", "972501234567"],
    ["050 123 4567", "972501234567"],
    ["+972 50-123-4567", "972501234567"],
    ["972501234567", "972501234567"],
    ["501234567", "972501234567"],
    ["04-6123456", "97246123456"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(toWhatsAppNumber(input)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "12", "abc", "050-123-45678-9"])(
    "rejects %s",
    (input) => {
      expect(toWhatsAppNumber(input)).toBeNull();
    },
  );
});

describe("selectWhatsAppEnv", () => {
  it("is live only for exactly `live`", () => {
    expect(selectWhatsAppEnv({ WHATSAPP_ENV: "live" })).toBe("live");
    expect(selectWhatsAppEnv({ WHATSAPP_ENV: "LIVE" })).toBe("dev");
    expect(selectWhatsAppEnv({ WHATSAPP_ENV: " live" })).toBe("dev");
    expect(selectWhatsAppEnv({})).toBe("dev");
  });
});

describe("readGreenApiCredentials", () => {
  const env = {
    WHATSAPP_DEV_ID_INSTANCE: "111",
    WHATSAPP_DEV_API_TOKEN: "dev-token",
    WHATSAPP_LIVE_ID_INSTANCE: "222",
    WHATSAPP_LIVE_API_TOKEN: "",
  };

  it("reads the pair for the requested environment", () => {
    expect(readGreenApiCredentials(env, "dev")).toEqual({ idInstance: "111", apiToken: "dev-token" });
  });

  it("returns null when either half is missing", () => {
    expect(readGreenApiCredentials(env, "live")).toBeNull();
    expect(readGreenApiCredentials({}, "dev")).toBeNull();
  });
});

describe("createGreenApiChannel", () => {
  it("posts the Green API sendMessage shape the Edge Function uses, with link previews off", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ idMessage: "x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const channel = createGreenApiChannel({ idInstance: "111", apiToken: "tok" }, fakeFetch);
    await expect(channel.send({ to: "972501234567", isGroup: false, body: "hi" })).resolves.toEqual({
      success: true,
    });
    await channel.send({ to: "12036", isGroup: true, body: "group" });

    // linkPreview: false — a preview would fetch the link before the
    // recipient taps it, which spends a one-time password-reset link.
    expect(calls[0]).toEqual({
      url: "https://api.green-api.com/waInstance111/sendMessage/tok",
      body: { chatId: "972501234567@c.us", message: "hi", linkPreview: false },
    });
    expect(calls[1]?.body).toEqual({ chatId: "12036@g.us", message: "group", linkPreview: false });
  });

  it("reports a non-2xx response and a thrown fetch as failures", async () => {
    const rejecting = createGreenApiChannel(
      { idInstance: "1", apiToken: "t" },
      (async () => new Response("bad number", { status: 400 })) as unknown as typeof fetch,
    );
    await expect(rejecting.send({ to: "972501234567", isGroup: false, body: "x" })).resolves.toEqual({
      success: false,
      error: "Green API responded 400: bad number",
    });

    const throwing = createGreenApiChannel(
      { idInstance: "1", apiToken: "t" },
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );
    await expect(throwing.send({ to: "972501234567", isGroup: false, body: "x" })).resolves.toEqual({
      success: false,
      error: "network down",
    });
  });

  // The token is part of the URL path, so a provider body or a fetch error
  // that repeats the URL would otherwise hand it to the admin's screen.
  it("takes the instance id and token out of a failure, and caps the provider's body", async () => {
    const credentials = { idInstance: "7105123456", apiToken: "secret-token-abc" };
    const echoing = createGreenApiChannel(
      credentials,
      (async (url: string) =>
        new Response(`bad request for ${url} (token secret-token-abc)`, {
          status: 400,
        })) as unknown as typeof fetch,
    );
    const echoed = await echoing.send({ to: "972501234567", isGroup: false, body: "x" });
    expect(echoed).toEqual({
      success: false,
      error:
        "Green API responded 400: bad request for https://api.green-api.com/waInstance***/sendMessage/*** (token ***)",
    });

    const throwing = createGreenApiChannel(credentials, (async (url: string) => {
      throw new Error(`fetch failed: ${url}`);
    }) as unknown as typeof fetch);
    const thrown = await throwing.send({ to: "972501234567", isGroup: false, body: "x" });
    expect(thrown.error).toBe(
      "fetch failed: https://api.green-api.com/waInstance***/sendMessage/***",
    );

    const verbose = createGreenApiChannel(
      credentials,
      (async () => new Response("x".repeat(5000), { status: 502 })) as unknown as typeof fetch,
    );
    const capped = await verbose.send({ to: "972501234567", isGroup: false, body: "x" });
    expect(capped.error).toBe(`Green API responded 502: ${"x".repeat(300)}`);
  });

  // Redaction matches whole secrets only, so the body must be redacted before
  // it is capped: cut first, a token straddling the cut kept its first letters.
  it("redacts a token that straddles the cap", async () => {
    const credentials = { idInstance: "7105123456", apiToken: "secret-token-abc" };
    const straddling = createGreenApiChannel(
      credentials,
      (async () =>
        new Response(`${"x".repeat(290)}token=secret-token-abc`, {
          status: 500,
        })) as unknown as typeof fetch,
    );
    const result = await straddling.send({ to: "972501234567", isGroup: false, body: "x" });
    expect(result.error).toBe(`Green API responded 500: ${"x".repeat(290)}token=***`);
    expect(result.error).not.toContain("secr");
  });
});
