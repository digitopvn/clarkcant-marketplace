import { createRoute, z } from "@hono/zod-openapi";
import {
  accountDeletionResultSchema,
  accountExportSchema,
  accountProfileSchema,
  addDomainInputSchema,
  apiTokenSchema,
  claimPackageInputSchema,
  createApiTokenInputSchema,
  createPublisherInputSchema,
  createdApiTokenSchema,
  deviceLinkSchema,
  errorBodySchema,
  inviteMemberInputSchema,
  linkDeviceInputSchema,
  linkRepositoryInputSchema,
  ownedPackageSchema,
  packageClaimSchema,
  publisherDomainSchema,
  publisherInvitationSchema,
  publisherMemberSchema,
  publisherRepositorySchema,
  publisherSchema,
  MarketplaceError,
  requireUser,
  type Actor,
} from "@marketplace/contracts";
import {
  acceptInvitation,
  addPublisherDomain,
  claimPackage,
  createApiToken,
  createHttpVerificationPorts,
  createPublisher,
  deleteAccount,
  exportAccountData,
  getAccountProfile,
  inviteMember,
  linkDevice,
  linkPublisherRepository,
  listApiTokens,
  listDeviceLinks,
  listMyPublishers,
  listOAuthGrants,
  listOwnedPackages,
  listPublisherClaims,
  listPublisherDomains,
  listPublisherInvitations,
  listPublisherMembers,
  listPublisherRepositories,
  revokeApiToken,
  revokeOAuthGrant,
  unlinkDevice,
  verifyPublisherDomain,
  verifyPublisherRepository,
  withIdempotency,
  type MarketplaceDeps,
} from "@marketplace/marketplace";
import { deleteMediaIfUnreferenced } from "@marketplace/media";

import { createRouter } from "../http/router";

const ERROR_DESCRIPTIONS = {
  400: "Invalid request (`validation_failed`)",
  401: "No credential, or an invalid/expired/revoked one (`unauthorized`)",
  403: "Missing scope, not permitted, or cross-site request (`forbidden`)",
  404: "Not found, or not visible to the caller",
  409: "Conflicts with the current state (`conflict`), or a request with this Idempotency-Key is still running (`idempotency_in_progress`)",
  422: "Idempotency-Key reused with a different request (`idempotency_key_reused`)",
  500: "Server error",
} as const;
type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

function errors(...statuses: ErrorStatus[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: ERROR_DESCRIPTIONS[status], content: { "application/json": { schema: errorBodySchema } } },
    ]),
  ) as Record<ErrorStatus, { description: string; content: { "application/json": { schema: typeof errorBodySchema } } }>;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});

const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
const tags = ["account"];
const itemsOf = <T extends z.ZodType>(schema: T) => z.object({ items: z.array(schema) });
const idParam = z.object({ id: z.string().min(1).max(200) });
const publisherParam = z.object({ publisherId: z.string().min(1).max(200) });
const publisherChildParam = publisherParam.extend({ childId: z.string().min(1).max(200) });
const common = errors(401, 403, 500);
/** Every `/me/*` POST accepts `Idempotency-Key`; a retry with the same key and request replays the first answer. */
const writeHeaders = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(255)
    .optional()
    .openapi({ description: "Makes retries safe; replayed for 24 hours" }),
});
const writeErrors = errors(409, 422);

const oauthGrantSchema = z.object({
  clientId: z.string(),
  clientName: z.string().nullable(),
  scopes: z.array(z.string()),
  grantedAt: z.string(),
});

