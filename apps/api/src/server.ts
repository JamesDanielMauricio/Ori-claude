import cors from "@fastify/cors";
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import Fastify from "fastify";

import { createContext } from "./context";
import { appRouter, type AppRouter } from "./router";

export async function buildServer() {
  const app = Fastify({ logger: true });

  // Auth is a bearer token in the Authorization header (the caller's
  // Supabase access token), not a cookie — no credentials/cookie exchange
  // with this server.
  await app.register(cors, { origin: true });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      // tRPC turns a thrown error into a normal response, so Fastify logs only
      // its status: without this the cause of a 5xx (Admin API, Postgres,
      // Green API) is written nowhere. Refusals (4xx) are answers, not
      // failures, and stay out. Never the input or ctx — they carry imported
      // users' details and the caller's bearer token.
      onError({ error, path, req }) {
        if (getHTTPStatusCodeFromError(error) >= 500) {
          req.log.error({ err: error, path }, "tRPC call failed");
        }
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
