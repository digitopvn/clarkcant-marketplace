import { MarketplaceError } from "@marketplace/contracts";
import { z } from "zod";

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

/**
 * Auth secrets. They are wrangler secrets in staging/production and `apps/web/.dev.vars` locally (git-ignored);
 * example files carry names only. GitHub sign-in is optional: it is enabled only when both halves are present.
 */
export const authSecretsSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32, { error: "must be at least 32 characters" }),
    GITHUB_CLIENT_ID: optionalSecret,
    GITHUB_CLIENT_SECRET: optionalSecret,
  })
  .refine((value) => (value.GITHUB_CLIENT_ID === undefined) === (value.GITHUB_CLIENT_SECRET === undefined), {
    error: "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together",
    path: ["GITHUB_CLIENT_ID"],
  });

export interface AuthSecrets {
  betterAuthSecret: string;
  github: { clientId: string; clientSecret: string } | null;
}

/** Validates auth secrets and fails with the variable names at fault. Values are never echoed. */
export function parseAuthSecrets(raw: Record<string, unknown>): AuthSecrets {
  const result = authSecretsSchema.safeParse(raw);
  if (!result.success) {
    const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "")))];
    throw new MarketplaceError("configuration_error", `Invalid auth configuration: ${variables.join(", ")}`, {
      details: { variables },
    });
  }
  const { BETTER_AUTH_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = result.data;
  return {
    betterAuthSecret: BETTER_AUTH_SECRET,
    github:
      GITHUB_CLIENT_ID !== undefined && GITHUB_CLIENT_SECRET !== undefined
        ? { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET }
        : null,
  };
}
