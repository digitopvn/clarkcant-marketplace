import { z } from "zod";

import { apiScopeSchema } from "./scopes";

/** Personal API tokens start with this prefix so leaked tokens are recognisable by secret scanners and humans. */
export const API_TOKEN_PREFIX = "cmk_";
export const API_TOKEN_MAX_LIFETIME_DAYS = 365;

export const createApiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(apiScopeSchema)
    .min(1)
    .max(apiScopeSchema.options.length)
    .transform((scopes) => [...new Set(scopes)]),
  /** Lifetime in days. Every token expires; the default is 90 days. */
  expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_LIFETIME_DAYS).default(90),
});
export type CreateApiTokenInput = z.input<typeof createApiTokenInputSchema>;

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(apiScopeSchema),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

/** Returned once, at creation. The plaintext `token` is never stored or shown again. */
export const createdApiTokenSchema = apiTokenSchema.extend({ token: z.string().startsWith(API_TOKEN_PREFIX) });
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>;

/** ClarkCant local principal id, e.g. `prin_7f3k9`. Mirrors ClarkCant's `prin_<alnum>` convention. */
export const localPrincipalIdSchema = z.string().regex(/^prin_[A-Za-z0-9]{1,120}$/, {
  error: "must be a ClarkCant local principal id (prin_<alphanumeric>)",
});

export const linkDeviceInputSchema = z.object({
  localPrincipalId: localPrincipalIdSchema,
  deviceLabel: z.string().trim().min(1).max(80),
});
export type LinkDeviceInput = z.input<typeof linkDeviceInputSchema>;

export const deviceLinkSchema = z.object({
  id: z.string(),
  localPrincipalId: z.string(),
  deviceLabel: z.string(),
  createdAt: z.iso.datetime(),
});
export type DeviceLink = z.infer<typeof deviceLinkSchema>;

export const accountProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: z.enum(["admin", "user"]),
  scopes: z.array(apiScopeSchema),
  createdAt: z.iso.datetime(),
});
export type AccountProfile = z.infer<typeof accountProfileSchema>;

/** A listing owned by one of the caller's publishers, in any curation state (owners see unlisted ones too). */
export const ownedPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  latestVersion: z.string().nullable(),
  curationStatus: z.string(),
  verifiedPublisher: z.boolean(),
  publisher: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
});
export type OwnedPackage = z.infer<typeof ownedPackageSchema>;

/**
 * Everything the marketplace stores about an account, for data portability. Secrets (password hashes, token
 * hashes, OAuth tokens, passkey public keys) are described, never exported.
 */
export const accountExportSchema = z.object({
  exportedAt: z.iso.datetime(),
  profile: accountProfileSchema.omit({ scopes: true }),
  signInMethods: z.array(z.object({ provider: z.string(), createdAt: z.iso.datetime() })),
  sessions: z.array(
    z.object({ createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), ipAddress: z.string().nullable(), userAgent: z.string().nullable() }),
  ),
  passkeys: z.array(z.object({ name: z.string().nullable(), deviceType: z.string(), createdAt: z.iso.datetime().nullable() })),
  apiTokens: z.array(apiTokenSchema),
  deviceLinks: z.array(deviceLinkSchema.extend({ revokedAt: z.iso.datetime().nullable() })),
  oauthConsents: z.array(z.object({ clientId: z.string(), scopes: z.array(z.string()), createdAt: z.iso.datetime() })),
  publishers: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), role: z.string() })),
  packageClaims: z.array(z.object({ id: z.string(), packageId: z.string(), publisherId: z.string(), status: z.string(), createdAt: z.iso.datetime() })),
  media: z.array(z.object({ id: z.string(), sha256: z.string(), contentType: z.string(), bytes: z.number(), createdAt: z.iso.datetime() })),
  auditEvents: z.array(z.object({ action: z.string(), subjectType: z.string(), subjectId: z.string().nullable(), createdAt: z.iso.datetime() })),
});
export type AccountExport = z.infer<typeof accountExportSchema>;

export const accountDeletionResultSchema = z.object({
  deleted: z.literal(true),
  removed: z.object({
    apiTokens: z.number().int(),
    deviceLinks: z.number().int(),
    oauthGrants: z.number().int(),
    publishers: z.number().int(),
    media: z.number().int(),
  }),
});
export type AccountDeletionResult = z.infer<typeof accountDeletionResultSchema>;
