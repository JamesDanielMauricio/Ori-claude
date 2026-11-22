// No two ACTIVE companies of the same kind (two growers, two customers, two
// transporters) may share a name — the rule the Growers, Customers and
// Transporters screens check before they save. Every list of the day's
// growers or customers shows names only, so two active companies with one
// name cannot be told apart anywhere (found in testing, 2026-11-20).
//
// Inactive companies don't count: live holds pairs of an old inactive
// customer beside a newer active one of the same name (records re-created
// in Bubble), and those must stay editable. Making the old one active again
// while the new one is active is refused, though — that is two active again.
//
// Checked in the screens rather than the database: only office staff create
// or rename companies, and what this guards against is a slip on the screen,
// not a determined attempt.

export interface NamedCompany {
  id: string;
  name: string;
  status: string;
}

// One spelling for comparing names: no spaces around it, single spaces
// inside it, one letter case (for a name written in Latin letters).
function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

// Whether saving `candidate` (id null for a new company) would give it the
// name of another active company in `companies` — all the companies of the
// same kind, as the screen lists them.
export function activeNameTaken(
  companies: readonly NamedCompany[],
  candidate: { id: string | null; name: string; status: string },
): boolean {
  if (candidate.status !== "active") return false;
  const key = nameKey(candidate.name);
  return companies.some(
    (company) =>
      company.id !== candidate.id && company.status === "active" && nameKey(company.name) === key,
  );
}
