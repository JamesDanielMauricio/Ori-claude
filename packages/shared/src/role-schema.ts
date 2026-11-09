import { z } from "zod";

// Re-exported from roles.ts, which is where everything imports it from. A
// module of its own so the web app's entry chunk — which needs only UserRole
// and resolveHomeRoute — leaves it, and zod with it, to the lazy screens that
// validate. Marked pure for the same reason: nothing else here runs on import.
export const userRoleSchema = /* @__PURE__ */ z.enum(["backoffice", "grower", "customer"]);