const routes = {
  getMe: createRoute({
    method: "get", path: "/me", operationId: "getMe", tags, security,
    summary: "The signed-in account, its role and the scopes of the current credential",
    responses: { 200: json(accountProfileSchema, "Account profile"), ...common },
  }),
  deleteMe: createRoute({
    method: "delete", path: "/me", operationId: "deleteMe", tags, security,
    summary: "Delete the account and all data tied to it (needs a signed-in session)",
    request: { body: body(z.object({ confirm: z.literal("DELETE") })) },
    responses: { 200: json(accountDeletionResultSchema, "Deleted"), ...common, ...errors(400, 409) },
  }),
  listMyPackages: createRoute({
    method: "get", path: "/me/packages", operationId: "listMyPackages", tags, security,
    summary: "Listings owned by the caller's publishers, in any curation state",
    responses: { 200: json(itemsOf(ownedPackageSchema), "Owned listings"), ...common },
  }),
  exportMe: createRoute({
    method: "get", path: "/me/export", operationId: "exportMe", tags, security,
    summary: "Download everything stored about the account as JSON",
    responses: { 200: json(accountExportSchema, "Account data export"), ...common },
  }),
  listTokens: createRoute({
    method: "get", path: "/me/tokens", operationId: "listApiTokens", tags, security,
    summary: "Personal API tokens (metadata only; plaintext is never shown again)",
    responses: { 200: json(itemsOf(apiTokenSchema), "Tokens"), ...common },
  }),
  createToken: createRoute({
    method: "post", path: "/me/tokens", operationId: "createApiToken", tags, security,
    summary:
      "Create a scoped personal API token (needs a signed-in session, not a token); the plaintext `token` is " +
      "returned once, so a replayed Idempotency-Key answers 409 instead of repeating it",
    request: { headers: writeHeaders, body: body(createApiTokenInputSchema) },
    responses: { 201: json(createdApiTokenSchema, "Created"), ...common, ...errors(400, 409), ...writeErrors },
  }),
  revokeToken: createRoute({
    method: "delete", path: "/me/tokens/{id}", operationId: "revokeApiToken", tags, security,
    summary: "Revoke a personal API token (needs a signed-in session, not a token)",
    request: { params: idParam },
    responses: { 200: json(apiTokenSchema, "Revoked"), ...common, ...errors(404) },
  }),
  linkDevice: createRoute({
    method: "post", path: "/me/devices/link", operationId: "linkClarkCantDevice", tags, security,
    summary:
      "Link a ClarkCant install (local principal prin_*) to this account; idempotent per principal. Needs " +
      "`devices:link` (offered to OAuth clients) or `account:write`",
    request: { headers: writeHeaders, body: body(linkDeviceInputSchema) },
    responses: { 200: json(deviceLinkSchema, "Linked"), ...common, ...errors(400), ...writeErrors },
  }),
  listDevices: createRoute({
    method: "get", path: "/me/devices", operationId: "listClarkCantDevices", tags, security,
    summary: "Linked ClarkCant installs (`devices:link` or `account:read`)",
    responses: { 200: json(itemsOf(deviceLinkSchema), "Linked devices"), ...common },
  }),
  unlinkDevice: createRoute({
    method: "delete", path: "/me/devices/{id}", operationId: "unlinkClarkCantDevice", tags, security,
    summary: "Unlink a ClarkCant install (`devices:link` or `account:write`)",
    request: { params: idParam },
    responses: { 204: { description: "Unlinked" }, ...common, ...errors(404) },
  }),
  listOAuthGrants: createRoute({
    method: "get", path: "/me/oauth/grants", operationId: "listOAuthGrants", tags, security,
    summary: "OAuth clients the account has authorized",
    responses: { 200: json(itemsOf(oauthGrantSchema), "Grants"), ...common },
  }),
  revokeOAuthGrant: createRoute({
    method: "delete", path: "/me/oauth/grants/{id}", operationId: "revokeOAuthGrant", tags, security,
    summary: "Revoke an OAuth client's consent and tokens (id = client id)",
    request: { params: idParam },
    responses: { 204: { description: "Revoked" }, ...common, ...errors(404) },
  }),
  listPublishers: createRoute({
    method: "get", path: "/me/publishers", operationId: "listMyPublishers", tags: ["publishers"], security,
    summary: "Publishers the caller belongs to, with the caller's role",
    responses: { 200: json(itemsOf(publisherSchema), "Publishers"), ...common },
  }),
  createPublisher: createRoute({
    method: "post", path: "/me/publishers", operationId: "createPublisher", tags: ["publishers"], security,
    summary: "Create a publisher (the caller becomes its owner)",
    request: { headers: writeHeaders, body: body(createPublisherInputSchema) },
    responses: { 201: json(publisherSchema, "Created"), ...common, ...errors(400, 409), ...writeErrors },
  }),
  listMembers: createRoute({
    method: "get", path: "/me/publishers/{publisherId}/members", operationId: "listPublisherMembers",
    tags: ["publishers"], security, summary: "Members of a publisher",
    request: { params: publisherParam },
    responses: { 200: json(itemsOf(publisherMemberSchema), "Members"), ...common, ...errors(404) },
  }),
  listInvitations: createRoute({
    method: "get", path: "/me/publishers/{publisherId}/invitations", operationId: "listPublisherInvitations",
    tags: ["publishers"], security, summary: "Pending invitations (owners and admins)",
    request: { params: publisherParam },
    responses: { 200: json(itemsOf(publisherInvitationSchema), "Invitations"), ...common, ...errors(404) },
  }),
  invite: createRoute({
    method: "post", path: "/me/publishers/{publisherId}/invitations", operationId: "inviteMember",
    tags: ["publishers"], security,
    summary: "Invite an email address; share the returned invitation id with the invitee (no email is sent)",
    request: { headers: writeHeaders, params: publisherParam, body: body(inviteMemberInputSchema) },
    responses: { 201: json(publisherInvitationSchema, "Invited"), ...common, ...errors(400, 404, 409), ...writeErrors },
  }),
  acceptInvitation: createRoute({
    method: "post", path: "/me/invitations/{id}/accept", operationId: "acceptInvitation", tags: ["publishers"],
    security, summary: "Accept an invitation addressed to the caller's email (the email must be verified)",
    request: { headers: writeHeaders, params: idParam },
    responses: { 200: json(publisherSchema, "Joined"), ...common, ...errors(404, 409), ...writeErrors },
  }),
  listDomains: createRoute({
    method: "get", path: "/me/publishers/{publisherId}/domains", operationId: "listPublisherDomains",
    tags: ["publishers"], security, summary: "Claimed domains and their TXT challenge",
    request: { params: publisherParam },
    responses: { 200: json(itemsOf(publisherDomainSchema), "Domains"), ...common, ...errors(404) },
  }),
  addDomain: createRoute({
    method: "post", path: "/me/publishers/{publisherId}/domains", operationId: "addPublisherDomain",
    tags: ["publishers"], security, summary: "Claim a domain; returns the DNS TXT record to publish",
    request: { headers: writeHeaders, params: publisherParam, body: body(addDomainInputSchema) },
    responses: { 201: json(publisherDomainSchema, "Claimed"), ...common, ...errors(400, 404, 409), ...writeErrors },
  }),
  verifyDomain: createRoute({
    method: "post", path: "/me/publishers/{publisherId}/domains/{childId}/verify",
    operationId: "verifyPublisherDomain", tags: ["publishers"], security,
    summary: "Check the DNS TXT record now and mark the domain verified on a match",
    request: { headers: writeHeaders, params: publisherChildParam },
    responses: { 200: json(publisherDomainSchema, "Verified"), ...common, ...errors(404, 409), ...writeErrors },
  }),
  listRepositories: createRoute({
    method: "get", path: "/me/publishers/{publisherId}/repositories", operationId: "listPublisherRepositories",
    tags: ["publishers"], security, summary: "Linked source repositories",
    request: { params: publisherParam },
    responses: { 200: json(itemsOf(publisherRepositorySchema), "Repositories"), ...common, ...errors(404) },
  }),
  linkRepository: createRoute({
    method: "post", path: "/me/publishers/{publisherId}/repositories", operationId: "linkPublisherRepository",
    tags: ["publishers"], security, summary: "Link a GitHub repository; returns the verification file to commit",
    request: { headers: writeHeaders, params: publisherParam, body: body(linkRepositoryInputSchema) },
    responses: { 201: json(publisherRepositorySchema, "Linked"), ...common, ...errors(400, 404, 409), ...writeErrors },
  }),
  verifyRepository: createRoute({
    method: "post", path: "/me/publishers/{publisherId}/repositories/{childId}/verify",
    operationId: "verifyPublisherRepository", tags: ["publishers"], security,
    summary: "Check the verification file on the default branch now",
    request: { headers: writeHeaders, params: publisherChildParam },
    responses: { 200: json(publisherRepositorySchema, "Verified"), ...common, ...errors(404, 409), ...writeErrors },
  }),
  listClaims: createRoute({
    method: "get", path: "/me/publishers/{publisherId}/claims", operationId: "listPackageClaims",
    tags: ["publishers"], security, summary: "Package claims made by a publisher",
    request: { params: publisherParam },
    responses: { 200: json(itemsOf(packageClaimSchema), "Claims"), ...common, ...errors(404) },
  }),
  claimPackage: createRoute({
    method: "post", path: "/me/publishers/{publisherId}/claims", operationId: "claimPackage",
    tags: ["publishers"], security,
    summary: "Claim an indexed package via npm maintainers or a verified repository; approved when proven",
    request: { headers: writeHeaders, params: publisherParam, body: body(claimPackageInputSchema) },
    responses: { 201: json(packageClaimSchema, "Recorded"), ...common, ...errors(400, 404, 409), ...writeErrors },
  }),
};

