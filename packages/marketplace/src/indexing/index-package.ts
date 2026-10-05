import {
  MarketplaceError,
  normalizeStoredManifest,
  type AuditActor,
  type CurationStatus,
  type NormalizedManifest,
} from "@marketplace/contracts";
import {
  auditEvents,
  categories,
  packageAudits,
  packageFacets,
  packagePermissions,
  packagePreviews,
  packageSubmissions,
  packageVersions,
  packages,
} from "@marketplace/db";
import { MarkdownInputTooLargeError, renderMarkdownToSafeHtml } from "@marketplace/markdown";
import { MediaRejectedError, storeGeneratedMedia, storeUntrustedImage, type MediaDeps } from "@marketplace/media";
import { and, eq, isNull, sql } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import { D1_MAX_BOUND_PARAMETERS, chunked } from "../d1-limits";
import { isConstraintViolation } from "../db-errors";
import type { MarketplaceDeps } from "../deps";
import { syncPackageSearchDocument } from "../search/search-index";
import { isIndexingRejection, rejectionErrorText, type IndexingRejectionCode } from "./indexing-errors";
import { verifyTarballIntegrity } from "./integrity";
import { validateManifest } from "./manifest-validation";
import { createNpmRegistry, resolveVersion, type NpmRegistry, type ResolvedVersion } from "./npm-registry";
import { MAX_README_BYTES, readPackageArchive, type PackageArchive } from "./package-archive";
import { isNewerSemver } from "./semver-order";
import { SOCIAL_CARD_HEIGHT, SOCIAL_CARD_WIDTH, renderSocialCardSvg } from "./social-card";

/**
 * The npm indexing pipeline. Each stage runs through a `StepRunner`: the jobs Worker passes one backed by
 * Cloudflare Workflows (`step.do`, durable and retried per step), while tests and the local CLI run the same stages
 * inline. Stage results are small JSON values because Workflows persist them between steps.
 *
 * Stages: start → resolve (packument, exact version) → ingest (tarball, sha512 integrity, untar, manifest,
 * README, previews, immutable version row) → social card → finalize (latest pointer, search, submission, audit).
 */

export type StepRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/** Runs every stage immediately, with no retries. */
export const runStepsInline: StepRunner = (_name, run) => run();

/** The audit identity of the indexer. Indexing is a system action even when a person submitted the package. */
export const INDEXER_ACTOR: AuditActor = { type: "system", id: "jobs.indexer" };

/**
 * Curation status a package gets the first time it is indexed. Indexed packages have passed every automated check
 * (manifest contract, sha512 integrity), so they are listed; curators hide or reject afterwards. Listing is not a
 * safety claim, and later re-indexing never changes a curator's decision.
 */
export const INITIAL_CURATION_STATUS: CurationStatus = "listed";

export interface IndexPackageParams {
  submissionId: string;
  packageName: string;
}

export type IndexPackageResult =
  | { status: "indexed"; packageId: string; version: string; created: boolean }
  | { status: "rejected"; code: IndexingRejectionCode; reason: string };

export interface IndexPackageOptions {
  registry?: NpmRegistry;
  runStep?: StepRunner;
}

/** Relative README links and images resolve against the version's files on an npm CDN, never our origin. */
export function readmeBaseUrl(name: string, version: string): string {
  return `https://cdn.jsdelivr.net/npm/${name}@${version}/`;
}

function mediaDeps(deps: MarketplaceDeps): MediaDeps {
  if (!deps.media) throw new MarketplaceError("configuration_error", "indexing needs the MEDIA R2 bucket binding");
  return { db: deps.db, bucket: deps.media, ids: deps.ids, now: deps.now };
}

interface IngestOutcome {
  packageId: string;
  versionId: string;
  created: boolean;
}

