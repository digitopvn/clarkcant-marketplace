import { z } from "zod";

import { MarketplaceError } from "./errors";

export const environmentNameSchema = z.enum(["development", "staging", "production"]);
export type EnvironmentName = z.infer<typeof environmentNameSchema>;

const emailListSchema = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.email()));

/**
 * Plain-text runtime variables shared by the web and jobs Workers. Bindings (D1, R2, Queue, Workflow) are typed by
 * `wrangler types`; secrets are validated by the feature that owns them, at the point of use.
 */
export const runtimeVarsSchema = z.object({
  PUBLIC_SITE_URL: z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, "")),
  ENVIRONMENT: environmentNameSchema,
  ADMIN_EMAILS: emailListSchema,
});
export type RuntimeVars = z.infer<typeof runtimeVarsSchema>;

/**
 * Validates runtime variables and fails fast with every problem named, so a misconfigured deployment reports the
 * variable at fault instead of failing later with an unrelated error. Values are never echoed back.
 */
export function parseRuntimeVars(raw: Record<string, unknown>): RuntimeVars {
  const result = runtimeVarsSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new MarketplaceError("configuration_error", `Invalid runtime configuration: ${problems.join("; ")}`, {
    details: { variables: [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "")))] },
  });
}
