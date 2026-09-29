import { MarketplaceError, type Actor } from "@marketplace/contracts";
import { user } from "@marketplace/db";
import { eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";

/**
 * Throws `forbidden` unless the caller is a signed-in session (`type: "user"`: a browser session, a session token, or
 * a device-flow session). Used by commands whose effect outlives the credential that performs them, such as minting
 * or revoking personal API tokens and deleting the account: a token (`cmk_…` or OAuth) must not be able to extend
 * itself into a long-lived credential. Call it after `requireScope`, so anonymous callers still get 401.
 */
export function requireSignedInSession(actor: Actor, action: string): void {
  if (actor.type !== "user") {
    throw new MarketplaceError("forbidden", `${action} needs a signed-in session, not a token`, {
      details: { reason: "session_required" },
    });
  }
}

/**
 * Throws `forbidden` unless the caller's account email is verified. No email is ever sent, so an invitation id is only
 * bound to a mailbox when the account proved it owns the address (e.g. a verified GitHub email): an unverified sign-up
 * must not accept invitations addressed to an email it merely typed. Returns the account's email for the caller's
 * own matching, or null when the account row no longer exists.
 */
export async function requireVerifiedEmail(deps: MarketplaceDeps, userId: string, action: string): Promise<string | null> {
  const [account] = await deps.db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!account) return null;
  if (!account.emailVerified) {
    throw new MarketplaceError("forbidden", `Verify your account email before ${action}`, {
      details: { reason: "email_unverified" },
    });
  }
  return account.email;
}
