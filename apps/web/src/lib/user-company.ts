import type { UserRole } from "@ori/shared/roles";

// Which companies a user may belong to, given their role — the Users screen's
// rule, the same one the import screen already applies (users-import.tsx): a
// grower belongs to a grower company, a customer to a customer company, an
// office account to the office's own company. A user saved into a company of
// another type has nothing to work with: a grower's screens look for their
// company's pick, a customer's for their company's order, and neither exists.

export interface CompanyOption {
  id: string;
  name: string;
  type: string;
}

// The role and company a user is saved with now.
export interface SavedPairing {
  role: UserRole;
  companyId: string;
}

// Whether `company` may be chosen for a user with `role`. Besides the
// companies of the role's own type, the user's saved company stays allowed
// while their role is unchanged: two office accounts on live belong to a
// customer company, and editing their name or phone must not force a move
// that would change which company's WhatsApp messages they receive.
export function companyFitsRole(
  company: CompanyOption,
  role: UserRole,
  saved: SavedPairing | null,
): boolean {
  return company.type === role || (saved?.role === role && saved.companyId === company.id);
}
