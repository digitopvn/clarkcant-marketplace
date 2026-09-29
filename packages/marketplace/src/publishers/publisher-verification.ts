import {
  MarketplaceError,
  addDomainInputSchema,
  linkRepositoryInputSchema,
  toAuditActor,
  type Actor,
  type PublisherDomain,
  type PublisherRepository,
} from "@marketplace/contracts";
import { publisherDomains, publisherRepositories, publishers } from "@marketplace/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";
import { authorizePublisher } from "./publisher-service";
import type { VerificationPorts } from "./verification-ports";

type DomainRow = typeof publisherDomains.$inferSelect;
type RepositoryRow = typeof publisherRepositories.$inferSelect;

export const DOMAIN_TXT_PREFIX = "_clarkcant-marketplace";
export const DOMAIN_TXT_VALUE_PREFIX = "clarkcant-marketplace-verification=";
export const REPOSITORY_VERIFICATION_PATH = ".well-known/clarkcant-marketplace.txt";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Claims a domain for a publisher and returns the DNS TXT record that proves control. The claim stays unverified
 * until `verifyPublisherDomain` finds the record. A domain another publisher already verified cannot be claimed.
 */
export async function addPublisherDomain(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  input: z.input<typeof addDomainInputSchema>,
): Promise<PublisherDomain> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "manage");
  const { domain } = parseInput(addDomainInputSchema, input);

  const [existing] = await deps.db.select().from(publisherDomains).where(eq(publisherDomains.domain, domain)).limit(1);
  if (existing) {
    if (existing.publisherId === publisher.id) return toDomain(existing);
    if (existing.verifiedAt !== null) throw new MarketplaceError("conflict", "Another publisher has verified this domain");
  }

  const row: DomainRow = {
    id: deps.ids("dom"),
    publisherId: publisher.id,
    domain,
    verificationToken: randomToken(),
    verifiedAt: null,
    createdAt: deps.now(),
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.domain_added",
    subject: { type: "publisher", id: publisher.id },
    data: { domain },
  });
  // An unverified claim by someone else must not block the real owner: the newer claim replaces it.
  await deps.db.batch([
    deps.db.delete(publisherDomains).where(and(eq(publisherDomains.domain, domain), isNull(publisherDomains.verifiedAt))),
    deps.db.insert(publisherDomains).values(row),
    audit.statement,
  ]);
  return toDomain(row);
}

export async function listPublisherDomains(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
): Promise<PublisherDomain[]> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "read");
  const rows = await deps.db
    .select()
    .from(publisherDomains)
    .where(eq(publisherDomains.publisherId, publisher.id))
    .orderBy(asc(publisherDomains.createdAt));
  return rows.map(toDomain);
}

/** The verification check: looks up the TXT record and marks the domain (and the publisher) verified on a match. */
export async function verifyPublisherDomain(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  domainId: string,
  ports: VerificationPorts,
): Promise<PublisherDomain> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "manage");
  const [row] = await deps.db
    .select()
    .from(publisherDomains)
    .where(and(eq(publisherDomains.id, domainId), eq(publisherDomains.publisherId, publisher.id)))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", "No such domain claim");
  if (row.verifiedAt !== null) return toDomain(row);

  const domain = toDomain(row);
  const records = await ports.resolveTxt(domain.txtRecordName);
  if (!records.some((record) => record.trim() === domain.txtRecordValue)) {
    throw new MarketplaceError("conflict", "The verification TXT record was not found yet", {
      details: { txtRecordName: domain.txtRecordName, txtRecordValue: domain.txtRecordValue, found: records.length },
    });
  }

  const verifiedAt = deps.now();
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.domain_verified",
    subject: { type: "publisher", id: publisher.id },
    data: { domain: row.domain },
  });
  await deps.db.batch([
    deps.db.update(publisherDomains).set({ verifiedAt }).where(eq(publisherDomains.id, row.id)),
    deps.db
      .update(publishers)
      .set({ verifiedAt })
      .where(and(eq(publishers.id, publisher.id), isNull(publishers.verifiedAt))),
    audit.statement,
  ]);
  return toDomain({ ...row, verifiedAt });
}

