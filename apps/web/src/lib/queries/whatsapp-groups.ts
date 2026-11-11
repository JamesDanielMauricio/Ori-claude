import { FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";
import { queryOptions, type Query } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";

// The WhatsApp groups of the connected number: what the company screens'
// group picker offers (components/reference-data/whatsapp-group-cell.tsx),
// and the names their read views show in place of a raw group id. One cache
// entry, shared by the Growers, Customers and Transporters screens.
//
// Read through the whatsapp-groups Edge Function (supabase/functions/
// whatsapp-groups), which holds the Green API credentials and answers with
// {env, groups} only.
//
// SECURITY: the browser never sees the WhatsApp token or instance id — the
// function calls Green API itself, from the server, and nothing in its answer
// (errors included) carries them. It ALLOWS the office to see the groups'
// names and ids, which they choose from anyway, and PROTECTS the credentials
// from every browser and its extensions. The call carries the signed-in
// user's session (functions.invoke adds it), and the function refuses
// everyone but backoffice staff.

export interface WhatsAppGroup {
  // Bare, as companies.whatsapp_group_id stores it: "120363000000000001",
  // never with "@g.us".
  id: string;
  name: string;
}

export interface WhatsAppGroupList {
  // Whose groups these are: the live number's, or the test number's
  // (WHATSAPP_ENV on the function — anything but "live" is the test number).
  env: "live" | "dev";
  groups: WhatsAppGroup[];
}

// Why there is no list, each explained to the user in its own words (see the
// picker). The first four are the function's own `kind` (its handler.ts —
// change one, change both); "not_deployed" is the gateway saying there is no
// such function on this project yet.
export type WhatsAppGroupsErrorKind =
  "not_configured" | "channel" | "unavailable" | "refused" | "not_deployed";

const FUNCTION_KINDS: ReadonlySet<string> = new Set([
  "not_configured",
  "channel",
  "unavailable",
  "refused",
]);

export class WhatsAppGroupsError extends Error {
  readonly kind: WhatsAppGroupsErrorKind;
  constructor(kind: WhatsAppGroupsErrorKind, message: string) {
    super(message);
    this.name = "WhatsAppGroupsError";
    this.kind = kind;
  }
}

// The function's answer, checked rather than trusted: anything but
// {env: "live" | "dev", groups: [{id, name}]} is refused whole, as
// "unavailable" — a half-understood answer would show a list that is not the
// number's. A group listed twice is kept once (keys must be unique), and a
// blank name shows the id, so no row is ever empty.
export function parseWhatsAppGroupList(data: unknown): WhatsAppGroupList {
  const refuse = () =>
    new WhatsAppGroupsError(
      "unavailable",
      "the WhatsApp group list's answer was not {env, groups}",
    );
  if (!data || typeof data !== "object") throw refuse();
  const { env, groups } = data as { env?: unknown; groups?: unknown };
  if ((env !== "live" && env !== "dev") || !Array.isArray(groups)) throw refuse();
  const seen = new Set<string>();
  const list: WhatsAppGroup[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") throw refuse();
    const { id, name } = group as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id === "" || typeof name !== "string") throw refuse();
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: name.trim() || id });
  }
  return { env, groups: list };
}

// What a failed call means. A non-2xx answer usually carries the function's
// own `kind`; without one (the gateway answered, not the function) the status
// decides: 401/403 is a session the gateway turned away, 404 a function not
// deployed yet. A request that never got an answer — the network, the
// timeout below, Supabase unable to reach the function — may pass, and so is
// "unavailable", like anything not recognised.
export async function whatsAppGroupsErrorKind(error: unknown): Promise<WhatsAppGroupsErrorKind> {
  if (error instanceof WhatsAppGroupsError) return error.kind;
  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    const response = error.context;
    const body: unknown = await response.json().catch(() => null);
    const kind = body && typeof body === "object" ? (body as { kind?: unknown }).kind : undefined;
    if (typeof kind === "string" && FUNCTION_KINDS.has(kind))
      return kind as WhatsAppGroupsErrorKind;
    if (response.status === 401 || response.status === 403) return "refused";
    if (response.status === 404) return "not_deployed";
  }
  return "unavailable";
}

// The browser gives up after this. Longer than the function's own wait on
// Green API (10 s, its contacts.ts), so a slow answer still arrives; short
// enough that a stuck request turns into an error with a retry button rather
// than a picker loading for ever.
const REQUEST_TIMEOUT_MS = 20_000;

export async function fetchWhatsAppGroups(
  client: Pick<SupabaseClient, "functions">,
  signal?: AbortSignal,
): Promise<WhatsAppGroupList> {
  // No body: the function reads nothing from the request but the session.
  const { data, error } = await client.functions.invoke("whatsapp-groups", {
    timeout: REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (error) {
    const kind = await whatsAppGroupsErrorKind(error);
    throw new WhatsAppGroupsError(kind, `could not load the WhatsApp groups (${kind})`);
  }
  return parseWhatsAppGroupList(data);
}

// How long one answer — a list, or an error — is used before the list is
// asked for again.
export const WHATSAPP_GROUPS_FRESH_MS = 5 * 60_000;

// "static" while the last answer is younger than WHATSAPP_GROUPS_FRESH_MS,
// stale after. A plain staleTime would not hold: the live updates
// (lib/live-updates.ts) and the refresh on return (lib/refresh-on-return.ts)
// invalidate EVERY query — on any save by anyone, on every return to the tab —
// and an invalidated query refetches whatever its staleTime. Each refetch here
// is a Green API call on the number the office's messages go out from, so
// those blanket refreshes must pass this one by; React Query leaves a "static"
// query alone for them, and for focus and reconnect. After an error too: a
// function that is missing or failing is asked again at most every five
// minutes on its own — sooner only when someone presses the picker's retry
// button, or a screen with no list yet mounts it.
export function whatsAppGroupsStaleTime(
  query: Pick<Query, "state">,
  now = Date.now(),
): number | "static" {
  const answeredAt = Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt);
  return now - answeredAt < WHATSAPP_GROUPS_FRESH_MS ? "static" : 0;
}

// One more try, a second later, for an error that may pass. A list that is not
// configured, refused or missing will not be there a second later either, and
// the picker has its own retry button.
export function retryWhatsAppGroups(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && error instanceof WhatsAppGroupsError && error.kind === "unavailable";
}

export const whatsAppGroupsQueries = {
  list() {
    return queryOptions({
      queryKey: ["whatsapp-groups"],
      queryFn: ({ signal }) => fetchWhatsAppGroups(createClient(), signal),
      staleTime: whatsAppGroupsStaleTime,
      retry: retryWhatsAppGroups,
    });
  },
};
