import { MarketplaceError, directoryFeedPageSchema, type DirectoryEntry, type DirectoryFeedPage } from "@marketplace/contracts";
import { packageVersionArtifacts, packages } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  backfillVersionArtifacts,
  createNpmRegistry,
  getDirectoryFeedPage,
  getPackage,
  getPackageInstall,
  indexPackage,
  submitPackage,
  type MarketplaceDeps,
  type NpmRegistry,
} from "../src";
import {
  FIXTURE_NAME,
  REGISTRY_URL,
  createAccount,
  fixtureRegistry,
  indexingDeps,
  resetIndexingState,
  upstreamPackages,
} from "./support/indexing-fixtures";

/** ClarkCant's digest of the example widget's files (`fixtures/upstream/clarkcant-directory/content-digests.json`). */
const EXAMPLE_DIGEST = "sha256:c0e7d38c9b96712a76bb1121b5169129afd21269d728606180afd9a011fa96af";
const EXAMPLE_ID = "cc.clarkcant.example-frame-widget";
const FORK_NAME = "@clarkcant/example-frame-widget-fork";
const SITE_URL = "https://marketplace.test";

let deps: MarketplaceDeps;
let clock: number;

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 1);
  // A clock that moves a second per call, so "who claimed an id first" never ties by accident.
  deps = { ...indexingDeps(), now: () => new Date((clock += 1000)) };
  await resetIndexingState(deps);
});

async function index(registry: NpmRegistry, name: string, version?: string) {
  const actor = await createAccount(deps);
  const { submission } = await submitPackage(deps, actor, { name, version }, { enqueue: false });
  const result = await indexPackage(deps, { submissionId: submission.id, packageName: name }, { registry });
  expect(result.status, JSON.stringify(result)).toBe("indexed");
}

async function feed(query: Record<string, unknown> = {}): Promise<DirectoryFeedPage> {
  const page = await getDirectoryFeedPage(deps, query, { siteUrl: SITE_URL });
  // Exactly the page ClarkCant's reader accepts: one invalid entry would make it refuse the whole feed.
  return directoryFeedPageSchema.parse(page);
}

async function allEntries(limit: number): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const page: DirectoryFeedPage = await feed(cursor === null ? { limit } : { limit, cursor });
    expect(page.entries.length).toBeLessThanOrEqual(limit);
    entries.push(...page.entries);
    cursor = page.nextCursor;
    if (cursor === null) return entries;
  }
  throw new Error("the feed never ended");
}

async function setPackage(name: string, values: Partial<typeof packages.$inferInsert>): Promise<void> {
  await deps.db.update(packages).set(values).where(eq(packages.name, name));
}

async function directoryOf(name: string) {
  return (await getPackage(deps, name)).latest?.directory;
}

async function artifactRows() {
  return deps.db.select().from(packageVersionArtifacts);
}

