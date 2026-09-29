import { packageNameSchema, semverSchema, type IngestMessage } from "@marketplace/contracts";
import { packageSubmissions, packageVersions, packages } from "@marketplace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { chunked } from "../d1-limits";
import type { MarketplaceDeps } from "../deps";
import { INDEXER_ACTOR, indexPackage, type IndexPackageOptions, type IndexPackageParams } from "./index-package";
import { createNpmRegistry, type NpmRegistry, type NpmSearchHit } from "./npm-registry";
import { createSystemSubmission, enqueueIngest } from "./submissions";

/** npm keywords that mark a package as a ClarkCant package. */
export const DISCOVERY_KEYWORDS = ["clarkcant", "clarkcant-widget"] as const;
const PAGE_SIZE = 250;
/** Upper bound per keyword per run, so one cron invocation stays well inside Worker limits. */
const MAX_HITS_PER_KEYWORD = 1000;
/**
 * New submissions created per run. Each costs a batch write and a queue send, so this keeps one cron invocation far
 * below D1's 1000-queries-per-invocation limit; candidates past it are submitted by the next run.
 */
export const MAX_QUEUED_PER_RUN = 100;

export interface DiscoveryResult {
  /** Distinct valid (name, latest version) candidates npm search returned. */
  seen: number;
  /** Submissions created and queued by this run. */
  queued: number;
  /** New candidates left for the next run because this one reached {@link MAX_QUEUED_PER_RUN}. */
  pending: number;
}

export interface DiscoverOptions {
  registry?: NpmRegistry;
}

async function searchKeyword(registry: NpmRegistry, keyword: string): Promise<NpmSearchHit[]> {
  const hits: NpmSearchHit[] = [];
  for (let from = 0; from < MAX_HITS_PER_KEYWORD; from += PAGE_SIZE) {
    const page = await registry.search(`keywords:${keyword}`, from, PAGE_SIZE);
    hits.push(...page.hits);
    if (page.hits.length < PAGE_SIZE || hits.length >= page.total) break;
  }
  return hits;
}

/**
 * Polls npm search for ClarkCant keywords and queues a submission for every (name, latest version) the marketplace
 * has not indexed, is not indexing and has not failed to index (see {@link handledVersions}). Hits with an invalid
 * name or version are ignored: search results are untrusted input.
 */
export async function discoverNpmPackages(
  deps: MarketplaceDeps,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const registry = options.registry ?? createNpmRegistry();
  const candidates = new Map<string, string>();
  for (const keyword of DISCOVERY_KEYWORDS) {
    for (const hit of await searchKeyword(registry, keyword)) {
      if (packageNameSchema.safeParse(hit.name).success && semverSchema.safeParse(hit.version).success) {
        candidates.set(hit.name, hit.version);
      }
    }
  }

  const handled = await handledVersions(deps, [...candidates.keys()]);
  let queued = 0;
  let pending = 0;
  for (const [name, version] of candidates) {
    if (handled.has(coordinate(name, version))) continue;
    // Anything past the per-run budget stays unsubmitted, so the next run picks it up.
    if (queued >= MAX_QUEUED_PER_RUN) {
      pending += 1;
      continue;
    }
    const id = await createSystemSubmission(deps, {
      name,
      version,
      actor: INDEXER_ACTOR,
      action: "package.discovered",
      source: "npm-search",
    });
    await enqueueIngest(deps, { type: "index-package", submissionId: id, packageName: name });
    queued += 1;
  }
  return { seen: candidates.size, queued, pending };
}

const coordinate = (name: string, version: string) => `${name}@${version}`;

/**
 * The `name@version` coordinates discovery must not submit again: versions already indexed, versions with a
 * submission still in flight, and versions whose submission failed. A version is immutable, so a failure (rejected
 * manifest, integrity mismatch, or retries exhausted) would only repeat; a person resubmits explicitly instead.
 * Names are looked up in chunks, a fixed handful of queries per run however many hits npm returns.
 */
async function handledVersions(deps: MarketplaceDeps, names: string[]): Promise<Set<string>> {
  const handled = new Set<string>();
  for (const chunk of chunked(names)) {
    const [indexed, submitted] = await Promise.all([
      deps.db
        .select({ name: packages.name, version: packageVersions.version })
        .from(packageVersions)
        .innerJoin(packages, eq(packages.id, packageVersions.packageId))
        .where(inArray(packages.name, chunk)),
      deps.db
        .selectDistinct({ name: packageSubmissions.packageName, version: packageSubmissions.version })
        .from(packageSubmissions)
        .where(
          and(
            inArray(packageSubmissions.packageName, chunk),
            isNotNull(packageSubmissions.version),
            inArray(packageSubmissions.status, ["queued", "indexing", "failed"]),
          ),
        ),
    ]);
    for (const row of [...indexed, ...submitted]) {
      if (row.version !== null) handled.add(coordinate(row.name, row.version));
    }
  }
  return handled;
}

export interface HandleIngestOptions extends IndexPackageOptions, DiscoverOptions {
  /**
   * Starts durable indexing (a Workflow instance keyed by submission id) instead of indexing inline. The jobs
   * Worker always provides it; without it the message is indexed in the current invocation.
   */
  startIndexing?: (params: IndexPackageParams) => Promise<void>;
}

/** Dispatches one ingest queue message. */
export async function handleIngestMessage(
  deps: MarketplaceDeps,
  message: IngestMessage,
  options: HandleIngestOptions = {},
): Promise<void> {
  switch (message.type) {
    case "discover":
      await discoverNpmPackages(deps, options);
      return;
    case "index-package": {
      const params = { submissionId: message.submissionId, packageName: message.packageName };
      if (options.startIndexing) {
        await deps.db
          .update(packageSubmissions)
          .set({ workflowId: message.submissionId, updatedAt: deps.now() })
          .where(eq(packageSubmissions.id, message.submissionId));
        await options.startIndexing(params);
        return;
      }
      await indexPackage(deps, params, options);
      return;
    }
  }
}