export async function indexPackage(
  deps: MarketplaceDeps,
  params: IndexPackageParams,
  options: IndexPackageOptions = {},
): Promise<IndexPackageResult> {
  const registry = options.registry ?? createNpmRegistry();
  const step = options.runStep ?? runStepsInline;

  try {
    const requestedVersion = await step("start", () => startSubmission(deps, params));
    const resolved = await step("resolve version", async () =>
      resolveVersion(await registry.fetchPackument(params.packageName), requestedVersion),
    );
    const ingested = await step("ingest version", () => ingestVersion(deps, registry, resolved));
    await step("social card", () => ensureSocialCard(deps, ingested.versionId));
    await step("finalize", () => finalize(deps, params.submissionId, resolved, ingested));
    return { status: "indexed", packageId: ingested.packageId, version: resolved.version, created: ingested.created };
  } catch (error) {
    if (isIndexingRejection(error)) {
      await step("record rejection", () => recordFailure(deps, params, error));
      return { status: "rejected", code: error.code, reason: error.message };
    }
    // Transient failures reach here only after the runner's retries are exhausted.
    await step("record failure", () => recordFailure(deps, params, error)).catch((recordError: unknown) => {
      console.error(`indexing: could not record failure of ${params.submissionId}`, recordError);
    });
    throw error;
  }
}

async function startSubmission(deps: MarketplaceDeps, params: IndexPackageParams): Promise<string | null> {
  const [submission] = await deps.db
    .select()
    .from(packageSubmissions)
    .where(eq(packageSubmissions.id, params.submissionId))
    .limit(1);
  if (!submission) throw new MarketplaceError("not_found", `submission ${params.submissionId} does not exist`);
  if (submission.packageName !== params.packageName) {
    throw new MarketplaceError("conflict", `submission ${params.submissionId} is for ${submission.packageName}`);
  }
  await deps.db
    .update(packageSubmissions)
    .set({ status: "indexing", error: null, updatedAt: deps.now() })
    .where(eq(packageSubmissions.id, params.submissionId));
  return submission.version;
}

async function chooseCategory(deps: MarketplaceDeps, keywords: string[], manifest: NormalizedManifest): Promise<string | null> {
  const known = new Set((await deps.db.select({ slug: categories.slug }).from(categories)).map((row) => row.slug));
  const byKeyword = keywords.find((keyword) => known.has(keyword));
  if (byKeyword) return byKeyword;
  const hasWidget = manifest.facets.some((facet) => facet.kind === "widget" || facet.kind === "ui");
  return hasWidget && known.has("widgets") ? "widgets" : null;
}

