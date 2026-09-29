import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { organization, user } from "./auth";
import { createdAt, timestampMs } from "./columns";

/**
 * A publisher is the marketplace identity that owns listings. It is backed by a Better Auth organization so
 * membership and invitations reuse one implementation; `kind` records whether it represents a person or a team.
 */
export const publishers = sqliteTable(
  "publishers",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["org", "person"] }).notNull(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
    verifiedAt: timestampMs("verified_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("publishers_slug_uidx").on(table.slug),
    index("publishers_organization_idx").on(table.organizationId),
  ],
);

/** Domains a publisher claims; `verifiedAt` is set only after a DNS/HTTP proof succeeds. */
export const publisherDomains = sqliteTable(
  "publisher_domains",
  {
    id: text("id").primaryKey(),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestampMs("verified_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("publisher_domains_domain_uidx").on(table.domain),
    index("publisher_domains_publisher_idx").on(table.publisherId),
  ],
);

/** Source repositories a publisher proves control of (e.g. `github.com/org/repo`). */
export const publisherRepositories = sqliteTable(
  "publisher_repositories",
  {
    id: text("id").primaryKey(),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["github"] }).notNull(),
    repository: text("repository").notNull(),
    verifiedAt: timestampMs("verified_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("publisher_repositories_repo_uidx").on(table.provider, table.repository),
    index("publisher_repositories_publisher_idx").on(table.publisherId),
  ],
);

/**
 * Links a marketplace account to a ClarkCant local principal (`prin_*`). The link is informational: it never
 * replaces ClarkCant's own local identity and never grants runtime authority.
 */
export const clarkcantDeviceLinks = sqliteTable(
  "clarkcant_device_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    localPrincipalId: text("local_principal_id").notNull(),
    deviceLabel: text("device_label").notNull(),
    createdAt: createdAt(),
    revokedAt: timestampMs("revoked_at"),
  },
  (table) => [
    index("clarkcant_device_links_user_idx").on(table.userId),
    uniqueIndex("clarkcant_device_links_user_principal_uidx").on(table.userId, table.localPrincipalId),
  ],
);

/** Personal API tokens for CLI/MCP/agents. Only a hash is stored; the plaintext is shown once at creation. */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    lastUsedAt: timestampMs("last_used_at"),
    expiresAt: timestampMs("expires_at"),
    revokedAt: timestampMs("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("api_tokens_hash_uidx").on(table.tokenHash),
    index("api_tokens_user_idx").on(table.userId),
  ],
);