/**
 * Links a source repository. Verification proves write access: the publisher commits a file naming its id to the
 * repository's default branch. Only verified repositories count for package claims.
 */
export async function linkPublisherRepository(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  input: z.input<typeof linkRepositoryInputSchema>,
): Promise<PublisherRepository> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "manage");
  const { provider, repository } = parseInput(linkRepositoryInputSchema, input);

  const [existing] = await deps.db
    .select()
    .from(publisherRepositories)
    .where(and(eq(publisherRepositories.provider, provider), eq(publisherRepositories.repository, repository)))
    .limit(1);
  if (existing) {
    if (existing.publisherId === publisher.id) return toRepository(existing);
    if (existing.verifiedAt !== null) {
      throw new MarketplaceError("conflict", "Another publisher has verified this repository");
    }
  }

  const row: RepositoryRow = {
    id: deps.ids("repo"),
    publisherId: publisher.id,
    provider,
    repository,
    verifiedAt: null,
    createdAt: deps.now(),
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.repository_linked",
    subject: { type: "publisher", id: publisher.id },
    data: { provider, repository },
  });
  await deps.db.batch([
    deps.db
      .delete(publisherRepositories)
      .where(
        and(
          eq(publisherRepositories.provider, provider),
          eq(publisherRepositories.repository, repository),
          isNull(publisherRepositories.verifiedAt),
        ),
      ),
    deps.db.insert(publisherRepositories).values(row),
    audit.statement,
  ]);
  return toRepository(row);
}

export async function listPublisherRepositories(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
): Promise<PublisherRepository[]> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "read");
  const rows = await deps.db
    .select()
    .from(publisherRepositories)
    .where(eq(publisherRepositories.publisherId, publisher.id))
    .orderBy(asc(publisherRepositories.createdAt));
  return rows.map(toRepository);
}

export async function verifyPublisherRepository(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  repositoryId: string,
  ports: VerificationPorts,
): Promise<PublisherRepository> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "manage");
  const [row] = await deps.db
    .select()
    .from(publisherRepositories)
    .where(and(eq(publisherRepositories.id, repositoryId), eq(publisherRepositories.publisherId, publisher.id)))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", "No such repository link");
  if (row.verifiedAt !== null) return toRepository(row);

  const expected = repositoryVerificationContent(publisher.id);
  const content = await ports.fetchRepositoryFile(row.provider, row.repository, REPOSITORY_VERIFICATION_PATH);
  if (content === null || !content.split(/\r?\n/).some((line) => line.trim() === expected)) {
    throw new MarketplaceError("conflict", "The verification file was not found on the default branch yet", {
      details: { path: REPOSITORY_VERIFICATION_PATH, expected },
    });
  }

  const verifiedAt = deps.now();
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.repository_verified",
    subject: { type: "publisher", id: publisher.id },
    data: { provider: row.provider, repository: row.repository },
  });
  await deps.db.batch([
    deps.db.update(publisherRepositories).set({ verifiedAt }).where(eq(publisherRepositories.id, row.id)),
    audit.statement,
  ]);
  return toRepository({ ...row, verifiedAt });
}

export function repositoryVerificationContent(publisherId: string): string {
  return `clarkcant-marketplace-publisher=${publisherId}`;
}

function toDomain(row: DomainRow): PublisherDomain {
  return {
    id: row.id,
    domain: row.domain,
    txtRecordName: `${DOMAIN_TXT_PREFIX}.${row.domain}`,
    txtRecordValue: `${DOMAIN_TXT_VALUE_PREFIX}${row.verificationToken}`,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRepository(row: RepositoryRow): PublisherRepository {
  return {
    id: row.id,
    provider: row.provider,
    repository: row.repository,
    verificationFilePath: REPOSITORY_VERIFICATION_PATH,
    verificationFileContent: repositoryVerificationContent(row.publisherId),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
