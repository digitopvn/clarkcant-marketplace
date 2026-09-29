import { MarketplaceError, requireScope, requireUser, toAuditActor, type Actor } from "@marketplace/contracts";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@marketplace/db";
import { and, eq } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";

export interface OAuthGrant {
  clientId: string;
  clientName: string | null;
  scopes: string[];
  grantedAt: string;
}

/** OAuth clients (e.g. ClarkCant desktop, MCP clients) the account has consented to. */
export async function listOAuthGrants(deps: MarketplaceDeps, actor: Actor): Promise<OAuthGrant[]> {
  requireScope(actor, "account:read");
  const rows = await deps.db
    .select({ clientId: oauthConsent.clientId, name: oauthClient.name, scopes: oauthConsent.scopes, createdAt: oauthConsent.createdAt })
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, requireUser(actor)));
  return rows.map((row) => ({
    clientId: row.clientId,
    clientName: row.name ?? null,
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    grantedAt: row.createdAt.toISOString(),
  }));
}

/**
 * Revokes everything one OAuth client holds for this account: the consent and every access and refresh token.
 * Refresh tokens are deleted, so the client must ask for consent again. JWT access tokens already issued stay
 * cryptographically valid until they expire (at most one hour); refresh is what this cuts off.
 */
export async function revokeOAuthGrant(deps: MarketplaceDeps, actor: Actor, clientId: string): Promise<void> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  const [consent] = await deps.db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);
  const [token] = await deps.db
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)))
    .limit(1);
  if (!consent && !token) throw new MarketplaceError("not_found", "No grant for that client");

  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "oauth_grant.revoked",
    subject: { type: "oauth_client", id: clientId },
  });
  await deps.db.batch([
    deps.db.delete(oauthAccessToken).where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId))),
    deps.db
      .delete(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId))),
    deps.db.delete(oauthConsent).where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId))),
    audit.statement,
  ]);
}

export interface OAuthClientSummary {
  clientId: string;
  name: string | null;
  uri: string | null;
  disabled: boolean;
}

/** Public facts about an OAuth client for the consent screen. Never includes the client secret. */
export async function describeOAuthClient(deps: MarketplaceDeps, clientId: string): Promise<OAuthClientSummary | null> {
  const [row] = await deps.db
    .select({ clientId: oauthClient.clientId, name: oauthClient.name, uri: oauthClient.uri, disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return row ? { clientId: row.clientId, name: row.name ?? null, uri: row.uri ?? null, disabled: row.disabled === true } : null;
}
