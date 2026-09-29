import type { EnvironmentName } from "@marketplace/contracts";
import { user } from "@marketplace/db";
import type { Database } from "@marketplace/db";
import { eq } from "drizzle-orm";

export interface AdminPolicy {
  /** Lower-cased allowlist from `ADMIN_EMAILS`. */
  adminEmails: readonly string[];
  environment: EnvironmentName;
}

export interface AccountIdentity {
  email: string;
  emailVerified: boolean;
}

/**
 * Admin rights come only from the `ADMIN_EMAILS` allowlist, never from source or from the stored `role` column
 * (which mirrors this decision for display). Outside development the address must also be verified: without that,
 * anyone could register an allowlisted address first and become an admin. GitHub sign-in with a verified GitHub
 * email satisfies this; an operator can also mark the address verified in D1.
 */
export function isAdminAccount(account: AccountIdentity, policy: AdminPolicy): boolean {
  if (!policy.adminEmails.includes(account.email.trim().toLowerCase())) return false;
  return policy.environment === "development" || account.emailVerified;
}

export type AccountRole = "admin" | "user";

/** Keeps `user.role` in step with the allowlist ("on sign-in / lookup"); writes only when it changed. */
export async function syncAccountRole(
  db: Database,
  account: AccountIdentity & { id: string; role?: string | null | undefined },
  policy: AdminPolicy,
): Promise<AccountRole> {
  const role: AccountRole = isAdminAccount(account, policy) ? "admin" : "user";
  if (account.role !== role) {
    await db.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, account.id));
  }
  return role;
}