async function ingestVersion(deps: MarketplaceDeps, registry: NpmRegistry, resolved: ResolvedVersion): Promise<IngestOutcome> {
  const [existingPackage] = await deps.db
    .select({ id: packages.id })
    .from(packages)
    .where(eq(packages.name, resolved.name))
    .limit(1);
  if (existingPackage) {
    const [existingVersion] = await deps.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, existingPackage.id), eq(packageVersions.version, resolved.version)))
      .limit(1);
    // Versions are immutable facts: an already indexed version is never downloaded or rewritten again.
    if (existingVersion) return { packageId: existingPackage.id, versionId: existingVersion.id, created: false };
  }

  const tarball = await registry.fetchTarball(resolved.tarballUrl);
  const verification = await verifyTarballIntegrity(tarball, resolved.integrity);
  const archive = await readPackageArchive(tarball);
  const manifest = validateManifest(archive.manifestText, resolved.version);
  const { readmeMd, readmeHtml, omitted: readmeOmitted } = renderReadme(
    archive,
    resolved,
    manifest.normalized.displayName ?? resolved.name,
  );

  const media = mediaDeps(deps);
  const storedPreviews: { mediaId: string; path: string }[] = [];
  const rejectedPreviews: { path: string; reason: string }[] = [];
  for (const preview of archive.previews) {
    try {
      const record = await storeUntrustedImage(media, preview.bytes);
      storedPreviews.push({ mediaId: record.id, path: preview.path });
    } catch (error) {
      if (!(error instanceof MediaRejectedError)) throw error;
      rejectedPreviews.push({ path: preview.path, reason: error.message });
    }
  }

  const now = deps.now();
  const packageId = existingPackage?.id ?? deps.ids("pkg");
  const versionId = deps.ids("pv");
  const normalized = manifest.normalized;
  const displayName = normalized.displayName ?? resolved.name;

  const statements = [];
  if (!existingPackage) {
    statements.push(
      deps.db.insert(packages).values({
        id: packageId,
        name: resolved.name,
        displayName,
        description: normalized.description ?? resolved.description ?? "",
        homepage: resolved.homepage,
        repositoryUrl: resolved.repositoryUrl,
        license: normalized.publisher?.license ?? resolved.license,
        keywords: resolved.keywords,
        categorySlug: await chooseCategory(deps, resolved.keywords, normalized),
        curationStatus: INITIAL_CURATION_STATUS,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  statements.push(
    deps.db.insert(packageVersions).values({
      id: versionId,
      packageId,
      version: resolved.version,
      manifest: manifest.raw,
      readmeMd,
      readmeHtml,
      npmIntegrity: verification.integrity,
      tarballSha512Verified: true,
      provenance: resolved.provenance
        ? { ...resolved.provenance, registrySignatureKeyIds: resolved.registrySignatureKeyIds }
        : null,
      publishedAt: resolved.publishedAt ? new Date(resolved.publishedAt) : now,
      indexedAt: now,
    }),
  );
  // Facets and permissions go in as multi-row inserts sized to D1's bound-parameter limit, so even the largest
  // manifest stays a small batch.
  const facetRows = normalized.facets.map((facet) => ({
    id: deps.ids("pf"),
    packageVersionId: versionId,
    kind: facet.kind,
    isolation: facet.isolation,
    renderer: facet.renderer,
    entry: facet.entry,
    widgetId: facet.widgetId,
  }));
  for (const rows of insertChunks(facetRows)) statements.push(deps.db.insert(packageFacets).values(rows));
  const permissionValues = manifest.permissions.map((permission) => ({ id: deps.ids("pp"), packageVersionId: versionId, ...permission }));
  for (const rows of insertChunks(permissionValues)) statements.push(deps.db.insert(packagePermissions).values(rows));
  storedPreviews.forEach((preview, position) => {
    statements.push(
      deps.db.insert(packagePreviews).values({
        id: deps.ids("ppv"),
        packageVersionId: versionId,
        kind: "image",
        mediaId: preview.mediaId,
        alt: `${displayName} preview (${preview.path.slice("previews/".length)})`,
        position,
      }),
    );
  });
  for (const check of securityChecks(resolved, verification.integrity, rejectedPreviews, readmeOmitted)) {
    statements.push(deps.db.insert(packageAudits).values({ id: deps.ids("pa"), packageVersionId: versionId, createdAt: now, ...check }));
  }

  // One atomic batch: a version appears with all its facets, permissions, previews and checks, or not at all. A
  // concurrent indexer inserting the same version makes the unique index fail the whole batch; the retry then sees
  // the existing row and stops above.
  const [first, ...rest] = statements;
  if (!first) throw new Error("unreachable: a version insert is always present");
  await deps.db.batch([first, ...rest]);
  return { packageId, versionId, created: true };
}

/**
 * Splits rows into groups that fit one multi-row insert: every column of a row is one bound parameter. Rows of one
 * table share their keys, so the first row's width holds for all.
 */
function insertChunks<T extends object>(rows: readonly T[]): T[][] {
  const width = rows[0] ? Object.keys(rows[0]).length : 1;
  return chunked(rows, Math.max(1, Math.floor(D1_MAX_BOUND_PARAMETERS / width)));
}

interface CheckRow {
  check: string;
  result: "pass" | "warn" | "fail";
  details: unknown;
}

/**
 * Stored README HTML is capped well below D1's 2 MB row limit: the row also holds the README source and the manifest.
 */
export const MAX_README_HTML_BYTES = 512 * 1024;

/** README h1 renders as h3: below the package page's h1 (package name) and its "README" h2. */
const README_HEADING_OFFSET = 2;

interface ReadmeOutcome {
  readmeMd: string | null;
  readmeHtml: string | null;
  omitted: { path: string; reason: string } | null;
}

/**
 * Renders the README once, at index time. Every limit here is a deterministic fact about an immutable version, so an
 * oversized or unrenderable README is recorded as omitted (a `readme` warn check) instead of failing the version,
 * which would only be retried to the same result.
 *
 * The README is nested content on the package page, which already owns the only h1 (the package name) and a "README"
 * h2, so headings are shifted down {@link README_HEADING_OFFSET} levels on the parsed tree and a leading title that
 * repeats the display name is dropped. The stored HTML is served as is; nothing rewrites it at render time.
 */
function renderReadme(archive: PackageArchive, resolved: ResolvedVersion, displayName: string): ReadmeOutcome {
  if (archive.readmeOmitted) {
    return { readmeMd: null, readmeHtml: null, omitted: { path: archive.readmeOmitted.path, reason: archive.readmeOmitted.reason } };
  }
  if (!archive.readme) return { readmeMd: null, readmeHtml: null, omitted: null };
  const { path, text } = archive.readme;
  let html: string;
  try {
    html = renderMarkdownToSafeHtml(text, {
      baseUrl: readmeBaseUrl(resolved.name, resolved.version),
      maxLength: MAX_README_BYTES,
      headingOffset: README_HEADING_OFFSET,
      omitLeadingTitle: displayName,
    });
  } catch (error) {
    const reason = error instanceof MarkdownInputTooLargeError ? error.message : "README could not be rendered";
    return { readmeMd: null, readmeHtml: null, omitted: { path, reason } };
  }
  const htmlBytes = new TextEncoder().encode(html).length;
  if (htmlBytes > MAX_README_HTML_BYTES) {
    return {
      readmeMd: text,
      readmeHtml: null,
      omitted: { path, reason: `rendered README is ${htmlBytes} bytes; the limit is ${MAX_README_HTML_BYTES}` },
    };
  }
  return { readmeMd: text, readmeHtml: html, omitted: null };
}

/** Automated facts about the artifact. They describe; they never change curation. */
function securityChecks(
  resolved: ResolvedVersion,
  integrity: string,
  rejectedPreviews: { path: string; reason: string }[],
  readmeOmitted: { path: string; reason: string } | null,
): CheckRow[] {
  const checks: CheckRow[] = [
    { check: "integrity", result: "pass", details: { algorithm: "sha512", integrity } },
    resolved.provenance
      ? { check: "provenance", result: "pass", details: { ...resolved.provenance, verified: false } }
      : { check: "provenance", result: "warn", details: { reason: "npm lists no provenance attestation for this version" } },
    resolved.installScripts.length > 0
      ? { check: "install-scripts", result: "warn", details: { scripts: resolved.installScripts } }
      : { check: "install-scripts", result: "pass", details: { scripts: [] } },
  ];
  if (rejectedPreviews.length > 0) checks.push({ check: "previews", result: "warn", details: { rejected: rejectedPreviews } });
  if (readmeOmitted) checks.push({ check: "readme", result: "warn", details: { omitted: readmeOmitted } });
  return checks;
}

async function ensureSocialCard(deps: MarketplaceDeps, versionId: string): Promise<void> {
  const [existing] = await deps.db
    .select({ id: packagePreviews.id })
    .from(packagePreviews)
    .where(and(eq(packagePreviews.packageVersionId, versionId), eq(packagePreviews.kind, "social_card")))
    .limit(1);
  if (existing) return;

  const [row] = await deps.db
    .select({ name: packages.name, version: packageVersions.version, manifest: packageVersions.manifest })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(eq(packageVersions.id, versionId))
    .limit(1);
  if (!row) throw new Error(`package version ${versionId} disappeared before its social card was made`);
  // The stored manifest is read tolerantly: a version stored under an older reader must still get its card.
  const manifest = normalizeStoredManifest(row.manifest);
  const displayName = manifest?.displayName ?? row.name;
  const svg = renderSocialCardSvg({
    name: row.name,
    displayName,
    description: manifest?.description ?? "",
    version: row.version,
    isolation: manifest?.facets.map((facet) => facet.isolation) ?? [],
  });
  const record = await storeGeneratedMedia(mediaDeps(deps), new TextEncoder().encode(svg), {
    contentType: "image/svg+xml",
    width: SOCIAL_CARD_WIDTH,
    height: SOCIAL_CARD_HEIGHT,
  });
  await deps.db.insert(packagePreviews).values({
    id: deps.ids("ppv"),
    packageVersionId: versionId,
    kind: "social_card",
    mediaId: record.id,
    alt: `${displayName} ${row.version} social card`,
    position: 1000,
  });
}

async function finalize(
  deps: MarketplaceDeps,
  submissionId: string,
  resolved: ResolvedVersion,
  ingested: IngestOutcome,
): Promise<void> {
  const [current] = await deps.db
    .select({ latestVersion: packages.latestVersion })
    .from(packages)
    .where(eq(packages.id, ingested.packageId))
    .limit(1);
  if (!current) throw new Error(`package ${ingested.packageId} disappeared during indexing`);
  const now = deps.now();

  // The listing follows npm's `latest` dist-tag but only ever moves forward. `resolved` may be minutes old (Workflows
  // persist it between steps), so a stale run finishing after a newer version was indexed must not roll it back.
  const becomesLatest =
    current.latestVersion === null ||
    (resolved.latestTag === resolved.version && isNewerSemver(resolved.version, current.latestVersion));
  const listing: Partial<typeof packages.$inferInsert> = { indexedAt: now, updatedAt: now };
  if (becomesLatest) {
    const [version] = await deps.db
      .select({ manifest: packageVersions.manifest })
      .from(packageVersions)
      .where(eq(packageVersions.id, ingested.versionId))
      .limit(1);
    // Tolerant, like the social card: a version stored under an older reader still finalizes, from npm's metadata.
    const manifest = normalizeStoredManifest(version?.manifest);
    Object.assign(listing, {
      latestVersion: resolved.version,
      displayName: manifest?.displayName ?? resolved.name,
      description: manifest?.description ?? resolved.description ?? "",
      keywords: resolved.keywords,
      homepage: resolved.homepage,
      repositoryUrl: resolved.repositoryUrl,
      license: manifest?.publisher?.license ?? resolved.license,
    });
  }

  const { row: auditRow } = prepareAuditEvent(deps, {
    actor: INDEXER_ACTOR,
    action: "package.indexed",
    subject: { type: "package", id: ingested.packageId },
    data: {
      name: resolved.name,
      version: resolved.version,
      submissionId,
      newVersion: ingested.created,
      becameLatest: becomesLatest,
    },
  });
  // Compare-and-set on the pointer read above, atomic with the submission status and the audit event. The audit insert
  // carries the precondition: when another run moved the pointer (or the package is gone) since it was read, the
  // insert yields a NULL actor type, the NOT NULL constraint aborts the whole batch, and nothing is written. The step
  // then retries against the new value; a retry after a successful batch sees its own version and leaves it alone.
  const unchanged = sql`exists (select 1 from ${packages} where ${packages.id} = ${ingested.packageId} and ${packages.latestVersion} is ${current.latestVersion})`;
  try {
    await deps.db.batch([
      deps.db.insert(auditEvents).select(
        deps.db
          .select({
            id: sql`${auditRow.id}`.as("id"),
            actorType: sql`case when ${unchanged} then ${auditRow.actorType} else null end`.as("actor_type"),
            actorId: sql`${auditRow.actorId}`.as("actor_id"),
            action: sql`${auditRow.action}`.as("action"),
            subjectType: sql`${auditRow.subjectType}`.as("subject_type"),
            subjectId: sql`${auditRow.subjectId}`.as("subject_id"),
            idempotencyKey: sql`${auditRow.idempotencyKey}`.as("idempotency_key"),
            data: sql`${JSON.stringify(auditRow.data)}`.as("data"),
            createdAt: sql`${auditRow.createdAt.getTime()}`.as("created_at"),
          })
          .from(packageSubmissions)
          .where(eq(packageSubmissions.id, submissionId)),
      ),
      deps.db
        .update(packages)
        .set(listing)
        .where(
          and(
            eq(packages.id, ingested.packageId),
            current.latestVersion === null ? isNull(packages.latestVersion) : eq(packages.latestVersion, current.latestVersion),
          ),
        ),
      deps.db
        .update(packageSubmissions)
        .set({ status: "indexed", error: null, updatedAt: now })
        .where(eq(packageSubmissions.id, submissionId)),
    ]);
  } catch (error) {
    if (isConstraintViolation(error, "audit_events.actor_type")) {
      throw new Error(`latest version of ${resolved.name} changed during finalize; retrying`, { cause: error });
    }
    throw error;
  }
  await syncPackageSearchDocument(deps, ingested.packageId);
}

async function recordFailure(deps: MarketplaceDeps, params: IndexPackageParams, error: unknown): Promise<void> {
  const rejection = isIndexingRejection(error) ? error : null;
  const message = rejection
    ? rejectionErrorText(rejection.code, rejection.message)
    : `indexing failed after retries: ${error instanceof Error ? error.message : String(error)}`;
  const audit = prepareAuditEvent(deps, {
    actor: INDEXER_ACTOR,
    action: rejection ? "package.index_rejected" : "package.index_failed",
    subject: { type: "package_submission", id: params.submissionId },
    data: {
      name: params.packageName,
      ...(rejection ? { code: rejection.code, details: rejection.details ?? null } : {}),
      message: message.slice(0, 1000),
    },
  });
  await deps.db.batch([
    deps.db
      .update(packageSubmissions)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: deps.now() })
      .where(eq(packageSubmissions.id, params.submissionId)),
    audit.statement,
  ]);
}
