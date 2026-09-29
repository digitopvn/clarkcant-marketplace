import { ANONYMOUS_ACTOR, scopesForAccount, type Actor } from "@marketplace/contracts";
import { media, packageAudits, packagePreviews, packageSubmissions, user } from "@marketplace/db";
import { env } from "cloudflare:workers";
import { inject } from "vitest";

import {
  createLocalRegistryFetch,
  createMarketplaceDeps,
  createNpmRegistry,
  type MarketplaceDeps,
  type NpmRegistry,
} from "../../src";
import { resetDatabase } from "./seed";

export type FixtureVariant = "valid" | "nextVersion" | "missingManifest" | "invalidManifest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Base64 `npm pack` output per fixture variant (see `fixture-tarballs.setup.ts`). */
    fixtureTarballs: Record<FixtureVariant, string>;
    /** True when `LIVE_NPM=1`: opt-in tests that talk to the real npm registry. */
    liveNpm: boolean;
  }
}

export const FIXTURE_NAME = "@clarkcant/example-frame-widget";
export const REGISTRY_URL = "https://registry.test/";

export function fixtureTarball(variant: FixtureVariant): Uint8Array {
  return Uint8Array.from(atob(inject("fixtureTarballs")[variant]), (char) => char.charCodeAt(0));
}

/** Real D1 + R2 deps, as the jobs Worker builds them. */
export function indexingDeps(): MarketplaceDeps {
  return createMarketplaceDeps({ d1: env.DB, media: env.MEDIA });
}

/** A registry serving the given real tarballs, with packuments derived from them. */
export async function fixtureRegistry(
  tarballs: { variant: FixtureVariant; publishedAt?: Date }[],
): Promise<NpmRegistry> {
  const fetch = await createLocalRegistryFetch(
    REGISTRY_URL,
    tarballs.map((entry) => ({ bytes: fixtureTarball(entry.variant), publishedAt: entry.publishedAt })),
  );
  return createNpmRegistry({ baseUrl: REGISTRY_URL, fetch });
}

export async function resetIndexingState(deps: MarketplaceDeps): Promise<void> {
  await deps.db.batch([
    deps.db.delete(packagePreviews),
    deps.db.delete(packageAudits),
    deps.db.delete(packageSubmissions),
  ]);
  await resetDatabase(deps);
  await deps.db.batch([deps.db.delete(media), deps.db.delete(user)]);
}

/** Creates a real account row so submissions can reference it, and returns an actor for it. */
export async function createAccount(deps: MarketplaceDeps, options: { admin?: boolean } = {}): Promise<Actor> {
  const id = deps.ids("usr");
  const now = deps.now();
  await deps.db.insert(user).values({
    id,
    name: options.admin ? "Curator" : "Publisher",
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return { type: "user", userId: id, scopes: scopesForAccount(options.admin ?? false) };
}

export { ANONYMOUS_ACTOR };
