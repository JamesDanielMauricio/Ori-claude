import { db } from "@ori/db";
import { profiles } from "@ori/db/schema";
import type { UserRole } from "@ori/shared/roles";
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { eq } from "drizzle-orm";

import { env } from "./env";

// Verifying a bearer token only needs the anon key — it's the same
// operation supabase-js does client-side, just run here so we can look up
// the caller's app-level role afterward. This client never touches the
// service-role key. It only ever checks other people's tokens, so it keeps
// no session of its own and runs no refresh timer.
const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface AuthenticatedCaller {
  userId: string;
  email: string;
  role: UserRole;
}

// apps/api is a trusted-server boundary distinct from Row Level Security
// (see docs/SCHEMA_DECISIONS.md) — every procedure that reaches here still
// needs its own explicit authorization, which is exactly what
// requireRole/backofficeProcedure in trpc.ts do with the role resolved
// below.
async function resolveCaller(
  authorizationHeader: string | undefined,
): Promise<AuthenticatedCaller | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorizationHeader.slice("Bearer ".length);

  const { data, error } = await anonClient.auth.getUser(token);
  if (error) {
    // "Not a valid session" (a 4xx) is an answer; Auth being down or
    // unreachable (a 5xx, or no status at all) is not, and must not tell the
    // caller their sign-in is bad — the same rule as whatsapp-dispatch/db.ts.
    // The message is the bare code, as UNAUTHORIZED's is.
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return null;
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "SERVICE_UNAVAILABLE",
      cause: error,
    });
  }
  if (!data.user?.email) {
    return null;
  }

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, data.user.id))
    .limit(1);
  if (!profile) {
    return null;
  }

  return { userId: data.user.id, email: data.user.email, role: profile.role };
}

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  const caller = await resolveCaller(req.headers.authorization);
  return { req, res, caller };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