describe("directory feed", () => {
  it("serves an indexed version as the entry ClarkCant builds", async () => {
    await index(await fixtureRegistry([{ variant: "valid" }]), FIXTURE_NAME);

    const page = await feed();
    expect(page).toMatchObject({ format: "clarkcant-directory@1", nextCursor: null });
    expect(page.entries).toHaveLength(1);
    const [entry] = page.entries;
    expect(entry).toEqual({
      packageId: EXAMPLE_ID,
      version: "1.0.0",
      displayName: "Example frame widget",
      description: expect.any(String) as string,
      source: { kind: "npm", name: FIXTURE_NAME, version: "1.0.0" },
      publisher: { id: "clarkcant", sourceUrl: "https://github.com/digitopvn/clarkcant-marketplace", license: "MIT" },
      preview: { imageUrl: expect.stringMatching(/^https:\/\/marketplace\.test\/media\/\S+$/) as string },
      // ClarkCant reads a schemaVersion 1 widget as a `ui` facet, and so does its directory.
      facets: ["ui"],
      isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      hostApi: { min: 1, max: 1 },
      permissionsSummary: [],
      riskTier: "isolated-ui",
      sizeBytes: 10210,
      digest: EXAMPLE_DIGEST,
    });

    expect(await directoryOf(FIXTURE_NAME)).toEqual({
      packageId: EXAMPLE_ID,
      contentDigest: EXAMPLE_DIGEST,
      sizeBytes: 10210,
      listed: true,
      reason: null,
    });
    expect(await getPackageInstall(deps, FIXTURE_NAME)).toMatchObject({
      packageId: EXAMPLE_ID,
      contentDigest: EXAMPLE_DIGEST,
      sizeBytes: 10210,
    });
  });

  it("is a valid empty feed before anything is indexed", async () => {
    expect(await feed()).toEqual({ format: "clarkcant-directory@1", entries: [], nextCursor: null });
  });

  it("lists every version once and pages with a stable cursor", async () => {
    const registry = await fixtureRegistry([
      { variant: "valid", publishedAt: new Date("2026-09-01T00:00:00Z") },
      { variant: "nextVersion", publishedAt: new Date("2026-09-02T00:00:00Z") },
    ]);
    await index(registry, FIXTURE_NAME, "1.0.0");
    await index(registry, FIXTURE_NAME, "1.1.0");
    for (const pkg of upstreamPackages()) await index(await fixtureRegistry([{ bytes: pkg.bytes }]), pkg.name);

    const unpaged = (await feed()).entries;
    expect(unpaged.filter((entry) => entry.packageId === EXAMPLE_ID).map((entry) => entry.version)).toEqual(["1.0.0", "1.1.0"]);
    // ClarkCant's reference apps and template: services with declared reach, resources, every risk lane in use.
    expect(unpaged).toHaveLength(2 + upstreamPackages().length);
    expect(new Set(unpaged.map((entry) => entry.riskTier))).toEqual(new Set(["isolated-ui", "service"]));
    expect(unpaged.some((entry) => entry.declaredReach !== undefined)).toBe(true);
    expect(unpaged.some((entry) => entry.resources !== undefined)).toBe(true);

    expect(await allEntries(1)).toEqual(unpaged);
    expect(await allEntries(3)).toEqual(unpaged);

    // A cursor keeps its place when a version before it disappears from the feed.
    const first = await feed({ limit: 2 });
    await setPackage(FIXTURE_NAME, { curationStatus: "hidden" });
    const rest = await feed({ limit: 250, cursor: first.nextCursor });
    expect(rest.entries).toEqual(unpaged.slice(2).filter((entry) => entry.packageId !== EXAMPLE_ID));
  });

  it("refuses a cursor it did not issue", async () => {
    for (const cursor of ["nope", "v1.pv_short", "v2.pv_01jabcdefghjkmnpqrstvwxyz0"]) {
      await expect(feed({ cursor })).rejects.toSatisfy(
        (error: unknown) => error instanceof MarketplaceError && error.code === "validation_failed",
      );
    }
    await expect(feed({ limit: 251 })).rejects.toBeInstanceOf(MarketplaceError);
  });

  it("leaves out hidden packages", async () => {
    await index(await fixtureRegistry([{ variant: "valid" }]), FIXTURE_NAME);
    expect((await feed()).entries.map((entry) => entry.source.name)).toEqual([FIXTURE_NAME]);
    await setPackage(FIXTURE_NAME, { curationStatus: "hidden" });
    expect((await feed()).entries).toEqual([]);
  });
});

