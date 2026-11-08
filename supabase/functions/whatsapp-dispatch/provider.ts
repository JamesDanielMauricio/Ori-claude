// Sending one WhatsApp message through Green API (https://green-api.com, the
// settled provider), and saying what kind of failure it was when it fails.
//
// Green API takes the instance id and token in the URL path itself
// (POST https://api.green-api.com/waInstance{id}/sendMessage/{token}), so any
// error that repeats the URL — a network error from fetch does — carries the
// token. redactSecrets() takes it out of every error before it leaves this
// file; nothing the dispatcher stores or returns has seen the raw text.

export interface GreenApiCredentials {
  idInstance: string;
  apiToken: string;
}

// - channel:   WhatsApp itself cannot send right now — missing or rejected
//              credentials, an unusable account. Retrying this message alone
//              can't help, and counting it as this message's failure would let
//              one outage use up every message's tries. The run stops and
//              hands its rows back.
// - transient: a network error, a timeout, rate limiting or a provider
//              error — worth another try later.
// - message:   Green API refused this one message (a malformed request,
//              say). Counted as a try like a transient one.
export type FailureKind = "channel" | "transient" | "message";

export type SendResult = { ok: true } | { ok: false; kind: FailureKind; error: string };

const GREEN_API_BASE = "https://api.green-api.com";
// How long one send may take. A run lasts at most ~150 s (Supabase Edge),
// so one stuck request must not eat it whole.
export const SEND_TIMEOUT_MS = 15_000;

// Green API status codes that mean "the account, not the message":
// 401/403 — the instance id or token is wrong, or the instance is not
// authorised; 466 — the account's sending quota is used up.
const CHANNEL_STATUSES = new Set([401, 403, 466]);

export function redactSecrets(text: string, credentials: GreenApiCredentials): string {
  let out = text.replace(/waInstance[0-9]*\/([A-Za-z]+)\/[^\s"')]+/g, "waInstance***/$1/***");
  for (const secret of [credentials.apiToken, credentials.idInstance]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

export function chatId(target: string, isGroup: boolean): string {
  return `${target}@${isGroup ? "g" : "c"}.us`;
}

export async function sendWhatsAppMessage(
  fetchImpl: typeof fetch,
  credentials: GreenApiCredentials,
  target: string,
  isGroup: boolean,
  body: string,
): Promise<SendResult> {
  if (!credentials.idInstance || !credentials.apiToken) {
    return { ok: false, kind: "channel", error: "WhatsApp credentials are not configured for the active environment" };
  }
  const url = `${GREEN_API_BASE}/waInstance${credentials.idInstance}/sendMessage/${credentials.apiToken}`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chatId(target, isGroup), message: body }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const kind: FailureKind = CHANNEL_STATUSES.has(response.status)
      ? "channel"
      : response.status === 429 || response.status >= 500
        ? "transient"
        : "message";
    return {
      ok: false,
      kind,
      error: redactSecrets(`Green API responded ${response.status}${detail ? `: ${detail}` : ""}`, credentials),
    };
  } catch (error) {
    return {
      ok: false,
      kind: "transient",
      error: redactSecrets(error instanceof Error ? error.message : String(error), credentials),
    };
  }
}
