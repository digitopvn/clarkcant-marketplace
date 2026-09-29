import { z } from "zod";

/** Publisher slugs follow npm scope rules (lowercase, digits, hyphen) so `@<slug>/…` packages map naturally. */
export const publisherSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, { error: "use 2-64 lowercase letters, digits or hyphens" });

export const publisherKindSchema = z.enum(["org", "person"]);
export const publisherRoleSchema = z.enum(["owner", "admin", "member"]);
export type PublisherRole = z.infer<typeof publisherRoleSchema>;

export const createPublisherInputSchema = z.object({
  slug: publisherSlugSchema,
  name: z.string().trim().min(1).max(120),
  kind: publisherKindSchema.default("org"),
});
export type CreatePublisherInput = z.input<typeof createPublisherInputSchema>;

export const publisherSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: publisherKindSchema,
  verifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** The caller's role, when listing the caller's own publishers. */
  role: publisherRoleSchema.optional(),
});
export type Publisher = z.infer<typeof publisherSchema>;

export const inviteMemberInputSchema = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
  role: z.enum(["admin", "member"]).default("member"),
});
export type InviteMemberInput = z.input<typeof inviteMemberInputSchema>;

export const publisherMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: publisherRoleSchema,
  joinedAt: z.iso.datetime(),
});
export type PublisherMember = z.infer<typeof publisherMemberSchema>;

export const publisherInvitationSchema = z.object({
  id: z.string(),
  publisherId: z.string(),
  email: z.string(),
  role: publisherRoleSchema,
  status: z.string(),
  expiresAt: z.iso.datetime(),
});
export type PublisherInvitation = z.infer<typeof publisherInvitationSchema>;

/** A registrable hostname such as `example.com` or `widgets.example.co.uk` (no scheme, port or path). */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, { error: "must be a hostname like example.com" });

export const addDomainInputSchema = z.object({ domain: domainNameSchema });

export const publisherDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  /** Publish this TXT record, then run the verification check. */
  txtRecordName: z.string(),
  txtRecordValue: z.string(),
  verifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PublisherDomain = z.infer<typeof publisherDomainSchema>;

export const repositorySlugSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, { error: "must look like owner/repo" })
  .transform((value) => value.toLowerCase());

export const linkRepositoryInputSchema = z.object({
  provider: z.enum(["github"]).default("github"),
  repository: repositorySlugSchema,
});

export const publisherRepositorySchema = z.object({
  id: z.string(),
  provider: z.enum(["github"]),
  repository: z.string(),
  /** Commit a file at this path containing `verificationFileContent` to the default branch, then verify. */
  verificationFilePath: z.string(),
  verificationFileContent: z.string(),
  verifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PublisherRepository = z.infer<typeof publisherRepositorySchema>;

export const claimMethodSchema = z.enum(["npm_maintainer", "repository"]);
export type ClaimMethod = z.infer<typeof claimMethodSchema>;

export const claimPackageInputSchema = z.object({
  packageName: z.string().trim().min(1).max(214),
  method: claimMethodSchema,
});

export const packageClaimSchema = z.object({
  id: z.string(),
  packageId: z.string(),
  packageName: z.string(),
  publisherId: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  method: claimMethodSchema,
  /** What was checked and what matched; never contains secrets. */
  evidence: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type PackageClaim = z.infer<typeof packageClaimSchema>;
