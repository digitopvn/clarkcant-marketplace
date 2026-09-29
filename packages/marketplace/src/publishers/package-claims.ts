import {
  MarketplaceError,
  claimMethodSchema,
  claimPackageInputSchema,
  requireUser,
  toAuditActor,
  type Actor,
  type ClaimMethod,
  type PackageClaim,
} from "@marketplace/contracts";
import { packageClaims, packages, publisherRepositories, user } from "@marketplace/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { syncPackageSearchDocumentsAfterCommit } from "../search/search-index";
import { parseInput } from "../validation";
import { authorizePublisher } from "./publisher-service";
import type { VerificationPorts } from "./verification-ports";

type ClaimRow = typeof packageClaims.$inferSelect;

/**
 * A publisher claims an indexed package by proving control, and the method is recorded with its evidence:
 *
 * - `npm_maintainer`: the caller's verified account email is a maintainer email on the npm registry.
 * - `repository`: the package's repository is one the publisher has verified.
 *
 * A successful proof approves the claim and moves the listing to the publisher (ownership belongs to the publisher,
 * never to an email). A failed proof is still recorded as `pending` with its evidence, for admin review.
 */
export async function claimPackage(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  input: z.input<typeof claimPackageInputSchema>,
  ports: VerificationPorts,
): Promise<PackageClaim> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "manage");
  const userId = requireUser(actor);
  const { packageName, method } = parseInput(claimPackageInputSchema, input);

  const [listing] = await deps.db.select().from(packages).where(eq(packages.name, packageName)).limit(1);
  if (!listing) throw new MarketplaceError("not_found", "That package is not indexed yet");
  if (listing.publisherId === publisher.id && listing.verifiedPublisher) {
    throw new MarketplaceError("conflict", "This publisher already owns the package");
  }

  const evidence =
    method === "npm_maintainer"
      ? await checkNpmMaintainer(deps, userId, packageName, ports)
      : await checkRepository(deps, publisher.id, listing.repositoryUrl);

  const now = deps.now();
  const row: ClaimRow = {
    id: deps.ids("clm"),
    packageId: listing.id,
    publisherId: publisher.id,
    requestedBy: userId,
    status: evidence.matched ? "approved" : "pending",
    evidence: { method, ...evidence },
    decidedAt: evidence.matched ? now : null,
    createdAt: now,
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: evidence.matched ? "package.claim_approved" : "package.claim_requested",
    subject: { type: "package", id: listing.id },
    data: { claimId: row.id, publisherId: publisher.id, method, matched: evidence.matched },
  });
  const writes = [deps.db.insert(packageClaims).values(row), audit.statement] as const;
  if (evidence.matched) {
    await deps.db.batch([
      ...writes,
      deps.db
        .update(packages)
        .set({ publisherId: publisher.id, verifiedPublisher: true, updatedAt: now })
        .where(eq(packages.id, listing.id)),
    ]);
    // The publisher's name is part of the package's search text.
    await syncPackageSearchDocumentsAfterCommit(deps, [listing.id], "claim approval");
  } else {
    await deps.db.batch(writes);
  }
  return toClaim(row, listing.name);
}

export async function listPublisherClaims(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
): Promise<PackageClaim[]> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "read");
  const rows = await deps.db
    .select({ claim: packageClaims, name: packages.name })
    .from(packageClaims)
    .innerJoin(packages, eq(packages.id, packageClaims.packageId))
    .where(eq(packageClaims.publisherId, publisher.id))
    .orderBy(desc(packageClaims.createdAt));
  return rows.map(({ claim, name }) => toClaim(claim, name));
}

async function checkNpmMaintainer(deps: MarketplaceDeps, userId: string, packageName: string, ports: VerificationPorts) {
  const [account] = await deps.db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!account?.emailVerified) {
    throw new MarketplaceError("forbidden", "Verify your account email before claiming through npm maintainers");
  }
  const maintainers = await ports.fetchNpmMaintainers(packageName);
  if (maintainers === null) return { matched: false, reason: "package not found on npm" };
  const email = account.email.toLowerCase();
  const match = maintainers.find((maintainer) => maintainer.email?.toLowerCase() === email);
  return match
    ? { matched: true, maintainer: match.name }
    : { matched: false, reason: "account email is not an npm maintainer", maintainerCount: maintainers.length };
}

async function checkRepository(deps: MarketplaceDeps, publisherId: string, repositoryUrl: string | null) {
  const repository = githubRepositoryFromUrl(repositoryUrl);
  if (repository === null) return { matched: false, reason: "package has no GitHub repository" };
  const [verified] = await deps.db
    .select({ id: publisherRepositories.id })
    .from(publisherRepositories)
    .where(
      and(
        eq(publisherRepositories.publisherId, publisherId),
        eq(publisherRepositories.provider, "github"),
        eq(publisherRepositories.repository, repository),
        isNotNull(publisherRepositories.verifiedAt),
      ),
    )
    .limit(1);
  return verified
    ? { matched: true, repository }
    : { matched: false, reason: "repository is not verified by this publisher", repository };
}

/** Normalises npm `repository` URLs (`git+https://github.com/o/r.git`, `github:o/r`, `git@github.com:o/r`). */
export function githubRepositoryFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /^(?:git\+)?(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(
    url.trim(),
  ) ?? /^github:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(url.trim());
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function toClaim(row: ClaimRow, packageName: string): PackageClaim {
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;
  const method: ClaimMethod = claimMethodSchema.catch("repository").parse(evidence.method);
  return {
    id: row.id,
    packageId: row.packageId,
    packageName,
    publisherId: row.publisherId,
    status: row.status,
    method,
    evidence,
    createdAt: row.createdAt.toISOString(),
  };
}