/** Media deletion is owned by the media feature; the account service only decides which objects to remove. */
function mediaDeleter(deps: MarketplaceDeps) {
  const bucket = deps.media;
  if (!bucket) return undefined;
  return (mediaId: string) => deleteMediaIfUnreferenced({ db: deps.db, bucket, ids: deps.ids, now: deps.now }, mediaId);
}

/**
 * Runs a `/me/*` write at most once per `Idempotency-Key` for this account and operation; without a key it simply
 * runs. The key's scope includes the account id, so keys never collide across accounts.
 */
async function idempotent<T>(
  deps: MarketplaceDeps,
  actor: Actor,
  operation: string,
  key: string | undefined,
  request: unknown,
  statusCode: number,
  run: () => Promise<T>,
): Promise<{ response: T; replayed: boolean }> {
  if (key === undefined) return { response: await run(), replayed: false };
  const scope = `user:${requireUser(actor)}:me.${operation}`;
  const outcome = await withIdempotency(deps, { scope, key }, request, async () => ({ statusCode, response: await run() }));
  return { response: outcome.response, replayed: outcome.replayed };
}

/**
 * The signed-in account: profile, API tokens, ClarkCant device links, OAuth grants, publishers, data export and
 * deletion. Every handler passes `c.var.actor` to an application service, which checks scopes itself.
 */
