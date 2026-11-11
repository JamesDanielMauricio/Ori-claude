// The WhatsApp groups of the connected number, from Green API's getContacts
// — the list the office picks a company's group from on the Growers,
// Customers and Transporters screens (the old Bubble app's "group IDs
// (whatsapp)" popup made the same call).
//
// GET https://api.green-api.com/waInstance{id}/getContacts/{token} answers
// with every chat the number knows, people (…@c.us) and groups (…@g.us)
// alike, as [{id, name, contactName, type}]. Only groups are kept, by their
// "@g.us" ending, and each is returned BARE: companies.whatsapp_group_id is
// stored without the suffix (whatsapp-dispatch's chatId() adds it back,
// migration 0053), so the id the picker saves is exactly the one the
// dispatcher sends to.
//
// As with the send (../whatsapp-dispatch/provider.ts), the instance id and
// the token are in the URL path, so every error leaves this file through
// redactSecrets.

import { type GreenApiCredentials, redactSecrets } from "../whatsapp-dispatch/provider.ts";

export interface WhatsAppGroup {
  // Bare — "120363000000000001", never "120363000000000001@g.us".
  id: string;
  name: string;
}

// - not_configured: no credentials for the active environment.
// - channel:        Green API refused the account itself — a wrong instance
//                   id or token, an instance not signed in to WhatsApp, a
//                   used-up quota. Asking again cannot help until someone
//                   fixes the account.
// - unavailable:    anything that may pass — a network error, a timeout,
//                   rate limiting, a provider error, an answer that is not
//                   the list it should be.
export type GroupsFailureKind = "not_configured" | "channel" | "unavailable";

export type GroupsResult = { ok: true; groups: WhatsAppGroup[] } | { ok: false; kind: GroupsFailureKind; error: string };

// The dispatcher's own host and "the account, not the message" statuses
// (provider.ts's GREEN_API_BASE and CHANNEL_STATUSES). Repeated rather than
// imported because provider.ts does not export them, and exporting them would
// change a file the deployed dispatcher is built from. index.test.ts holds
// both copies to the dispatcher's real behaviour — the address its send calls
// and the statuses its send calls "channel" — so they cannot drift apart
// unnoticed.
export const GREEN_API_BASE = "https://api.green-api.com";
export const CHANNEL_STATUSES: ReadonlySet<number> = new Set([401, 403, 466]);

// How long the list may take. Someone is waiting on it with the picker open,
// and the browser gives up on its own a little later
// (apps/web/src/lib/queries/whatsapp-groups.ts).
export const CONTACTS_TIMEOUT_MS = 10_000;

const GROUP_SUFFIX = "@g.us";

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// Direction controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069).
// A group's name is whatever its creator typed, and anyone can add the
// office's number to a group: these characters can make one name display
// exactly like another (a company's real group), so they are taken out.
const DIRECTION_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
const nameOf = (value: unknown): string => textOf(value).replace(DIRECTION_CONTROLS, "").trim();

// redactSecrets, and the token and instance id also as a URL writes them. A
// secret saved with a character a URL escapes (a trailing space, say) shows
// as "%20" in a network error that repeats the address, where neither
// redactSecrets' pattern nor its literal pass finds it. Both passes over an
// error that leaves this function (here and in handler.ts) go through this.
export function redactCredentials(text: string, credentials: GreenApiCredentials): string {
  let out = redactSecrets(text, credentials);
  for (const secret of [credentials.apiToken, credentials.idInstance]) {
    const escaped = encodeURIComponent(secret);
    if (secret && escaped !== secret && escaped.length >= 4) out = out.split(escaped).join("***");
  }
  return out;
}

// The groups in a getContacts answer, or null when the answer is not a list
// at all. Read defensively, entry by entry: an entry that is not an object,
// has no string id or is not a group is skipped, not trusted. The name is the
// group's own (`name`), else the number's name for it (`contactName`), else
// the bare id, so a row is never blank. Green API can list a chat twice; each
// group is kept once, by its first entry that has a name. Sorted by name in
// Hebrew order — ties by id, so the order is the same on every call.
export function groupsFromContacts(contacts: unknown): WhatsAppGroup[] | null {
  if (!Array.isArray(contacts)) return null;
  const byId = new Map<string, { name: string; named: boolean }>();
  for (const entry of contacts) {
    if (!entry || typeof entry !== "object") continue;
    const { id: rawId, name, contactName } = entry as Record<string, unknown>;
    const chatId = textOf(rawId);
    if (!chatId.endsWith(GROUP_SUFFIX)) continue;
    const id = chatId.slice(0, -GROUP_SUFFIX.length);
    // Not something chatId() can turn back into this group's address.
    if (!id || /[\s@]/.test(id)) continue;
    const label = nameOf(name) || nameOf(contactName);
    const kept = byId.get(id);
    if (kept && (kept.named || !label)) continue;
    byId.set(id, { name: label || id, named: label !== "" });
  }
  return [...byId]
    .map(([id, { name }]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "he") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function listWhatsAppGroups(fetchImpl: typeof fetch, credentials: GreenApiCredentials): Promise<GroupsResult> {
  if (!credentials.idInstance || !credentials.apiToken) {
    return { ok: false, kind: "not_configured", error: "WhatsApp credentials are not configured for the active environment" };
  }
  const clean = (text: string) => redactCredentials(text, credentials);
  const url = `${GREEN_API_BASE}/waInstance${credentials.idInstance}/getContacts/${credentials.apiToken}`;
  let response: Response;
  try {
    // The timeout covers reading the answer too: aborting the signal also
    // stops a body that arrives slowly.
    response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(CONTACTS_TIMEOUT_MS) });
  } catch (error) {
    // A network error repeats the URL — and with it the token.
    return { ok: false, kind: "unavailable", error: clean(messageOf(error)) };
  }
  if (!response.ok) {
    // Redacted whole, then cut: cut first, a token the body repeats past the
    // cut would leave as a piece the literal pass no longer matches.
    const detail = clean(await response.text().catch(() => "")).slice(0, 300);
    return {
      ok: false,
      kind: CHANNEL_STATUSES.has(response.status) ? "channel" : "unavailable",
      error: clean(`Green API responded ${response.status}${detail ? `: ${detail}` : ""}`),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not the parser's message: it quotes the start of the answer, which
    // nothing here can vouch for.
    return { ok: false, kind: "unavailable", error: "Green API's answer could not be read as JSON" };
  }
  const groups = groupsFromContacts(body);
  if (!groups) return { ok: false, kind: "unavailable", error: "Green API's answer was not a list of contacts" };
  return { ok: true, groups };
}