describe("package id collisions", () => {
  async function indexBoth(): Promise<void> {
    await index(await fixtureRegistry([{ variant: "valid" }]), FIXTURE_NAME);
    await index(await fixtureRegistry([{ variant: "sameIdOtherName" }]), FORK_NAME);
  }
  const listedNames = async () => (await feed()).entries.map((entry) => entry.source.name);

  it("lists only the first claimant, and says why on the other", async () => {
    await indexBoth();
    expect(await listedNames()).toEqual([FIXTURE_NAME]);
    expect(await directoryOf(FORK_NAME)).toEqual({
      packageId: EXAMPLE_ID,
      // Its package.json names the fork, so its files, and their digest, differ.
      contentDigest: expect.stringMatching(/^sha256:(?!c0e7d38c)[0-9a-f]{64}$/) as string,
      sizeBytes: expect.any(Number) as number,
      listed: false,
      reason: expect.stringContaining(`"${FIXTURE_NAME}" holds the ClarkCant package id "${EXAMPLE_ID}"`) as string,
    });
  });

  it("puts a verified publisher ahead of an earlier claim", async () => {
    await indexBoth();
    await setPackage(FORK_NAME, { verifiedPublisher: true });
    expect(await listedNames()).toEqual([FORK_NAME]);
    expect(await directoryOf(FIXTURE_NAME)).toMatchObject({ listed: false, reason: expect.stringContaining(FORK_NAME) as string });

    // Both verified: the first claim wins again.
    await setPackage(FIXTURE_NAME, { verifiedPublisher: true });
    expect(await listedNames()).toEqual([FIXTURE_NAME]);
  });

  it("hands the id to the next claimant when a curator hides the holder", async () => {
    await indexBoth();
    await setPackage(FIXTURE_NAME, { curationStatus: "hidden" });
    expect(await listedNames()).toEqual([FORK_NAME]);
    expect(await directoryOf(FORK_NAME)).toMatchObject({ listed: true, reason: null });
  });

  it("breaks a tie on the claim time by npm name", async () => {
    // Both claims at the same instant, the fork indexed first: the byte order of the npm names decides.
    const frozen = new Date(Date.UTC(2026, 9, 1));
    deps = { ...deps, now: () => frozen };
    await index(await fixtureRegistry([{ variant: "sameIdOtherName" }]), FORK_NAME);
    await index(await fixtureRegistry([{ variant: "valid" }]), FIXTURE_NAME);
    expect(await listedNames()).toEqual([FIXTURE_NAME]);
  });
});

describe("measuring versions indexed before the directory existed", () => {
  async function forgetMeasurements(): Promise<void> {
    await deps.db.delete(packageVersionArtifacts);
  }

  it("backfills a version on the next scheduled run, once", async () => {
    const registry = await fixtureRegistry([{ variant: "valid" }]);
    await index(registry, FIXTURE_NAME);
    await forgetMeasurements();
    expect(await directoryOf(FIXTURE_NAME)).toBeNull();
    expect((await feed()).entries).toEqual([]);

    expect(await backfillVersionArtifacts(deps, { registry })).toEqual({ measured: 1, withoutDigest: 0, failed: 0 });
    expect((await feed()).entries.map((entry) => entry.digest)).toEqual([EXAMPLE_DIGEST]);
    expect(await backfillVersionArtifacts(deps, { registry })).toEqual({ measured: 0, withoutDigest: 0, failed: 0 });
  });

  it("measures an unmeasured version when it is indexed again", async () => {
    const registry = await fixtureRegistry([{ variant: "valid" }]);
    await index(registry, FIXTURE_NAME);
    await forgetMeasurements();
    await index(registry, FIXTURE_NAME);
    expect(await artifactRows()).toMatchObject([{ manifestId: EXAMPLE_ID, contentDigest: EXAMPLE_DIGEST }]);
  });

  it("records a version npm no longer serves, and retries one that failed transiently", async () => {
    await index(await fixtureRegistry([{ variant: "valid" }]), FIXTURE_NAME);
    await forgetMeasurements();

    const unreachable = createNpmRegistry({
      baseUrl: REGISTRY_URL,
      fetch: () => Promise.reject(new TypeError("network connection lost")),
    });
    expect(await backfillVersionArtifacts(deps, { registry: unreachable })).toEqual({ measured: 0, withoutDigest: 0, failed: 1 });
    expect(await artifactRows()).toEqual([]);

    // A registry that no longer has the package (it serves only the fork).
    const gone = await fixtureRegistry([{ variant: "sameIdOtherName" }]);
    expect(await backfillVersionArtifacts(deps, { registry: gone })).toEqual({ measured: 0, withoutDigest: 1, failed: 0 });
    expect(await artifactRows()).toMatchObject([
      { manifestId: EXAMPLE_ID, contentDigest: null, digestProblem: expect.stringContaining("could not be fetched again") as string },
    ]);
    expect(await directoryOf(FIXTURE_NAME)).toMatchObject({ listed: false, contentDigest: null });
    expect((await feed()).entries).toEqual([]);
  });
});
