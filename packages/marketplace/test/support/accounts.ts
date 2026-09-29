import { scopesForAccount, type Actor } from "@marketplace/contracts";
import { user } from "@marketplace/db";

import type { MarketplaceDeps } from "../../src";

/** Inserts an account row the way Better Auth does at sign-up and returns a session actor for it. */
export async function seedAccount(
  deps: MarketplaceDeps,
  input: { email: string; name?: string; emailVerified?: boolean; admin?: boolean },
): Promise<Actor & { userId: string }> {
  const id = deps.ids("usr");
  const now = deps.now();
  await deps.db.insert(user).values({
    id,
    name: input.name ?? input.email.split("@")[0] ?? "user",
    email: input.email.toLowerCase(),
    emailVerified: input.emailVerified ?? false,
    image: null,
    createdAt: now,
    updatedAt: now,
    role: input.admin ? "admin" : "user",
  });
  return { type: "user", userId: id, scopes: scopesForAccount(input.admin ?? false) };
}

/** A token actor for the same account holding only `scopes`. */
export function tokenActor(account: Actor & { userId: string }, scopes: Actor["scopes"], tokenId = "tok_test"): Actor {
  return { type: "token", userId: account.userId, tokenId, scopes };
}

let counter = 0;
/** Unique email per call so test files can share one database without resets. */
export function uniqueEmail(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}@example.test`;
}
