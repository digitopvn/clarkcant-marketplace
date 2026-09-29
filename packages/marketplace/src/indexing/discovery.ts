import { packageNameSchema, semverSchema, type IngestMessage } from "@marketplace/contracts";
import { packageSubmissions, packageVersions, packages } from "@marketplace/db";
import { and, eq, inArray } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { INDEXER_ACTOR, indexPackage, type IndexPackageOptions, type IndexPackageParams } from "./index-package";
import { createNpmRegistry, type NpmRegistry, type NpmSearchHit } from "./npm-registry";
import { createSystemSubmission, enqueueIngest } from "./submissions";

/** npm keywords that mark a package as a ClarkCant package. */
export const DISCOVERY_KEYWORDS = ["clarkcant", "clarkcant-widget"] as const;
const PAGE_SIZE = 250;
/** Upper bound per keyword per run, so one cron invocation stays well inside Worker limits. */
const MAX_HITS_PER_KEYWORD = 1000;

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
 * has neither indexed nor already queued. Hits with an invalid name or version are ignored: search results are
 * untrusted input.
 */
export async function discoverNpmPackages(
  deps: MarketplaceDeps,
  options: DiscoverOptions = {},
): Promise<{ seen: number; queued: number }> {
  const registry = options.registry ?? createNpmRegistry();
  const candidates = new Map<string, string>();
  for (const keyword of DISCOVERY_KEYWORDS) {
    for (const hit of await searchKeyword(registry, keyword)) {
      if (packageNameSchema.safeParse(hit.name).success && semverSchema.safeParse(hit.version).success) {
        candidates.set(hit.name, hit.version);
      }
    }
  }

  let queued = 0;
  for (const [name, version] of candidates) {
    const [indexed] = await deps.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(and(eq(packages.name, name), eq(packageVersions.version, version)))
      .limit(1);
    if (indexed) continue;
    const [open] = await deps.db
      .select({ id: packageSubmissions.id })
      .from(packageSubmissions)
      .where(
        and(
          eq(packageSubmissions.packageName, name),
          eq(packageSubmissions.version, version),
          inArray(packageSubmissions.status, ["queued", "indexing"]),
        ),
      )
      .limit(1);
    if (open) continue;

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
  return { seen: candidates.size, queued };
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
