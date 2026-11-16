// Fills the EMPTY dev Supabase project (owjgzyxuldmgvwxnhrom) with made-up
// test data, once. Not part of the shipped app.
//
// Creates: an office (backoffice) login, 3 growers and 3 customers each with
// a login, 1 transporter, 5 product families with 15 varieties, and each
// grower's in-season products. No trading day — start one in the app.
//
// Everything is invented: "(dev)" names, @example.test emails, NO phone
// numbers and NO WhatsApp groups, so even with WhatsApp switched on later
// nothing here can reach a real person.
//
// Run from the repo root in PowerShell, with DEV values only:
//   $env:DATABASE_URL = "<dev session pooler address>"
//   $env:SUPABASE_URL = "https://owjgzyxuldmgvwxnhrom.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY = "<dev service role / secret key>"
//   pnpm.cmd --filter @ori/db exec tsx scripts/seed-dev.ts
//
// The logins' passwords are random and written to dev-logins.local.txt in
// the repo root (gitignored), never printed into a commit.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";

const DEV_REF = "owjgzyxuldmgvwxnhrom";
const PROD_REF = "zvzqfjrxknxigddkwlir";

// SECURITY: this script writes data, so it must only ever reach the dev
// project. ALLOWS: running when both addresses name dev's project.
// PROTECTS AGAINST: seeding fake companies and logins into production (the
// real business) through a pasted prod address, or a shell that still has
// prod values in it. Checked BEFORE the database client is loaded, because
// loading it opens the connection.
function devOnly(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See the top of seed-dev.ts.`);
  if (value.includes(PROD_REF)) throw new Error(`${name} points at PRODUCTION. Refusing.`);
  if (!value.includes(DEV_REF)) throw new Error(`${name} does not point at the dev project (${DEV_REF}). Refusing.`);
  return value;
}
const databaseUrl = devOnly("DATABASE_URL");
const supabaseUrl = devOnly("SUPABASE_URL");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set. See the top of seed-dev.ts.");
// A legacy (JWT) service key names its project inside; check that it's dev's.
// A newer sb_secret_ key doesn't, but it is only ever sent to the dev address
// above, where a key from another project is simply rejected.
if (serviceKey.startsWith("eyJ")) {
  const payload = JSON.parse(Buffer.from(serviceKey.split(".")[1] ?? "", "base64url").toString()) as {
    ref?: string;
  };
  if (payload.ref !== DEV_REF) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not dev's key. Refusing.");
}
void databaseUrl; // checked above; the client below reads it from process.env

const { db } = await import("../src/client");
const { companies, growerProducts, productFamilies, productVarieties, profiles } = await import(
  "../src/schema/index"
);

// Seed once: an already-filled project means this ran before (or someone
// started using dev), and a second run would make duplicates.
const existing = await db.select({ id: companies.id }).from(companies).limit(1);
if (existing.length > 0) {
  throw new Error("Dev already has companies — this seed runs only on an empty project. Nothing was changed.");
}

// ----------------------------------------------------------------- logins

type Role = "backoffice" | "grower" | "customer";
interface Login {
  key: string;
  email: string;
  displayName: string;
  role: Role;
  password: string;
  userId?: string;
}
const newPassword = () => `Dev-${randomBytes(9).toString("base64url")}`;
const logins: Login[] = [
  { key: "office", email: "office@example.test", displayName: "משרד (dev)", role: "backoffice", password: newPassword() },
  { key: "growerA", email: "grower-a@example.test", displayName: "דני מגדל (dev)", role: "grower", password: newPassword() },
  { key: "growerB", email: "grower-b@example.test", displayName: "רותי מגדלת (dev)", role: "grower", password: newPassword() },
  { key: "growerC", email: "grower-c@example.test", displayName: "יוסי מגדל (dev)", role: "grower", password: newPassword() },
  { key: "customerA", email: "customer-a@example.test", displayName: "מיכל לקוחה (dev)", role: "customer", password: newPassword() },
  { key: "customerB", email: "customer-b@example.test", displayName: "אבי לקוח (dev)", role: "customer", password: newPassword() },
  { key: "customerC", email: "customer-c@example.test", displayName: "נועה לקוחה (dev)", role: "customer", password: newPassword() },
];

const auth = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
}).auth.admin;

async function deleteCreatedUsers() {
  for (const login of logins) {
    if (login.userId) await auth.deleteUser(login.userId);
  }
}

for (const login of logins) {
  const { data, error } = await auth.createUser({
    email: login.email,
    password: login.password,
    email_confirm: true,
  });
  if (error || !data.user) {
    await deleteCreatedUsers();
    throw new Error(`Could not create the login ${login.email}: ${error?.message ?? "unknown error"}`);
  }
  login.userId = data.user.id;
}

// ---------------------------------------------------------------- catalog
// Price fields follow the app's rule (packages/shared/src/price-type.ts):
// "fixed" has a price, "range" has from ≤ to, the "record…" types store none.

type Variety = {
  name: string;
  sizes?: string;
  packType: "pallets" | "crates";
  priceType: "fixed" | "range" | "record" | "record_minus_1" | "record_plus_1";
  price?: string;
  from?: string;
  to?: string;
  noOverbooking?: string;
};
const catalog: Array<{ name: string; category: "fruit" | "vegetable"; varieties: Variety[] }> = [
  {
    name: "עגבניות",
    category: "vegetable",
    varieties: [
      { name: "עגבנייה", sizes: "גדול", packType: "pallets", priceType: "fixed", price: "42.00" },
      { name: "עגבניית שרי", packType: "crates", priceType: "range", from: "30.00", to: "38.00" },
      { name: "עגבניית תמר", packType: "pallets", priceType: "record", noOverbooking: "2" },
    ],
  },
  {
    name: "מלפפונים",
    category: "vegetable",
    varieties: [
      { name: "מלפפון", packType: "pallets", priceType: "fixed", price: "25.00" },
      { name: "מלפפון בייבי", packType: "crates", priceType: "record_minus_1" },
      { name: "מלפפון חממה", sizes: "בינוני", packType: "pallets", priceType: "range", from: "22.00", to: "28.00" },
    ],
  },
  {
    name: "פלפלים",
    category: "vegetable",
    varieties: [
      { name: "פלפל אדום", packType: "pallets", priceType: "fixed", price: "60.00" },
      { name: "פלפל צהוב", packType: "pallets", priceType: "record_plus_1" },
      { name: "פלפל חריף", packType: "crates", priceType: "fixed", price: "18.50" },
    ],
  },
  {
    name: "תפוחים",
    category: "fruit",
    varieties: [
      { name: "תפוח גאלה", packType: "pallets", priceType: "fixed", price: "70.00" },
      { name: "תפוח פינק ליידי", packType: "pallets", priceType: "range", from: "80.00", to: "95.00" },
      { name: "תפוח גרני סמית", packType: "crates", priceType: "record" },
    ],
  },
  {
    name: "בננות",
    category: "fruit",
    varieties: [
      { name: "בננה", sizes: "גדול", packType: "pallets", priceType: "fixed", price: "48.00" },
      { name: "בננה", sizes: "קטן", packType: "pallets", priceType: "fixed", price: "40.00" },
      { name: "בננה אורגנית", packType: "crates", priceType: "range", from: "55.00", to: "65.00", noOverbooking: "1" },
    ],
  },
];

// Which grower grows which family. Tomatoes come from two growers on
// purpose: a product two growers supply behaves differently in a few screens
// (the picked-products stock popup, for one).
const growerFamilies: Record<string, string[]> = {
  growerA: ["עגבניות", "מלפפונים"],
  growerB: ["פלפלים", "עגבניות"],
  growerC: ["תפוחים", "בננות"],
};

// ------------------------------------------------------------------ write

try {
  await db.transaction(async (tx) => {
    const insertCompany = async (values: typeof companies.$inferInsert) => {
      const [row] = await tx.insert(companies).values(values).returning({ id: companies.id });
      return row!.id;
    };

    const officeId = await insertCompany({ name: "משרד אורי (dev)", type: "backoffice" });
    const transporterId = await insertCompany({ name: "מוביל בדיקה (dev)", type: "transporter" });
    const companyIds: Record<string, string> = {
      office: officeId,
      growerA: await insertCompany({ name: "משק דני (dev)", type: "grower", defaultPickupTime: "06:00", transporterCompanyId: transporterId }),
      growerB: await insertCompany({ name: "חוות רותי (dev)", type: "grower", defaultPickupTime: "07:00", transporterCompanyId: transporterId }),
      growerC: await insertCompany({ name: "מטעי יוסי (dev)", type: "grower", defaultPickupTime: "08:00", transporterCompanyId: transporterId }),
      // One customer without prices, so both versions of the shop can be tried.
      customerA: await insertCompany({ name: "ירקות מיכל (dev)", type: "customer", canSeeProductPrices: true }),
      customerB: await insertCompany({ name: "המכולת של אבי (dev)", type: "customer", canSeeProductPrices: true }),
      customerC: await insertCompany({ name: "שוק נועה (dev)", type: "customer", canSeeProductPrices: false }),
    };

    for (const login of logins) {
      await tx.insert(profiles).values({
        userId: login.userId!,
        companyId: companyIds[login.key]!,
        role: login.role,
        displayName: login.displayName,
      });
      // The login is its company's contact person (the office has none).
      if (login.key !== "office") {
        await tx.update(companies).set({ contactPersonId: login.userId! }).where(eq(companies.id, companyIds[login.key]!));
      }
    }

    const varietyIdsByFamily: Record<string, string[]> = {};
    for (const family of catalog) {
      const [familyRow] = await tx
        .insert(productFamilies)
        .values({ name: family.name, category: family.category })
        .returning({ id: productFamilies.id });
      varietyIdsByFamily[family.name] = [];
      for (const variety of family.varieties) {
        const [varietyRow] = await tx
          .insert(productVarieties)
          .values({
            familyId: familyRow!.id,
            name: variety.name,
            sizes: variety.sizes ?? null,
            packType: variety.packType,
            priceType: variety.priceType,
            price: variety.priceType === "fixed" ? variety.price! : null,
            priceRangeFrom: variety.priceType === "range" ? variety.from! : null,
            priceRangeTo: variety.priceType === "range" ? variety.to! : null,
            noOverbooking: variety.noOverbooking ?? "0",
          })
          .returning({ id: productVarieties.id });
        varietyIdsByFamily[family.name]!.push(varietyRow!.id);
      }
    }

    for (const [growerKey, families] of Object.entries(growerFamilies)) {
      for (const familyName of families) {
        for (const productVarietyId of varietyIdsByFamily[familyName]!) {
          await tx.insert(growerProducts).values({ companyId: companyIds[growerKey]!, productVarietyId });
        }
      }
    }
  });
} catch (error) {
  // The data rolled back with the transaction; take the logins back too, so
  // the project is empty again and the seed can simply be re-run.
  await deleteCreatedUsers();
  throw error;
}

const loginsFile = fileURLToPath(new URL("../../../dev-logins.local.txt", import.meta.url));
writeFileSync(
  loginsFile,
  [
    `Dev test logins (project ${DEV_REF}) — made up, not real people.`,
    "",
    ...logins.map((login) => `${login.role.padEnd(10)} ${login.email.padEnd(26)} ${login.password}   ${login.displayName}`),
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Done: 7 logins, 3 growers, 3 customers, 1 transporter, ${catalog.length} families, 15 varieties.`);
console.log(`Logins and passwords: ${loginsFile}`);
await db.$client.end();
