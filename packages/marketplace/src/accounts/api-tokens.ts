import {
  API_TOKEN_PREFIX,
  MarketplaceError,
  apiScopeSchema,
  createApiTokenInputSchema,
  hasScope,
  requireScope,
  requireUser,
  toAuditActor,
  type Actor,
  type ApiScope,
  type ApiToken,
  type CreateApiTokenInput,
  type CreatedApiToken,
} from "@marketplace/contracts";
import { apiTokens } from "@marketplace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";

type ApiTokenRow = typeof apiTokens.$inferSelect;

const DAY_MS = 86_400_000;
/** `lastUsedAt` is refreshed at most once per minute so a busy token does not write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;
const MAX_ACTIVE_TOKENS = 50;

/** 32 random bytes, base64url: 256 bits of entropy, so a hash lookup needs no rate limit or constant-time compare. */
export function generateApiTokenPlaintext(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return API_TOKEN_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex digest; only this is stored. */
export async function hashApiToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isApiTokenFormat(value: string): boolean {
  return /^cmk_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Creates a token whose scopes must be a subset of what the creating credential holds right now, so a token can
 * never widen access. Creating tokens needs `account:write`; a token cannot mint tokens beyond its own grant.
 */
export async function createApiToken(
  deps: MarketplaceDeps,
  actor: Actor,
  input: CreateApiTokenInput,
): Promise<CreatedApiToken> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  const { name, scopes, expiresInDays } = parseInput(createApiTokenInputSchema, input);

  const excess = scopes.filter((scope) => !hasScope(actor.scopes, scope));
  if (excess.length > 0) {
    throw new MarketplaceError("forbidden", "A token cannot hold scopes your account does not have", {
      details: { scopes: excess },
    });
  }

  const now = deps.now();
  const active = await deps.db
    .select({ id: apiTokens.id, expiresAt: apiTokens.expiresAt })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  if (active.filter((row) => row.expiresAt === null || row.expiresAt > now).length >= MAX_ACTIVE_TOKENS) {
    throw new MarketplaceError("conflict", `An account can hold at most ${MAX_ACTIVE_TOKENS} active tokens`);
  }

  const token = generateApiTokenPlaintext();
  const row: ApiTokenRow = {
    id: deps.ids("tok"),
    userId,
    name,
    tokenHash: await hashApiToken(token),
    scopes,
    lastUsedAt: null,
    expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS),
    revokedAt: null,
    createdAt: now,
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "api_token.created",
    subject: { type: "api_token", id: row.id },
    data: { name, scopes, expiresAt: row.expiresAt?.toISOString() },
  });
  await deps.db.batch([deps.db.insert(apiTokens).values(row), audit.statement]);
  return { ...toApiToken(row), token };
}

export async function listApiTokens(deps: MarketplaceDeps, actor: Actor): Promise<ApiToken[]> {
  requireScope(actor, "account:read");
  const rows = await deps.db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, requireUser(actor)))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
  return rows.map(toApiToken);
}

/** Revokes one of the caller's tokens. Revoking an already revoked token is a no-op that returns it unchanged. */
export async function revokeApiToken(deps: MarketplaceDeps, actor: Actor, tokenId: string): Promise<ApiToken> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  const [row] = await deps.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", "No such token");
  if (row.revokedAt !== null) return toApiToken(row);

  const revokedAt = deps.now();
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "api_token.revoked",
    subject: { type: "api_token", id: row.id },
  });
  await deps.db.batch([
    deps.db.update(apiTokens).set({ revokedAt }).where(eq(apiTokens.id, row.id)),
    audit.statement,
  ]);
  return toApiToken({ ...row, revokedAt });
}

export interface VerifiedApiToken {
  tokenId: string;
  userId: string;
  /** The scopes granted when the token was created; callers intersect them with the account's current scopes. */
  scopes: ApiScope[];
}

/**
 * Resolves a presented plaintext token. Returns null for anything unknown, revoked or expired, so the caller can
 * answer with one indistinguishable `unauthorized`.
 */
export async function verifyApiToken(deps: MarketplaceDeps, plaintext: string): Promise<VerifiedApiToken | null> {
  if (!isApiTokenFormat(plaintext)) return null;
  const [row] = await deps.db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, await hashApiToken(plaintext)))
    .limit(1);
  const now = deps.now();
  if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) return null;

  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await deps.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
  }
  return { tokenId: row.id, userId: row.userId, scopes: parseStoredScopes(row.scopes) };
}

/** Stored scopes are re-validated on read; an unknown (e.g. retired) scope is dropped rather than trusted. */
function parseStoredScopes(stored: unknown): ApiScope[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((scope) => {
    const parsed = apiScopeSchema.safeParse(scope);
    return parsed.success ? [parsed.data] : [];
  });
}

export function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
