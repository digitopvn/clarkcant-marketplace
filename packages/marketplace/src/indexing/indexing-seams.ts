import { NotImplementedError, type IngestMessage } from "@marketplace/contracts";

import type { MarketplaceDeps } from "../deps";

/**
 * Entry points the jobs Worker calls. The npm indexing pipeline (fetch packument, verify tarball integrity, parse
 * `clarkcant.json`, sanitize README, write versions/facets/permissions, sync search) is delivered separately; until
 * then these throw `NotImplementedError` so the queue retries/dead-letters instead of acknowledging work that
 * never happened.
 */

export interface IndexPackageParams {
  submissionId: string;
  packageName: string;
}

export interface IndexPackageResult {
  packageId: string;
  version: string;
}

/** Indexes the requested npm package version. Called from `IndexPackageWorkflow.run`. */
export async function indexPackage(_deps: MarketplaceDeps, _params: IndexPackageParams): Promise<IndexPackageResult> {
  throw new NotImplementedError("indexPackage");
}

/** Finds candidate packages on npm (keywords `clarkcant`, `clarkcant-widget`). Called from the cron trigger. */
export async function discoverNpmPackages(_deps: MarketplaceDeps): Promise<{ queued: number }> {
  throw new NotImplementedError("discoverNpmPackages");
}

/** Dispatches one ingest queue message. Called from the queue consumer. */
export async function handleIngestMessage(_deps: MarketplaceDeps, message: IngestMessage): Promise<void> {
  throw new NotImplementedError(`handleIngestMessage(${message.type})`);
}