export function createMeRouter() {
  const router = createRouter();
  router.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Personal API token (`cmk_…`), OAuth access token (audience `<origin>/api/v1`), or a session token",
  });
  router.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Browser session; mutations must come from the site's own origin",
  });
  const ports = createHttpVerificationPorts();
  const noStore = { "Cache-Control": "private, no-store" };
  const key = (c: { req: { header(name: string): string | undefined } }) => c.req.header("idempotency-key");

  return router
    .openapi(routes.getMe, async (c) => c.json(await getAccountProfile(c.var.context.deps, c.var.actor), 200, noStore))
    .openapi(routes.deleteMe, async (c) => {
      const { deps } = c.var.context;
      const result = await deleteAccount(deps, c.var.actor, { deleteMedia: mediaDeleter(deps) });
      return c.json(result, 200, noStore);
    })
    .openapi(routes.listMyPackages, async (c) =>
      c.json({ items: await listOwnedPackages(c.var.context.deps, c.var.actor) }, 200, noStore),
    )
    .openapi(routes.exportMe, async (c) =>
      c.json(await exportAccountData(c.var.context.deps, c.var.actor), 200, {
        ...noStore,
        "Content-Disposition": 'attachment; filename="clarkcant-marketplace-account.json"',
      }),
    )
    .openapi(routes.listTokens, async (c) =>
      c.json({ items: await listApiTokens(c.var.context.deps, c.var.actor) }, 200, noStore),
    )
    .openapi(routes.createToken, async (c) => {
      const { deps } = c.var.context;
      const actor = c.var.actor;
      const input = c.req.valid("json");
      // The service refuses token callers (signed-in session only). The plaintext is never stored for replay (only
      // its hash exists at rest), so a replay cannot repeat it.
      let plaintext: string | undefined;
      const { response, replayed } = await idempotent(deps, actor, "tokens.create", key(c), input, 201, async () => {
        const { token, ...metadata } = await createApiToken(deps, actor, input);
        plaintext = token;
        return metadata;
      });
      if (replayed || plaintext === undefined) {
        throw new MarketplaceError(
          "conflict",
          "A token was already created with this Idempotency-Key and its plaintext is shown only once; revoke it and create a new one if it was lost",
          { details: { tokenId: response.id } },
        );
      }
      return c.json({ ...response, token: plaintext }, 201, noStore);
    })
    .openapi(routes.revokeToken, async (c) =>
      c.json(await revokeApiToken(c.var.context.deps, c.var.actor, c.req.valid("param").id), 200, noStore),
    )
    .openapi(routes.linkDevice, async (c) => {
      const { deps } = c.var.context;
      const input = c.req.valid("json");
      const { response } = await idempotent(deps, c.var.actor, "devices.link", key(c), input, 200, () =>
        linkDevice(deps, c.var.actor, input),
      );
      return c.json(response, 200, noStore);
    })
    .openapi(routes.listDevices, async (c) =>
      c.json({ items: await listDeviceLinks(c.var.context.deps, c.var.actor) }, 200, noStore),
    )
    .openapi(routes.unlinkDevice, async (c) => {
      await unlinkDevice(c.var.context.deps, c.var.actor, c.req.valid("param").id);
      return c.body(null, 204);
    })
    .openapi(routes.listOAuthGrants, async (c) =>
      c.json({ items: await listOAuthGrants(c.var.context.deps, c.var.actor) }, 200, noStore),
    )
    .openapi(routes.revokeOAuthGrant, async (c) => {
      await revokeOAuthGrant(c.var.context.deps, c.var.actor, c.req.valid("param").id);
      return c.body(null, 204);
    })
    .openapi(routes.listPublishers, async (c) =>
      c.json({ items: await listMyPublishers(c.var.context.deps, c.var.actor) }, 200, noStore),
    )
    .openapi(routes.createPublisher, async (c) => {
      const { deps } = c.var.context;
      const input = c.req.valid("json");
      const { response } = await idempotent(deps, c.var.actor, "publishers.create", key(c), input, 201, () =>
        createPublisher(deps, c.var.actor, input),
      );
      return c.json(response, 201, noStore);
    })
    .openapi(routes.listMembers, async (c) => {
      const { publisherId } = c.req.valid("param");
      return c.json({ items: await listPublisherMembers(c.var.context.deps, c.var.actor, publisherId) }, 200, noStore);
    })
    .openapi(routes.listInvitations, async (c) => {
      const { publisherId } = c.req.valid("param");
      const items = await listPublisherInvitations(c.var.context.deps, c.var.actor, publisherId);
      return c.json({ items }, 200, noStore);
    })
    .openapi(routes.invite, async (c) => {
      const { deps } = c.var.context;
      const { publisherId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { response } = await idempotent(deps, c.var.actor, "invitations.create", key(c), { publisherId, input }, 201, () =>
        inviteMember(deps, c.var.actor, publisherId, input),
      );
      return c.json(response, 201, noStore);
    })
    .openapi(routes.acceptInvitation, async (c) => {
      const { deps } = c.var.context;
      const { id } = c.req.valid("param");
      // The service requires a verified account email.
      const { response } = await idempotent(deps, c.var.actor, "invitations.accept", key(c), { id }, 200, () =>
        acceptInvitation(deps, c.var.actor, id),
      );
      return c.json(response, 200, noStore);
    })
    .openapi(routes.listDomains, async (c) => {
      const { publisherId } = c.req.valid("param");
      return c.json({ items: await listPublisherDomains(c.var.context.deps, c.var.actor, publisherId) }, 200, noStore);
    })
    .openapi(routes.addDomain, async (c) => {
      const { deps } = c.var.context;
      const { publisherId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { response } = await idempotent(deps, c.var.actor, "domains.add", key(c), { publisherId, input }, 201, () =>
        addPublisherDomain(deps, c.var.actor, publisherId, input),
      );
      return c.json(response, 201, noStore);
    })
    .openapi(routes.verifyDomain, async (c) => {
      const { deps } = c.var.context;
      const params = c.req.valid("param");
      const { response } = await idempotent(deps, c.var.actor, "domains.verify", key(c), params, 200, () =>
        verifyPublisherDomain(deps, c.var.actor, params.publisherId, params.childId, ports),
      );
      return c.json(response, 200, noStore);
    })
    .openapi(routes.listRepositories, async (c) => {
      const { publisherId } = c.req.valid("param");
      const items = await listPublisherRepositories(c.var.context.deps, c.var.actor, publisherId);
      return c.json({ items }, 200, noStore);
    })
    .openapi(routes.linkRepository, async (c) => {
      const { deps } = c.var.context;
      const { publisherId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { response } = await idempotent(deps, c.var.actor, "repositories.link", key(c), { publisherId, input }, 201, () =>
        linkPublisherRepository(deps, c.var.actor, publisherId, input),
      );
      return c.json(response, 201, noStore);
    })
    .openapi(routes.verifyRepository, async (c) => {
      const { deps } = c.var.context;
      const params = c.req.valid("param");
      const { response } = await idempotent(deps, c.var.actor, "repositories.verify", key(c), params, 200, () =>
        verifyPublisherRepository(deps, c.var.actor, params.publisherId, params.childId, ports),
      );
      return c.json(response, 200, noStore);
    })
    .openapi(routes.listClaims, async (c) => {
      const { publisherId } = c.req.valid("param");
      return c.json({ items: await listPublisherClaims(c.var.context.deps, c.var.actor, publisherId) }, 200, noStore);
    })
    .openapi(routes.claimPackage, async (c) => {
      const { deps } = c.var.context;
      const { publisherId } = c.req.valid("param");
      const input = c.req.valid("json");
      const { response } = await idempotent(deps, c.var.actor, "claims.create", key(c), { publisherId, input }, 201, () =>
        claimPackage(deps, c.var.actor, publisherId, input, ports),
      );
      return c.json(response, 201, noStore);
    });
}
